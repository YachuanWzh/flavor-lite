// store.js — persistence for the evolve (recursive self-improvement) loop.
// Pure Node built-ins only so it runs in a disk plugin without flavor-lite deps.
//
// Layout under <cwd>/.flavorlite/evolve/:
//   signals.jsonl      aggregated tool-failure signals (deduped by fingerprint)
//   patterns.jsonl     recurring success-call trigrams (tool proposals)
//   reflections.jsonl  one line per agent run (loop/after-run)
//   rules.md           prompt rules distilled via evolve_improve kind=prompt_rule
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

/** Stable id for a tool-call sequence, so repeated trigrams coalesce. */
export function patternFingerprint(sequence) {
  return createHash("sha1").update(sequence.join("->")).digest("hex").slice(0, 12);
}

/** Value-free summary of tool args: only key names, never secrets. */
export function argKeys(args) {
  if (!args || typeof args !== "object") return [];
  return Object.keys(args).slice(0, 12);
}

export function classifySignal(error) {
  const text = normalizeError(error).toLocaleLowerCase();
  if (/\b(?:probe|deliberate|intentional|expected behavior)\b|nonexistent-command|process\.exit\(1\)/.test(text)) {
    return { kind: "intentional", actionable: false };
  }
  if (/timeout|timed out|econnreset|rate.?limit|temporar(?:y|ily)/.test(text)) {
    return { kind: "transient", actionable: true };
  }
  if (/blocked by policy|permission mode|escapes the workspace/.test(text)) {
    return { kind: "policy", actionable: true };
  }
  return { kind: "agent_or_product", actionable: true };
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

async function readJsonObject(file, fallback = {}) {
  try {
    const parsed = JSON.parse(await readFile(file, "utf-8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
}

export class EvolveStore {
  constructor({ cwd, maxSignals = 400, maxDetailChars = 300 } = {}) {
    this.dir = join(cwd, ".flavorlite", "evolve");
    this.signalsFile = join(this.dir, "signals.jsonl");
    this.patternsFile = join(this.dir, "patterns.jsonl");
    this.reflectionsFile = join(this.dir, "reflections.jsonl");
    this.rulesFile = join(this.dir, "rules.md");
    this.rulesDataFile = join(this.dir, "rules.json");
    this.doneFile = join(this.dir, "done.json");
    this.episodesFile = join(this.dir, "episodes.json");
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
  recordSignal({ tool, args, error, runId, sessionId }) {
    return this._enqueue(async () => {
      const id = fingerprint(tool, error);
      const message = String(error ?? "").trim().slice(0, this.maxDetailChars);
      const quality = classifySignal(error);
      const now = new Date().toISOString();
      const signals = await readJsonLines(this.signalsFile);
      const existing = signals.find((signal) => signal.id === id);
      if (existing) {
        existing.count = (existing.count ?? 1) + 1;
        existing.lastAt = now;
        existing.kind = quality.kind;
        existing.actionable = quality.actionable;
        if (runId) existing.lastRunId = runId;
        if (sessionId) existing.lastSessionId = sessionId;
        const runs = new Set(existing.runIds ?? []);
        if (runId) runs.add(runId);
        existing.runIds = [...runs].slice(-20);
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
        kind: quality.kind,
        actionable: quality.actionable,
        ...(runId ? { lastRunId: runId, runIds: [runId] } : {}),
        ...(sessionId ? { lastSessionId: sessionId } : {}),
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
      await rm(this.patternsFile, { force: true });
      await rm(this.doneFile, { force: true });
    });
  }

  /**
   * Record one recurring success-call trigram. Dedupes by sequence
   * fingerprint; callers dedupe within a run so counts grow across runs.
   */
  recordPattern({ sequence, signature, runId }) {
    return this._enqueue(async () => {
      const id = patternFingerprint(sequence);
      const now = new Date().toISOString();
      const patterns = await readJsonLines(this.patternsFile);
      const existing = patterns.find((pattern) => pattern.id === id);
      if (existing) {
        existing.count = (existing.count ?? 1) + 1;
        existing.lastAt = now;
        if (runId) existing.lastRunId = runId;
        await writeJsonLines(this.patternsFile, patterns);
        return { added: false, record: existing };
      }
      const record = {
        id,
        sequence: [...sequence],
        ...(signature ? { signature } : {}),
        ...(runId ? { lastRunId: runId } : {}),
        firstAt: now,
        lastAt: now,
        count: 1,
      };
      patterns.push(record);
      if (patterns.length > this.maxSignals) patterns.splice(0, patterns.length - this.maxSignals);
      await writeJsonLines(this.patternsFile, patterns);
      return { added: true, record };
    });
  }

  patterns() {
    return this._enqueue(async () => {
      const patterns = await readJsonLines(this.patternsFile);
      return patterns.sort((a, b) => (b.count ?? 1) - (a.count ?? 1) || String(b.lastAt).localeCompare(String(a.lastAt)));
    });
  }

  /** Read the distilled prompt rules; empty string when none exist. */
  readRules() {
    return this._enqueue(async () => {
      const data = await readJsonObject(this.rulesDataFile, { rules: [] });
      if (Array.isArray(data.rules) && data.rules.length > 0) {
        return data.rules
          .filter((rule) => rule?.active !== false && typeof rule?.text === "string")
          .sort((a, b) => String(b.updatedAt ?? b.createdAt).localeCompare(String(a.updatedAt ?? a.createdAt)))
          .slice(0, 12)
          .map((rule) => `- ${rule.text}`)
          .join("\n");
      }
      try {
        return await readFile(this.rulesFile, "utf-8");
      } catch {
        return "";
      }
    });
  }

  /** Append one rule line (deduped by exact normalized text). */
  appendRule(text, metadata = {}) {
    return this._enqueue(async () => {
      const line = String(text ?? "").replace(/\s+/g, " ").trim();
      if (!line) return undefined;
      const data = await readJsonObject(this.rulesDataFile, { version: 1, rules: [] });
      const rules = Array.isArray(data.rules) ? data.rules : [];
      const normalized = line.toLocaleLowerCase();
      let rule = rules.find((entry) => String(entry?.text ?? "").toLocaleLowerCase() === normalized);
      const now = new Date().toISOString();
      if (!rule) {
        rule = {
          id: createHash("sha1").update(line).digest("hex").slice(0, 12),
          text: line,
          active: true,
          confidence: Number.isFinite(metadata.confidence) ? metadata.confidence : 0.5,
          hits: 0,
          helpful: 0,
          harmful: 0,
          createdAt: now,
          updatedAt: now,
          ...(metadata.sourceId ? { sourceId: metadata.sourceId } : {}),
          ...(metadata.scope ? { scope: metadata.scope } : {}),
        };
        rules.push(rule);
      } else {
        rule.active = true;
        rule.updatedAt = now;
      }
      await mkdir(this.dir, { recursive: true });
      await writeFile(this.rulesDataFile, `${JSON.stringify({ version: 1, rules }, null, 2)}\n`, "utf-8");
      await writeFile(this.rulesFile, `${rules.filter((entry) => entry.active !== false).map((entry) => `- ${entry.text}`).join("\n")}\n`, "utf-8");
      return rule;
    });
  }

  updateRule(id, patch) {
    return this._enqueue(async () => {
      const data = await readJsonObject(this.rulesDataFile, { version: 1, rules: [] });
      const rules = Array.isArray(data.rules) ? data.rules : [];
      const rule = rules.find((entry) => entry?.id === id);
      if (!rule) return undefined;
      Object.assign(rule, patch, { updatedAt: new Date().toISOString() });
      await writeFile(this.rulesDataFile, `${JSON.stringify({ version: 1, rules }, null, 2)}\n`, "utf-8");
      await writeFile(this.rulesFile, `${rules.filter((entry) => entry.active !== false).map((entry) => `- ${entry.text}`).join("\n")}\n`, "utf-8");
      return rule;
    });
  }

  /** Aggregate open tool proposals from recurring success trigrams. */
  openPatternSuggestions({ threshold = 3, limit = 8 } = {}) {
    return this._enqueue(async () => {
      const patterns = await readJsonLines(this.patternsFile);
      const done = new Set(await readJsonArray(this.doneFile));
      const episodeData = await readJsonObject(this.episodesFile, { episodes: [] });
      const active = new Set((episodeData.episodes ?? []).filter((episode) => ["implemented", "verified", "canary"].includes(episode.status)).map((episode) => episode.suggestionId));
      return patterns
        .filter((pattern) => (pattern.count ?? 1) >= threshold && !done.has(pattern.id) && !active.has(pattern.id))
        .sort((a, b) => (b.count ?? 1) - (a.count ?? 1) || String(b.lastAt).localeCompare(String(a.lastAt)))
        .slice(0, limit)
        .map((pattern) => ({
          id: pattern.id,
          kind: "tool",
          sequence: pattern.sequence,
          count: pattern.count,
          hint: `The tool sequence "${pattern.sequence.join("->")}" recurred ${pattern.count} times across runs. Consider packaging it as one tool or command.`,
        }));
    });
  }

  appendReflection({ runId, sessionId, iterations, reason, outcome, signalDelta, failedTools, toolCalls, toolErrors, steers, totalFailures, failureRate }) {
    return this._enqueue(async () => {
      await mkdir(this.dir, { recursive: true });
      const record = {
        at: new Date().toISOString(),
        ...(runId ? { runId } : {}),
        ...(sessionId ? { sessionId } : {}),
        iterations,
        reason,
        ...(outcome ? { outcome } : {}),
        // Run stats from the loop/after-run payload (absent pre-extension).
        toolCalls: toolCalls ?? 0,
        toolErrors: toolErrors ?? 0,
        runFailures: toolErrors ?? 0,
        failureRate: failureRate ?? ((toolCalls ?? 0) > 0 ? (toolErrors ?? 0) / toolCalls : 0),
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
      const episodeData = await readJsonObject(this.episodesFile, { episodes: [] });
      const active = new Set((episodeData.episodes ?? []).filter((episode) => ["implemented", "verified", "canary"].includes(episode.status)).map((episode) => episode.suggestionId));
      const suggestions = signals
        .filter((signal) => {
          const repeats = Array.isArray(signal.runIds) && signal.runIds.length > 0 ? signal.runIds.length : (signal.count ?? 1);
          return repeats >= threshold && signal.actionable !== false && !done.has(signal.id) && !active.has(signal.id);
        })
        .sort((a, b) => (b.count ?? 1) - (a.count ?? 1) || String(b.lastAt).localeCompare(String(a.lastAt)))
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

  /** Raw done-marker ids (failure fingerprints, pattern ids, em:<record> ids). */
  readDoneIds() {
    return this._enqueue(async () => readJsonArray(this.doneFile));
  }

  beginEpisode({ suggestionId, kind, implementation, pluginName, source }) {
    return this._enqueue(async () => {
      await mkdir(this.dir, { recursive: true });
      const data = await readJsonObject(this.episodesFile, { version: 1, episodes: [] });
      const episodes = Array.isArray(data.episodes) ? data.episodes : [];
      const now = new Date().toISOString();
      let episode = episodes.find((entry) => entry.suggestionId === suggestionId && !["accepted", "rejected", "rolled_back"].includes(entry.status));
      if (!episode) {
        episode = {
          id: createHash("sha1").update(`${suggestionId}:${now}`).digest("hex").slice(0, 12),
          suggestionId,
          status: "implemented",
          kind,
          implementation,
          ...(pluginName ? { pluginName } : {}),
          ...(source ? { source } : {}),
          createdAt: now,
          updatedAt: now,
          history: [{ status: "implemented", at: now }],
        };
        episodes.push(episode);
      }
      await writeFile(this.episodesFile, `${JSON.stringify({ version: 1, episodes }, null, 2)}\n`, "utf-8");
      return episode;
    });
  }

  updateEpisode(idOrSuggestionId, status, detail = {}) {
    return this._enqueue(async () => {
      const data = await readJsonObject(this.episodesFile, { version: 1, episodes: [] });
      const episodes = Array.isArray(data.episodes) ? data.episodes : [];
      const episode = [...episodes].reverse().find((entry) => entry.id === idOrSuggestionId || entry.suggestionId === idOrSuggestionId);
      if (!episode) return undefined;
      const now = new Date().toISOString();
      episode.status = status;
      episode.updatedAt = now;
      Object.assign(episode, detail);
      episode.history = [...(episode.history ?? []), { status, at: now, ...detail }].slice(-30);
      await writeFile(this.episodesFile, `${JSON.stringify({ version: 1, episodes }, null, 2)}\n`, "utf-8");
      if (status === "accepted") {
        const done = await readJsonArray(this.doneFile);
        if (!done.includes(episode.suggestionId)) {
          done.push(episode.suggestionId);
          await writeFile(this.doneFile, JSON.stringify(done, null, 2), "utf-8");
        }
      }
      return episode;
    });
  }

  episodes(limit = 20) {
    return this._enqueue(async () => {
      const data = await readJsonObject(this.episodesFile, { episodes: [] });
      return (Array.isArray(data.episodes) ? data.episodes : []).slice(-limit).reverse();
    });
  }

  activeSuggestionIds() {
    return this._enqueue(async () => {
      const data = await readJsonObject(this.episodesFile, { episodes: [] });
      return (Array.isArray(data.episodes) ? data.episodes : [])
        .filter((episode) => ["implemented", "verified", "canary"].includes(episode.status))
        .map((episode) => episode.suggestionId);
    });
  }
}
