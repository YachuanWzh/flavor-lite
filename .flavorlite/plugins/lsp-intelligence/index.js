import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { extname, isAbsolute, relative, resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const DEFAULT_SERVERS = {
  ".ts": { command: "typescript-language-server", args: ["--stdio"], languageId: "typescript" },
  ".tsx": { command: "typescript-language-server", args: ["--stdio"], languageId: "typescriptreact" },
  ".js": { command: "typescript-language-server", args: ["--stdio"], languageId: "javascript" },
  ".jsx": { command: "typescript-language-server", args: ["--stdio"], languageId: "javascriptreact" },
  ".py": { command: "pyright-langserver", args: ["--stdio"], languageId: "python" },
  ".rs": { command: "rust-analyzer", args: [], languageId: "rust" },
  ".go": { command: "gopls", args: ["serve"], languageId: "go" },
  ".c": { command: "clangd", args: [], languageId: "c" },
  ".h": { command: "clangd", args: [], languageId: "c" },
  ".cpp": { command: "clangd", args: [], languageId: "cpp" },
  ".hpp": { command: "clangd", args: [], languageId: "cpp" },
};

export class LspFrameDecoder {
  constructor() { this.buffer = Buffer.alloc(0); }
  push(chunk) {
    this.buffer = Buffer.concat([this.buffer, Buffer.from(chunk)]);
    const messages = [];
    for (;;) {
      const separator = this.buffer.indexOf("\r\n\r\n");
      if (separator < 0) break;
      const header = this.buffer.subarray(0, separator).toString("ascii");
      const match = /(?:^|\r\n)Content-Length:\s*(\d+)/i.exec(header);
      if (!match) throw new Error("Invalid LSP frame: missing Content-Length");
      const length = Number(match[1]);
      const bodyStart = separator + 4;
      if (this.buffer.length < bodyStart + length) break;
      const body = this.buffer.subarray(bodyStart, bodyStart + length).toString("utf8");
      this.buffer = this.buffer.subarray(bodyStart + length);
      messages.push(JSON.parse(body));
    }
    return messages;
  }
}

export function positionToOffset(text, position) {
  const line = Math.max(0, Number(position?.line) || 0);
  const character = Math.max(0, Number(position?.character) || 0);
  let offset = 0;
  for (let index = 0; index < line; index += 1) {
    const newline = text.indexOf("\n", offset);
    if (newline < 0) return text.length;
    offset = newline + 1;
  }
  const lineEnd = text.indexOf("\n", offset);
  return Math.min(offset + character, lineEnd < 0 ? text.length : lineEnd);
}

export function applyTextEdits(text, edits) {
  const normalized = edits.map((edit) => ({
    start: positionToOffset(text, edit.range?.start),
    end: positionToOffset(text, edit.range?.end),
    newText: typeof edit.newText === "string" ? edit.newText : "",
  })).sort((a, b) => b.start - a.start || b.end - a.end);
  for (let index = 0; index < normalized.length - 1; index += 1) {
    if (normalized[index + 1].end > normalized[index].start) throw new Error("LSP text edits overlap");
  }
  let output = text;
  for (const edit of normalized) {
    if (edit.start > edit.end) throw new Error("Invalid LSP edit range");
    output = output.slice(0, edit.start) + edit.newText + output.slice(edit.end);
  }
  return output;
}

export function normalizeWorkspaceEdit(edit) {
  const entries = [];
  if (edit?.changes && typeof edit.changes === "object") {
    for (const [uri, edits] of Object.entries(edit.changes)) entries.push({ uri, edits: Array.isArray(edits) ? edits : [] });
  }
  if (Array.isArray(edit?.documentChanges)) {
    for (const change of edit.documentChanges) {
      if (change?.textDocument?.uri && Array.isArray(change.edits)) entries.push({ uri: change.textDocument.uri, edits: change.edits });
    }
  }
  return entries;
}

class LspClient {
  constructor(root, server, options = {}) {
    this.root = root;
    this.server = server;
    this.timeoutMs = positiveInt(options.requestTimeoutMs, 10_000);
    this.diagnosticWaitMs = positiveInt(options.diagnosticWaitMs, 500);
    this.decoder = new LspFrameDecoder();
    this.pending = new Map();
    this.diagnostics = new Map();
    this.versions = new Map();
    this.nextId = 1;
    this.closed = false;
  }
  async start() {
    if (this.child) return;
    this.child = spawn(this.server.command, this.server.args ?? [], { cwd: this.root, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    this.child.stdout.on("data", (chunk) => { for (const message of this.decoder.push(chunk)) this.onMessage(message); });
    this.child.stderr.on("data", (chunk) => { this.lastStderr = (this.lastStderr || "") + chunk.toString("utf8"); });
    this.child.on("error", (error) => this.failAll(new Error(`Cannot start ${this.server.command}: ${error.message}`)));
    this.child.on("close", (code) => { this.closed = true; this.failAll(new Error(`${this.server.command} exited (${code})${this.lastStderr ? `: ${this.lastStderr.trim()}` : ""}`)); });
    await this.request("initialize", {
      processId: process.pid,
      rootUri: pathToFileURL(this.root).href,
      capabilities: { textDocument: { publishDiagnostics: {}, definition: {}, references: {}, hover: {}, rename: { prepareSupport: false } }, workspace: { workspaceEdit: { documentChanges: true } } },
      workspaceFolders: [{ uri: pathToFileURL(this.root).href, name: this.root.split(/[\\/]/).pop() }],
    });
    this.notify("initialized", {});
  }
  onMessage(message) {
    if (message.id !== undefined && this.pending.has(message.id)) {
      const pending = this.pending.get(message.id); this.pending.delete(message.id); clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(message.error.message || "LSP request failed")); else pending.resolve(message.result);
      return;
    }
    if (message.method === "textDocument/publishDiagnostics") this.diagnostics.set(message.params?.uri, message.params?.diagnostics ?? []);
  }
  send(value) {
    if (!this.child?.stdin || this.closed) throw new Error(`${this.server.command} is not running`);
    const body = JSON.stringify(value);
    this.child.stdin.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
  }
  request(method, params) {
    const id = this.nextId++;
    return new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`LSP ${method} timed out after ${this.timeoutMs}ms`)); }, this.timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve: resolvePromise, reject, timer });
      try { this.send({ jsonrpc: "2.0", id, method, params }); } catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }
  notify(method, params) { this.send({ jsonrpc: "2.0", method, params }); }
  async open(path, languageId) {
    await this.start();
    const uri = pathToFileURL(path).href;
    const text = await readFile(path, "utf8");
    const version = (this.versions.get(uri) ?? 0) + 1;
    this.versions.set(uri, version);
    this.notify("textDocument/didOpen", { textDocument: { uri, languageId, version, text } });
    return { uri, text };
  }
  async waitDiagnostics(uri) {
    if (this.diagnostics.has(uri)) return this.diagnostics.get(uri);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, this.diagnosticWaitMs));
    return this.diagnostics.get(uri) ?? [];
  }
  failAll(error) { for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); } this.pending.clear(); }
  async dispose() {
    if (!this.child || this.closed) return;
    try { await this.request("shutdown", null); this.notify("exit", null); } catch { /* force below */ }
    this.child.kill("SIGKILL"); this.closed = true;
  }
}

