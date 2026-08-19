/**
 * LLM-powered error analysis for the error-monitor plugin.
 *
 * When a tool call fails, this module sends the failure — tool name, error
 * kind, shell command, arguments, redacted error text, and the runtime
 * environment (platform, arch, node version, shell, cwd) — to the configured
 * LLM, which returns a JSON object:
 *
 *   { "analysis": "<actionable lesson>", "confidence": 0.0-1.0 }
 *
 * The error-monitor plugin only distills the analysis into long-term memory
 * when `confidence >= confidenceThreshold` (default 0.7). Everything sent to
 * the LLM is redacted first so credentials never leave the machine.
 *
 * Self-contained (no imports from other plugins) so tests can exercise it
 * directly.
 */

import { redactSecrets } from "./records.js";

const DEFAULT_MAX_TOKENS = 800;
const DEFAULT_ANALYSIS_CHARS = 500;
const DEFAULT_TIMEOUT_MS = 20000;
const DEFAULT_RETRY_COUNT = 2;
const DEFAULT_RETRY_BACKOFF_MS = 1500;

/** Build the runtime-environment block included in every analysis prompt. */
export function buildEnvironmentInfo(extra = {}) {
  return {
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    shell: process.platform === "win32" ? "cmd.exe" : process.env.SHELL ?? "unknown",
    cwd: process.cwd(),
    ...extra,
  };
}

/**
 * Build the LLM prompt for one failure. Sensitive values (command, args,
 * error text) are redacted before they are embedded.
 */
export function buildAnalysisPrompt({ record, environment, includeArgs = true, maxAnalysisChars = DEFAULT_ANALYSIS_CHARS }) {
  const safe = redactSecrets(record.detail || record.content || "");
  const argsText = includeArgs
    ? `\n- arguments: ${redactSecrets(safeJson(record.args)).slice(0, 600)}`
    : "";
  const envText = environment
    ? [
        "Runtime environment:",
        ...Object.entries(environment).map(([key, value]) => `- ${key}: ${value}`),
      ].join("\n")
    : "Runtime environment: unavailable";
  return [
    "A tool call failed. Diagnose it and produce a concise, actionable lesson",
    "that prevents the same failure from recurring. Be specific: name the",
    "correct fix (e.g. the right command, path style, argument, or workflow).",
    "",
    "Tool failure:",
    `- tool: ${record.tool}`,
    `- kind: ${record.kind}`,
    ...(record.command ? [`- command: ${redactSecrets(record.command)}`] : []),
    argsText,
    `- error:`,
    safe.slice(0, 1200),
    "",
    envText,
    "",
    "Reply with ONLY one JSON object (no markdown fences, no commentary):",
    `{"analysis": "<the lesson, at most ${maxAnalysisChars} chars, written in the same language as the error text>", "confidence": <number 0.0 to 1.0 — how sure you are that this analysis is correct and generally useful>}`,
  ].join("\n");
}

/** Parse the LLM's JSON reply into { analysis, confidence }, or undefined. */
export function parseAnalysisResult(raw) {
  if (typeof raw !== "string") return undefined;
  const text = raw.replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return undefined;
  let parsed;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return undefined;
  }
  const { analysis, confidence } = parsed ?? {};
  if (typeof analysis !== "string" || analysis.trim() === "") return undefined;
  if (typeof confidence !== "number" || !Number.isFinite(confidence)) return undefined;
  if (confidence < 0 || confidence > 1) return undefined;
  return { analysis: analysis.trim(), confidence };
}

/**
 * Run the analysis against the llm service. Never throws; returns
 * { status: "success", analysis, confidence } or { status: "error", reason }.
 */
export async function analyzeWithLlm({ llm, record, environment, config = {} }) {
  const prompt = buildAnalysisPrompt({
    record,
    environment,
    includeArgs: config.includeArgs ?? true,
    maxAnalysisChars: config.maxAnalysisChars ?? DEFAULT_ANALYSIS_CHARS,
  });
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const retryCount = config.retryCount ?? DEFAULT_RETRY_COUNT;
  const backoffMs = config.retryBackoffMs ?? DEFAULT_RETRY_BACKOFF_MS;
  let lastReason = "unknown";

  // Transient provider failures (empty replies, "Provider stream ended...",
  // timeouts) are common with streaming gateways — empirically an immediate
  // retry often lands in the same failure window, so retries wait with
  // exponential backoff (backoffMs, 2x backoffMs, ...) before giving up.
  for (let attempt = 0; attempt <= retryCount; attempt += 1) {
    if (attempt > 0) {
      await new Promise((resolve) => setTimeout(resolve, backoffMs * 2 ** (attempt - 1)));
    }
    let controller;
    let timer;
    try {
      if (timeoutMs > 0 && typeof AbortController !== "undefined") {
        controller = new AbortController();
        timer = setTimeout(() => controller.abort(), timeoutMs);
        timer.unref?.();
      }
      let text = "";
      const stream = llm.stream({
        ...(config.model ? { model: config.model } : {}),
        systemPrompt:
          "You are a concise diagnostic subsystem of a coding agent. Always reply in exactly the requested JSON format, with a realistic confidence score.",
        messages: [{ role: "user", content: prompt }],
        maxTokens: config.maxTokens ?? DEFAULT_MAX_TOKENS,
        // Reasoning models (e.g. deepseek-v4-flash) spend the whole token
        // budget on chain-of-thought and leave `content` empty — the strict
        // JSON answer needs no reasoning, so ask to skip it where supported.
        ...(config.thinking !== undefined ? { thinking: config.thinking } : { thinking: "disabled" }),
        ...(controller ? { signal: controller.signal } : {}),
      });
      for await (const event of stream) {
        if (event.type === "text_delta") text += event.text;
      }
      if (!text.trim()) {
        lastReason = "empty";
        continue; // retry
      }
      const parsed = parseAnalysisResult(text);
      if (!parsed) {
        lastReason = "unparseable";
        continue; // retry
      }
      return { status: "success", analysis: parsed.analysis, confidence: parsed.confidence };
    } catch (error) {
      // Preserve the real reason (e.g. "Provider stream ended...", timeout)
      // so the plugin can surface why no lesson was distilled.
      lastReason = error instanceof Error ? error.message : String(error);
      if (attempt < retryCount) continue; // retry
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  return { status: "error", reason: lastReason };
}

/**
 * Collect the text of a streaming LLM response, aborting after timeoutMs.
 * Returns undefined on failure, empty output, or timeout.
 */
export async function collectLlmText(llm, options, timeoutMs = DEFAULT_TIMEOUT_MS) {
  let controller;
  let timer;
  try {
    if (timeoutMs > 0 && typeof AbortController !== "undefined") {
      controller = new AbortController();
      timer = setTimeout(() => controller.abort(), timeoutMs);
      timer.unref?.();
    }
    let text = "";
    const stream = llm.stream({ ...options, ...(controller ? { signal: controller.signal } : {}) });
    for await (const event of stream) {
      if (event.type === "text_delta") text += event.text;
    }
    return text.trim() || undefined;
  } catch {
    return undefined;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function safeJson(value) {
  if (value === undefined) return "{}";
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
