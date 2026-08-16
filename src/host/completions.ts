/**
 * Slash-command completion for the interactive host.
 *
 * The host owns the terminal; plugins own the candidate sources. A plugin
 * registers a CompletionProvider through the "repl" service; while the user
 * types, the host renders matching candidates below the input line with the
 * typed prefix highlighted, and Tab completes the selected candidate.
 *
 * Rendering is raw ANSI and keeps readline's own cursor model intact: after
 * every draw the terminal cursor is restored to the end of the input line,
 * so readline's next redraw (Enter, prompt) always starts from a clean
 * screen. Suggestions are dismissed by a prepended keypress listener before
 * readline handles Enter/Ctrl+C, so command output never collides with a
 * leftover suggestion block.
 */

import type { Key } from "node:readline";
import type { Disposer } from "../kernel/types";
import { bold, cyan, dim } from "./render";

export interface CompletionSuggestion {
  /** Text inserted on Tab. Omit for informational candidates (e.g. skills). */
  completion?: string;
  /** Plain-text line shown in the list (no ANSI, no description). */
  display: string;
  /** Optional dimmed description shown after the display. */
  description?: string;
}

export interface CompletionProvider {
  /** Return completion candidates for the current line. */
  complete(line: string): Promise<CompletionSuggestion[]> | CompletionSuggestion[];
}

/** Service surface exposed to plugins through the "repl" service key. */
export interface ReplService {
  /** Register a completion provider. Returns a disposer. */
  registerCompleter(provider: CompletionProvider): Disposer;
}

/** Structural view of the parts of a readline interface the controller uses. */
export interface ReplLineLike {
  line: string;
  cursor: number;
  getPrompt(): string;
  /** readline's internal refresh; present at runtime on every Interface. */
  _refreshLine?(): void;
}

export interface KeypressInput extends NodeJS.EventEmitter {
  isTTY?: boolean;
}

export interface TerminalOutput {
  isTTY?: boolean;
  columns?: number;
  write(chunk: string): unknown;
}

export interface ReplCompletionsOptions {
  rl: ReplLineLike;
  input: KeypressInput;
  output: TerminalOutput;
  /** Called before each render; return false to suppress suggestions (e.g. busy). */
  enabled?: () => boolean;
  /** Maximum suggestion rows rendered at once. Default 8. */
  maxSuggestions?: number;
}