class LspManager {
  constructor(root, config = {}) { this.root = root; this.config = config; this.clients = new Map(); this.servers = { ...DEFAULT_SERVERS, ...(config.servers ?? {}) }; }
  async document(path) {
    const abs = resolve(this.root, path);
    if (!inside(this.root, abs)) throw new Error(`Path "${path}" escapes the workspace`);
    const extension = extname(abs).toLowerCase();
    const server = this.servers[extension];
    if (!server) throw new Error(`No language server configured for ${extension || "extensionless files"}`);
    const key = JSON.stringify([server.command, server.args ?? []]);
    let client = this.clients.get(key);
    if (!client) { client = new LspClient(this.root, server, this.config); this.clients.set(key, client); }
    const document = await client.open(abs, server.languageId ?? extension.slice(1));
    return { ...document, abs, client };
  }
  async dispose() { await Promise.all([...this.clients.values()].map((client) => client.dispose())); this.clients.clear(); }
}

async function applyWorkspaceEdit(root, edit) {
  const entries = normalizeWorkspaceEdit(edit);
  const snapshots = [];
  const staged = [];
  for (const entry of entries) {
    if (!String(entry.uri).startsWith("file:")) throw new Error(`Unsupported workspace edit URI: ${entry.uri}`);
    const path = fileURLToPath(entry.uri);
    if (!inside(root, path)) throw new Error(`Rename edit escapes workspace: ${path}`);
    const content = await readFile(path, "utf8");
    snapshots.push({ path, content });
    staged.push({ path, content: applyTextEdits(content, entry.edits) });
  }
  try { for (const file of staged) await writeFile(file.path, file.content, "utf8"); }
  catch (error) { for (const file of snapshots) await writeFile(file.path, file.content, "utf8").catch(() => {}); throw error; }
  return staged.map((file) => relative(root, file.path).replaceAll("\\", "/"));
}

