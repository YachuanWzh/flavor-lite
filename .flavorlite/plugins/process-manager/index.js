import { spawn } from "node:child_process";

export class RingLog {
  constructor(limit = 100_000) { this.limit = positiveInt(limit, 100_000); this.text = ""; this.cursor = 0; this.baseCursor = 0; }
  append(value) {
    const chunk = String(value);
    this.text += chunk;
    this.cursor += chunk.length;
    if (this.text.length > this.limit) {
      const cut = this.text.length - this.limit;
      this.text = this.text.slice(cut);
      this.baseCursor += cut;
    }
  }
  read(cursor = this.baseCursor) {
    const requested = Number.isFinite(cursor) ? Math.max(0, Math.floor(cursor)) : this.baseCursor;
    const truncated = requested < this.baseCursor;
    const start = Math.max(0, Math.min(this.text.length, requested - this.baseCursor));
    return { cursor: this.cursor, baseCursor: this.baseCursor, text: this.text.slice(start), truncated };
  }
}

export class ProcessRegistry {
  constructor(options = {}) {
    this.cwd = options.cwd ?? process.cwd();
    this.maxProcesses = positiveInt(options.maxProcesses, 6);
    this.maxOutputChars = positiveInt(options.maxOutputChars, 100_000);
    this.records = new Map();
    this.nextId = 1;
  }
  start({ command, label, cwd }) {
    if (typeof command !== "string" || !command.trim()) throw new Error("command is required");
    const live = [...this.records.values()].filter((record) => record.state === "running");
    if (live.length >= this.maxProcesses) throw new Error(`Process limit reached (${this.maxProcesses})`);
    if (label && live.some((record) => record.label === label)) throw new Error(`A live process already uses label "${label}"`);
    const id = `p${this.nextId++}`;
    const log = new RingLog(this.maxOutputChars);
    const child = spawn(command, {
      cwd: cwd ?? this.cwd,
      shell: true,
      windowsHide: true,
      detached: process.platform !== "win32",
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const record = { id, label: label || id, command, cwd: cwd ?? this.cwd, child, log, state: "running", pid: child.pid, startedAt: new Date().toISOString(), exitCode: undefined, endedAt: undefined };
    this.records.set(id, record);
    child.stdout.on("data", (chunk) => log.append(chunk.toString("utf8")));
    child.stderr.on("data", (chunk) => log.append(`[stderr] ${chunk.toString("utf8")}`));
    child.on("error", (error) => { log.append(`[spawn error] ${error.message}\n`); record.state = "failed"; record.endedAt = new Date().toISOString(); });
    child.on("close", (code, signal) => { record.exitCode = code; record.signal = signal; record.state = record.state === "stopping" ? "stopped" : code === 0 ? "exited" : "failed"; record.endedAt = new Date().toISOString(); });
    return view(record);
  }
  poll(id, cursor = 0) {
    const record = this.require(id);
    const output = record.log.read(cursor);
    return { ...view(record), output: output.text, cursor: output.cursor, baseCursor: output.baseCursor, truncated: output.truncated };
  }
  list() { return [...this.records.values()].map(view); }
  async stop(id) {
    const record = this.require(id);
    if (record.state !== "running" && record.state !== "stopping") return view(record);
    record.state = "stopping";
    await killTree(record.child);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
    if (record.state === "stopping") { record.state = "stopped"; record.endedAt = new Date().toISOString(); }
    return view(record);
  }
  require(id) { const record = this.records.get(id); if (!record) throw new Error(`Unknown process id "${id}"`); return record; }
  async dispose() { await Promise.all([...this.records.values()].filter((record) => record.state === "running" || record.state === "stopping").map((record) => this.stop(record.id))); }
}

export default {
  name: "process-manager",
  inject: ["hooks", "tools", "commands"],
  provides: ["processManager"],
  apply(ctx, config = {}) {
    const registry = new ProcessRegistry({ cwd: ctx.cwd, ...config });
    return ctx.effect(() => {
      const disposers = [ctx.provide("processManager", registry)];
      const tools = ctx.get("tools");
      const safe = (fn) => async (args) => { try { const value = fn(args); return { content: value instanceof Promise ? await value : value }; } catch (error) { return { content: error instanceof Error ? error.message : String(error), isError: true }; } };
      disposers.push(tools.register({ name: "process_start", description: "Start a long-running background command and return immediately with a process id.", category: "shell", inputSchema: { type: "object", properties: { command: { type: "string" }, label: { type: "string" } }, required: ["command"] }, execute: safe((args) => format(registry.start(args))) }));
      disposers.push(tools.register({ name: "process_poll", description: "Read new output and state from a background process. Reuse the returned cursor for incremental polling.", category: "read", inputSchema: { type: "object", properties: { id: { type: "string" }, cursor: { type: "number" } }, required: ["id"] }, execute: safe((args) => formatPoll(registry.poll(args.id, args.cursor ?? 0))) }));
      disposers.push(tools.register({ name: "process_list", description: "List background processes and their current state.", category: "read", inputSchema: { type: "object", properties: {} }, execute: safe(() => formatList(registry.list())) }));
      disposers.push(tools.register({ name: "process_stop", description: "Stop a background process and its descendants.", category: "shell", inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] }, execute: safe(async (args) => format(await registry.stop(args.id))) }));
      disposers.push(ctx.get("commands").register({ name: "processes", description: "List managed background processes", run: () => formatList(registry.list()) }));
      disposers.push(ctx.get("hooks").hook("prompt/assemble", async (event, next) => { event.sections.push({ name: "process-manager", content: "Use process_start for development servers and watchers that must outlive one tool call. Poll logs with the returned cursor, and stop processes when they are no longer needed." }); return next(event); }));
      return async () => { for (const dispose of disposers.reverse()) dispose(); await registry.dispose(); };
    }, "process-manager.install");
  },
};

function view(record) { return { id: record.id, label: record.label, command: record.command, cwd: record.cwd, state: record.state, pid: record.pid, startedAt: record.startedAt, endedAt: record.endedAt, exitCode: record.exitCode, signal: record.signal }; }
function format(record) { return `${record.id} [${record.state}] ${record.label}${record.pid ? ` pid=${record.pid}` : ""}\n${record.command}`; }
function formatPoll(record) { return `${format(record)}\ncursor=${record.cursor}${record.truncated ? ` (older output truncated; base=${record.baseCursor})` : ""}${record.output ? `\n${record.output}` : "\n(no new output)"}`; }
function formatList(records) { return records.length ? records.map((record) => `${record.id}  ${record.state.padEnd(8)}  ${record.label}  ${record.command}`).join("\n") : "No managed processes."; }
async function killTree(child) {
  if (!child.pid) { child.kill("SIGKILL"); return; }
  if (process.platform === "win32") await new Promise((resolvePromise) => { const killer = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" }); killer.on("close", resolvePromise); killer.on("error", () => { child.kill("SIGKILL"); resolvePromise(); }); });
  else { try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); } }
}
function positiveInt(value, fallback) { return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback; }
