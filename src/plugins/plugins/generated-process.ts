import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { pathToFileURL } from "node:url";

import type { ToolResult } from "../tools";

export interface GeneratedToolDescriptor {
  name: string;
  description: string;
  category: "read" | "write" | "shell" | "control";
  inputSchema: Record<string, unknown>;
}

export interface GeneratedCommandDescriptor {
  name: string;
  description: string;
}

export interface GeneratedDescriptor {
  name: string;
  inject: string[];
  provides: string[];
  tools: GeneratedToolDescriptor[];
  commands: GeneratedCommandDescriptor[];
  promptHooks: number;
}

type Broker = (
  tool: string,
  args: Record<string, unknown>,
  parentRequestId?: number,
) => Promise<ToolResult>;

interface Pending {
  resolve(value: unknown): void;
  reject(error: Error): void;
}

export class GeneratedPluginProcess {
  private child: ChildProcessWithoutNullStreams | undefined;
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  private buffer = "";
  private descriptor: GeneratedDescriptor | undefined;

  constructor(
    private readonly entryPath: string,
    private readonly root: string,
    private readonly config: Record<string, unknown>,
    private readonly broker: Broker,
    private readonly timeoutMs: number,
    private readonly memoryMB = 128,
    private readonly maxOutputChars = 100_000,
  ) {}

