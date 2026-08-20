// hallucination-detector — pure analysis engine (no IO, no kernel imports).
//
// Design follows the full-lifecycle attribution model: an agent run is a
// perceive → plan → act → reflect closed loop, so hallucination findings are
// attributed to a lifecycle STAGE instead of only judging the final answer:
//
//   input-planning    user request vs what was actually done (LLM judge)
//   tool-execution    repeat-window loops, flip-flop edits, misread results
//   reasoning         self-contradicting statements across the run
//   memory-state      compaction decay, mid-run steering drift
//   process           redundant exploration, dead-end check chains
//   output-grounding  claims (files, commands) without evidence in the trace
//
// Every function here is synchronous and side-effect free so tests can pin
// each rule individually.

import { createHash } from "node:crypto";

export const SEVERITY_WEIGHT = { low: 1, medium: 3, high: 8 };
export const STAGES = [
  "input-planning",
  "tool-execution",
  "reasoning",
  "memory-state",
  "process",
  "output-grounding",
];

export const DEFAULT_REPEAT = { windowSize: 20, threshold: 10 };

/* ------------------------------------------------------------------ */
/* Call hashing: tool name + recursively key-sorted args              */
/* ------------------------------------------------------------------ */

/** Recursively sort object keys so semantically equal args hash equally. */
export function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    const sorted = {};
    for (const key of Object.keys(value).sort()) sorted[key] = canonicalize(value[key]);
    return sorted;
  }
  return value;
}

/**
 * Identity hash of one tool call: the tool name joined with the
 * canonicalized args, hashed with sha1. Same tool + same args ⇒ same hash
 * regardless of argument key order.
 */
export function toolCallHash(toolCall) {
  const canonical = JSON.stringify(canonicalize(toolCall.args ?? {}));
  return createHash("sha1").update(`${toolCall.name}|${canonical}`).digest("hex");
}

/* ------------------------------------------------------------------ */
/* Repeat-window detection (the core "stuck loop" signal)             */
/* ------------------------------------------------------------------ */

/**
 * Slide a window over the call sequence; flag every hash that reaches the
 * threshold inside some window. Returns the maximum in-window count.
 *
 * @param {string[]} hashes identity hash per call, in order
 * @param {{windowSize?: number, threshold?: number}} config
 */
export function detectRepeatWindows(hashes, config = {}) {
  const { windowSize, threshold } = { ...DEFAULT_REPEAT, ...config };
  if (windowSize <= 0 || threshold <= 0) return [];

  const hits = new Map(); // hash -> max count seen inside any window
  const counts = new Map(); // hash -> count inside the current window
  for (let index = 0; index < hashes.length; index += 1) {
    const hash = hashes[index];
    counts.set(hash, (counts.get(hash) ?? 0) + 1);
    if (index >= windowSize) {
      const leaving = hashes[index - windowSize];
      const remaining = (counts.get(leaving) ?? 1) - 1;
      if (remaining <= 0) counts.delete(leaving);
      else counts.set(leaving, remaining);
    }
    const inWindow = counts.get(hash) ?? 0;
    if (inWindow >= threshold) {
      hits.set(hash, Math.max(hits.get(hash) ?? 0, inWindow));
    }
  }
  return [...hits.entries()].map(([hash, count]) => ({ hash, count }));
}

/* ------------------------------------------------------------------ */
/* Trace extraction from the session transcript                       */
/* ------------------------------------------------------------------ */

const EDIT_TOOLS = new Set(["Write", "Edit", "ApplyPatch"]);
const READ_TOOLS = new Set(["Read", "Glob", "Grep", "LS"]);
/** Result bodies that mean "nothing was found" but are not errors. */
const EMPTY_RESULT_PATTERN = /^no (matches|files matched|results|entries)\b/i;

/**
 * Rebuild the run trace from the model-visible session messages.
 * Pairs each assistant toolCall with its following tool result, remembers
 * event order (needed for "misread result" and contradiction checks), and
 * counts steering messages / compaction markers.
 *
 * @param {Array<object>} messages
 */
