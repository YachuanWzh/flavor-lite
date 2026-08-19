/**
 * Text normalization and similarity helpers used for memory dedupe and
 * heat-classification scoring. Ported from flavor-code's memory/similarity.
 */

/** NFKC-normalize, lowercase, collapse non-letter/number runs to single spaces. */
export function normalizeForSimilarity(value) {
  return value.normalize("NFKC").toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ").trim();
}

/** Jaccard index over two sets; empty/empty = 1, one empty = 0. */
export function jaccard(left, right) {
  if (left.size === 0 && right.size === 0) return 1;
  if (left.size === 0 || right.size === 0) return 0;
  let intersection = 0;
  for (const item of left) if (right.has(item)) intersection += 1;
  return intersection / (left.size + right.size - intersection);
}

/** Word tokens (whitespace-separated after normalization). */
export function wordTokens(value) {
  return new Set(normalizeForSimilarity(value).split(" ").filter((token) => token.length > 0));
}

/** Character n-grams over the normalized string (whitespace removed). */
export function characterNgrams(value, size = 3) {
  const normalized = [...normalizeForSimilarity(value).replace(/\s+/g, "")];
  if (normalized.length === 0) return new Set();
  if (normalized.length <= size) return new Set([normalized.join("")]);
  return new Set(Array.from({ length: normalized.length - size + 1 }, (_, index) => normalized.slice(index, index + size).join("")));
}

function dice(left, right) {
  if (left.size === 0 && right.size === 0) return 1;
  let intersection = 0;
  for (const item of left) if (right.has(item)) intersection += 1;
  return (2 * intersection) / (left.size + right.size);
}

/**
 * 0..1 similarity tuned for short memory entries. The exact-match band is
 * reserved for truly identical content: a tiny token substitution
 * (npm/pnpm, allow/deny) must not cross the automatic-duplicate threshold.
 */
export function memorySimilarity(left, right) {
  const normalizedLeft = normalizeForSimilarity(left);
  const normalizedRight = normalizeForSimilarity(right);
  if (normalizedLeft === normalizedRight) return 1;
  const words = jaccard(wordTokens(normalizedLeft), wordTokens(normalizedRight));
  const leftBigrams = characterNgrams(normalizedLeft, 2);
  const rightBigrams = characterNgrams(normalizedRight, 2);
  const characters = Math.max(
    jaccard(leftBigrams, rightBigrams),
    jaccard(characterNgrams(normalizedLeft, 3), characterNgrams(normalizedRight, 3)),
    dice(leftBigrams, rightBigrams) * 0.9,
  );
  const score = Math.max(words, characters, words * 0.6 + characters * 0.4);
  return words < 1 && characters >= 0.9 ? Math.min(score, 0.89) : score;
}
