/**
 * Hybrid multi-path retrieval: BM25 (sparse lexical) fused with a dense
 * vector path by reciprocal rank fusion (RRF).
 *
 * The dense path is *injected*: callers pass a `vectorSearch(query, refs)`
 * function backed by the external embedding client + VectorStore (see
 * embedding.js / vector-store.js). rankMemoryReferences stays pure and
 * testable; without a vectorSearch it degrades gracefully to BM25-only.
 *
 * Why RRF: BM25 and cosine similarities live on incomparable scales. RRF
 * combines ranked lists instead (`score = Σ 1/(fusionK + rank + 1)`), so a
 * document that ranks well in either path surfaces near the top.
 */

import { characterNgrams, jaccard, normalizeForSimilarity, wordTokens } from "./similarity.js";

const HOT_WINDOW_MS = 7 * 24 * 60 * 60 * 1_000;
const COLD_AFTER_MS = 3 * 24 * 60 * 60 * 1_000;

const DEFAULT_BM25_K1 = 1.5;
const DEFAULT_BM25_B = 0.75;
const DEFAULT_FUSION_K = 60;

/** heat: hot (recalled >10x within 7d) / cold (inactive >3d) / normal. */
export function classifyMemoryHeat(reference, now = new Date()) {
  const cutoff = now.getTime() - HOT_WINDOW_MS;
  const recent = Object.values(reference.recalls).filter((value) => {
    const timestamp = Date.parse(value);
    return Number.isFinite(timestamp) && timestamp >= cutoff && timestamp <= now.getTime();
  }).length;
  if (recent > 10) return "hot";
  const last = Math.max(
    Date.parse(reference.createdAt),
    ...Object.values(reference.recalls).map(Date.parse).filter(Number.isFinite),
  );
  return now.getTime() - last > COLD_AFTER_MS ? "cold" : "normal";
}

/**
 * Tokenize for BM25: lowercase words + CJK single chars and bigrams, so both
 * English identifiers and Chinese text get usable lexical terms.
 */
export function tokenize(text) {
  const tokens = [];
  const lower = text.toLocaleLowerCase();
  for (const match of lower.matchAll(/[a-z0-9_]+/g)) {
    const token = match[0];
    if (token.length > 1) tokens.push(token);
  }
  for (const run of lower.matchAll(/[\u4e00-\u9fff]+/g)) {
    const chars = run[0] ?? "";
    for (const char of chars) tokens.push(char);
    for (let i = 0; i + 1 < chars.length; i += 1) tokens.push(chars.slice(i, i + 2));
  }
  return tokens;
}

/** Searchable text for a memory reference (summary + keywords + topic key). */
function searchableText(reference) {
  return `${reference.summary} ${reference.keywords.join(" ")} ${reference.topicKey}`;
}

/**
 * BM25 scorer. Corpus statistics come from the full reference list so IDF is
 * stable across queries and entries are comparable.
 */
class Bm25Index {
  constructor(references, { k1 = DEFAULT_BM25_K1, b = DEFAULT_BM25_B } = {}) {
    this.k1 = k1;
    this.b = b;
    this.references = references;
    this.documents = references.map((reference) => tokenize(searchableText(reference)));
    this.docLengths = this.documents.map((terms) => terms.length);
    const totalTerms = this.docLengths.reduce((sum, length) => sum + length, 0);
    this.avgDocLength = this.documents.length === 0 ? 0 : totalTerms / this.documents.length;

    this.docFreq = new Map();
    for (const terms of this.documents) {
      for (const term of new Set(terms)) this.docFreq.set(term, (this.docFreq.get(term) ?? 0) + 1);
    }
  }

  idf(term) {
    const n = this.docFreq.get(term) ?? 0;
    return Math.log(1 + (this.references.length - n + 0.5) / (n + 0.5));
  }

  score(queryTerms, docIndex) {
    const terms = this.documents[docIndex] ?? [];
    const length = this.docLengths[docIndex] ?? 0;
    let score = 0;
    for (const term of new Set(queryTerms)) {
      const tf = terms.filter((t) => t === term).length;
      if (tf === 0) continue;
      const denominator = tf + this.k1 * (1 - this.b + this.b * (length / Math.max(this.avgDocLength, 1)));
      score += this.idf(term) * ((tf * (this.k1 + 1)) / denominator);
    }
    return score;
  }

  /** Return indices sorted by BM25 score, descending. */
  search(queryTerms) {
    const scored = this.references.map((_, index) => ({ index, score: this.score(queryTerms, index) }));
    scored.sort((left, right) => right.score - left.score || left.index - right.index);
    return scored;
  }
}