export function extractTrace(messages) {
  const userRequests = [];
  const toolTrace = []; // {toolCall, result, isError, hash}
  const assistantTexts = [];
  // Interleaved event stream keeps temporal order for causal rules.
  const events = []; // {kind: "tool"|"text", index}
  const results = new Map();
  let steeringCount = 0;
  let compacted = false;
  let finalAnswer = "";

  for (const message of messages) {
    if (message.role === "user") {
      const content = typeof message.content === "string" ? message.content : "";
      if (content.startsWith("[steering]")) steeringCount += 1;
      else if (content.includes("was compacted to fit the context window")) compacted = true;
      else if (!content.startsWith("[system]")) userRequests.push(content);
    } else if (message.role === "tool") {
      results.set(message.toolCallId, {
        content: typeof message.content === "string" ? message.content : "",
        isError: message.isError === true,
      });
    } else if (message.role === "assistant") {
      const text = typeof message.content === "string" ? message.content : "";
      if (text.trim()) {
        assistantTexts.push(text);
        events.push({ kind: "text", index: assistantTexts.length - 1 });
      }
      if (Array.isArray(message.toolCalls) && message.toolCalls.length > 0) {
        for (const toolCall of message.toolCalls) {
          toolTrace.push({ toolCall, result: "", isError: false, hash: toolCallHash(toolCall) });
          events.push({ kind: "tool", index: toolTrace.length - 1 });
        }
      } else if (text.trim()) {
        finalAnswer = text;
      }
    }
  }
  for (const entry of toolTrace) {
    const result = results.get(entry.toolCall.id);
    if (result) {
      entry.result = result.content;
      entry.isError = result.isError;
    }
  }
  return { userRequests, toolTrace, assistantTexts, events, steeringCount, compacted, finalAnswer };
}

function isEmptyResult(entry) {
  return !entry.isError && EMPTY_RESULT_PATTERN.test(entry.result.trim());
}

function isFailed(entry) {
  return entry.isError || isEmptyResult(entry);
}

/* ------------------------------------------------------------------ */
/* Tool-execution dimension                                           */
/* ------------------------------------------------------------------ */

/** Edit/Write calls whose target file alternates content A→B→A→… (flip-flop). */
export function detectFlipFlopEdits(trace) {
  const lastContent = new Map(); // path -> last written content
  const flips = new Map(); // path -> flip count

  for (const entry of trace.toolTrace) {
    if (!EDIT_TOOLS.has(entry.toolCall.name)) continue;
    const path = typeof entry.toolCall.args?.path === "string" ? entry.toolCall.args.path : "";
    if (!path) continue;
    const content =
      entry.toolCall.name === "Write"
        ? String(entry.toolCall.args?.content ?? "")
        : String(entry.toolCall.args?.newText ?? "");
    const previous = lastContent.get(path);
    if (previous !== undefined && previous !== content) {
      flips.set(path, (flips.get(path) ?? 0) + 1);
    }
    lastContent.set(path, content);
  }

  return [...flips.entries()]
    .filter(([, count]) => count >= 2)
    .map(([path, count]) => ({
      rule: "flip-flop-edit",
      severity: "medium",
      stage: "tool-execution",
      message: `File "${path}" was rewritten ${count + 1} times with different content — oscillating decisions or failed self-correction.`,
      data: { path, flips: count },
    }));
}

/** An error/empty result followed by the exact same call again, verbatim. */
export function detectIgnoredFailures(trace) {
  const findings = [];
  const lastIndex = new Map();
  const reported = new Set();

  trace.toolTrace.forEach((entry, index) => {
    const previous = lastIndex.get(entry.hash);
    if (previous !== undefined && isFailed(entry)) {
      const earlier = trace.toolTrace[previous];
      if (isFailed(earlier) && !reported.has(entry.hash)) {
        reported.add(entry.hash);
        findings.push({
          rule: "failure-ignored",
          severity: "medium",
          stage: "tool-execution",
          message: `Tool "${entry.toolCall.name}" returned ${earlier.isError ? "an error" : "an empty result"} and was retried verbatim — the failure may have been misread or ignored.`,
          data: { hash: entry.hash, tool: entry.toolCall.name },
        });
      }
    }
    lastIndex.set(entry.hash, index);
  });
  return findings;
}

