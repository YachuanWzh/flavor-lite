// store.js — persistence for the evolve (recursive self-improvement) loop.
// Pure Node built-ins only so it runs in a disk plugin without flavor-lite deps.
//
// Layout under <cwd>/.flavorlite/evolve/:
//   signals.jsonl      aggregated tool-failure signals (deduped by fingerprint)
//   reflections.jsonl  one line per agent run (loop/after-run)
//   done.json          suggestion ids the operator/model already acted on

import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export function normalizeError(message) {
  return String(message ?? "")
    .replace(/\s+/g, " ")
    .replace(/"[^"]*"/g, '"…"')
    .replace(/`[^`]*`/g, "`…`")
    .trim()
    .slice(0, 160);
}

/** Stable id for a (tool, error) pair, so repeated failures coalesce. */
export function fingerprint(tool, error) {
  return createHash("sha1").update(`${tool}::${normalizeError(error)}`).digest("hex").slice(0, 12);
}

/** Value-free summary of tool args: only key names, never secrets. */
export function argKeys(args) {
  if (!args || typeof args !== "object") return [];
  return Object.keys(args).slice(0, 12);
}

async function readJsonLines(file) {
  try {
    const text = await readFile(file, "utf-8");
    const records = [];
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        records.push(JSON.parse(trimmed));
      } catch {
        // skip corrupt lines; the store stays readable
      }
    }
    return records;
  } catch {
    return [];
  }
}

async function writeJsonLines(file, records) {
  await mkdir(dirname(file), { recursive: true });
  const body = records.map((record) => JSON.stringify(record)).join("\n");
  await writeFile(file, body ? `${body}\n` : "", "utf-8");
}

async function readJsonArray(file) {
  try {
    const parsed = JSON.parse(await readFile(file, "utf-8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export class EvolveStore {
  constructor({ cwd, maxSignals = 400, maxDetailChars = 300 } = {}) {
    this.dir = join(cwd, ".flavorlite", "evolve");
    this.signalsFile = join(this.dir, "signals.jsonl");
    this.reflectionsFile = join(this.dir, "reflections.jsonl");
    this.doneFile = join(this.dir, "done.json");
    this.maxSignals = maxSignals;
    this.maxDetailChars = maxDetailChars;
    // Serialize file mutations: tool hooks may fire in bursts.
    this.queue = Promise.resolve();
  }

  _enqueue(operation) {
    this.queue = this.queue.then(operation, operation);
    return this.queue;
  }

  /**
   * Record one failed tool call. Dedupes by (tool, normalized error):
   * existing entries get count/lastAt bumped instead of growing unbounded.
   */
  recordSignal({ tool, args, error }) {
    return this._enqueue(async () => {
      const id = fingerprint(tool, error);
      const message = String(error ?? "").trim().slice(0, this.maxDetailChars);
      const now = new Date().toISOString();
      const signals = await readJsonLines(this.signalsFile);
      const existing = signals.find((signal) => signal.id === id);
      if (existing) {
        existing.count = (existing.count ?? 1) + 1;
        existing.lastAt = now;
        await writeJsonLines(this.signalsFile, signals);
        return { added: false, record: existing };
      }
      const record = {
        id,
        tool,
        error: message,
        args: argKeys(args),
        firstAt: now,
        lastAt: now,
        count: 1,
      };
      signals.push(record);
      // Keep the file bounded: drop the oldest signals beyond maxSignals.
      if (signals.length > this.maxSignals) signals.splice(0, signals.length - this.maxSignals);
      await writeJsonLines(this.signalsFile, signals);
      return { added: true, record };
    });
  }

  signals() {
    return this._enqueue(async () => {
      const signals = await readJsonLines(this.signalsFile);
      return signals.sort((a, b) => (b.count ?? 1) - (a.count ?? 1) || String(b.lastAt).localeCompare(String(a.lastAt)));
    });
  }

  clearSignals() {
    return this._enqueue(async () => {
      await rm(this.signalsFile, { force: true });
      await rm(this.doneFile, { force: true });
    });
  }

  appendReflection({ iterations, reason, signalDelta, failedTools, toolCalls, toolErrors, steers, totalFailures }) {
    return this._enqueue(async () => {
      await mkdir(this.dir, { recursive: true });
      const record = {
        at: new Date().toISOString(),
        iterations,
        reason,
        // Run stats from the loop/after-run payload (absent pre-extension).
        toolCalls: toolCalls ?? 0,
        toolErrors: toolErrors ?? 0,
        steers: steers ?? 0,
        // Total failure occurrences across all signals at run end; the delta
        // against the previous reflection measures whether improvement stuck.
        totalFailures: totalFailures ?? 0,
        signalDelta: signalDelta ?? 0,
        failedTools: [...(failedTools ?? [])].sort(),
      };
      await appendFile(this.reflectionsFile, `${JSON.stringify(record)}\n`, "utf-8");
      return record;
    });
  }

  reflections(limit = 5) {
    return this._enqueue(async () => {
      const records = await readJsonLines(this.reflectionsFile);
      return records.slice(-limit).reverse();
    });
  }

  /** Aggregate open suggestions from repeated failure signals. */
  openSuggestions({ threshold = 2, limit = 8 } = {}) {
    return this._enqueue(async () => {
      const signals = await readJsonLines(this.signalsFile);
      const done = new Set(await readJsonArray(this.doneFile));
      const suggestions = signals
        .filter((signal) => (signal.count ?? 1) >= threshold && !done.has(signal.id))
        .slice(0, limit)
        .map((signal) => ({
          id: signal.id,
          tool: signal.tool,
          count: signal.count,
          error: signal.error,
          hint: `Repeated failure on tool "${signal.tool}" (${signal.count}x). Consider a plugin, memory rule, or prompt tweak to fix it.`,
        }));
      return suggestions;
    });
  }

  markSuggestionDone(id) {
    return this._enqueue(async () => {
      await mkdir(this.dir, { recursive: true });
      const done = await readJsonArray(this.doneFile);
      if (!done.includes(id)) {
        done.push(id);
        await writeFile(this.doneFile, JSON.stringify(done, null, 2), "utf-8");
      }
    });
  }
}