/** Export the BM25 index separately for tests / custom fusion. */
export function buildBm25Index(references, bm25) {
  return new Bm25Index(references, bm25);
}

/**
 * Rank memory references by hybrid retrieval.
 *
 * @param {object[]} references          memory index references
 * @param {string} query                 user query
 * @param {object} [options]
 * @param {Date}   [options.now]
 * @param {number} [options.topK=4]
 * @param {number} [options.maxChars=1600]
 * @param {number} [options.minScore=0]
 * @param {object} [options.bm25]        { k1, b }
 * @param {number} [options.fusionK=60]
 * @param {(query: string, references: object[]) => Promise<{ id: string; score: number }[] | { id: string; score: number }[]>} [options.vectorSearch]
 *   Dense-path searcher (external embedding + vector store). Returns results
 *   sorted by similarity desc. When omitted, ranking is BM25-only.
 *
 * Returns references sorted by fused score, filtered by minScore, trimmed to
 * topK within maxChars. Heat modulates the fused score (hot up 15%, cold
 * down 25%).
 *
 * Every selected item carries a `sources` field so callers can attribute the
 * hit and compare the two paths:
 *   sources.bm25   { rank, score } — BM25 score (0 means no lexical match)
 *   sources.vector { rank, score } — cosine similarity from the dense path
 *   (each path's rank is 1-based; missing paths/entries are `undefined`)
 */
export async function rankMemoryReferences(references, query, options = {}) {
  const {
    now = new Date(),
    topK = 4,
    maxChars = 1600,
    minScore = 0,
    bm25 = {},
    fusionK = DEFAULT_FUSION_K,
    vectorSearch,
  } = options;

  if (references.length === 0) return [];

  const queryTerms = tokenize(query);
  const bm25Index = new Bm25Index(references, bm25);
  const bm25Ranked = bm25Index.search(queryTerms);
  const bm25Rank = new Map(bm25Ranked.map((entry, index) => [entry.index, index]));
  const bm25Score = new Map(bm25Ranked.map((entry) => [entry.index, entry.score]));

  // Dense path: caller-provided searcher; optional, degrades to BM25-only.
  // Map<docIndex, { rank, score }> — keeps both position and raw similarity.
  let vectorRank = undefined;
  if (vectorSearch !== undefined) {
    try {
      const vectorResults = await vectorSearch(query, references);
      if (Array.isArray(vectorResults) && vectorResults.length > 0) {
        const position = new Map(vectorResults.map((result, index) => [result.id, index]));
        const score = new Map(vectorResults.map((result) => [result.id, result.score]));
        vectorRank = new Map(
          references.map((reference, index) => [index, position.get(reference.id)])
            .filter(([, pos]) => pos !== undefined)
            .map(([index, pos]) => [index, { rank: pos, score: score.get(references[index].id) }]),
        );
      }
    } catch (error) {
      // Vector path failure must never kill recall: fall back to BM25-only.
      vectorRank = undefined;
    }
  }

  const fused = references.map((_, index) => {
    let score = 1 / (fusionK + (bm25Rank.get(index) ?? 0) + 1);
    if (vectorRank !== undefined) {
      const vectorPosition = vectorRank.get(index);
      if (vectorPosition !== undefined) score += 1 / (fusionK + vectorPosition.rank + 1);
    }
    return { index, score };
  });
  fused.sort((left, right) => right.score - left.score || left.index - right.index);

  const selected = [];
  let chars = 0;
  for (const { index, score } of fused) {
    if (selected.length >= topK) break;
    const reference = references[index];
    if (reference === undefined) continue;
    const heat = classifyMemoryHeat(reference, now);
    const modulated = score * (heat === "hot" ? 1.15 : heat === "cold" ? 0.75 : 1);
    if (modulated < minScore) continue;
    const size = reference.summary.length;
    if (chars + size > maxChars) continue;
    const vector = vectorRank?.get(index);
    selected.push({
      reference,
      score: modulated,
      heat,
      sources: {
        bm25: { rank: (bm25Rank.get(index) ?? 0) + 1, score: bm25Score.get(index) ?? 0 },
        vector: vector === undefined ? undefined : { rank: vector.rank + 1, score: vector.score },
      },
    });
    chars += size;
  }
  return selected;
}

/** Lexical fallback used by callers without a dense path. */
export function lexicalFallbackScore(query, reference) {
  const normalizedQuery = normalizeForSimilarity(query);
  const searchable = searchableText(reference);
  const wordScore = jaccard(wordTokens(normalizedQuery), wordTokens(searchable));
  const characterScore = jaccard(characterNgrams(normalizedQuery), characterNgrams(searchable));
  return Math.max(wordScore, characterScore);
}