/**
 * The assistant claims success for a tool whose actual result is a failure
 * or empty ("execution state hallucination"). Only texts AFTER the call are
 * considered, so earlier planning prose never triggers this.
 */
export function detectResultMisread(trace) {
  const successPhrase = /\b(?:succeeded|successful|completed|done|passed|已完成|成功)\b/i;
  const failureWords = [/not found/i, /no such file/i, /does not exist/i, /permission denied/i, /error:/i, /missing/i];
  const findings = [];
  const reported = new Set();

  for (const event of trace.events) {
    if (event.kind !== "text") continue;
    const text = trace.assistantTexts[event.index];
    if (!successPhrase.test(text)) continue;
    // Look back at tool calls that happened before this statement.
    for (const prior of trace.events) {
      if (prior === event) break;
      if (prior.kind !== "tool") continue;
      const entry = trace.toolTrace[prior.index];
      const failedBadly =
        (entry.isError && failureWords.some((pattern) => pattern.test(entry.result))) || isEmptyResult(entry);
      if (!failedBadly) continue;
      if (!text.includes(entry.toolCall.name)) continue;
      if (reported.has(entry.hash)) continue;
      reported.add(entry.hash);
      findings.push({
        rule: "result-misread",
        severity: "high",
        stage: "tool-execution",
        message: `The assistant claims "${entry.toolCall.name}" succeeded, but its result indicates failure or emptiness: ${truncate(entry.result, 120)}`,
        data: { hash: entry.hash, tool: entry.toolCall.name },
      });
    }
  }
  return findings;
}

/* ------------------------------------------------------------------ */
/* Reasoning dimension                                                */
/* ------------------------------------------------------------------ */

