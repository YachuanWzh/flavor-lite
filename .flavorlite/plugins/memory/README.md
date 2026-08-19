# memory

A long-term memory plugin for flavor-lite. Durable facts are stored under
`.flavorlite/memory/` with dedupe, heat aging, recall counting, and a
**hybrid multi-path retriever** — BM25 (sparse lexical) plus **external
embedding vectors** (dense), fused by reciprocal rank fusion (RRF).

This plugin is fully self-contained: it never touches `.flavor/`, and its
storage format is flavor-lite's own (no flavor-code compatibility).

## Install

```text
# from the flavor-lite REPL
/plugin reload
/plugin list          # memory should be "loaded"
```

Or drop this directory into `.flavorlite/plugins/memory/` (project) or
`~/.flavorlite/plugins/memory/` (user-global) and restart / reload.

## Data layout

```
.flavorlite/memory/MEMORY.md       routing index (human-readable + base64url JSON)
.flavorlite/memory/tasks/<id>.md   full content per task, isolated per task
.flavorlite/memory/behavior.json   auto-extraction behavior
.flavorlite/memory/vectors.json    persisted embedding vectors (when embedding is configured)
.flavorlite/memory/embedding.json  your embedding endpoint config (optional)
```

## Commands

| Command | Effect |
|---|---|
| `/memory` | List stored memories with heat tag and recall count |
| `/remember <type> <text>` | Manually store a durable fact (`user` / `feedback` / `project` / `reference`) |
| `/forget <id-or-text>` | Remove matching memories |
| `/forget-cold` | Age out cold entries (inactive 3+ days) |
| `/embedding` | Show embedding/vector-store status (configured? model? vector count?) |

## How it works

### Storage

Each memory is a typed entry (`user` preferences, `feedback` corrections,
`project` conventions, `reference` pointers). The store keeps a routing
index in `MEMORY.md` (human-readable plus an embedded base64url JSON index)
and full content in `tasks/<task>.md`. Every write is crash-safe: file lock +
atomic rename + `.bak` fallback, so a torn write never loses entries.

- **Dedupe** — exact normalization plus `similarity >= 0.92` rejects
  duplicates (a tiny token substitution like `npm`/`pnpm` stays below the
  duplicate band).
- **Heat aging** — entries recalled >10× within 7 days are `hot`; entries
  inactive for 3+ days are `cold`; everything else is `normal`. Heat
  modulates retrieval score and powers `/forget-cold`.
- **Recall counting** — every retrieval records `recallTotal` and per-task
  recall timestamps, which drive the heat classification.

### Hybrid retrieval (BM25 + external embeddings + RRF)

`recall(query)` runs two independent paths over the memory index:

1. **BM25** — tokenizes query and documents into words plus CJK
   single-char/bigram terms, scores with standard BM25 (`k1=1.5`, `b=0.75`,
   smoothed IDF). Exact identifiers, commands, and proper nouns rank high.
2. **Dense vectors** — every entry is embedded through your configured
   embedding endpoint (OpenAI-compatible; works with OpenAI, Azure, Ollama,
   LM Studio, vLLM, SiliconFlow, ...). The vectors live in a lightweight
   vector store (`.flavorlite/memory/vectors.json`) and recall runs an exact
   cosine scan.

The two ranked lists are fused by **reciprocal rank fusion** (RRF,
`score = Σ 1/(fusionK + rank + 1)`, default `fusionK=60`) so an entry that
ranks well in either path surfaces near the top. Heat then modulates the
fused score (hot up 15%, cold down 25%), and results are trimmed to `topK`
within a `maxChars` budget.

**Without embedding configuration, recall is BM25-only** — the plugin stays
fully usable offline; only the dense path is skipped.

### Embedding configuration

The plugin reads `<workspace>/.flavorlite/memory/embedding.json` first; if
that file is absent it falls back to the manifest `config.embedding`. Copy
`embedding.json.example` from the plugin directory and fill it in:

```json
{
  "url": "https://api.openai.com/v1/embeddings",
  "model": "text-embedding-3-small",
  "apiKey": "sk-...",
  "timeoutMs": 15000,
  "batchSize": 8
}
```

- `url` — any OpenAI-compatible `/embeddings` endpoint (required). Works
  with Ollama too: `http://localhost:11434/api/embed` (or
  `/api/embeddings`).
- `model` — embedding model name, passed through verbatim (required).
- `apiKey` — optional; the `Authorization: Bearer <key>` header is only
  sent when set.
- `timeoutMs` — per-request timeout (default 15000).
- `batchSize` — texts per request (default 8).

Run `/embedding` to verify the plugin picked up your config. When the
embedding endpoint fails at write/recall time, the plugin logs a warning and
falls back to BM25-only — a dead embedding API never breaks the loop.

### The vector store

`vector-store.js` is a deliberately tiny vector library: pure JS, zero
dependencies, no FAISS/sqlite-vec/native bindings. It persists L2-normalized
Float32 vectors to `.flavorlite/memory/vectors.json` (base64-encoded,
written atomically with a `.bak`), validates dimensions (a model change that
alters dimension resets the store), and searches exactly with a single-pass
cosine scan. The memory index is capped at `maxEntries` (default 200), so
exact scanning is microseconds — an approximate index would only add
complexity. New entries are embedded at write time; pre-existing entries
are backfilled lazily on first recall.

### Automatic recall (per turn)

Before every model request the plugin hooks `loop/before-request`, builds a
query from the latest user/assistant messages, runs the hybrid BM25 + vector
recall, and appends the top hits to the system prompt. Results are cached
per query so repeated tool iterations inside one turn don't re-embed; a
recall failure degrades silently and never blocks the loop. User-type
memories are additionally injected into every system prompt via
`prompt/assemble` (full text, always).

### Automatic extraction

When an `llm` service is available, the plugin hooks `loop/after-run` and
extracts durable facts from the finished conversation using the agent's own
LLM (fire-and-forget; the loop is never blocked). Candidates scoring at or
above the `autoStoreThreshold` (default 11/12) are stored automatically;
lower-scoring ones are dropped — there is no interactive review in this
host. Secrets, credentials, raw tool output, and prompt-injection text are
rejected by the sensitive-content filter.

## Config

Manifest `config` overrides (defaults shown):

```json
{
  "maxEntries": 200,
  "maxEntryChars": 600,
  "autoStoreThreshold": 11,
  "recallTopK": 4,
  "recallMaxChars": 1600,
  "bm25": { "k1": 1.5, "b": 0.75 },
  "fusionK": 60,
  "embedding": { "url": "", "model": "", "apiKey": "", "timeoutMs": 15000, "batchSize": 8 }
}
```

## Files

- `index.js` — plugin entry: service, commands, hooks
- `store.js` — MemoryStore (routing-index storage, dedupe, heat, recall counting)
- `retrieval.js` — BM25 + RRF fusion, heat classification
- `embedding.js` — external embedding client (OpenAI/Ollama-compatible)
- `vector-store.js` — lightweight persisted vector store (cosine search)
- `similarity.js` — normalization / similarity primitives
- `extractor.js` — LLM extraction prompt + candidate parsing
- `protected-file.js` — crash-safe locked file updates
- `types.js` — shared constants
