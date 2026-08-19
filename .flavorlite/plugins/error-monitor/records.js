/**
 * Error-record store for the error-monitor plugin.
 *
 * Persists erroneous tool results under `<workspace>/.flavorlite/error-monitor/
 * records.json` with these guarantees:
 * - dedupe: a signature derived from (tool, kind, command, normalized error
 *   text) identifies "the same failure"; repeats only bump `count`/`lastAt`
 *   and never create a new record
 * - classification: shell exit/spawn/timeout, unknown tool, invalid
 *   arguments, network/link failures, file errors
 * - lesson distillation: every new failure becomes a bounded, actionable
 *   lesson (Windows shell hints included on win32)
 * - safety: secrets in stored detail/command are redacted; writes go through
 *   a temp-file rename so a crash never corrupts the log
 * - serialized mutations: concurrent tool results are applied one at a time
 *
 * This module is self-contained (no imports from other plugins) so tests can
 * exercise it directly.
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

export const RECORDS_VERSION = 1;
export const DEFAULT_MAX_RECORDS = 200;
export const DEFAULT_MAX_DETAIL_CHARS = 500;
export const DEFAULT_MAX_LESSON_CHARS = 560;

export const ERROR_KINDS = [
  "shell_exit",
  "shell_spawn",
  "shell_timeout",
  "tool_not_found",
  "tool_blocked",
  "invalid_args",
  "network",
  "file",
  "unknown",
];

/** Mask credential-like fragments before anything is persisted or sent out. */
export function redactSecrets(text) {
  return text
    .replace(/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/gi, "[REDACTED PRIVATE KEY]")
    // JSON/JS object style: "api_key": "value" — replace the whole key/value pair.
    .replace(/["'](?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|passwd)["']\s*:\s*["'][^"']*["']/gi, '"redacted_key": "[REDACTED]"')
    .replace(/(\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|passwd)\s*[:=]\s*)\S+/gi, "$1[REDACTED]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{12,}={0,2}\b/gi, "Bearer [REDACTED]")
    .replace(/\bsk-[A-Za-z0-9_-]{16,}\b/g, "sk-[REDACTED]");
}

/**
 * Classify an erroneous tool result. Shell failures are detected first
 * because cmd.exe messages (exit codes, "not recognized") would otherwise be
 * misread as generic file/network errors.
 */
export function classifyError(content) {
  if (/\[spawn error\]/.test(content)) return "shell_spawn";
  if (/\[killed after \d+ms timeout\]/.test(content)) return "shell_timeout";
  if (/\[exit code: \d+\]/.test(content)) return "shell_exit";
  if (/Tool ".*" not found\. Available tools:/.test(content)) return "tool_not_found";
  if (/was blocked by policy/.test(content)) return "tool_blocked";
  if (/missing required argument|invalid argument|failed to (?:parse|validate) arguments|must be a (?:string|number|boolean)|does not match (?:pattern|format)/i.test(content)) {
    return "invalid_args";
  }
  if (/fetch failed|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|socket hang up|network error|getaddrinfo|unable to connect|failed to fetch|timeout of \d+ms exceeded/i.test(content)) {
    return "network";
  }
  if (/\b(?:ENOENT|EACCES|EPERM|ENOTDIR|EISDIR|EEXIST|ENOSPC|EBUSY)\b|no such file or directory|permission denied|the system cannot find the file specified/i.test(content)) {
    return "file";
  }
  return "unknown";
}

/** First meaningful line of the error text (skips bracket-only markers). */
export function extractErrorLine(content) {
  const lines = content.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const stderrIndex = lines.findIndex((line) => line.toLowerCase() === "[stderr]");
  const source = stderrIndex >= 0 ? lines.slice(stderrIndex + 1) : lines;
  return source.find((line) => !/^\[.*\]$/.test(line)) ?? lines[0] ?? content;
}

/** Windows/cmd.exe-specific hints derived from the error text. */
export function windowsShellHints(content) {
  const hints = [];
  if (/(?:'[^']*'|"[^"]*") is not recognized as an internal or external command/i.test(content) || /\[exit code: 9009\]/.test(content)) {
    hints.push("The command was not found on PATH — use the full path or run 'where <command>' to locate it.");
  }
  if (/the system cannot find the file specified|no such file or directory|cannot find the path/i.test(content)) {
    hints.push("A referenced file or path does not exist — verify the path before retrying (forward slashes and escaped backslashes both work in cmd.exe).");
  }
  if (/'(?:[^']+)' is not recognized|not found as an internal/i.test(content)) {
    hints.push("On Windows the shell is cmd.exe: quote paths containing spaces with double quotes.");
  }
  return hints;
}