function escapeRegex(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Contradiction patterns: a negative claim captured early, and a builder for
 * the positive regex that must appear later. The positive regex is built
 * dynamically because a `\1` backreference cannot span two separate RegExp
 * literals. Captured phrases only contain word chars, spaces and hyphens,
 * so escaping is belt-and-braces.
 */
const CONTRADICTION_PATTERNS = [
  {
    negative: /\b(?:cannot|can't)\s+([a-z][\w -]{2,40})\b/i,
    // Allows one intervening verb ("have found X", "has located X").
    positive: (phrase) => new RegExp(`\\b(?:have|has)\\s+(?:[a-z]+\\s+)?${escapeRegex(phrase)}\\b`, "i"),
  },
  {
    negative: /\bthere (?:is|are) no ([a-z][\w -]{1,40})\b/i,
    positive: (phrase) => new RegExp(`\\bfound (?:the\\s|a\\s|\\d+\\s+)?${escapeRegex(phrase)}\\b`, "i"),
  },
];

/** Lexical check for self-contradicting statements across the run. */
export function detectContradictions(trace) {
  const texts = [...trace.assistantTexts];
  if (trace.finalAnswer.trim() && texts[texts.length - 1] !== trace.finalAnswer) {
    texts.push(trace.finalAnswer);
  }
  if (texts.length < 2) return [];

  const findings = [];
  const reported = new Set();
  for (let i = 0; i < texts.length - 1; i += 1) {
    for (const pattern of CONTRADICTION_PATTERNS) {
      const negated = texts[i].match(pattern.negative);
      if (!negated || reported.has(negated[0])) continue;
      const positive = pattern.positive(negated[1]);
      for (let j = i + 1; j < texts.length; j += 1) {
        if (positive.test(texts[j])) {
          reported.add(negated[0]);
          findings.push({
            rule: "contradiction",
            severity: "medium",
            stage: "reasoning",
            message: `Statement "${truncate(negated[0], 80)}" is contradicted later in the run — possible broken self-correction.`,
            data: { phrase: negated[0] },
          });
          break;
        }
      }
    }
  }
  return findings;
}

/* ------------------------------------------------------------------ */
/* Memory & state dimension                                           */
/* ------------------------------------------------------------------ */

export function detectMemoryRisks(trace) {
  const findings = [];
  if (trace.compacted) {
    findings.push({
      rule: "context-compacted",
      severity: "medium",
      stage: "memory-state",
      message:
        "The conversation was compacted during this run; early constraints may have decayed — verify the final output still respects the original request.",
      data: { compaction: true },
    });
  }
  if (trace.steeringCount > 0) {
    findings.push({
      rule: "steering-required",
      severity: "low",
      stage: "memory-state",
      message: `${trace.steeringCount} steering message(s) were needed mid-run, suggesting the first interpretation of the request drifted.`,
      data: { steeringCount: trace.steeringCount },
    });
  }
  return findings;
}

/* ------------------------------------------------------------------ */
/* Process dimension                                                  */
/* ------------------------------------------------------------------ */

/**
 * Redundant exploration: the same read-only lookup issued 3+ times with no
 * non-read call in between — spinning instead of progressing.
 */
export function detectRedundantExploration(trace) {
  const findings = [];
  const runLength = new Map();

  const flush = () => {
    for (const [hash, run] of runLength) {
      if (run < 3) continue;
      const entry = trace.toolTrace.find((item) => item.hash === hash);
      if (!entry) continue;
      findings.push({
        rule: "redundant-exploration",
        severity: "low",
        stage: "process",
        message: `Identical read-only call "${entry.toolCall.name}" issued ${run} times in a row with no progress in between.`,
        data: { hash, tool: entry.toolCall.name, run },
      });
    }
    runLength.clear();
  };

  for (const entry of trace.toolTrace) {
    if (READ_TOOLS.has(entry.toolCall.name)) {
      runLength.set(entry.hash, (runLength.get(entry.hash) ?? 0) + 1);
    } else {
      flush();
    }
  }
  flush();
  return findings;
}

/** A successful read immediately followed by a failing call (abnormal chain). */
export function detectDeadEndChains(trace) {
  const findings = [];
  for (let index = 0; index < trace.toolTrace.length - 1; index += 1) {
    const entry = trace.toolTrace[index];
    const next = trace.toolTrace[index + 1];
    if (!READ_TOOLS.has(entry.toolCall.name) || entry.isError || !next.isError) continue;
    findings.push({
      rule: "dead-end-chain",
      severity: "low",
      stage: "process",
      message: `Read "${entry.toolCall.name}" was immediately followed by a failing call — the evidence may not have informed the action.`,
      data: { hash: entry.hash, tool: entry.toolCall.name },
    });
  }
  return findings;
}

/* ------------------------------------------------------------------ */
/* Output-grounding dimension                                         */
/* ------------------------------------------------------------------ */

/** Files mentioned in the text (extension-bearing tokens or slash paths). */
export function extractMentionedFiles(text) {
  const candidates = text.match(/[\w.\\/-]+\.[a-zA-Z]{1,8}\b|\b[\w.-]+(?:\/[\w.-]+)+\b/g) ?? [];
  const files = new Set();
  for (const candidate of candidates) {
    if (/^\d+(\.\d+)*$/.test(candidate)) continue;
    if (/^(e\.g|i\.e|etc|vs)$/i.test(candidate)) continue;
    files.add(candidate.toLowerCase());
  }
  return [...files];
}

/** Commands claimed as executed: fenced shell blocks or "ran/run X". */
export function extractMentionedCommands(text) {
  const commands = new Set();
  const fenced = text.match(/```(?:bash|sh|shell|console|terminal)?\n([\s\S]*?)```/gi) ?? [];
  for (const block of fenced) {
    const body = block.replace(/```[a-z]*\n?/gi, "").replace(/```/g, "");
    for (const line of body.split("\n")) {
      const trimmed = line.trim().replace(/^\$\s*/, "");
      if (trimmed) commands.add(trimmed);
    }
  }
  const inline =
    text.match(/\b(?:ran|run|executed)\s+(?:`([^`]+)`|\b(npm|npx|node|git|cargo|go|python|pytest|make|docker)\b[^\n.,;]{0,60})/gi) ??
    [];
  for (const phrase of inline) {
    commands.add(phrase.replace(/^\w+\s+/, "").replace(/`/g, "").trim());
  }
  return [...commands];
}

/**
 * Grounding check: every file/command mentioned in the final answer must
 * have supporting evidence in the run trace (tool args or results).
 */
