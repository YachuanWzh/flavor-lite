import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

const LEGACY_PROTOCOL = "2025-06-18";
const CURRENT_PROTOCOL = "2026-07-28";

class StdioClient {
  constructor(name, definition, cwd, timeoutMs, logger) {
    this.name = name;
    this.definition = definition;
    this.cwd = cwd;
    this.timeoutMs = timeoutMs;
    this.logger = logger;
    this.nextId = 1;
    this.pending = new Map();
    this.buffer = "";
  }

  async start() {
    if (this.child) return;
    const env = { ...process.env, ...(this.definition.env ?? {}) };
    this.child = spawn(this.definition.command, this.definition.args ?? [], {
      cwd: this.definition.cwd ? resolve(this.cwd, this.definition.cwd) : this.cwd,
      env,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child.stdout.setEncoding("utf-8");
    this.child.stdout.on("data", (chunk) => this.onData(chunk));
    this.child.stderr.on("data", (chunk) => this.logger.debug?.(`mcp:${this.name}: ${String(chunk).trim()}`));
    this.child.on("error", (error) => this.failAll(error));
    this.child.on("close", (code) => this.failAll(new Error(`MCP server ${this.name} exited ${code}`)));
    try {
      await this.request("initialize", {
        protocolVersion: LEGACY_PROTOCOL,
        capabilities: {},
        clientInfo: { name: "flavor-lite", version: "0.3.0" },
      });
      this.notify("notifications/initialized", {});
      this.protocol = LEGACY_PROTOCOL;
    } catch {
      // 2026-07-28 removed the initialize handshake. Requests below carry
      // client identity in _meta and work against the current protocol.
      this.protocol = CURRENT_PROTOCOL;
    }
  }

  async tools() {
    const tools = [];
    let cursor;
    do {
      const result = await this.request("tools/list", cursor ? { cursor } : {});
      tools.push(...(Array.isArray(result?.tools) ? result.tools : []));
      cursor = result?.nextCursor;
    } while (cursor);
    return tools;
  }

  async call(name, args) {
    return this.request("tools/call", { name, arguments: args });
  }

  async stop() {
    const child = this.child;
    if (!child) return;
    child.kill();
    await new Promise((done) => {
      if (child.exitCode !== null) return done();
      const timer = setTimeout(done, 1500);
      child.once("close", () => { clearTimeout(timer); done(); });
    });
    this.child = undefined;
  }

  request(method, params) {
    if (!this.child) return Promise.reject(new Error(`MCP server ${this.name} is not connected`));
    const id = this.nextId++;
    const meta = this.protocol === CURRENT_PROTOCOL
      ? {
          "io.modelcontextprotocol/protocolVersion": CURRENT_PROTOCOL,
          "io.modelcontextprotocol/clientCapabilities": {},
          "io.modelcontextprotocol/clientInfo": { name: "flavor-lite", version: "0.3.0" },
        }
      : undefined;
    return new Promise((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        rejectPromise(new Error(`MCP ${this.name} ${method} timed out after ${this.timeoutMs}ms`));
      }, this.timeoutMs);
      this.pending.set(id, {
        resolve: (value) => { clearTimeout(timer); resolvePromise(value); },
        reject: (error) => { clearTimeout(timer); rejectPromise(error); },
      });
      this.send({ jsonrpc: "2.0", id, method, params: meta ? { ...params, _meta: meta } : params });
    });
  }

  notify(method, params) {
    this.send({ jsonrpc: "2.0", method, params });
  }

  send(message) {
    this.child?.stdin.write(`${JSON.stringify(message)}\n`);
  }

  onData(chunk) {
    this.buffer += chunk;
    for (;;) {
      const newline = this.buffer.indexOf("\n");
      if (newline < 0) break;
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (!line.trim()) continue;
      let message;
      try { message = JSON.parse(line); } catch { continue; }
      if (message.id !== undefined && (message.result !== undefined || message.error !== undefined)) {
        const pending = this.pending.get(message.id);
        if (!pending) continue;
        this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(message.error.message ?? JSON.stringify(message.error)));
        else pending.resolve(message.result);
      } else if (message.id !== undefined && message.method) {
        this.send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: `Client method not supported: ${message.method}` } });
      }
    }
  }

  failAll(error) {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
}