  async start(): Promise<GeneratedDescriptor> {
    if (this.descriptor) return this.descriptor;
    const child = spawn(
      process.execPath,
      [
        `--max-old-space-size=${Math.max(16, Math.floor(this.memoryMB))}`,
        "--permission",
        `--allow-fs-read=${this.root}`,
        "--input-type=module",
        "--eval",
        GENERATED_WORKER_SCRIPT,
        pathToFileURL(this.entryPath).href,
        JSON.stringify(this.config),
      ],
      { cwd: this.root, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] },
    );
    this.child = child;
    child.stdout.setEncoding("utf-8");
    child.stdout.on("data", (chunk: string) => this.onData(chunk));
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr = `${stderr}${String(chunk)}`.slice(-8_000);
    });
    child.on("error", (error) => this.failAll(error));
    child.on("close", (code) => {
      if (code !== 0 && !this.descriptor) this.failAll(new Error(`generated plugin process exited ${code}: ${stderr.trim()}`));
      else this.failAll(new Error("generated plugin process closed"));
    });
    const ready = await this.request("ready", {});
    this.descriptor = ready as GeneratedDescriptor;
    return this.descriptor;
  }

  tool(name: string, args: Record<string, unknown>, context: Record<string, unknown>): Promise<ToolResult> {
    return this.request("tool", { name, args, context }).then((value) => {
      const result = value as ToolResult;
      if (result.content.length <= this.maxOutputChars) return result;
      return {
        ...result,
        content: `${result.content.slice(0, this.maxOutputChars)}\n\n[isolated plugin output truncated]`,
        truncated: true,
      };
    });
  }

  command(name: string, args: string): Promise<string | undefined> {
    return this.request("command", { name, args }) as Promise<string | undefined>;
  }

  prompt(event: { cwd: string }): Promise<Array<{ name: string; content: string; priority?: number; maxChars?: number; source?: string }>> {
    return this.request("prompt", event) as Promise<Array<{ name: string; content: string; priority?: number; maxChars?: number; source?: string }>>;
  }

  async dispose(): Promise<void> {
    const child = this.child;
    if (!child) return;
    try {
      await this.request("dispose", {});
    } catch {
      /* process may already be gone */
    }
    if (child.exitCode === null) child.kill();
    await new Promise<void>((resolvePromise) => {
      if (child.exitCode !== null) return resolvePromise();
      const timer = setTimeout(resolvePromise, 2_000);
      child.once("close", () => {
        clearTimeout(timer);
        resolvePromise();
      });
    });
    this.child = undefined;
  }

  private request(method: string, payload: unknown): Promise<unknown> {
    if (!this.child) return Promise.reject(new Error("generated plugin process is not running"));
    const id = this.nextId++;
    return new Promise((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        rejectPromise(new Error(`generated plugin RPC "${method}" timed out after ${this.timeoutMs}ms`));
      }, this.timeoutMs);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolvePromise(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          rejectPromise(error);
        },
      });
      this.send({ type: "request", id, method, payload });
    });
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    const maxRpcChars = Math.max(1_000_000, this.maxOutputChars * 4);
    if (this.buffer.length > maxRpcChars && !this.buffer.includes("\n")) {
      const error = new Error(`generated plugin RPC message exceeds ${maxRpcChars} characters`);
      this.child?.kill();
      this.failAll(error);
      this.buffer = "";
      return;
    }
    for (;;) {
      const newline = this.buffer.indexOf("\n");
      if (newline < 0) break;
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (!line.trim()) continue;
      if (line.length > maxRpcChars) {
        const error = new Error(`generated plugin RPC message exceeds ${maxRpcChars} characters`);
        this.child?.kill();
        this.failAll(error);
        this.buffer = "";
        return;
      }
      let message: Record<string, unknown>;
      try {
        message = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }
      if (message.type === "response") {
        const pending = this.pending.get(Number(message.id));
        if (!pending) continue;
        this.pending.delete(Number(message.id));
        if (message.ok === false) pending.reject(new Error(String(message.error ?? "generated plugin RPC failed")));
        else pending.resolve(message.value);
      } else if (message.type === "broker") {
        const id = Number(message.id);
        void this.broker(
          String(message.tool),
          (message.args as Record<string, unknown>) ?? {},
          typeof message.parentRequestId === "number" ? message.parentRequestId : undefined,
        ).then(
          (value) => this.send({ type: "broker-response", id, ok: true, value }),
          (error) => this.send({ type: "broker-response", id, ok: false, error: error instanceof Error ? error.message : String(error) }),
        );
      }
    }
  }

  private send(message: unknown): void {
    this.child?.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private failAll(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
}

const GENERATED_WORKER_SCRIPT = String.raw`
import { createInterface } from "node:readline";
import { AsyncLocalStorage } from "node:async_hooks";
const entry = process.argv[1];
const config = JSON.parse(process.argv[2] || "{}");
const tools = new Map();
const commands = new Map();
const promptHooks = [];
const disposers = [];
const pendingBroker = new Map();
const callScope = new AsyncLocalStorage();
let brokerId = 1;
let plugin;
const send = (value) => process.stdout.write(JSON.stringify(value) + "\n");
for (const key of ["log", "info", "warn", "error", "debug"]) console[key] = (...args) => process.stderr.write(args.map(String).join(" ") + "\n");
const capabilities = {
  call(tool, args = {}) {
    const id = brokerId++;
    return new Promise((resolve, reject) => {
      pendingBroker.set(id, { resolve, reject });
      send({ type: "broker", id, tool, args, parentRequestId: callScope.getStore() });
    });
  },
};
const services = {
  tools: { register(value) { tools.set(value.name, value); const d=()=>tools.delete(value.name); disposers.push(d); return d; }, list:()=>[...tools.values()], schemas:()=>[] },
  commands: { register(value) { commands.set(value.name, value); const d=()=>commands.delete(value.name); disposers.push(d); return d; }, list:()=>[...commands.values()] },
  hooks: { hook(name, listener) { if (name !== "prompt/assemble") throw new Error("isolated generated plugins may only register prompt/assemble hooks"); promptHooks.push(listener); const d=()=>{const i=promptHooks.indexOf(listener);if(i>=0)promptHooks.splice(i,1)}; disposers.push(d); return d; }, waterfall:async(_n,v)=>v },
  systemPrompt: { assemble: async()=>"" },
  skills: { discover: async()=>[], usedInRun: async()=>[] },
  capabilities,
};
const aborter = new AbortController();
const ctx = {
  cwd: process.cwd(), signal: aborter.signal, active: true,
  logger: { debug:()=>{}, info:()=>{}, warn:()=>{}, error:()=>{} },
  get(key) { if (!(key in services)) throw new Error("isolated service unavailable: " + key); return services[key]; },
  tryGet(key) { return services[key]; },
  whenAvailable(key) { return key in services ? Promise.resolve(services[key]) : Promise.reject(new Error("isolated service unavailable: " + key)); },
  provide() { throw new Error("isolated generated plugins cannot provide host services"); },
  effect(setup) { const result=setup(); if(typeof result==="function") disposers.push(result); return result; },
};
async function activate() {
  const mod = await import(entry + "?isolated=" + Date.now());
  if (Array.isArray(mod.default)) throw new Error("isolated generated plugin entry must export exactly one plugin");
  plugin = mod.default;
  if (!plugin || typeof plugin.apply !== "function") throw new Error("invalid generated plugin export");
  const returned = await plugin.apply(ctx, config);
  if (typeof returned === "function") disposers.push(returned);
}
const ready = activate();
const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", async (line) => {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  if (message.type === "broker-response") {
    const pending = pendingBroker.get(message.id); if(!pending)return; pendingBroker.delete(message.id);
    message.ok ? pending.resolve(message.value) : pending.reject(new Error(message.error)); return;
  }
  if (message.type !== "request") return;
  const respond = (ok, value, error) => send({ type: "response", id: message.id, ok, value, error });
  try {
    await ready;
    const payload = message.payload || {};
    if (message.method === "ready") {
      respond(true, { name: plugin.name, inject: plugin.inject || [], provides: plugin.provides || [], tools: [...tools.values()].map(t=>({name:t.name,description:t.description,category:t.category,inputSchema:t.inputSchema})), commands: [...commands.values()].map(c=>({name:c.name,description:c.description})), promptHooks: promptHooks.length });
    } else if (message.method === "tool") {
      const tool=tools.get(payload.name); if(!tool)throw new Error("tool not registered: "+payload.name);
      respond(true, await callScope.run(message.id, ()=>tool.execute(payload.args || {}, { cwd: payload.context?.cwd || process.cwd() })));
    } else if (message.method === "command") {
      const command=commands.get(payload.name); if(!command)throw new Error("command not registered: "+payload.name); respond(true, await command.run(payload.args || ""));
    } else if (message.method === "prompt") {
      const event={cwd:payload.cwd,sections:[]}; let index=0; const next=async(value)=>{const listener=promptHooks[index++];return listener?await listener(value,next):value}; await next(event); respond(true,event.sections);
    } else if (message.method === "dispose") {
      aborter.abort(); for(const dispose of disposers.reverse()){try{await dispose()}catch{}} respond(true,true); setTimeout(()=>process.exit(0),0);
    } else throw new Error("unknown method: "+message.method);
  } catch (error) { respond(false, undefined, error?.message || String(error)); }
});
`;
