/**
 * External embedding client for the memory plugin.
 *
 * Calls any OpenAI-compatible embeddings endpoint (OpenAI, Azure, Ollama,
 * LM Studio, vLLM, SiliconFlow, ...). Response parsing accepts three shapes:
 *   OpenAI            { data: [{ embedding: number[] }] }
 *   Ollama /api/embed { embeddings: [number[]] }
 *   Ollama /api/emb   { embedding: number[] }   (single text)
 *
 * Configuration (from `<workspace>/.flavorlite/memory/embedding.json`, falling
 * back to the manifest `config.embedding`):
 *   {
 *     "url": "https://api.openai.com/v1/embeddings",
 *     "model": "text-embedding-3-small",
 *     "apiKey": "sk-...",        // optional; Bearer header only when set
 *     "timeoutMs": 15000,        // optional, default 15000
 *     "batchSize": 8             // optional, max texts per request (default 8)
 *   }
 *
 * Fails loud with a descriptive error; callers decide whether to degrade
 * (BM25-only) or abort.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Load the user-editable embedding config file, falling back to the manifest
 * config. Lookup order:
 *   1. <workspace>/.flavorlite/memory/embedding.json   (data dir, preferred)
 *   2. <pluginDir>/embedding.json                      (plugin dir, convenient)
 *   3. manifest config.embedding
 * Synchronous: called once at plugin mount, reads a tiny JSON file.
 */
export function loadEmbeddingConfig({ workspace, pluginDir, manifestEmbedding, logger }) {
  const candidates = [
    join(workspace, ".flavorlite", "memory", "embedding.json"),
    ...(pluginDir === undefined ? [] : [join(pluginDir, "embedding.json")]),
  ];
  for (const userPath of candidates) {
    if (!existsSync(userPath)) continue;
    try {
      return validateEmbeddingConfig(JSON.parse(readFileSync(userPath, "utf8")), userPath);
    } catch (error) {
      logger?.warn(`memory: invalid embedding config at ${userPath} — ${message(error)}`);
      return undefined;
    }
  }
  if (manifestEmbedding !== undefined) {
    try {
      return validateEmbeddingConfig(manifestEmbedding, "config.embedding");
    } catch (error) {
      logger?.warn(`memory: invalid config.embedding — ${message(error)}`);
      return undefined;
    }
  }
  return undefined;
}

/** Validate and normalize an embedding config object. Throws when unusable. */
export function validateEmbeddingConfig(config, source) {
  if (typeof config !== "object" || config === null) {
    throw new Error(`memory: embedding config (${source}) must be an object`);
  }
  const { url, model, apiKey, timeoutMs, batchSize } = config;
  if (typeof url !== "string" || url.trim() === "") throw new Error(`memory: embedding config (${source}) requires "url"`);
  const normalizedUrl = url.trim();
  if (!/^https?:\/\//i.test(normalizedUrl)) {
    throw new Error(`memory: embedding config (${source}) "url" must be http(s), got ${normalizedUrl}`);
  }
  if (typeof model !== "string" || model.trim() === "") throw new Error(`memory: embedding config (${source}) requires "model"`);
  const timeout = Number.isFinite(timeoutMs) && timeoutMs > 0 ? Math.round(timeoutMs) : 15000;
  const batch = Number.isInteger(batchSize) && batchSize >= 1 ? Math.min(batchSize, 64) : 8;
  return {
    url: normalizedUrl,
    model: model.trim(),
    apiKey: typeof apiKey === "string" && apiKey.trim() !== "" ? apiKey.trim() : undefined,
    timeoutMs: timeout,
    batchSize: batch,
  };
}

/** True when an embedding config is present and usable. */
export function isEmbeddingConfigured(config) {
  return config !== undefined && typeof config.url === "string" && typeof config.model === "string";
}

/**
 * Embed an array of texts into number[][] vectors, batched into
 * config.batchSize requests. Fails loud on network/HTTP/parse errors.
 */
export async function embedTexts(config, texts, signal) {
  if (!isEmbeddingConfigured(config)) throw new Error("memory: embedding is not configured");
  const vectors = [];
  for (let start = 0; start < texts.length; start += config.batchSize) {
    const slice = texts.slice(start, start + config.batchSize);
    vectors.push(...await embedBatch(config, slice, signal));
  }
  return vectors;
}

async function embedBatch(config, texts, signal) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("embedding request timed out")), config.timeoutMs);
  const onAbort = () => controller.abort(signal?.reason ?? new Error("aborted"));
  if (signal) {
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  }
  try {
    const headers = { "Content-Type": "application/json", Accept: "application/json" };
    if (config.apiKey !== undefined) headers.Authorization = `Bearer ${config.apiKey}`;
    const response = await fetch(config.url, {
      method: "POST",
      headers,
      body: JSON.stringify({ model: config.model, input: texts }),
      signal: controller.signal,
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new Error(`embedding HTTP ${response.status}${detail ? `: ${detail.slice(0, 200)}` : ""}`);
    }
    const parsed = await response.json().catch(() => undefined);
    return parseEmbeddingResponse(parsed, texts.length);
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener("abort", onAbort);
  }
}

function parseEmbeddingResponse(parsed, expectedCount) {
  // OpenAI shape: { data: [{ embedding: number[] }] }
  if (parsed && Array.isArray(parsed.data)) {
    const vectors = parsed.data.map((entry) => entry?.embedding).filter(Array.isArray);
    if (vectors.length === expectedCount) return vectors.map(validateVector);
    throw new Error(`embedding response data count mismatch: got ${vectors.length}, expected ${expectedCount}`);
  }
  // Ollama /api/embed shape: { embeddings: [number[]] }
  if (parsed && Array.isArray(parsed.embeddings)) {
    if (parsed.embeddings.length === expectedCount) return parsed.embeddings.map(validateVector);
    throw new Error(`embedding response embeddings count mismatch: got ${parsed.embeddings.length}, expected ${expectedCount}`);
  }
  // Ollama /api/embeddings (single): { embedding: number[] }
  if (parsed && Array.isArray(parsed.embedding)) {
    if (expectedCount !== 1) throw new Error("embedding endpoint returned a single vector for a batch request");
    return [validateVector(parsed.embedding)];
  }
  throw new Error("embedding endpoint returned an unrecognized response shape");
}

function validateVector(vector) {
  if (vector.length === 0) throw new Error("embedding endpoint returned an empty vector");
  if (!vector.every((value) => Number.isFinite(value))) throw new Error("embedding endpoint returned non-finite values");
  return vector.map(Number);
}

function message(error) {
  return error instanceof Error ? error.message : String(error);
}
