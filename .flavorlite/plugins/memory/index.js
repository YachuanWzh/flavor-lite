/**
 * flavor-lite memory plugin.
 *
 * Provides:
 * - service `memory`: a MemoryStore with hybrid (BM25 + vector) recall
 * - commands: /memory (list), /remember (manual add), /forget (remove),
 *   /forget-cold (age out cold entries)
 * - `prompt/assemble` hook: injects user-type memories (always) into the
 *   system prompt so persistent preferences are always visible
 * - `loop/after-run` hook: automatically extracts durable facts from the
 *   finished conversation via the LLM (when an `llm` service is available)
 *
 * All state lives under `<cwd>/.flavorlite/memory/` (flavor-lite's own
 * format — fully decoupled from flavor-code's `.flavor/memory/`).
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { embedTexts, loadEmbeddingConfig } from "./embedding.js";
import { MemoryStore } from "./store.js";
import { buildMemoryExtractionPrompt, parseScoredMemoryCandidates } from "./extractor.js";
import { formatMemoryContext } from "./store.js";
import { HEAT_EMOJI, MEMORY_TYPES, TYPE_LABEL } from "./types.js";
import { classifyMemoryHeat } from "./retrieval.js";
import { VectorStore } from "./vector-store.js";

const PLUGIN_DIR = dirname(fileURLToPath(import.meta.url));

const DEFAULT_CONFIG = {
  maxEntries: 200,
  maxEntryChars: 600,
  autoStoreThreshold: 11,
  recallTopK: 4,
  recallMaxChars: 1600,
  bm25: { k1: 1.5, b: 0.75 },
  fusionK: 60,
  /** Optional; `.flavorlite/memory/embedding.json` overrides this when present. */
  embedding: undefined,
};

/**
 * Collect a full text response from an async-iterable LLM stream.
 * Returns undefined when the stream fails or yields no text.
 */
async function collectLlmText(llm, options) {
  try {
    let text = "";
    const stream = llm.stream(options);
    for await (const event of stream) {
      if (event.type === "text_delta") text += event.text;
    }
    return text.trim() || undefined;
  } catch {
    return undefined;
  }
}

