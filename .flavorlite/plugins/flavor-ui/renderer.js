/** flavor-ui v2 — a compact flight-recorder timeline for the terminal. */

const SPINNER_FRAMES = ["◐", "◓", "◑", "◒"];
const SGR = /\x1b\[[0-9;]*m/g;
const ANSI_SGR = /\x1b\[[0-9;]*m/;
const STYLE_FULL = "full";
const STYLE_PLAIN = "plain";

const DEFAULT_PRESENTATIONS = [
  { matcher: /^(Read|Write|Edit|ApplyPatch|apply_patch_transaction|Glob|Grep)$/i, spec: { badge: "FILE", accent: "ion" } },
  { matcher: /^verify(?:_|$)/i, spec: { badge: "VERIFY", accent: "ultraviolet", previewOnSuccess: true } },
  { matcher: /^git_/i, spec: { badge: "GIT", accent: "amber" } },
  { matcher: /^lsp_/i, spec: { badge: "LSP", accent: "ultraviolet", previewOnSuccess: true } },
  { matcher: /^process_/i, spec: { badge: "PROCESS", accent: "ion", previewOnSuccess: true } },
  { matcher: /^(subagent_|Task$)/i, spec: { badge: "AGENT", accent: "ember", previewOnSuccess: true } },
  { matcher: /^(plan_|TodoWrite$)/i, spec: { badge: "PLAN", accent: "amber" } },
  { matcher: /^(memory_|remember|recall|forget)/i, spec: { badge: "MEMORY", accent: "mint" } },
  { matcher: /^(web_|WebSearch|WebFetch)/i, spec: { badge: "WEB", accent: "ion" } },
  { matcher: /^(ast_|symbol_|repo_)/i, spec: { badge: "CODE", accent: "ultraviolet" } },
];

export function createRenderer(options = {}) {
  const output = options.output ?? process.stdout;
  const colorEnabled = options.color ?? (output.isTTY === true && process.env.NO_COLOR === undefined);
  const tty = options.tty ?? output.isTTY === true;
  let style = options.style === STYLE_PLAIN ? STYLE_PLAIN : STYLE_FULL;
  const spinnerMs = options.spinnerMs ?? 90;
  const paint = makePaint(colorEnabled);
  let turnStartedAt = 0;
  let iterations = 0;
  let usage;
  let sawText = false;
  let atLineStart = true;
  let activeTool;
  let spinner;
  let animated = false;
  let inlineTool = false;
  let nextPresentationId = 1;
  const presentations = [];

  function write(text) { output.write(text); atLineStart = text.endsWith("\n"); }
  function line(text = "") {
    write(text + (colorEnabled && text.includes("\x1b[") && !text.endsWith("\x1b[0m") ? "\x1b[0m" : "") + "\n");
  }
  function ensureLineStart() { if (!atLineStart) line(); }
  function startTurn() {
    stopSpinner(); turnStartedAt = Date.now(); iterations = 0; usage = undefined;
    sawText = false; activeTool = undefined; animated = false; inlineTool = false;
  }
  function stopSpinner() { if (spinner) { clearInterval(spinner.timer); spinner = undefined; } }
  function clipRow(body) {
    const columns = output.columns;
    const max = Number.isFinite(columns) && columns > 20 ? columns - 1 : Number.POSITIVE_INFINITY;
    if (stringWidth(body) <= max) return body;
    const clipped = truncateToWidth(body, max);
    return colorEnabled ? `${clipped}\x1b[0m` : clipped;
  }
  function toolBody(symbol, name, summary, presentation, tail = "") {
    const head = `${paint.graphite("├─")} ${symbol} ${name}`;
    const badge = accent(presentation.accent)(`‹${presentation.badge}›`);
    return `${head}${summary ? `  ${paint.graphite(summary)}` : ""}  ${badge}${tail}`;
  }
  function resolvePresentation(toolCall) {
    const custom = [...presentations].reverse().find((entry) => matches(entry.matcher, toolCall.name, toolCall.args ?? {}));
    if (custom) return custom.spec;
    const builtIn = DEFAULT_PRESENTATIONS.find((entry) => matches(entry.matcher, toolCall.name, toolCall.args ?? {}));
    if (builtIn) return builtIn.spec;
    const category = options.resolveTool?.(toolCall.name)?.category;
    if (category === "read") return { badge: "READ", accent: "ion" };
    if (category === "write") return { badge: "WRITE", accent: "amber" };
    if (category === "shell") return { badge: "SHELL", accent: "ember", previewOnSuccess: true };
    if (category === "control") return { badge: "CONTROL", accent: "ultraviolet" };
    return { badge: "TOOL", accent: "graphite" };
  }
  function accent(name) {
    return typeof paint[name] === "function" ? paint[name] : paint.graphite;
  }
  function startTool(toolCall) {
    ensureLineStart();
    activeTool = { name: toolCall.name, summary: summarize(toolCall.args ?? {}), presentation: resolvePresentation(toolCall), startedAt: Date.now() };
    if (!tty) {
      line(clipRow(toolBody(accent(activeTool.presentation.accent)("○"), activeTool.name, activeTool.summary, activeTool.presentation)));
      return;
    }
    inlineTool = true;
    if (style === STYLE_PLAIN) {
      write(clipRow(toolBody(accent(activeTool.presentation.accent)("○"), activeTool.name, activeTool.summary, activeTool.presentation)));
      return;
    }
    animated = true;
    let frame = 0;
    const draw = () => write(`\r\x1b[2K${clipRow(toolBody(accent(activeTool.presentation.accent)(SPINNER_FRAMES[frame % SPINNER_FRAMES.length]), paint.bold(activeTool.name), activeTool.summary, activeTool.presentation))}`);
    draw();
    const timer = setInterval(() => { frame += 1; draw(); }, spinnerMs);
    timer.unref?.();
    spinner = { timer };
  }
  function finishTool(toolCall, content, isError) {
    const tool = activeTool ?? { name: toolCall.name, summary: summarize(toolCall.args ?? {}), presentation: resolvePresentation(toolCall), startedAt: Date.now() };
    const rewrite = inlineTool;
    stopSpinner(); activeTool = undefined; animated = false; inlineTool = false;
    const tail = paint.graphite(`  (${formatDuration(Date.now() - tool.startedAt)})`);
    const body = clipRow(toolBody(isError ? paint.red("✗") : paint.mint("✓"), paint.bold(tool.name), tool.summary, tool.presentation, tail));
    if (rewrite) { write("\r\x1b[2K"); write(`${body}\n`); } else line(body);
    const preview = firstLine(content, 90);
    if (isError && preview) line(`${paint.graphite("│")}  ${paint.amber(`error: ${preview}`)}`);
    else if ((style === STYLE_FULL || tool.presentation.previewOnSuccess) && preview) line(`${paint.graphite("│")}  ${paint.graphite(preview)}`);
  }
  function pauseAnimation() {
    if (!activeTool || !inlineTool) return;
    stopSpinner(); animated = false; inlineTool = false;
    write(`\r\x1b[2K${clipRow(toolBody(accent(activeTool.presentation.accent)("○"), activeTool.name, activeTool.summary, activeTool.presentation))}\n`);
  }
  function turnStats() {
    const turns = `${iterations} ${iterations === 1 ? "turn" : "turns"}`;
    let value = turns;
    if (usage) value += ` · ${formatTokens(usage.inputTokens)} → ${formatTokens(usage.outputTokens)} tokens`;
    if (turnStartedAt > 0) value += ` · ${formatDuration(Date.now() - turnStartedAt)}`;
    return value;
  }
  function render(event) {
    switch (event.type) {
      case "agent_start": startTurn(); break;
      case "turn_start": iterations = event.iteration; sawText = false; break;
      case "text_delta":
        if (!sawText) { ensureLineStart(); write(`${paint.graphite("│")}  `); }
        sawText = true; write(event.text); break;
      case "message_end": if (sawText) write("\n"); break;
      case "tool_start": startTool(event.toolCall); break;
      case "tool_end": finishTool(event.toolCall, event.content, event.isError); break;
      case "usage": usage = { inputTokens: event.inputTokens, outputTokens: event.outputTokens }; break;
      case "warning": ensureLineStart(); line(`${paint.graphite("│")}  ${paint.amber(`⚠ ${event.message}`)}`); break;
      case "agent_end":
        pauseAnimation(); stopSpinner(); ensureLineStart();
        if (event.reason === "max_iterations") line(`${paint.ember("╰─")} ${paint.amber(`⛔ reached the iteration limit (${event.iterations} turns)`)}`);
        else if (event.reason === "aborted") line(`${paint.graphite("╰─")} ${paint.graphite(`⏹ aborted (${event.iterations} turns)`)}`);
        else line(`${paint.ultraviolet("╰─")} ${paint.ion("⚡")} ${paint.graphite(turnStats())}`);
        break;
    }
  }
  function renderUserInput(input) {
    const [first, ...rest] = String(input).split("\n");
    line(`${paint.ultraviolet("╭─")} ${paint.bold(paint.ion("❯"))} ${first}`);
    for (const part of rest) line(`  ${part}`);
  }
  function renderError(error) { ensureLineStart(); line(`${paint.ember("╰─")} ${paint.red("✖")} ${error instanceof Error ? error.message : String(error)}`); }
  function renderNotice(message) { ensureLineStart(); line(`${paint.graphite("│")}  ${paint.graphite(`· ${message}`)}`); }
  function renderBanner(info = {}) {
    const plugins = info.plugins ?? { loaded: 0, total: 0, errors: [] };
    const errors = plugins.errors ?? [];
    const columns = output.columns ?? 80;
    const width = Math.max(38, Math.min(88, columns - 2));
    const narrow = columns < 68;
    const version = info.version ? `v${info.version}` : "dev";
    const beacon = `${paint.bold(paint.ultraviolet("FLAVOR//LITE"))}  ${paint.graphite("flavor-lite · everything is a plugin")}`;
    const versionText = paint.graphite(version);
    const pad = Math.max(2, width - stringWidth(beacon) - stringWidth(versionText));
    line(`${paint.ultraviolet("╭─")} ${beacon}${" ".repeat(Math.max(0, pad - 2))}${versionText}`);
    line(paint.graphite("├" + "─".repeat(Math.max(1, width - 1))));
    const model = info.model || paint.graphite("unset");
    const mode = paintMode(info.mode, paint);
    const session = info.sessionId || paint.graphite("-");
    const loaded = plugins.loaded ?? 0;
    const total = plugins.total ?? 0;
    const health = loaded === total ? paint.mint(`${loaded}/${total} loaded`) : paint.amber(`${loaded}/${total} loaded`);
    if (narrow) {
      line(`model   ${model}`); line(`mode    ${mode}`); line(`session ${session}`); line(`plugins ${health}`);
    } else {
      const target = Math.max(31, Math.min(44, Math.floor(columns / 2)));
      line(twoCol(`${paint.graphite("model")}   ${model}`, `${paint.graphite("mode")}    ${mode}`, target));
      line(twoCol(`${paint.graphite("session")} ${session}`, `${paint.graphite("plugins")} ${health}`, target));
    }
    if (errors.length) {
      const names = errors.slice(0, 3).map((error) => error.name).join(", ");
      const more = errors.length > 3 ? `, +${errors.length - 3} more` : "";
      line(paint.red(`✗ ${errors.length} plugin${errors.length === 1 ? "" : "s"} failed: ${names}${more} (/plugin list)`));
    }
    line(`${paint.ultraviolet("╰─")} ${paint.graphite("type /help for commands · input while running becomes steering")}`);
  }
  return {
    render, renderUserInput, renderBanner, renderError, renderNotice, pauseAnimation,
    registerToolPresentation(matcher, spec) {
      if (!(typeof matcher === "string" || matcher instanceof RegExp || typeof matcher === "function")) throw new TypeError("tool presentation matcher must be a name, RegExp or function");
      if (!spec || typeof spec.badge !== "string" || !spec.badge.trim()) throw new TypeError("tool presentation requires a badge");
      const entry = { id: nextPresentationId++, matcher, spec: { badge: spec.badge.trim().toUpperCase().slice(0, 12), accent: spec.accent ?? "graphite", previewOnSuccess: spec.previewOnSuccess === true } };
      presentations.push(entry);
      return () => { const index = presentations.findIndex((value) => value.id === entry.id); if (index >= 0) presentations.splice(index, 1); };
    },
    setStyle(next) { if (next === STYLE_PLAIN) { stopSpinner(); style = STYLE_PLAIN; } else style = STYLE_FULL; },
    styleName: () => style,
  };
}

function matches(matcher, name, args) {
  if (typeof matcher === "string") return matcher === name;
  if (matcher instanceof RegExp) { matcher.lastIndex = 0; return matcher.test(name); }
  return matcher(name, args) === true;
}

function makePaint(enabled) {
  const wrap = (code) => (text) => enabled ? `\x1b[${code}m${text}\x1b[0m` : text;
  return {
    bold: wrap(1), graphite: wrap("38;2;119;129;154"), ion: wrap("38;2;101;209;255"),
    ultraviolet: wrap("38;2;167;139;250"), mint: wrap("38;2;94;230;168"), ember: wrap("38;2;251;113;133"),
    amber: wrap(33), red: wrap(31), green: wrap(32), cyan: wrap(36), yellow: wrap(33),
  };
}
function paintMode(mode, paint) { const value = mode || "default"; if (value === "plan") return paint.yellow(value); if (value === "acceptEdits") return paint.cyan(value); if (value === "bypass") return paint.red(value); return paint.green(value); }
function twoCol(left, right, target) { return left + " ".repeat(Math.max(2, target - stringWidth(left))) + right; }
function firstLine(text, max) { return truncateToWidth(String(text).split("\n", 1)[0].trim(), max); }
function summarize(args) { for (const key of ["path", "file_path", "command", "pattern", "query", "url", "text", "prompt", "input", "message", "target", "id"]) if (typeof args[key] === "string" && args[key]) return truncateToWidth(args[key], 72); const value = Object.values(args).find((entry) => typeof entry === "string" && entry); return typeof value === "string" ? truncateToWidth(value, 72) : ""; }
function formatDuration(ms) { return ms < 1000 ? `${Math.max(1, Math.round(ms))}ms` : `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)}s`; }
function formatTokens(count) { return count >= 1000 ? `${(count / 1000).toFixed(1)}k` : String(count); }
function stringWidth(text) { let width = 0; for (const char of String(text).replace(SGR, "")) width += charWidth(char); return width; }
function charWidth(char) { const code = char.codePointAt(0) ?? 0; if (code === 0 || isCombining(code)) return 0; return isWide(code) ? 2 : 1; }
function isCombining(code) { return (code >= 0x0300 && code <= 0x036f) || (code >= 0x1ab0 && code <= 0x1aff) || (code >= 0x1dc0 && code <= 0x1dff) || (code >= 0x20d0 && code <= 0x20ff) || (code >= 0xfe20 && code <= 0xfe2f); }
function isWide(code) { return (code >= 0x1100 && code <= 0x115f) || (code >= 0x2e80 && code <= 0x303e) || (code >= 0x3041 && code <= 0x33ff) || (code >= 0x3400 && code <= 0x4dbf) || (code >= 0x4e00 && code <= 0x9fff) || (code >= 0xa000 && code <= 0xa4cf) || (code >= 0xac00 && code <= 0xd7a3) || (code >= 0xf900 && code <= 0xfaff) || (code >= 0xfe30 && code <= 0xfe4f) || (code >= 0xff00 && code <= 0xff60) || (code >= 0xffe0 && code <= 0xffe6) || (code >= 0x20000 && code <= 0x3fffd); }
function truncateToWidth(text, maxWidth) {
  if (maxWidth <= 0 || !text) return "";
  if (stringWidth(text) <= maxWidth) return text;
  let output = ""; let width = 0; let index = 0;
  while (index < text.length) {
    if (text[index] === "\x1b") { const match = ANSI_SGR.exec(text.slice(index)); if (match?.index === 0) { output += match[0]; index += match[0].length; continue; } }
    const code = text.codePointAt(index); const char = String.fromCodePoint(code); const charWidthValue = charWidth(char);
    if (width + charWidthValue > maxWidth - 1) break;
    output += char; width += charWidthValue; index += char.length;
  }
  return `${output}…`;
}
