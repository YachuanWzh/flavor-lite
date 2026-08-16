import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import {
  ReplCompletions,
  findHighlight,
  stringWidth,
  truncateToWidth,
  type KeypressInput,
  type ReplLineLike,
  type TerminalOutput,
} from "../src/host/completions";
import { collectSuggestions } from "../.flavorlite/plugins/command-hints/index.js";

describe("stringWidth", () => {
  it("counts ASCII and wide CJK characters", () => {
    expect(stringWidth("ab")).toBe(2);
    expect(stringWidth("中文")).toBe(4);
    expect(stringWidth("a中b")).toBe(4);
  });

  it("ignores ANSI SGR sequences and combining marks", () => {
    expect(stringWidth("\x1b[36mre\x1b[0m")).toBe(2);
    expect(stringWidth("e\u0301")).toBe(1); // e + combining acute
  });
});

describe("truncateToWidth", () => {
  it("returns the text unchanged when it fits", () => {
    expect(truncateToWidth("hello", 80)).toBe("hello");
  });

  it("truncates by display width, keeping wide chars whole", () => {
    expect(truncateToWidth("abcdef", 4)).toBe("abcd");
    expect(truncateToWidth("a中b", 3)).toBe("a中"); // 中 would exceed 3
  });

  it("preserves ANSI sequences when truncating", () => {
    const text = "\x1b[2mhello world\x1b[0m";
    const out = truncateToWidth(text, 7);
    expect(out.startsWith("\x1b[2mhello")).toBe(true);
    expect(stringWidth(out)).toBeLessThanOrEqual(7);
  });
});

describe("findHighlight", () => {
  it("finds the first case-insensitive occurrence", () => {
    expect(findHighlight("/remember", "re")).toEqual([1, 3]);
    expect(findHighlight("/Init", "i")).toEqual([1, 2]);
  });

  it("returns undefined for an empty or unmatched prefix", () => {
    expect(findHighlight("/remember", "")).toBeUndefined();
    expect(findHighlight("/remember", "zz")).toBeUndefined();
  });
});

describe("command-hints plugin: collectSuggestions", () => {
  const commands = {
    list: () => [
      { name: "remember", description: "Store a fact" },
      { name: "resume", description: "Resume a session" },
      { name: "plugin", description: "Manage plugins" },
    ],
  };
  const plugins = {
    list: () => [
      { name: "memory", description: "Long-term memory", status: "loaded" },
      { name: "release-tools", description: "Release automation", status: "loaded" },
    ],
  };
  const skills = [{ name: "review", description: "Review code" }];

  it("matches commands, plugins and skills by typed prefix", async () => {
    const suggestions = await collectSuggestions({ line: "/re", commands, plugins, skills });
    expect(suggestions.map((s) => s.display)).toEqual(["/remember", "/resume", "release-tools", "review"]);
    expect(suggestions[0]).toMatchObject({ completion: "/remember", description: "Store a fact" });
    expect(suggestions[2]).toMatchObject({ completion: "/plugin reload release-tools" });
    expect(suggestions[3]).toMatchObject({ completion: undefined });
  });

  it("lists everything when only a slash is typed", async () => {
    const suggestions = await collectSuggestions({ line: "/", commands, plugins, skills });
    expect(suggestions.map((s) => s.display)).toEqual([
      "/plugin",
      "/remember",
      "/resume",
      "memory",
      "release-tools",
      "review",
    ]);
  });

  it("drops the exact match once the command is complete", async () => {
    const suggestions = await collectSuggestions({ line: "/remember", commands, plugins, skills });
    expect(suggestions).toEqual([]);
  });

  it("ignores lines with arguments and non-slash lines", async () => {
    expect(await collectSuggestions({ line: "/re foo", commands, plugins, skills })).toEqual([]);
    expect(await collectSuggestions({ line: "hello", commands, plugins, skills })).toEqual([]);
  });

  it("matches case-insensitively", async () => {
    const suggestions = await collectSuggestions({ line: "/RE", commands, plugins, skills });
    expect(suggestions.map((s) => s.display)).toEqual(["/remember", "/resume", "release-tools", "review"]);
  });
});

function makeInput(isTTY = true): KeypressInput {
  const emitter = new EventEmitter() as EventEmitter & { isTTY?: boolean };
  emitter.isTTY = isTTY;
  return emitter as KeypressInput;
}

function makeController(line = "/re") {
  const rl: ReplLineLike = {
    line,
    cursor: line.length,
    getPrompt: () => "› ",
    _refreshLine: vi.fn(),
  };
  const input = makeInput();
  const output: TerminalOutput & { writes: string[] } = {
    isTTY: true,
    columns: 120,
    writes: [],
    write(chunk: string) {
      this.writes.push(chunk);
    },
  };
  const controller = new ReplCompletions({ rl, input, output });
  return { rl, input, output, controller };
}