export default {
  name: "lsp-intelligence",
  inject: ["hooks", "tools"],
  apply(ctx, config = {}) {
    const manager = new LspManager(ctx.cwd, config);
    return ctx.effect(() => {
      const tools = ctx.get("tools");
      const disposers = [];
      const safe = (fn) => async (args) => { try { return { content: await fn(args) }; } catch (error) { return { content: `${error instanceof Error ? error.message : String(error)}\nInstall the language server or configure lsp-intelligence.config.servers.`, isError: true }; } };
      const locate = async (args, method, extra = {}) => {
        const doc = await manager.document(args.path);
        const result = await doc.client.request(method, { textDocument: { uri: doc.uri }, position: position(args), ...extra });
        return formatLocations(result, ctx.cwd);
      };
      disposers.push(tools.register({ name: "lsp_diagnostics", description: "Get type/syntax diagnostics from the installed language server for a file.", category: "read", inputSchema: fileSchema(false), execute: safe(async (args) => { const doc = await manager.document(args.path); return formatDiagnostics(await doc.client.waitDiagnostics(doc.uri), args.path); }) }));
      disposers.push(tools.register({ name: "lsp_definition", description: "Find the semantic definition at a file position.", category: "read", inputSchema: fileSchema(true), execute: safe((args) => locate(args, "textDocument/definition")) }));
      disposers.push(tools.register({ name: "lsp_references", description: "Find semantic references at a file position.", category: "read", inputSchema: fileSchema(true), execute: safe((args) => locate(args, "textDocument/references", { context: { includeDeclaration: args.includeDeclaration !== false } })) }));
      disposers.push(tools.register({ name: "lsp_hover", description: "Get type and documentation hover information at a file position.", category: "read", inputSchema: fileSchema(true), execute: safe(async (args) => { const doc = await manager.document(args.path); const result = await doc.client.request("textDocument/hover", { textDocument: { uri: doc.uri }, position: position(args) }); return formatHover(result); }) }));
      disposers.push(tools.register({ name: "lsp_rename", description: "Use the language server to rename a symbol and atomically apply its workspace edits.", category: "write", inputSchema: { ...fileSchema(true), properties: { ...fileSchema(true).properties, newName: { type: "string" } }, required: ["path", "line", "character", "newName"] }, execute: safe(async (args) => { if (typeof args.newName !== "string" || !args.newName) throw new Error("newName is required"); const doc = await manager.document(args.path); const edit = await doc.client.request("textDocument/rename", { textDocument: { uri: doc.uri }, position: position(args), newName: args.newName }); const paths = await applyWorkspaceEdit(ctx.cwd, edit); return paths.length ? `Renamed symbol across ${paths.length} files:\n${paths.join("\n")}` : "Language server returned no rename edits."; }) }));
      disposers.push(ctx.get("hooks").hook("prompt/assemble", async (event, next) => { event.sections.push({ name: "lsp-intelligence", content: "Use LSP tools for semantic diagnostics, definitions, references and rename when a language server is available. Positions are zero-based. Fall back to AST/text search when the server is not installed." }); return next(event); }));
      return async () => { for (const dispose of disposers.reverse()) dispose(); await manager.dispose(); };
    }, "lsp-intelligence.install");
  },
};

function fileSchema(positionRequired) { return { type: "object", properties: { path: { type: "string" }, line: { type: "number" }, character: { type: "number" }, includeDeclaration: { type: "boolean" } }, required: positionRequired ? ["path", "line", "character"] : ["path"] }; }
function position(args) { return { line: Math.max(0, Math.floor(Number(args.line) || 0)), character: Math.max(0, Math.floor(Number(args.character) || 0)) }; }
function formatDiagnostics(values, path) { if (!values.length) return `No diagnostics for ${path}.`; return values.map((value) => { const start = value.range?.start ?? {}; const severity = ["", "error", "warning", "info", "hint"][value.severity] || "diagnostic"; return `${path}:${(start.line ?? 0) + 1}:${(start.character ?? 0) + 1} [${severity}] ${value.message}`; }).join("\n"); }
function formatLocations(result, root) { const values = Array.isArray(result) ? result : result ? [result] : []; if (!values.length) return "No locations found."; return values.map((value) => { const uri = value.uri ?? value.targetUri; const range = value.range ?? value.targetSelectionRange ?? value.targetRange; const path = uri?.startsWith("file:") ? relative(root, fileURLToPath(uri)).replaceAll("\\", "/") : uri; return `${path}:${(range?.start?.line ?? 0) + 1}:${(range?.start?.character ?? 0) + 1}`; }).join("\n"); }
function formatHover(result) { if (!result?.contents) return "No hover information."; const values = Array.isArray(result.contents) ? result.contents : [result.contents]; return values.map((value) => typeof value === "string" ? value : value.value ?? String(value)).join("\n\n"); }
function inside(root, abs) { const rel = relative(resolve(root), resolve(abs)); return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel)); }
function positiveInt(value, fallback) { return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback; }
