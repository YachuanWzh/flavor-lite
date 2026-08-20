import { cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Runtime } from "../src/kernel";
import { commandsPlugin, type CommandsService } from "../src/plugins/commands";
import { hooksPlugin } from "../src/plugins/hooks";
import { pluginsLoaderPlugin, type PluginsLoaderService } from "../src/plugins/plugins";
import { createRenderer } from "../.flavorlite/plugins/flavor-ui/renderer.js";

interface FakeOutput {
  chunks: string[];
  write(chunk: string): void;
  isTTY?: boolean;
  columns?: number;
}

function makeOutput(columns?: number): FakeOutput {
  return { chunks: [], write(chunk: string) { this.chunks.push(chunk); }, ...(columns ? { columns } : {}) };
}

/** Plain text of everything written, with ANSI codes stripped. */
function plain(output: FakeOutput): string {
  return output.chunks.join("").replace(/\x1b\[[0-9;]*m/g, "");
}

const event = {
  agentStart: { type: "agent_start" as const },
  turn: (iteration: number) => ({ type: "turn_start" as const, iteration }),
  text: (text: string) => ({ type: "text_delta" as const, text }),
  messageEnd: { type: "message_end" as const, message: { role: "assistant" as const, content: "" } },
  toolStart: (name: string, args: Record<string, unknown>) => ({
    type: "tool_start" as const,
    toolCall: { id: "t1", name, args },
  }),
  toolEnd: (name: string, content: string, isError = false) => ({
    type: "tool_end" as const,
    toolCall: { id: "t1", name, args: {} },
    content,
    isError,
  }),
  usage: (inputTokens: number, outputTokens: number) => ({ type: "usage" as const, inputTokens, outputTokens }),
  agentEnd: (iterations: number, reason: "finished" | "max_iterations" | "aborted" = "finished") => ({
    type: "agent_end" as const,
    iterations,
    reason,
  }),
};

describe("flavor-ui renderer", () => {
  it("renders a full turn as a timeline: echo, raw text, tool card, stat line", () => {
    const output = makeOutput();
    const renderer = createRenderer({ output, color: false, tty: false });

    renderer.renderUserInput("fix the failing test");
    renderer.render(event.agentStart);
    renderer.render(event.turn(1));
    renderer.render(event.text("I will look at the test."));
    renderer.render(event.messageEnd);
    renderer.render(event.toolStart("Read", { path: "tests/cli.test.ts" }));
    renderer.render(event.toolEnd("Read", "18 lines", false));
    renderer.render(event.usage(1234, 860));
    renderer.render(event.agentEnd(1));

    const text = plain(output);
    expect(text).toContain("❯ fix the failing test");
    expect(text).toContain("I will look at the test.");
    expect(text).toContain("✓ Read  tests/cli.test.ts");
    expect(text).toMatch(/\(.*\)/); // duration badge
    expect(text).toContain("18 lines"); // one-line preview
    expect(text).toContain("⚡ 1 turn · 1.2k → 860 tokens");
  });

  it("renders a failed tool with the error reason", () => {
    const output = makeOutput();
    const renderer = createRenderer({ output, color: false, tty: false });

    renderer.render(event.agentStart);
    renderer.render(event.toolStart("Write", { file_path: "src/cli.ts" }));
    renderer.render(event.toolEnd("Write", "EACCES: permission denied", true));
    renderer.render(event.agentEnd(1));

    const text = plain(output);
    expect(text).toContain("✗ Write  src/cli.ts");
    expect(text).toContain("error: EACCES: permission denied");
  });

  it("echoes multi-line input with continuation indent", () => {
    const output = makeOutput();
    const renderer = createRenderer({ output, color: false, tty: false });

    renderer.renderUserInput("first line\nsecond line");

    const text = plain(output);
    expect(text).toContain("❯ first line");
    expect(text).toContain("\n  second line");
  });

  it("renders warnings and aborts distinctly", () => {
    const output = makeOutput();
    const renderer = createRenderer({ output, color: false, tty: false });

    renderer.render(event.agentStart);
    renderer.render({ type: "warning", message: "Approaching the iteration limit." });
    renderer.render(event.agentEnd(3, "max_iterations"));
    renderer.render(event.agentStart);
    renderer.render(event.agentEnd(1, "aborted"));

    const text = plain(output);
    expect(text).toContain("⚠ Approaching the iteration limit.");
    expect(text).toContain("⛔ reached the iteration limit (3 turns)");
    expect(text).toContain("⏹ aborted (1 turns)");
  });

  it("emits no ANSI codes when color is disabled", () => {
    const output = makeOutput();
    const renderer = createRenderer({ output, color: false, tty: false });

    renderer.renderUserInput("hello");
    renderer.render(event.agentStart);
    renderer.render(event.toolStart("Read", { path: "a.ts" }));
    renderer.render(event.toolEnd("Read", "ok", false));
    renderer.render(event.agentEnd(1));

    expect(output.chunks.join("")).not.toContain("\x1b[");
  });

  it("emits ANSI color when enabled", () => {
    const output = makeOutput();
    const renderer = createRenderer({ output, color: true, tty: false });

    renderer.renderUserInput("hello");
    renderer.render(event.agentStart);
    renderer.render(event.toolStart("Read", { path: "a.ts" }));
    renderer.render(event.toolEnd("Read", "ok", false));
    renderer.render(event.agentEnd(1));

    expect(output.chunks.join("")).toContain("\x1b[");
  });

  it("rewrites the tool card in place on a TTY (spinner mode)", () => {
    const output = makeOutput();
    const renderer = createRenderer({ output, color: false, tty: true });

    renderer.render(event.agentStart);
    renderer.render(event.toolStart("Read", { path: "a.ts" }));

    // The running card is drawn with a carriage-return rewrite.
    const during = output.chunks.join("");
    expect(during).toContain("\r\x1b[2K");
    expect(plain(output)).toContain("Read  a.ts");

    renderer.render(event.toolEnd("Read", "ok", false));
    renderer.render(event.agentEnd(1));

    const text = plain(output);
    expect(text).toContain("✓ Read  a.ts");
    expect(text).not.toContain("○");
  });

  it("keeps every spinner frame on the same line (no ghost copies)", async () => {
    const output = makeOutput();
    const renderer = createRenderer({ output, color: false, tty: true, spinnerMs: 20 });

    renderer.render(event.agentStart);
    renderer.render(event.toolStart("Shell", { command: "npm test" }));
    await new Promise((resolve) => setTimeout(resolve, 70)); // several frames
    renderer.render(event.toolEnd("Shell", "ok", false));

    // Animated frames rewrite the current line: none of them may end with a
    // newline, otherwise each tick stacks another identical ghost line.
    const frames = output.chunks.filter((chunk) => chunk.startsWith("\r\x1b[2K") && chunk.length > "\r\x1b[2K".length);
    expect(frames.length).toBeGreaterThanOrEqual(3);
    for (const frame of frames) {
      expect(frame.endsWith("\n"), `frame leaks a newline: ${JSON.stringify(frame)}`).toBe(false);
    }
    expect(plain(output)).toContain("✓ Shell  npm test");
  });

  it("clips cards to the terminal width so rewrites never wrap (no ghost copies)", () => {
    const output = makeOutput(40);
    const renderer = createRenderer({ output, color: false, tty: true });

    // A summary longer than the terminal: a wrapped card leaves the pending
    // line behind because \r only reaches the last physical line.
    const longPath = "C:\\Users\\wangzh\\Desktop\\idea\\flavor-lite\\tests\\completions.test.ts";
    renderer.render(event.agentStart);
    renderer.render(event.toolStart("Read", { path: longPath }));
    renderer.render(event.toolEnd("Read", "ok", false));

    const frames = output.chunks.filter((chunk) => chunk.startsWith("\r\x1b[2K") && chunk.length > "\r\x1b[2K".length);
    expect(frames.length).toBeGreaterThanOrEqual(1); // at least one spinner frame
    // Every written row (spinner frames and the final card alike) must fit
    // one physical row, otherwise the \r rewrite leaves the wrapped part
    // behind as a ghost copy.
    for (const chunk of output.chunks) {
      const body = chunk.replace(/\r\x1b\[2K/g, "").replace(/\n$/, "");
      if (body) expect(body.length, `row wraps the terminal: ${JSON.stringify(body)}`).toBeLessThanOrEqual(39);
    }
    expect(plain(output)).toContain("✓ Read");
    expect(plain(output)).toContain("…"); // long path clipped with an ellipsis
    expect(plain(output)).not.toContain(longPath);
  });

  it("pauseAnimation freezes the spinner into a static pending card", () => {
    const output = makeOutput();
    const renderer = createRenderer({ output, color: false, tty: true });

    renderer.render(event.agentStart);
    renderer.render(event.toolStart("Shell", { command: "npm test" }));
    renderer.pauseAnimation?.(); // e.g. a permission prompt takes the terminal
    renderer.render(event.toolEnd("Shell", "ok", false));

    const text = plain(output);
    expect(text).toContain("○ Shell  npm test"); // frozen pending card
    expect(text).toContain("✓ Shell  npm test"); // final result still lands
  });

  it("plain style uses one settlement rewrite without timer animation on a TTY", () => {
    const output = makeOutput();
    const renderer = createRenderer({ output, color: false, tty: true, style: "plain" });

    renderer.render(event.agentStart);
    renderer.render(event.toolStart("Read", { path: "a.ts" }));
    renderer.render(event.toolEnd("Read", "ok", false));
    renderer.render(event.agentEnd(1));

    const raw = output.chunks.join("");
    const text = plain(output);
    expect(raw.match(/\r\x1b\[2K/g)).toHaveLength(1);
    expect(text).toContain("○ Read  a.ts");
    expect(text).toContain("✓ Read  a.ts");
    expect(text).not.toContain("ok"); // no preview in plain style
  });

  it("setStyle switches between full and plain at runtime", () => {
    const output = makeOutput();
    const renderer = createRenderer({ output, color: false, tty: true });

    renderer.setStyle("plain");
    expect(renderer.styleName()).toBe("plain");
    renderer.render(event.agentStart);
    renderer.render(event.toolStart("Read", { path: "a.ts" }));
    renderer.render(event.toolEnd("Read", "ok", false));
    expect(plain(output)).toContain("○ Read");

    renderer.setStyle("full");
    expect(renderer.styleName()).toBe("full");
    renderer.render(event.toolStart("Read", { path: "b.ts" }));
    expect(output.chunks.join("")).toContain("\r\x1b[2K");
  });

  it("truncates long summaries without breaking ANSI", () => {
    const output = makeOutput();
    const renderer = createRenderer({ output, color: true, tty: false });

    const long = "x".repeat(200);
    renderer.render(event.agentStart);
    renderer.render(event.toolStart("Read", { path: long }));
    renderer.render(event.toolEnd("Read", "ok", false));
    renderer.render(event.agentEnd(1));

    const raw = output.chunks.join("");
    const text = plain(output);
    expect(text).toContain("…");
    // Every SGR open is closed again on its own line (no leaked color state).
    for (const line of raw.split("\n")) {
      if (!line.includes("\x1b[")) continue;
      expect(line.endsWith("\x1b[0m"), `unclosed ANSI on line: ${JSON.stringify(line)}`).toBe(true);
    }
  });
});

describe("flavor-ui plugin (through the plugins loader)", () => {
  let tmp: string;
  let root: string;
  let runtime: Runtime;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "flavor-ui-plugin-"));
    root = join(tmp, ".flavorlite", "plugins");
    await mkdir(root, { recursive: true });
    await cp(join(process.cwd(), ".flavorlite", "plugins", "flavor-ui"), join(root, "flavor-ui"), { recursive: true });
  });

  afterEach(async () => {
    await runtime?.dispose();
    await rm(tmp, { recursive: true, force: true });
  });

  it("loads, provides the ui service, and registers /ui", async () => {
    runtime = Runtime.create({ cwd: tmp });
    runtime
      .use(hooksPlugin)
      .use(commandsPlugin)
      .use(pluginsLoaderPlugin, { runtime, roots: [root], watch: false });
    runtime.start();

    const loader = runtime.ctx.get("pluginsLoader") as PluginsLoaderService;
    await loader.init();

    expect(loader.list().find((entry) => entry.name === "flavor-ui")?.status).toBe("loaded");
    const ui = runtime.ctx.tryGet("ui") as { render: unknown; renderUserInput?: unknown } | undefined;
    expect(ui).toBeDefined();
    expect(typeof ui?.render).toBe("function");
    expect(typeof ui?.renderUserInput).toBe("function");

    const commands = runtime.ctx.get("commands") as CommandsService;
    expect(await commands.execute("/ui")).toContain("flavor-ui");
    expect(await commands.execute("/ui on")).toContain("full style");
    expect(await commands.execute("/ui off")).toContain("plain style");
    expect(await commands.execute("/ui bogus")).toContain("unknown option");
  });

  it("unmounting the plugin removes the ui service again", async () => {
    runtime = Runtime.create({ cwd: tmp });
    runtime
      .use(hooksPlugin)
      .use(commandsPlugin)
      .use(pluginsLoaderPlugin, { runtime, roots: [root], watch: false });
    runtime.start();

    const loader = runtime.ctx.get("pluginsLoader") as PluginsLoaderService;
    await loader.init();
    expect(runtime.ctx.tryGet("ui")).toBeDefined();

    await loader.eject("flavor-ui");
    expect(runtime.ctx.tryGet("ui")).toBeUndefined();
  });
});