export function detectUngroundedClaims(trace) {
  if (!trace.finalAnswer.trim()) return [];
  const findings = [];

  const evidence = trace.toolTrace
    .map((entry) => `${JSON.stringify(entry.toolCall.args ?? {})}\n${entry.result}`)
    .join("\n")
    .toLowerCase();

  for (const file of extractMentionedFiles(trace.finalAnswer)) {
    const shortName = file.split(/[\\/]/).pop() ?? file;
    if (!evidence.includes(file) && !evidence.includes(shortName)) {
      findings.push({
        rule: "ungrounded-file",
        severity: "high",
        stage: "output-grounding",
        message: `Final answer mentions "${file}" but no tool call or result in this run references it — possible fabricated reference.`,
        data: { claim: file },
      });
    }
  }

  for (const command of extractMentionedCommands(trace.finalAnswer)) {
    const shellEvidence = trace.toolTrace.some(
      (entry) =>
        entry.toolCall.name === "Shell" &&
        JSON.stringify(entry.toolCall.args ?? {}).toLowerCase().includes(command.toLowerCase()),
    );
    if (!shellEvidence) {
      findings.push({
        rule: "ungrounded-command",
        severity: "medium",
        stage: "output-grounding",
        message: `Final answer claims to run \`${command}\` but no Shell call in this run executed it — possible fabricated execution.`,
        data: { claim: command },
      });
    }
  }
  return findings;
}

/* ------------------------------------------------------------------ */
/* LLM judge (intent alignment) — prompt building & reply parsing     */
/* ------------------------------------------------------------------ */

/** Build the strict-JSON judge prompt from the trace (bounded). */
export function buildJudgePrompt(trace, maxChars = 4000) {
  const request = trace.userRequests.join("\n---\n").slice(0, maxChars) || "(no user request captured)";
  const evidence = trace.toolTrace
    .map((entry) => `- ${entry.toolCall.name}(${truncate(JSON.stringify(entry.toolCall.args ?? {}), 160)}) → ${entry.isError ? "ERROR: " : isEmptyResult(entry) ? "EMPTY: " : ""}${truncate(entry.result, 160)}`)
    .join("\n")
    .slice(0, maxChars);
  const answer = trace.finalAnswer.slice(0, maxChars) || "(no final answer)";

  return [
    "You audit a coding agent's finished run for hallucination and intent drift.",
    "Judge ONLY from the evidence below; do not assume anything not shown.",
    "",
    `[USER REQUEST]\n${request}`,
    "",
    `[TOOL EVIDENCE]\n${evidence || "(no tool calls)"}`,
    "",
    `[FINAL ANSWER]\n${answer}`,
    "",
    "Reply with STRICT JSON only, no prose:",
    '{"aligned": true|false, "score": 0-5, "issues": [{"stage": "input-planning|tool-execution|reasoning|memory-state|process|output-grounding", "severity": "low|medium|high", "message": "<short>"}]}',
    "score = how well the run satisfied the user request (5 = fully). issues list every hallucination or drift you can prove from the evidence.",
  ].join("\n");
}

/** Parse the judge reply; tolerates code fences and prose around the JSON. */
export function parseJudgeReply(raw) {
  const fenced = String(raw ?? "").match(/```(?:json)?\s*([\s\S]*?)```/);
  const text = (fenced ? fenced[1] : String(raw ?? "")).trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) return undefined;
  let reply;
  try {
    reply = JSON.parse(text.slice(start, end + 1));
  } catch {
    return undefined;
  }
  if (typeof reply !== "object" || reply === null) return undefined;
  const score = Number(reply.score);
  const issues = Array.isArray(reply.issues)
    ? reply.issues
        .filter((issue) => issue && typeof issue.message === "string")
        .map((issue) => ({
          stage: STAGES.includes(issue.stage) ? issue.stage : "input-planning",
          severity: ["low", "medium", "high"].includes(issue.severity) ? issue.severity : "medium",
          message: truncate(String(issue.message), 300),
        }))
        .slice(0, 20)
    : [];
  return { aligned: reply.aligned !== false, score: Number.isFinite(score) ? Math.max(0, Math.min(5, score)) : 0, issues };
}