const DEFAULT_MAX_SUGGESTIONS = 8;
const DEFAULT_COLUMNS = 80;
const ANSI_SGR = /\x1b\[[0-9;]*m/;

/** Display width of a string, ignoring ANSI SGR codes and combining marks. */
export function stringWidth(text: string): number {
  let width = 0;
  for (const char of text.replace(/\x1b\[[0-9;]*m/g, "")) {
    width += charWidth(char);
  }
  return width;
}

/** True when the code point is a combining mark (renders as width 0). */
function isCombining(code: number): boolean {
  return (
    (code >= 0x0300 && code <= 0x036f) ||
    (code >= 0x1ab0 && code <= 0x1aff) ||
    (code >= 0x1dc0 && code <= 0x1dff) ||
    (code >= 0x20d0 && code <= 0x20ff) ||
    (code >= 0xfe20 && code <= 0xfe2f)
  );
}

/** True when the code point renders as two terminal columns (East Asian wide). */
function isWide(code: number): boolean {
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

function charWidth(char: string): number {
  const code = char.codePointAt(0) ?? 0;
  if (code === 0 || isCombining(code)) return 0;
  return isWide(code) ? 2 : 1;
}

/** Truncate to a display width, preserving ANSI sequences and wide chars. */
export function truncateToWidth(text: string, maxWidth: number): string {
  if (maxWidth <= 0) return "";
  if (stringWidth(text) <= maxWidth) return text;
  let out = "";
  let width = 0;
  let index = 0;
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
    if (width + charW > maxWidth) break;
    out += char;
    width += charW;
    index += 1;
  }
  return out;
}

/** First case-insensitive occurrence of the typed prefix in a display. */
export function findHighlight(display: string, typed: string): [number, number] | undefined {
  if (typed === "") return undefined;
  const index = display.toLowerCase().indexOf(typed.toLowerCase());
  if (index < 0) return undefined;
  return [index, index + typed.length];
}

export class ReplCompletions implements ReplService {
  private readonly providers: CompletionProvider[] = [];
  private readonly enabled: () => boolean;
  private readonly maxSuggestions: number;
  private readonly tty: boolean;
  private readonly input: KeypressInput;
  private readonly output: TerminalOutput;
  private readonly rl: ReplLineLike;

  private visible: CompletionSuggestion[] = [];
  private selected = 0;
  private blockHeight = 0;
  private lastRenderedLine = "";
  private renderGen = 0;
  private closed = false;

  private readonly onKeypressBefore: (str: string | undefined, key: Key | undefined) => void;
  private readonly onKeypressAfter: (str: string | undefined, key: Key | undefined) => void;

  constructor(options: ReplCompletionsOptions) {
    this.rl = options.rl;
    this.input = options.input;
    this.output = options.output;
    this.enabled = options.enabled ?? (() => true);
    this.maxSuggestions = options.maxSuggestions ?? DEFAULT_MAX_SUGGESTIONS;
    this.tty = options.input.isTTY === true && options.output.isTTY === true;

    this.onKeypressBefore = (_str, key) => this.beforeKeypress(key);
    this.onKeypressAfter = (_str, key) => this.afterKeypress(key);
    if (this.tty) {
      // Runs before readline's own handler so Enter/Ctrl+C can dismiss the
      // suggestion block while the screen is still clean.
      this.input.prependListener("keypress", this.onKeypressBefore);
      this.input.on("keypress", this.onKeypressAfter);
    }
  }

  registerCompleter(provider: CompletionProvider): Disposer {
    this.providers.push(provider);
    return () => {
      const index = this.providers.indexOf(provider);
      if (index >= 0) this.providers.splice(index, 1);
    };
  }

  /** The currently displayed suggestions (used by tests and debugging). */
  suggestions(): CompletionSuggestion[] {
    return [...this.visible];
  }

  /** Recompute suggestions for the current line and redraw. Public for tests. */
  async refresh(): Promise<void> {
    if (this.closed || !this.enabled()) return;
    const gen = ++this.renderGen;
    const line = this.rl.line;
    const cursor = this.rl.cursor;
    const suggestions = await this.collect(line);
    if (
      this.closed ||
      gen !== this.renderGen ||
      this.rl.line !== line ||
      this.rl.cursor !== cursor ||
      !this.enabled()
    ) {
      return;
    }
    this.render(line, suggestions);
  }

  /** Dismiss any visible suggestion block and reset selection. */
  clear(): void {
    // Invalidate in-flight renders: the line was just reset (Enter/abort),
    // so a pending refresh must not draw suggestions on the next prompt.
    this.renderGen += 1;
    if (this.blockHeight > 0) {
      this.eraseBlock(this.currentCursorCol());
      this.blockHeight = 0;
    }
    this.visible = [];
    this.selected = 0;
  }

  dispose(): void {
    if (this.closed) return;
    this.closed = true;
    this.clear();
    this.input.removeListener("keypress", this.onKeypressBefore);
    this.input.removeListener("keypress", this.onKeypressAfter);
  }

  /** Before readline processes the key: dismiss the block on Enter/abort. */
  private beforeKeypress(key: Key | undefined): void {
    if (!key || this.closed) return;
    const isEnter = key.name === "return" || key.name === "enter";
    const isAbort = key.ctrl && (key.name === "c" || key.name === "d");
    if (isEnter || isAbort) this.clear();
  }

  /** After readline processed the key: complete on Tab, redraw otherwise. */
  private afterKeypress(key: Key | undefined): void {
    if (!key || this.closed) return;
    if (key.ctrl || key.meta) {
      // Ctrl+C/Ctrl+D were already dismissed; don't re-render for any ctrl combo.
      this.clear();
      return;
    }
    if (key.name === "return" || key.name === "enter") return; // prepend already cleared
    if (key.name === "tab") {
      this.completeSelected();
      return;
    }
    if (!this.enabled()) {
      this.clear();
      return;
    }
    void this.refresh();
  }

  /** Tab: complete the line to the next insertable candidate (cycling). */
  private completeSelected(): void {
    if (this.visible.length === 0) return;
    const insertable = this.visible.filter((suggestion) => suggestion.completion !== undefined);
    if (insertable.length === 0) return;
    const candidate = insertable[this.selected % insertable.length];
    if (!candidate || candidate.completion === undefined) return;
    this.selected = (this.selected + 1) % insertable.length;
    const completion = candidate.completion;
    this.rl.line = completion;
    this.rl.cursor = completion.length;
    this.rl._refreshLine?.();
  }

  private async collect(line: string): Promise<CompletionSuggestion[]> {
    const results = await Promise.all(this.providers.map((provider) => provider.complete(line)));
    const seen = new Set<string>();
    const merged: CompletionSuggestion[] = [];
    for (const result of results) {
      for (const suggestion of result) {
        const key = suggestion.completion ?? suggestion.display;
        if (seen.has(key)) continue;
        seen.add(key);
        merged.push(suggestion);
      }
    }
    return merged.slice(0, this.maxSuggestions);
  }

  private render(line: string, suggestions: CompletionSuggestion[]): void {
    if (line !== this.lastRenderedLine) {
      this.lastRenderedLine = line;
      this.selected = 0;
    }
    const cursorCol = this.currentCursorCol();
    this.eraseBlock(cursorCol);
    this.visible = suggestions;
    if (!this.tty || suggestions.length === 0 || this.inputAboutToWrap()) {
      this.blockHeight = 0;
      return;
    }
    const typed = line.startsWith("/") ? line.slice(1) : "";
    const rows = suggestions.map((suggestion) => this.formatSuggestion(suggestion, typed));
    this.drawBlock(rows, cursorCol);
    this.blockHeight = rows.length;
  }

  /** Position of the cursor on the input row (prompt + text before cursor). */
  private currentCursorCol(): number {
    return stringWidth(this.rl.getPrompt()) + stringWidth(this.rl.line.slice(0, this.rl.cursor));
  }

  /**
   * When the input line is about to wrap, readline's own redraws own
   * multiple terminal rows and would collide with the block — degrade to no
   * suggestions rather than corrupt the screen.
   */
  private inputAboutToWrap(): boolean {
    const columns = this.output.columns ?? DEFAULT_COLUMNS;
    return stringWidth(this.rl.getPrompt()) + stringWidth(this.rl.line) >= columns - 2;
  }

  private formatSuggestion(suggestion: CompletionSuggestion, typed: string): string {
    const { display } = suggestion;
    const hit = findHighlight(display, typed);
    let text = `  ${display}`;
    if (hit) {
      const [start, end] = hit;
      text = `  ${display.slice(0, start)}${cyan(bold(display.slice(start, end)))}${dim(display.slice(end))}`;
    }
    if (suggestion.description) text += dim(`  ${suggestion.description}`);
    const maxWidth = Math.max(1, (this.output.columns ?? DEFAULT_COLUMNS) - 1);
    const row = truncateToWidth(text, maxWidth);
    // Truncation can cut inside an open SGR code; close it so the dim state
    // does not leak into the next suggestion row or the input line.
    if (row.includes("\x1b[") && !row.endsWith("\x1b[0m")) return `${row}\x1b[0m`;
    return row;
  }

  /** Erase the previously drawn block and restore the cursor to the input row. */
  private eraseBlock(cursorCol: number): void {
    const height = this.blockHeight;
    if (height <= 0 || !this.tty) return;
    const out = this.output;
    out.write("\x1b[1B");
    out.write("\x1b[G");
    for (let i = 0; i < height; i += 1) {
      out.write("\x1b[2K");
      if (i < height - 1) {
        out.write("\x1b[1B");
        out.write("\x1b[G");
      }
    }
    out.write(`\x1b[${height}A`);
    out.write(`\x1b[${cursorCol}C`);
  }

  /**
   * Draw suggestion rows directly below the input row. Relative positioning
   * survives terminal scrolling, so a prompt sitting on the last terminal
   * row still renders (and later erases) the block correctly.
   */
  private drawBlock(rows: string[], cursorCol: number): void {
    const out = this.output;
    out.write("\r\n");
    for (let i = 0; i < rows.length; i += 1) {
      out.write(rows[i] ?? "");
      if (i < rows.length - 1) out.write("\r\n");
    }
    out.write(`\x1b[${rows.length}A`);
    out.write(`\x1b[${cursorCol}C`);
  }
}

declare module "../kernel/types" {
  interface ServiceMap {
    repl: ReplService;
  }
}