/**
 * Distill a bounded, actionable lesson from one failure. The text is derived
 * from the redacted error so nothing sensitive leaks into records or memory.
 */
export function buildLesson({ tool, kind, content, command, platform = process.platform }) {
  const safe = redactSecrets(content);
  const head = extractErrorLine(safe).slice(0, 200);
  const parts = [`Tool "${tool}" failed${command ? ` while running: ${command}` : ""}: ${head || "(no error text)"}.`];
  switch (kind) {
    case "shell_exit": {
      const exit = safe.match(/\[exit code: (\d+)\]/)?.[1];
      parts.push(`Shell exited non-zero (${exit ?? "?"}).`);
      if (platform === "win32") parts.push(...windowsShellHints(safe));
      parts.push("Fix the command or its inputs using the output above, then retry with a simpler, portable command.");
      break;
    }
    case "shell_spawn":
      parts.push("The process could not be started — the program may be missing, or the command line may be malformed.");
      if (platform === "win32") parts.push("On Windows verify the executable exists on PATH and quoting is valid for cmd.exe.");
      break;
    case "shell_timeout":
      parts.push("The command exceeded its timeout — pass a larger timeoutMs or split it into smaller steps.");
      break;
    case "tool_not_found":
      parts.push(`"${tool}" is not registered in this runtime — call only tools from the available-tools list.`);
      break;
    case "tool_blocked":
      parts.push("The call was rejected by policy — check the permission mode before retrying.");
      break;
    case "invalid_args":
      parts.push(`"${tool}" was called with missing or invalid arguments — re-read the tool's JSON schema and pass every required field with the correct type.`);
      break;
    case "network":
      parts.push("A network/link call failed — verify the URL, connectivity, and any required headers, proxy, or API key before retrying.");
      break;
    case "file":
      parts.push("A file operation failed — check that the path exists, is spelled correctly, and that permissions allow the operation.");
      break;
    default:
      parts.push("Inspect the error, correct the arguments or inputs, then retry.");
  }
  const lesson = parts.join(" ").replace(/\s+/g, " ").trim();
  return lesson.length > DEFAULT_MAX_LESSON_CHARS ? `${lesson.slice(0, DEFAULT_MAX_LESSON_CHARS - 3)}...` : lesson;
}

function normalizeText(text) {
  return String(text).normalize("NFKC").replace(/\s+/g, " ").trim().toLocaleLowerCase();
}

function errorSignature(tool, kind, command, content) {
  return [tool, kind, command ? normalizeText(command) : "", normalizeText(content).slice(0, 240)].join("\n");
}

function recordId(tool, kind, signature) {
  return createHash("sha256").update(`${tool}\0${kind}\0${signature}`, "utf8").digest("hex").slice(0, 12);
}

export class ErrorRecordStore {
  constructor(options) {
    const {
      workspace,
      logger,
      recordsDir = ".flavorlite/error-monitor",
      maxRecords = DEFAULT_MAX_RECORDS,
      maxDetailChars = DEFAULT_MAX_DETAIL_CHARS,
      maxLessonChars = DEFAULT_MAX_LESSON_CHARS,
      ignorePatterns = [],
      enabled = true,
    } = options;
    this.workspace = resolve(workspace);
    this.path = join(this.workspace, recordsDir, "records.json");
    this.logger = logger;
    this.maxRecords = maxRecords;
    this.maxDetailChars = maxDetailChars;
    this.maxLessonChars = maxLessonChars;
    this.ignore = ignorePatterns.map((source) => new RegExp(source, "i"));
    this.enabled = enabled;
    this.queue = Promise.resolve();
  }