describe("flavor-ui banner", () => {
  const info = {
    version: "0.1.1",
    model: "openai:deepseek-v4-flash",
    mode: "default",
    sessionId: "sess-1",
    plugins: { loaded: 8, total: 9, errors: [] as Array<{ name: string; error: string }> },
  };

  it("renders brand, version, status panel, and hint", () => {
    const output = makeOutput(100);
    const renderer = createRenderer({ output, color: false, tty: false });

    renderer.renderBanner(info);

    const text = plain(output);
    expect(text).toContain("flavor-lite");
    expect(text).toContain("everything is a plugin");
    expect(text).toContain("v0.1.1");
    expect(text).toContain("openai:deepseek-v4-flash");
    expect(text).toContain("default");
    expect(text).toContain("sess-1");
    expect(text).toContain("8/9 loaded");
    expect(text).toContain("type /help for commands");
  });

  it("two-column layout keeps model and mode on the same row on wide terminals", () => {
    const output = makeOutput(100);
    const renderer = createRenderer({ output, color: false, tty: false });

    renderer.renderBanner(info);

    const lines = plain(output).split("\n");
    const modelLine = lines.find((line) => line.includes("model"));
    expect(modelLine).toBeDefined();
    expect(modelLine).toContain("openai:deepseek-v4-flash");
    expect(modelLine).toContain("mode");
    expect(modelLine).toContain("default");
  });

  it("falls back to one column on narrow terminals", () => {
    const output = makeOutput(50);
    const renderer = createRenderer({ output, color: false, tty: false });

    renderer.renderBanner(info);

    const lines = plain(output).split("\n");
    const modelLine = lines.find((line) => line.includes("model"));
    const modeLine = lines.find((line) => line.startsWith("mode"));
    expect(modelLine).toBeDefined();
    expect(modeLine).toBeDefined();
    expect(modelLine).not.toContain("default"); // model row has no mode value on it
  });

  it("lists failed plugins in red", () => {
    const output = makeOutput(100);
    const renderer = createRenderer({ output, color: true, tty: false });

    renderer.renderBanner({
      ...info,
      plugins: { loaded: 8, total: 9, errors: [{ name: "websearch", error: "import failed" }] },
    });

    const raw = output.chunks.join("");
    expect(raw).toContain("\x1b[31m"); // red
    expect(plain(output)).toContain("✗ 1 plugin failed: websearch");
    expect(plain(output)).toContain("/plugin list");
  });

  it("colors modes semantically: plan=yellow, bypass=red, default=green", () => {
    const yellow = makeOutput(100);
    createRenderer({ output: yellow, color: true, tty: false }).renderBanner({ ...info, mode: "plan" });
    expect(yellow.chunks.join("")).toContain("\x1b[33m"); // yellow

    const red = makeOutput(100);
    createRenderer({ output: red, color: true, tty: false }).renderBanner({ ...info, mode: "bypass" });
    expect(red.chunks.join("")).toContain("\x1b[31m"); // red

    const green = makeOutput(100);
    createRenderer({ output: green, color: true, tty: false }).renderBanner({ ...info, mode: "default" });
    expect(green.chunks.join("")).toContain("\x1b[32m"); // green
  });

  it("shows unset model and all-loaded plugins as green", () => {
    const output = makeOutput(100);
    const renderer = createRenderer({ output, color: false, tty: false });

    renderer.renderBanner({ mode: "default", sessionId: "s", plugins: { loaded: 3, total: 3, errors: [] } });

    const text = plain(output);
    expect(text).toContain("unset");
    expect(text).toContain("3/3 loaded");
  });
});