/* ------------------------------------------------------------------ */
/* Aggregation                                                        */
/* ------------------------------------------------------------------ */

/** 0–100 risk score: weighted severity sum, capped. */
export function scoreFindings(findings) {
  const raw = findings.reduce((sum, finding) => sum + (SEVERITY_WEIGHT[finding.severity] ?? 0), 0);
  return Math.min(100, raw);
}

export function verdictFor(score) {
  // 12 = one high plus correlated medium/low signals, or several mediums.
  return score >= 12 ? "likely-hallucinated" : score > 0 ? "suspect" : "clean";
}

/**
 * Run every heuristic dimension over one trace. When `judge` is provided
 * (already parsed), its issues are merged as attributed findings.
 *
 * @returns {{ts: string, score: number, verdict: string, findings: Array<object>, stats: object}}
 */
export function analyzeRun(trace, { repeat = {}, judge } = {}) {
  const hashes = trace.toolTrace.map((entry) => entry.hash);
  const hashToTool = new Map(trace.toolTrace.map((entry) => [entry.hash, entry.toolCall.name]));

  const findings = [];

  for (const hit of detectRepeatWindows(hashes, repeat)) {
    findings.push({
      rule: "repeat-window",
      severity: "high",
      stage: "tool-execution",
      message: `Tool "${hashToTool.get(hit.hash)}" was called ${hit.count} times with identical arguments inside a ${repeat.windowSize ?? DEFAULT_REPEAT.windowSize}-call window — a stuck loop, a classic hallucination signature.`,
      data: { hash: hit.hash, tool: hashToTool.get(hit.hash), count: hit.count },
    });
  }

  findings.push(...detectFlipFlopEdits(trace));
  findings.push(...detectIgnoredFailures(trace));
  findings.push(...detectResultMisread(trace));
  findings.push(...detectContradictions(trace));
  findings.push(...detectMemoryRisks(trace));
  findings.push(...detectRedundantExploration(trace));
  findings.push(...detectDeadEndChains(trace));
  findings.push(...detectUngroundedClaims(trace));

  if (judge) {
    if (judge.aligned === false) {
      findings.push({
        rule: "intent-misalignment",
        severity: "high",
        stage: "input-planning",
        message: `LLM judge scored the run ${judge.score}/5 against the user request and marked it NOT aligned.`,
        data: { judgeScore: judge.score },
      });
    } else if (judge.score <= 2) {
      findings.push({
        rule: "intent-partial",
        severity: "medium",
        stage: "input-planning",
        message: `LLM judge scored the run only ${judge.score}/5 against the user request — the implementation may not fully satisfy the need.`,
        data: { judgeScore: judge.score },
      });
    }
    for (const issue of judge.issues) {
      findings.push({
        rule: "judge-finding",
        severity: issue.severity,
        stage: issue.stage,
        message: issue.message,
        data: { judge: true },
      });
    }
  }

  const score = scoreFindings(findings);
  return {
    ts: new Date().toISOString(),
    score,
    verdict: verdictFor(score),
    findings,
    stats: {
      toolCalls: trace.toolTrace.length,
      assistantMessages: trace.assistantTexts.length,
      compacted: trace.compacted,
      steering: trace.steeringCount,
      judgeScore: judge ? judge.score : undefined,
    },
  };
}

/** Render a report as compact human-readable text. */
export function formatReport(report) {
  const lines = [
    `hallucination audit: ${report.verdict} (score ${report.score}/100)`,
    `  tool calls: ${report.stats.toolCalls}, assistant messages: ${report.stats.assistantMessages}` +
      (report.stats.compacted ? ", context was compacted" : "") +
      (report.stats.judgeScore !== undefined ? `, judge alignment ${report.stats.judgeScore}/5` : ""),
  ];
  if (report.findings.length === 0) {
    lines.push("  no hallucination signals detected");
    return lines.join("\n");
  }
  for (const finding of report.findings) {
    lines.push(`  [${finding.severity.toUpperCase()}] (${finding.stage}/${finding.rule}) ${finding.message}`);
  }
  return lines.join("\n");
}

export function truncate(text, max) {
  const flat = String(text ?? "").replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}
