import { describe, expect, it } from "vitest";
import { Runtime, definePlugin } from "../src/kernel";
import { toolsPlugin, type Tool, type ToolRegistry } from "../src/plugins/tools";
import { permissionPlugin, type InteractionService, type PermissionService } from "../src/plugins/permission";
import type { PermissionMode } from "../src/plugins/permission";

const writeTool: Tool = {
  name: "FakeWrite",
  description: "pretends to write a file",
  category: "write",
  inputSchema: { type: "object", properties: { path: { type: "string" } } },
  async execute() {
    return { content: "written" };
  },
};

const shellTool: Tool = {
  name: "FakeShell",
  description: "pretends to run a command",
  category: "shell",
  inputSchema: { type: "object", properties: { command: { type: "string" } } },
  async execute(args) {
    return { content: `ran: ${String(args.command)}` };
  },
};

const testToolsPlugin = definePlugin({
  name: "tool:fake",
  inject: ["tools"],
  apply(ctx) {
    return ctx.effect(() => {
      const registry = ctx.get("tools") as ToolRegistry;
      const d1 = registry.register(writeTool);
      const d2 = registry.register(shellTool);
      return () => {
        d2();
        d1();
      };
    }, "tool:fake.register");
  },
});

function mount(mode: PermissionMode, interaction?: InteractionService): Runtime {
  const runtime = Runtime.create({ cwd: "/tmp/flavor-lite-permission-test" });
  runtime.use(toolsPlugin).use(testToolsPlugin).use(permissionPlugin, { mode });
  runtime.start();
  if (interaction) runtime.ctx.provide("interaction", interaction);
  return runtime;
}

async function call(runtime: Runtime, name: string, args: Record<string, unknown>) {
  const registry = runtime.ctx.get("tools") as ToolRegistry;
  return registry.execute({ id: "c1", name, args }, { cwd: runtime.ctx.cwd });
}

describe("permission plugin", () => {
  it("plan mode blocks writes and shell, allows reads", async () => {
    const runtime = mount("plan");
    const result = await call(runtime, "FakeWrite", { path: "a.txt" });
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/plan/);
    const permission = runtime.ctx.get("permission") as PermissionService;
    expect(permission.evaluateStatic("read", {})).toEqual({ allow: true });
    await runtime.dispose();
  });

  it("hard-dangerous commands are blocked even in bypass", async () => {
    const runtime = mount("bypass");
    const result = await call(runtime, "FakeShell", { command: "rm -rf /" });
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/dangerous/i);
    await runtime.dispose();
  });

  it("bypass auto-approves normal shell commands", async () => {
    const runtime = mount("bypass");
    const result = await call(runtime, "FakeShell", { command: "npm test" });
    expect(result.isError).toBeUndefined();
    expect(result.content).toBe("ran: npm test");
    await runtime.dispose();
  });

  it("default mode fails closed without an interaction service", async () => {
    const runtime = mount("default");
    const result = await call(runtime, "FakeWrite", { path: "a.txt" });
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/approval/i);
    await runtime.dispose();
  });

  it("default mode asks once and remembers the approval", async () => {
    let questions = 0;
    const interaction: InteractionService = {
      async ask() {
        return undefined;
      },
      async confirm() {
        questions += 1;
        return true;
      },
    };
    const runtime = mount("default", interaction);
    const first = await call(runtime, "FakeWrite", { path: "a.txt" });
    expect(first.isError).toBeUndefined();
    const second = await call(runtime, "FakeWrite", { path: "a.txt" });
    expect(second.isError).toBeUndefined();
    expect(questions).toBe(1); // approval remembered for the session
    await runtime.dispose();
  });

  it("rejects path traversal arguments in any mode", async () => {
    const runtime = mount("bypass");
    const result = await call(runtime, "FakeWrite", { path: "../../etc/passwd" });
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/\.\./);
    await runtime.dispose();
  });

  it("denied approvals surface as blocked results", async () => {
    const interaction: InteractionService = {
      async ask() {
        return undefined;
      },
      async confirm() {
        return false;
      },
    };
    const runtime = mount("default", interaction);
    const result = await call(runtime, "FakeWrite", { path: "a.txt" });
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/denied/i);
    await runtime.dispose();
  });
});
