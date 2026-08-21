import { afterEach, describe, expect, it } from "vitest";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

import { createAgent } from "../src/host/bootstrap";
import type { PluginsLoaderService } from "../src/plugins/plugins";
import type { CommandsService } from "../src/plugins/commands";
import type { ToolRegistry } from "../src/plugins/tools";

describe("mcp bridge", () => {
  let root: string | undefined;
  let handle: ReturnType<typeof createAgent> | undefined;

  afterEach(async () => {
    await handle?.dispose();
    if (root) await rm(root, { recursive: true, force: true });
  });

  it("falls back from legacy initialize and sends self-describing 2026 requests", async () => {
    root = await mkdtemp(join(tmpdir(), "flavor-mcp-"));
    const pluginRoot = join(root, ".flavorlite", "plugins", "mcp-bridge");
    await mkdir(pluginRoot, { recursive: true });
    await cp(resolve(".flavorlite/plugins/mcp-bridge"), pluginRoot, { recursive: true });

    const serverPath = join(root, "fake-mcp.mjs");
    await writeFile(serverPath, `
import { createInterface } from "node:readline";
const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
rl.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") return send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "removed" } });
  const meta = message.params?._meta ?? {};
  if (meta["io.modelcontextprotocol/protocolVersion"] !== "2026-07-28" || !("io.modelcontextprotocol/clientCapabilities" in meta)) {
    return send({ jsonrpc: "2.0", id: message.id, error: { code: -32022, message: "missing current metadata" } });
  }
  if (message.method === "tools/list") return send({ jsonrpc: "2.0", id: message.id, result: { resultType: "complete", tools: [{ name: "echo", description: "echo input", inputSchema: { type: "object" } }], ttlMs: 1000, cacheScope: "private" } });
  if (message.method === "tools/call") return send({ jsonrpc: "2.0", id: message.id, result: { resultType: "complete", content: [{ type: "text", text: String(message.params.arguments.value) }] } });
});
`, "utf-8");
    await writeFile(join(root, ".flavorlite", "mcp.json"), JSON.stringify({
      servers: { fake: { command: process.execPath, args: [serverPath], category: "read" } },
    }), "utf-8");

    handle = createAgent({ cwd: root, requireProvider: false, config: { mode: "bypass" } });
    await handle.ready;
    const loader = handle.runtime.ctx.get("pluginsLoader") as PluginsLoaderService;
    await loader.reload("mcp-bridge");
    const commands = handle.runtime.ctx.get("commands") as CommandsService;
    expect(await commands.execute("/mcp connect fake")).toBe("connected fake: 1 tool(s)");

    const tools = handle.runtime.ctx.get("tools") as ToolRegistry;
    const result = await tools.execute({ id: "mcp-1", name: "mcp_fake_echo", args: { value: "hello" } }, { cwd: root });
    expect(result).toMatchObject({ content: "hello", isError: false });
  });
});