/** Auto-extract memory candidates from a finished conversation. */
async function extractMemories({ llm, store, messages, taskId, config, logger }) {
  if (!messages || messages.length === 0) return;
  const systemPrompt = [
    "You are the memory subsystem of a coding agent.",
    "Extract durable facts from the conversation below for long-term memory.",
  ].join("\n");

  const raw = await collectLlmText(llm, {
    systemPrompt,
    messages,
    maxTokens: 600,
  });
  if (raw === undefined) {
    logger?.debug("memory: LLM extraction produced no output");
    return;
  }

  let candidates;
  try {
    candidates = parseScoredMemoryCandidates(raw, {
      maxEntryChars: config.maxEntryChars,
      scoreThreshold: 0,
      maxCandidates: 2,
    });
  } catch (error) {
    logger?.warn(`memory: extraction parse failed: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }
  if (candidates.length === 0) return;

  // Auto-store candidates at/above the threshold; drop the rest silently
  // (no interactive review in this host — that stays a flavor-code feature).
  const auto = candidates.filter((candidate) => totalScore(candidate) >= config.autoStoreThreshold);
  if (auto.length === 0) {
    logger?.debug("memory: no candidate met the auto-store threshold");
    return;
  }
  for (const candidate of auto) {
    try {
      const { added } = await store.rememberForTask(taskId, candidate);
      if (added) logger?.info(`memory: stored ${candidate.type} fact: ${candidate.summary}`);
    } catch (error) {
      logger?.warn(`memory: store failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

function totalScore(candidate) {
  return candidate.scores.durability + candidate.scores.futureUtility
    + candidate.scores.authority + candidate.scores.nonDerivability;
}

/**
 * Build a recall query from the conversation: the latest user message plus
 * the most recent assistant text (as context). Trimmed to keep embedding
 * requests cheap. Returns undefined when there's nothing usable.
 */
function buildRecallQuery(messages) {
  const parts = [];
  for (let i = messages.length - 1; i >= 0 && parts.length < 2; i -= 1) {
    const message = messages[i];
    if (!message || typeof message.content !== "string") continue;
    if (message.role === "user" || message.role === "assistant") {
      parts.unshift(message.content.trim());
    }
  }
  const query = parts.join("\n").trim();
  if (!query) return undefined;
  return query.length > 600 ? query.slice(-600) : query;
}

/** Render the /memory listing. */
async function renderMemoryList(store, maxChars = 4000) {
  const entries = await store.list();
  const references = await store.references();
  if (entries.length === 0) return "No memories stored yet.";
  const now = new Date();
  const lines = [`${entries.length} memory entr${entries.length === 1 ? "y" : "ies"}:`];
  let chars = 0;
  for (const entry of entries) {
    const reference = references.find((ref) => ref.id === entry.id);
    const heat = reference ? classifyMemoryHeat(reference, now) : "normal";
    const recalls = reference?.recallTotal ?? 0;
    const line = `- ${HEAT_EMOJI[heat]}[${TYPE_LABEL[entry.type]}] ${entry.content} (id: ${entry.id}, recalls: ${recalls})`;
    if (chars + line.length > maxChars) {
      lines.push("... (truncated)");
      break;
    }
    lines.push(line);
    chars += line.length;
  }
  return lines.join("\n");
}

export default {
  name: "memory",
  inject: ["hooks", "commands"],
  provides: ["memory"],
  apply(ctx, config = {}) {
    return ctx.effect(() => {
      const cfg = { ...DEFAULT_CONFIG, ...config };

      // Dense retrieval setup: user-editable .flavorlite/memory/embedding.json
      // wins over the manifest config; absent both, recall is BM25-only.
      let embeddingConfig;
      try {
        embeddingConfig = loadEmbeddingConfig({
          workspace: ctx.cwd,
          pluginDir: PLUGIN_DIR,
          manifestEmbedding: cfg.embedding,
          logger: ctx.logger,
        });
      } catch (error) {
        ctx.logger.warn(`memory: embedding disabled — ${error instanceof Error ? error.message : String(error)}`);
      }
      let vectorStore;
      if (embeddingConfig !== undefined) {
        vectorStore = new VectorStore({
          path: join(ctx.cwd, ".flavorlite", "memory", "vectors.json"),
          logger: ctx.logger,
        }).init();
      }

      const store = new MemoryStore({
        workspace: ctx.cwd,
        maxEntries: cfg.maxEntries,
        maxEntryChars: cfg.maxEntryChars,
        bm25: cfg.bm25,
        fusionK: cfg.fusionK,
        logger: ctx.logger,
        embedder: embeddingConfig === undefined ? undefined : {
          embed: (texts) => embedTexts(embeddingConfig, texts),
        },
        vectorStore,
      });
      const disposers = [];

      // Service: other plugins can inject "memory" for direct access.
      disposers.push(ctx.provide("memory", {
        store,
        embedding: {
          configured: embeddingConfig !== undefined,
          model: embeddingConfig?.model,
          url: embeddingConfig?.url,
          vectorCount: () => vectorStore?.size ?? 0,
        },
        recall: (query, options = {}) => store.recall(query, {
          taskId: options.taskId ?? "plugin",
          topK: options.topK ?? cfg.recallTopK,
          maxChars: options.maxChars ?? cfg.recallMaxChars,
          bm25: cfg.bm25,
          fusionK: cfg.fusionK,
        }),
        list: () => renderMemoryList(store),
      }));

      // System prompt: always surface user-type preferences.
      disposers.push(ctx.get("hooks").hook("prompt/assemble", async (event, next) => {
        try {
          const userContext = await store.userContext();
          if (userContext) {
            event.sections.push({ name: "memory", content: `## Long-term memory (user preferences — directly injected, not retrieval)\n\n${userContext}` });
          }
        } catch {
          // Memory read failure must not break the prompt.
        }
        return next(event);
      }));

      // Hybrid recall before every model request: use the latest messages as
      // the query, fuse BM25 + vector results, and append the hits to the
      // system prompt. Cached per query so repeated iterations inside one
      // turn don't re-embed. Failures degrade silently (BM25 already ran or
      // the loop just proceeds without memory).
      const recallCache = { query: undefined, context: undefined };
      disposers.push(ctx.get("hooks").hook("loop/before-request", async (event, next) => {
        try {
          const query = buildRecallQuery(event.messages);
          if (!query) return next(event);
          if (recallCache.query === query) {
            if (recallCache.context) event.systemPrompt = `${event.systemPrompt}\n\n${recallCache.context}`;
            return next(event);
          }
          const { context } = await store.recall(query, {
            taskId: "loop",
            topK: cfg.recallTopK,
            maxChars: cfg.recallMaxChars,
          });
          recallCache.query = query;
          recallCache.context = context;
          if (context) event.systemPrompt = `${event.systemPrompt}\n\n${context}`;
        } catch {
          // Recall failure must never break the loop.
        }
        return next(event);
      }));

      // Auto-extraction after each finished turn (only when an llm exists).
      const llm = ctx.tryGet("llm");
      if (llm) {
        disposers.push(ctx.get("hooks").hook("loop/after-run", async (event, next) => {
          // Fire-and-forget: never block the loop on extraction.
          const taskId = `auto-${new Date().toISOString().replace(/[:.]/g, "-")}`;
          const session = ctx.tryGet("session");
          let messages;
          if (session) {
            try {
              const latestId = await session.latest();
              if (latestId) {
                const handle = await session.open(latestId);
                messages = handle.messages();
              }
            } catch {
              messages = undefined;
            }
          }
          void extractMemories({
            llm,
            store,
            messages,
            taskId,
            config: cfg,
            logger: ctx.logger,
          });
          return next(event);
        }));
      }

      // Commands.
      const commands = ctx.get("commands");
      disposers.push(commands.register({
        name: "memory",
        description: "List long-term memories with heat and recall counts",
        run: () => renderMemoryList(store),
      }));
      disposers.push(commands.register({
        name: "remember",
        description: "Manually store a durable fact: /remember <type> <text> (type: user|feedback|project|reference)",
        async run(args) {
          const trimmed = args.trim();
          if (!trimmed) return "Usage: /remember <type> <text> — type is user|feedback|project|reference";
          const space = trimmed.indexOf(" ");
          const type = (space === -1 ? trimmed : trimmed.slice(0, space)).toLocaleLowerCase();
          const text = (space === -1 ? "" : trimmed.slice(space + 1)).trim();
          if (!MEMORY_TYPES.includes(type) || !text) {
            return "Usage: /remember <type> <text> — type is user|feedback|project|reference";
          }
          try {
            const { added } = await store.remember({ type, content: text });
            return added
              ? `Remembered: [${type}] ${text}`
              : `Skipped: already stored (duplicate or capacity reached): [${type}] ${text}`;
          } catch (error) {
            return `Failed to remember: ${error instanceof Error ? error.message : String(error)}`;
          }
        },
      }));
      disposers.push(commands.register({
        name: "forget",
        description: "Remove memories matching an id or text: /forget <id-or-text>",
        async run(args) {
          const query = args.trim();
          if (!query) return "Usage: /forget <id-or-text>";
          const removed = await store.forget(query);
          return removed > 0 ? `Removed ${removed} memor${removed === 1 ? "y" : "ies"}.` : "No matching memory found.";
        },
      }));
      disposers.push(commands.register({
        name: "forget-cold",
        description: "Age out cold memories (inactive for 3+ days)",
        async run() {
          const { removed, filesRemoved } = await store.forgetCold();
          return removed > 0
            ? `Forgot ${removed} cold memor${removed === 1 ? "y" : "ies"} (${filesRemoved} file${filesRemoved === 1 ? "" : "s"} removed).`
            : "No cold memories to forget.";
        },
      }));
      disposers.push(commands.register({
        name: "embedding",
        description: "Show the embedding/vector-store status for memory retrieval",
        async run() {
          const configured = embeddingConfig !== undefined;
          const lines = [
            `Embedding: ${configured ? "configured" : "not configured (BM25-only recall)"}`,
          ];
          if (configured) {
            lines.push(`  url: ${embeddingConfig.url}`);
            lines.push(`  model: ${embeddingConfig.model}`);
            lines.push(`  apiKey: ${embeddingConfig.apiKey ? "(set)" : "(none)"}`);
            lines.push(`  vectors: ${vectorStore?.size ?? 0} stored`);
          }
          return lines.join("\n");
        },
      }));

      return () => {
        for (const dispose of disposers.reverse()) dispose();
      };
    }, "memory.install");
  },
};