  /**
   * Record an erroneous tool result. Returns { added, ignored, record }:
   * - added: true when a NEW record was created (a duplicate only bumps count)
   * - ignored: true when ignorePatterns matched and nothing was stored
   */
  async record({ tool, args = {}, result }) {
    if (!this.enabled) return { added: false, ignored: false, record: undefined };
    const content = typeof result?.content === "string" ? result.content : "";
    if (!content) return { added: false, ignored: false, record: undefined };
    if (this.ignore.some((pattern) => pattern.test(content))) return { added: false, ignored: true, record: undefined };

    const command = typeof args.command === "string" ? args.command : undefined;
    const kind = classifyError(content);
    const signature = errorSignature(tool, kind, command, content);
    const id = recordId(tool, kind, signature);
    const now = new Date().toISOString();
    const safe = redactSecrets(content);
    const detail = safe.replace(/\s+/g, " ").trim().slice(0, this.maxDetailChars);

    return this.#mutate(async (records) => {
      const existing = records.find((entry) => entry.id === id);
      if (existing) {
        existing.count += 1;
        existing.lastAt = now;
        return { records, added: false, ignored: false, record: existing };
      }
      const record = {
        id,
        tool,
        kind,
        signature,
        command: command ? redactSecrets(command).slice(0, 300) : undefined,
        detail,
        lesson: buildLesson({ tool, kind, content, command, platform: process.platform }).slice(0, this.maxLessonChars),
        count: 1,
        firstAt: now,
        lastAt: now,
      };
      records.push(record);
      if (records.length > this.maxRecords) {
        records.sort((left, right) => (left.lastAt < right.lastAt ? 1 : -1));
        records.length = this.maxRecords;
      }
      return { records, added: true, ignored: false, record };
    });
  }

  /** Attach an LLM analysis result (text + confidence) to an existing record. */
  async attachAnalysis(id, analysis, confidence) {
    return this.#mutate((records) => {
      const record = records.find((entry) => entry.id === id);
      if (!record) return { records, added: false, ignored: false, record: undefined };
      record.analysis = String(analysis).slice(0, this.maxLessonChars);
      record.confidence = Number.isFinite(confidence) ? Math.min(Math.max(confidence, 0), 1) : undefined;
      // A successful (re-)analysis supersedes any stale failure reason.
      delete record.analysisError;
      return { records, added: false, ignored: false, record };
    });
  }

  /**
   * Attach the reason an LLM analysis failed so `/errors` can show why no
   * lesson was distilled into memory (e.g. provider timeout, unparseable
   * reply, no llm service).
   */
  async attachAnalysisError(id, reason) {
    return this.#mutate((records) => {
      const record = records.find((entry) => entry.id === id);
      if (!record) return { records, added: false, ignored: false, record: undefined };
      record.analysisError = String(reason).slice(0, 300);
      return { records, added: false, ignored: false, record };
    });
  }

  /**
   * Attach the long-term-memory outcome of a distillation attempt so it is
   * inspectable via `/errors` even when the host logger is silent. Status is
   * "stored" or "skipped:<reason>" (low-confidence, duplicate, rejected,
   * analysis-failed, no-memory-service, ...).
   */
  async attachMemoryStatus(id, status) {
    return this.#mutate((records) => {
      const record = records.find((entry) => entry.id === id);
      if (!record) return { records, added: false, ignored: false, record: undefined };
      record.memoryStatus = String(status).slice(0, 300);
      return { records, added: false, ignored: false, record };
    });
  }

  /** All records, newest first. */
  async list() {
    const { records } = await this.#load();
    return [...records].sort((left, right) => (left.lastAt < right.lastAt ? 1 : -1));
  }

  /**
   * Latest lessons for the system-prompt section, bounded by count and
   * chars. An LLM analysis (when attached) leads over the rule-based
   * lesson: it is the distilled insight actually written to long-term
   * memory, so it is also what the model should see first.
   */
  async lessons(max = 4, maxChars = 1200) {
    const lines = [];
    let total = 0;
    for (const record of await this.list()) {
      const text = record.analysis || record.lesson;
      const line = `- [${record.tool} \u00b7 ${record.kind}${record.count > 1 ? ` \u00d7${record.count}` : ""}] ${text}`;
      if (total + line.length > maxChars) break;
      lines.push(line);
      total += line.length;
      if (lines.length >= max) break;
    }
    return lines;
  }

  /** Drop the on-disk log (long-term memory lessons are intentionally kept). */
  async clear() {
    await rm(this.path, { force: true });
    return true;
  }

  /** Serialize read-modify-write so parallel tool results never race. */
  #mutate(fn) {
    const run = async () => {
      const { records } = await this.#load();
      const outcome = await fn(records);
      await this.#save(outcome.records);
      return outcome;
    };
    const result = this.queue.then(run, run);
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }

  async #load() {
    try {
      const parsed = JSON.parse(await readFile(this.path, "utf-8"));
      if (parsed.version === RECORDS_VERSION && Array.isArray(parsed.records)) return { records: parsed.records };
    } catch {
      // missing or corrupt log: start empty
    }
    return { records: [] };
  }

  async #save(records) {
    await mkdir(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp-${process.pid}-${Date.now()}`;
    await writeFile(tmp, JSON.stringify({ version: RECORDS_VERSION, records }, null, 2), "utf-8");
    await rename(tmp, this.path);
  }
}