const reProvider = {
  complete: (line: string) =>
    line === "/re"
      ? [
          { display: "/remember", description: "Store a fact", completion: "/remember" },
          { display: "/resume", description: "Resume a session", completion: "/resume" },
        ]
      : [],
};

describe("ReplCompletions", () => {
  it("renders a suggestion block below the input and restores the cursor", async () => {
    const { rl, output, controller } = makeController("/re");
    controller.registerCompleter(reProvider);
    await controller.refresh();

    expect(controller.suggestions().map((s) => s.display)).toEqual(["/remember", "/resume"]);
    expect(output.writes).toEqual([
      "\r\n",
      "  /remember  Store a fact",
      "\r\n",
      "  /resume  Resume a session",
      "\x1b[2A",
      "\x1b[5C", // prompt "› " (2) + "/re" (3)
    ]);
    expect(rl._refreshLine).not.toHaveBeenCalled();
  });

  it("respects maxSuggestions", async () => {
    const { output, controller } = makeController("/re");
    controller.registerCompleter(reProvider);
    await controller.refresh();
    expect(output.writes.filter((w) => w.includes("/"))).toHaveLength(2);

    const small = new ReplCompletions({
      rl: { line: "/re", cursor: 3, getPrompt: () => "› " },
      input: makeInput(),
      output: { isTTY: true, columns: 120, write() {} } as TerminalOutput,
      maxSuggestions: 1,
    });
    small.registerCompleter(reProvider);
    await small.refresh();
    expect(small.suggestions()).toHaveLength(1);
  });

  it("completes to the next candidate on Tab and cycles", async () => {
    const { rl, input, controller } = makeController("/re");
    controller.registerCompleter(reProvider);
    await controller.refresh();

    input.emit("keypress", "\t", { name: "tab", ctrl: false, meta: false, shift: false, sequence: "\t" });
    expect(rl.line).toBe("/remember");
    expect(rl.cursor).toBe(9);
    expect(rl._refreshLine).toHaveBeenCalledTimes(1);

    input.emit("keypress", "\t", { name: "tab", ctrl: false, meta: false, shift: false, sequence: "\t" });
    expect(rl.line).toBe("/resume");
    expect(rl.cursor).toBe(8);

    input.emit("keypress", "\t", { name: "tab", ctrl: false, meta: false, shift: false, sequence: "\t" });
    expect(rl.line).toBe("/remember"); // wraps around
  });

  it("dismisses the block on Enter before the line is processed", async () => {
    const { output, input, controller } = makeController("/re");
    controller.registerCompleter(reProvider);
    await controller.refresh();
    expect(controller.suggestions()).toHaveLength(2);

    output.writes.length = 0;
    input.emit("keypress", "\r", { name: "return", ctrl: false, meta: false, shift: false, sequence: "\r" });

    expect(controller.suggestions()).toEqual([]);
    expect(output.writes.join("")).toContain("\x1b[2K"); // erase sequence
  });

  it("clears the block when the line no longer matches anything", async () => {
    const { rl, output, controller } = makeController("/re");
    controller.registerCompleter(reProvider);
    await controller.refresh();
    expect(controller.suggestions()).toHaveLength(2);

    output.writes.length = 0;
    rl.line = "/zz";
    rl.cursor = 3;
    await controller.refresh();

    expect(controller.suggestions()).toEqual([]);
    expect(output.writes.join("")).toContain("\x1b[2K"); // erased
    expect(output.writes.join("")).not.toContain("\r\n"); // nothing drawn
  });

  it("skips rendering while disabled and drops the provider on dispose", async () => {
    const { output, controller } = makeController("/re");
    const dispose = controller.registerCompleter(reProvider);
    const disabled = new ReplCompletions({
      rl: { line: "/re", cursor: 3, getPrompt: () => "› " },
      input: makeInput(),
      output: { isTTY: true, columns: 120, write() {} } as TerminalOutput,
      enabled: () => false,
    });
    disabled.registerCompleter(reProvider);
    await disabled.refresh();
    expect(disabled.suggestions()).toEqual([]);

    dispose();
    await controller.refresh();
    expect(controller.suggestions()).toEqual([]);
    expect(output.writes).toEqual([]);
  });

  it("collects suggestions programmatically but renders nothing without a TTY", async () => {
    const writes: string[] = [];
    const controller = new ReplCompletions({
      rl: { line: "/re", cursor: 3, getPrompt: () => "› " },
      input: { isTTY: false } as unknown as KeypressInput,
      output: {
        isTTY: false,
        columns: 120,
        write(chunk: string) {
          writes.push(chunk);
        },
      } as TerminalOutput,
    });
    controller.registerCompleter(reProvider);
    await controller.refresh();
    expect(controller.suggestions()).toHaveLength(2);
    expect(writes).toEqual([]);
  });
});
