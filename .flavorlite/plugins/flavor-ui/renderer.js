/**
 * flavor-ui renderer — a timeline UI for the flavor-lite terminal.
 *
 * Pure ESM, zero dependencies. The host delegates event rendering to the
 * "ui" service (see src/host/render.ts); this module implements that
 * surface with an injectable output so tests can capture the stream.
 *
 * Design: every turn is a timeline. The user's input opens the turn, model
 * text streams raw (never buffered), and tool calls are rendered as live
 * status lines — a spinner rewrites the same line in place until the tool
 * finishes, then the line becomes a ✓/✗ result with a duration and an
 * optional preview. The turn closes with a dim stat line. All styling
 * degrades gracefully: no animation and no color when stdout is not a TTY
 * or NO_COLOR is set.
 */

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

const SGR = /\x1b\[[0-9;]*m/g;
const ANSI_SGR = /\x1b\[[0-9;]*m/;

/** Styles. "full" animates tool cards; "plain" keeps static one-liners. */
const STYLE_FULL = "full";
const STYLE_PLAIN = "plain";

export function createRenderer(options = {}) {
  const output = options.output ?? process.stdout;
  const colorEnabled = options.color ?? (output.isTTY === true && process.env.NO_COLOR === undefined);
  const tty = options.tty ?? output.isTTY === true;
  let style = options.style === STYLE_PLAIN ? STYLE_PLAIN : STYLE_FULL;
  const spinnerMs = options.spinnerMs ?? 80;

  const paint = makePaint(colorEnabled);

  // ---- turn state ----
  let turnStartedAt = 0;
  let iterations = 0;
  let usage = undefined;
  let sawText = false;
  let atLineStart = true;
  let spinner = undefined; // { timer, frame, line, startedAt }
  let activeTool = undefined; // { name, summary, startedAt }
  let animated = false; // the active tool card is being rewritten in place

  function write(text) {
    output.write(text);
    atLineStart = text.endsWith("\n");
  }

  function line(text) {
    write(text + "\n");
  }

  function ensureLineStart() {
    if (!atLineStart) line("");
  }

  function startTurn() {
    stopSpinner();
    turnStartedAt = Date.now();
    iterations = 0;
    usage = undefined;
    sawText = false;
    activeTool = undefined;
    animated = false;
  }

  function stopSpinner() {
    if (!spinner) return;
    clearInterval(spinner.timer);
    spinner = undefined;
  }

  /** Rewrite the animated tool card in place, or print a fresh line. */
  function drawCard(body, rewrite = animated) {
    if (rewrite) {
      write("\r\x1b[2K");
      write(clipCard(body) + "\n");
      return;
    }
    write(body + "\n");
  }

  /**
   * Rewrites (\r + erase) only work while a card fits on one physical
   * line: once a card wraps, the stale wrapped content sits on a line the
   * next rewrite cannot reach and stays visible as a ghost copy. Clip the
   * card to the terminal width instead (columns - 1: filling the very last
   * column puts some terminals in a deferred-wrap state that breaks the
   * rewrite just the same).
   */
  function clipCard(body) {
    const cols = output.columns;
    const max = Number.isFinite(cols) && cols > 20 ? cols - 1 : Number.POSITIVE_INFINITY;
    if (stringWidth(body) <= max) return body;
    const clipped = truncateToWidth(body, max);
    // Truncation may cut inside a styled span; re-close the styling.
    return colorEnabled ? `${clipped}\u001b[0m` : clipped;
  }

  function toolCardBody(symbol, tool, summary) {
    const head = `${symbol} ${tool}`;
    return summary ? `${head}  ${paint.dim(summary)}` : head;
  }

  function startToolCard(toolCall) {
    const summary = summarize(toolCall.args ?? {});
    activeTool = { name: toolCall.name, summary, startedAt: Date.now() };
    if (style === STYLE_PLAIN || !tty) {
      line(toolCardBody(paint.dim("○"), activeTool.name, summary));
      return;
    }
    animated = true;
    startSpinner();
  }

  /** Animate the active card in place: every frame rewrites the same line. */
  function startSpinner() {
    let frame = 0;
    const draw = () => {
      const body = toolCardBody(
        paint.cyan(SPINNER_FRAMES[frame % SPINNER_FRAMES.length]),
        paint.bold(activeTool.name),
        activeTool.summary,
      );
      // No trailing newline: frames overwrite the current line instead of
      // stacking one ghost copy per tick.
      write(`\r\x1b[2K${clipCard(body)}`);
    };
    draw();
    const timer = setInterval(() => {
      frame += 1;
      draw();
    }, spinnerMs);
    timer.unref?.();
    spinner = { timer, frame, startedAt: activeTool.startedAt };
  }

  /**
   * Freeze the animation while the host owns the terminal (permission
   * prompts). The card degrades to a static pending line for the rest of
   * this tool; the final ✓/✗ line is still printed on completion.
   */
  function pauseAnimation() {
    if (!spinner || !activeTool) return;
    stopSpinner();
    animated = false;
    write(`\r\x1b[2K${clipCard(toolCardBody(paint.dim("○"), activeTool.name, activeTool.summary))}\n`);
  }

  function finishToolCard(toolCall, content, isError) {
    const tool = activeTool ?? { name: toolCall.name, summary: summarize(toolCall.args ?? {}), startedAt: Date.now() };
    const rewrite = animated; // the pending card is being rewritten in place
    stopSpinner();
    activeTool = undefined;
    animated = false;
    const duration = formatDuration(Date.now() - tool.startedAt);
    const tail = paint.dim(`  (${duration})`);
    if (isError) {
      drawCard(`${paint.red("✗")} ${paint.bold(tool.name)}${tool.summary ? `  ${paint.dim(tool.summary)}` : ""}${tail}`, rewrite);
      const first = firstLine(content, 100);
      if (first) line(paint.yellow(`  error: ${first}`));
    } else {
      drawCard(`${paint.green("✓")} ${paint.bold(tool.name)}${tool.summary ? `  ${paint.dim(tool.summary)}` : ""}${tail}`, rewrite);
      if (style === STYLE_FULL) {
        const preview = firstLine(content, 72);
        if (preview) line(paint.dim(`  ${preview}`));
      }
    }
  }

  function turnStats() {
    const turns = `${iterations} ${iterations === 1 ? "turn" : "turns"}`;
    let stats = turns;
    if (usage) {
      stats += ` · ${formatTokens(usage.inputTokens)} → ${formatTokens(usage.outputTokens)} tokens`;
    }
    if (turnStartedAt > 0) stats += ` · ${formatDuration(Date.now() - turnStartedAt)}`;
    return stats;
  }

  /** Render one agent event (the host "ui" service surface). */
  function render(event) {
    switch (event.type) {
      case "agent_start":
        startTurn();
        break;
      case "turn_start":
        iterations = event.iteration;
        break;
      case "text_delta":
        sawText = true;
        write(event.text);
        break;
      case "message_end":
        if (sawText) write("\n");
        break;
      case "tool_start":
        ensureLineStart();
        startToolCard(event.toolCall);
        break;
      case "tool_end":
        finishToolCard(event.toolCall, event.content, event.isError);
        break;
      case "usage":
        usage = { inputTokens: event.inputTokens, outputTokens: event.outputTokens };
        break;
      case "warning":
        ensureLineStart();
        line(paint.yellow(`⚠ ${event.message}`));
        break;
      case "agent_end":
        stopSpinner();
        if (event.reason === "max_iterations") {
          ensureLineStart();
          line(paint.yellow(`⛔ reached the iteration limit (${event.iterations} turns)`));
        } else if (event.reason === "aborted") {
          ensureLineStart();
          line(paint.dim(`⏹ aborted (${event.iterations} turns)`));
        } else {
          ensureLineStart();
          line(`${paint.cyan("⚡")} ${paint.dim(turnStats())}`);
        }
        break;
    }
  }

  /**
   * Render the startup banner: brand line, a ruled table of model/mode/
   * session/plugins, and failed-plugin details. Layout adapts to the
   * terminal width (box rule width follows the widest row).
   */
  function renderBanner(info) {
    const plugins = info.plugins ?? { loaded: 0, total: 0, errors: [] };
    const errors = plugins.errors ?? [];
    const mode = info.mode ?? "default";
    const columns = output.columns && output.columns > 20 ? output.columns : 80;

    const pluginSummary =
      errors.length === 0
        ? paint.green(`${plugins.loaded}/${plugins.total} loaded`)
        : paint.yellow(`${plugins.loaded}/${plugins.total} loaded · ${errors.length} failed`);

    const rows = [
      ["model", paint.bold(info.model ?? "unset")],
      ["mode", mode === "default" ? mode : paint.yellow(mode)],
      ["session", info.sessionId ?? "-"],
      ["plugins", pluginSummary + (plugins.total > 0 ? paint.dim("  (/plugin list)") : "")],
    ];

    // Rule width: content + margins, capped to the terminal width.
    const labelWidth = Math.max(...rows.map(([label]) => stringWidth(label))) + 2;
    const valueWidth = Math.max(...rows.map(([, value]) => stringWidth(value)));
    const ruleWidth = Math.min(Math.max(2 + labelWidth + 1 + valueWidth + 2, 30), columns - 2);

    const rule = paint.dim("─".repeat(ruleWidth));
    line("");
    line(`  ${paint.cyan("✦")} ${paint.bold("flavor-lite")}  ${paint.dim("everything is a plugin")}`);
    line(`  ${rule}`);
    for (const [label, value] of rows) {
      line(`  ${paint.dim(label.padEnd(labelWidth - 1))} ${truncateToWidth(value, ruleWidth - labelWidth - 3)}`);
    }
    line(`  ${rule}`);
    for (const error of errors.slice(0, 3)) {
      line(`  ${paint.red("✖")} ${paint.red(error.name)}: ${truncateToWidth(error.error, ruleWidth - 8)}`);
    }
    if (errors.length > 3) line(`  ${paint.red(`… and ${errors.length - 3} more failed plugins`)}`);
    line(`  ${paint.dim("type /help for commands · input while running becomes steering")}`);
    line("");
  }

  /** Echo the user input that starts a turn. */
  function renderUserInput(input) {
    const [first, ...rest] = input.split("\n");
    // Bright magenta (95) matches the brand color used in the banner.
    line(`${paint.bold(paint.brightMagenta("❯"))} ${first}`);
    for (const part of rest) line(`  ${part}`);
  }

  /** Render a caught turn-level error (model failure, aborted stream). */
  function renderError(error) {
    ensureLineStart();
    line(paint.yellow(`✖ ${error instanceof Error ? error.message : String(error)}`));
  }

  /** Render a non-fatal notice. */
  function renderNotice(message) {
    ensureLineStart();
    line(paint.dim(`· ${message}`));
  }

  /** Render the startup banner: brand, status panel, and hint line. */
  function renderBanner(info = {}) {
    const plugins = info.plugins ?? { loaded: 0, total: 0, errors: [] };
    const columns = output.columns ?? 80;
    const ruleWidth = Math.max(20, Math.min(72, columns - 2));
    const rule = paint.dim("─".repeat(ruleWidth));
    const narrow = columns < 68;

    // Brand line: bold magenta name + dim slogan, version right-aligned.
    const brand = `${paint.bold(paint.magenta("flavor-lite"))}${paint.dim(" · everything is a plugin")}`;
    const versionText = info.version ? paint.dim(`v${info.version}`) : "";
    if (versionText) {
      const pad = Math.max(2, ruleWidth - stringWidth(brand) - stringWidth(versionText));
      line(brand + " ".repeat(pad) + versionText);
    } else {
      line(brand);
    }
    line(rule);

    const model = info.model || paint.dim("unset");
    const mode = paintMode(info.mode);
    const session = info.sessionId || paint.dim("-");
    const loaded = plugins.loaded ?? 0;
    const total = plugins.total ?? 0;
    const pluginText = loaded === total ? paint.green(`${loaded}/${total} loaded`) : paint.yellow(`${loaded}/${total} loaded`);

    if (narrow) {
      line(`${paint.dim("model")}   ${model}`);
      line(`${paint.dim("mode")}    ${mode}`);
      line(`${paint.dim("session")} ${session}`);
      line(`${paint.dim("plugins")} ${pluginText}`);
    } else {
      const target = Math.max(30, Math.min(38, Math.floor(columns / 2) - 6));
      line(twoCol(`${paint.dim("model")}   ${model}`, `${paint.dim("mode")}    ${mode}`, target));
      line(twoCol(`${paint.dim("session")} ${session}`, `${paint.dim("plugins")} ${pluginText}`, target));
    }

    if (plugins.errors.length > 0) {
      const names = plugins.errors
        .slice(0, 3)
        .map((entry) => entry.name)
        .join(", ");
      const more = plugins.errors.length > 3 ? `, +${plugins.errors.length - 3} more` : "";
      line(
        paint.red(
          `✗ ${plugins.errors.length} plugin${plugins.errors.length === 1 ? "" : "s"} failed: ${names}${more} (/plugin list)`,
        ),
      );
    }

    line(rule);
    line(paint.dim("type /help for commands · input while running becomes steering"));
  }

  /** Mode rendered with a semantic color: default=green, plan=yellow, etc. */
  function paintMode(mode) {
    const text = mode || "default";
    if (mode === "plan") return paint.yellow(text);
    if (mode === "acceptEdits") return paint.cyan(text);
    if (mode === "bypass") return paint.red(text);
    return paint.green(text);
  }

  /** Lay out two label/value pairs side by side with a fixed left column. */
  function twoCol(left, right, target) {
    return left + " ".repeat(Math.max(2, target - stringWidth(left))) + right;
  }

  return {
    render,
    renderUserInput,
    renderBanner,
    renderError,
    renderNotice,
    pauseAnimation,
    setStyle(next) {
      if (next === STYLE_PLAIN) {
        stopSpinner();
        style = STYLE_PLAIN;
      } else {
        style = STYLE_FULL;
      }
    },
    styleName: () => style,
  };
}

function makePaint(enabled) {
  const wrap = (code) => (text) => (enabled ? `\u001b[${code}m${text}\u001b[0m` : text);
  return {
    dim: wrap(2),
    bold: wrap(1),
    yellow: wrap(33),
    red: wrap(31),
    cyan: wrap(36),
    green: wrap(32),
    magenta: wrap(35),
    brightMagenta: wrap(95),
  };
}

/** First line of text, truncated to a display width. */
function firstLine(text, max) {
  const lineText = text.split("\n", 1)[0] ?? text;
  return truncateToWidth(lineText.trim(), max);
}

/** Pick the primary argument to show beside a tool name. */
function summarize(args) {
  const preferred = [
    "path",
    "file_path",
    "command",
    "pattern",
    "query",
    "url",
    "text",
    "prompt",
    "input",
    "message",
    "target",
    "id",
  ];
  for (const key of preferred) {
    const value = args[key];
    if (typeof value === "string" && value) return truncateToWidth(value, 72);
  }
  const first = Object.values(args).find((value) => typeof value === "string" && value);
  return typeof first === "string" ? truncateToWidth(first, 72) : "";
}

function formatDuration(ms) {
  if (ms < 1000) return `${Math.max(1, Math.round(ms))}ms`;
  return `${(ms / 1000).toFixed(ms < 10000 ? 2 : 1)}s`;
}

function formatTokens(count) {
  return count >= 1000 ? `${(count / 1000).toFixed(1)}k` : String(count);
}

/** Display width of a string, ignoring ANSI SGR codes and combining marks. */
function stringWidth(text) {
  let width = 0;
  for (const char of text.replace(SGR, "")) width += charWidth(char);
  return width;
}

function charWidth(char) {
  const code = char.codePointAt(0) ?? 0;
  if (code === 0 || isCombining(code)) return 0;
  return isWide(code) ? 2 : 1;
}

function isCombining(code) {
  return (
    (code >= 0x0300 && code <= 0x036f) ||
    (code >= 0x1ab0 && code <= 0x1aff) ||
    (code >= 0x1dc0 && code <= 0x1dff) ||
    (code >= 0x20d0 && code <= 0x20ff) ||
    (code >= 0xfe20 && code <= 0xfe2f)
  );
}

function isWide(code) {
  return (
    (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2e80 && code <= 0x303e) ||
    (code >= 0x3041 && code <= 0x33ff) ||
    (code >= 0x3400 && code <= 0x4dbf) ||
    (code >= 0x4e00 && code <= 0x9fff) ||
    (code >= 0xa000 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe30 && code <= 0xfe4f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x20000 && code <= 0x2fffd) ||
    (code >= 0x30000 && code <= 0x3fffd)
  );
}

/** Truncate to a display width, preserving ANSI sequences and wide chars. */
function truncateToWidth(text, maxWidth) {
  if (maxWidth <= 0 || !text) return "";
  if (stringWidth(text) <= maxWidth) return text;
  let out = "";
  let width = 0;
  let index = 0;
  // Reserve one column for the ellipsis so the result never exceeds maxWidth.
  while (index < text.length) {
    if (text[index] === "\x1b") {
      const match = ANSI_SGR.exec(text.slice(index));
      if (match && match.index === 0) {
        out += match[0];
        index += match[0].length;
        continue;
      }
    }
    const char = text[index] ?? "";
    const charW = charWidth(char);
    if (width + charW > maxWidth - 1) break;
    out += char;
    width += charW;
    index += 1;
  }
  return `${out}…`;
}