function safeName(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 48) || "tool";
}

function resultText(result) {
  const blocks = Array.isArray(result?.content) ? result.content : [];
  const lines = blocks.map((block) => block?.type === "text" ? block.text : JSON.stringify(block));
  return lines.join("\n") || JSON.stringify(result?.structuredContent ?? result ?? {});
}

async function readDefinitions(cwd, config) {
  if (config.servers && typeof config.servers === "object") return config.servers;
  const path = isAbsolute(config.path ?? "") ? config.path : resolve(cwd, config.path ?? ".flavorlite/mcp.json");
  try {
    const parsed = JSON.parse(await readFile(path, "utf-8"));
    return parsed.servers ?? parsed;
  } catch {
    return {};
  }
}

export default {
  name: "mcp-bridge",
  inject: ["tools", "commands"],
  provides: ["mcp"],
  async apply(ctx, config = {}) {
    const definitions = await readDefinitions(ctx.cwd, config);
    const clients = new Map();
    const toolDisposers = new Map();
    const registry = ctx.get("tools");
    const timeoutMs = Number.isFinite(config.requestTimeoutMs) ? config.requestTimeoutMs : 30000;

    const disconnect = async (name) => {
      for (const dispose of toolDisposers.get(name) ?? []) dispose();
      toolDisposers.delete(name);
      await clients.get(name)?.stop();
      clients.delete(name);
    };

    const connect = async (name) => {
      if (clients.has(name)) return `${name} already connected`;
      const definition = definitions[name];
      if (!definition?.command) throw new Error(`MCP server "${name}" is not configured`);
      const client = new StdioClient(name, definition, ctx.cwd, timeoutMs, ctx.logger);
      await client.start();
      const remoteTools = await client.tools();
      const disposers = [];
      for (const remote of remoteTools) {
        const exposed = `mcp_${safeName(name)}_${safeName(remote.name)}`;
        disposers.push(registry.register({
          name: exposed,
          description: `[MCP:${name}] ${remote.description ?? remote.name}`,
          category: definition.category ?? "shell",
          inputSchema: remote.inputSchema ?? { type: "object" },
          async execute(args) {
            try {
              const result = await client.call(remote.name, args);
              return { content: resultText(result), isError: result?.isError === true, data: result?.structuredContent };
            } catch (error) {
              return { content: error instanceof Error ? error.message : String(error), isError: true, retryable: true };
            }
          },
        }));
      }
      clients.set(name, client);
      toolDisposers.set(name, disposers);
      return `connected ${name}: ${remoteTools.length} tool(s)`;
    };

    const service = { connect, disconnect, list: () => [...clients.keys()] };
    const disposeService = ctx.provide("mcp", service);
    const disposeCommand = ctx.get("commands").register({
      name: "mcp",
      description: "Manage MCP stdio servers (/mcp list|connect <name>|disconnect <name>)",
      async run(args) {
        const [sub = "list", name] = args.trim().split(/\s+/);
        if (sub === "list") {
          const names = Object.keys(definitions);
          return names.length ? names.map((value) => `${value}: ${clients.has(value) ? "connected" : "disconnected"}`).join("\n") : "no MCP servers configured";
        }
        if (sub === "connect") return name ? connect(name) : "usage: /mcp connect <name>";
        if (sub === "disconnect") { if (!name) return "usage: /mcp disconnect <name>"; await disconnect(name); return `disconnected ${name}`; }
        return `unknown MCP command "${sub}"`;
      },
    });
    for (const name of config.autoConnect ?? []) await connect(name).catch((error) => ctx.logger.warn(`MCP auto-connect ${name} failed: ${error.message}`));
    return async () => {
      disposeCommand();
      disposeService();
      for (const name of [...clients.keys()]) await disconnect(name);
    };
  },
};
