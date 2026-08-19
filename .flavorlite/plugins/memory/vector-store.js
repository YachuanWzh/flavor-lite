/**
 * Lightweight vector store for the memory plugin.
 *
 * Deliberately tiny: no FAISS, no sqlite-vec, no native bindings. The memory
 * index is capped (default 200 entries), so a full cosine scan over L2-
 * normalized Float32 vectors is microseconds and an approximate index would
 * only add complexity. What this module does give you is a *real* vector
 * store: persisted on disk, atomic (crash-safe via updateProtectedFile),
 * dimension-checked, with insert/update/delete/search.
 *
 * Storage: `.flavorlite/memory/vectors.json`
 *   { "version": 1, "dimensions": 1536,
 *     "entries": { "<memoryId>": { "v": "<base64 float32le>", "updatedAt": "..." } } }
 *
 * Vectors are L2-normalized at insert time, so cosine similarity = dot
 * product and search() is a single pass with Math.fround accumulation.
 */

import { Buffer } from "node:buffer";
import { existsSync, readFileSync } from "node:fs";

import { updateProtectedFile } from "./protected-file.js";

const FILE_VERSION = 1;

export class VectorStore {
  /**
   * @param {object} options
   * @param {string} options.path  absolute path of the vectors.json file
   * @param {object} [options.logger]
   */
  constructor({ path, logger }) {
    this.path = path;
    this.logger = logger;
    this.dimensions = undefined;
    /** Map<memoryId, Float32Array> — normalized vectors. */
    this.vectors = new Map();
    this.loaded = false;
    this.dirty = false;
  }

  /** Load the persisted store synchronously (called once at plugin mount). */
  init() {
    if (!existsSync(this.path)) return this;
    try {
      const file = decodeFile(readFileSync(this.path, "utf8"));
      this.dimensions = file.dimensions;
      for (const [id, vector] of Object.entries(file.entries ?? {})) {
        this.vectors.set(id, vector);
      }
    } catch (error) {
      this.logger?.warn(`memory: vector store read failed — ${message(error)}; starting empty`);
    }
    this.loaded = true;
    this.dirty = false;
    return this;
  }

  get size() {
    return this.vectors.size;
  }

  has(id) {
    return this.vectors.has(id);
  }

  /**
   * Insert or replace a vector. The vector is L2-normalized in place. The
   * first insert fixes the store's dimensions; a later vector of a different
   * length is rejected (the embedding model likely changed — see README).
   * Call persist() to write to disk.
   */
  upsert(id, vector) {
    if (!Array.isArray(vector) || vector.length === 0) throw new Error("memory: vector must be a non-empty array");
    if (this.dimensions !== undefined && vector.length !== this.dimensions) {
      throw new Error(`memory: vector dimension mismatch — store is ${this.dimensions}, got ${vector.length}`);
    }
    if (this.dimensions === undefined) this.dimensions = vector.length;
    const normalized = normalize(vector);
    this.vectors.set(id, normalized);
    this.dirty = true;
  }

  /** Remove a vector; returns true when it existed. */
  remove(id) {
    const existed = this.vectors.delete(id);
    if (existed) this.dirty = true;
    return existed;
  }

  /**
   * Cosine search (exact, single pass). Returns [{ id, score }] sorted
   * descending; query vector is normalized first. Missing vectors are simply
   * absent from the result — callers reconcile with the memory index.
   */
  search(queryVector, topK = 10, minScore = 0) {
    if (!Array.isArray(queryVector) || queryVector.length === 0) throw new Error("memory: query vector must be non-empty");
    if (this.dimensions !== undefined && queryVector.length !== this.dimensions) {
      throw new Error(`memory: query vector dimension mismatch — store is ${this.dimensions}, got ${queryVector.length}`);
    }
    const q = normalize(queryVector);
    const results = [];
    for (const [id, vector] of this.vectors) {
      const score = dot(q, vector);
      if (score >= minScore) results.push({ id, score });
    }
    results.sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1));
    return results.slice(0, topK);
  }

  /** All (id, vector) pairs — used by tests and re-embedding. */
  entries() {
    return [...this.vectors.entries()];
  }

  /**
   * Persist the in-memory vectors to disk (idempotent, atomic). Cheap when
   * nothing changed: skips the write entirely.
   */
  async persist() {
    if (!this.dirty) return;
    await updateProtectedFile({
      path: this.path,
      decode: decodeFile,
      encode: encodeFile,
      update: (current) => ({
        version: FILE_VERSION,
        dimensions: this.dimensions,
        entries: Object.fromEntries(
          [...this.vectors.entries()].map(([id, vector]) => [id, {
            v: float32ToBase64(vector),
            updatedAt: new Date().toISOString(),
          }]),
        ),
      }),
    });
    this.dirty = false;
  }
}

function normalize(vector) {
  let magnitude = 0;
  for (const value of vector) magnitude += value * value;
  magnitude = Math.sqrt(magnitude);
  if (magnitude === 0) throw new Error("memory: cannot store a zero vector");
  const out = new Float32Array(vector.length);
  for (let i = 0; i < vector.length; i += 1) out[i] = vector[i] / magnitude;
  return out;
}

function dot(left, right) {
  let score = 0;
  for (let i = 0; i < left.length; i += 1) score += left[i] * right[i];
  return score;
}

function float32ToBase64(vector) {
  return Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength).toString("base64");
}

function base64ToFloat32(base64) {
  const buffer = Buffer.from(base64, "base64");
  if (buffer.length % 4 !== 0) throw new Error("memory: corrupt vector encoding");
  return new Float32Array(buffer.buffer, buffer.byteOffset, buffer.length / 4);
}

function decodeFile(raw) {
  const parsed = JSON.parse(raw);
  if (typeof parsed !== "object" || parsed === null || parsed.version !== FILE_VERSION) {
    throw new Error("memory: invalid vector store file");
  }
  const entries = {};
  for (const [id, entry] of Object.entries(parsed.entries ?? {})) {
    if (typeof entry !== "object" || entry === null || typeof entry.v !== "string") {
      throw new Error("memory: invalid vector store entry");
    }
    entries[id] = base64ToFloat32(entry.v);
  }
  const dimensions = parsed.dimensions;
  if (dimensions !== undefined && (!Number.isInteger(dimensions) || dimensions < 1)) {
    throw new Error("memory: invalid vector store dimensions");
  }
  return { version: FILE_VERSION, dimensions, entries };
}

function encodeFile(file) {
  return JSON.stringify(file);
}

function message(error) {
  return error instanceof Error ? error.message : String(error);
}
