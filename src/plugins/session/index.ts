/**
 * Session plugin: append-only JSONL persistence under `.flavor/sessions/`.
 * Follows dsh's rule "model-visible ⇔ logged": the loop appends every message
 * that can reach a model request, so a session file fully reconstructs state.
 */

import { randomBytes } from "node:crypto";
import { appendFile, mkdir, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { definePlugin } from "../../kernel";
import type { PluginContext } from "../../kernel/types";
import type { Message } from "../../shared/messages";

export interface SessionHeader {
  id: string;
  cwd: string;
  createdAt: string;
  model?: string;
}

export type SessionLine =
  | { type: "header"; header: SessionHeader }
  | { type: "message"; message: Message }
  | { type: "title"; title: string };

export interface SessionInfo {
  id: string;
  cwd: string;
  updatedAt: number;
  title?: string;
  messageCount: number;
}

export interface SessionHandle {
  readonly id: string;
  /** All model-visible messages in order. */
  messages(): Message[];
  /** Append one model-visible message to the log. */
  append(message: Message): Promise<void>;
  setTitle(title: string): Promise<void>;
  title(): string | undefined;
}

export interface SessionService {
  readonly dir: string;
  /** Create a fresh session and write its header line. */
  create(options?: { model?: string }): Promise<SessionHandle>;
  /** Open a persisted session; throws when the file is missing. */
  open(id: string): Promise<SessionHandle>;
  /** Most recently updated session id, if any. */
  latest(): Promise<string | undefined>;
  list(): Promise<SessionInfo[]>;
}

function newSessionId(): string {
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, "0");
  const stamp =
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `${stamp}-${randomBytes(3).toString("hex")}`;
}

function parseLines(raw: string): SessionLine[] {
  const lines: SessionLine[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      lines.push(JSON.parse(trimmed) as SessionLine);
    } catch {
      // A torn trailing line from a crash is quarantined by skipping, matching
      // flavor-code's corrupt-isolation policy without losing the whole file.
    }
  }
  return lines;
}

class SessionHandleImpl implements SessionHandle {
  private cachedTitle: string | undefined;

  constructor(
    readonly id: string,
    private readonly filePath: string,
    private readonly history: Message[],
    initialTitle?: string,
  ) {
    this.cachedTitle = initialTitle;
  }

  messages(): Message[] {
    return this.history;
  }

  title(): string | undefined {
    return this.cachedTitle;
  }

  async append(message: Message): Promise<void> {
    this.history.push(message);
    const line: SessionLine = { type: "message", message };
    await appendFile(this.filePath, `${JSON.stringify(line)}\n`, "utf-8");
  }

  async setTitle(title: string): Promise<void> {
    this.cachedTitle = title;
    const line: SessionLine = { type: "title", title };
    await appendFile(this.filePath, `${JSON.stringify(line)}\n`, "utf-8");
  }
}

class SessionServiceImpl implements SessionService {
  readonly dir: string;

  constructor(private readonly ctx: PluginContext) {
    this.dir = join(ctx.cwd, ".flavor", "sessions");
  }

  async create(options?: { model?: string }): Promise<SessionHandle> {
    await mkdir(this.dir, { recursive: true });
    const id = newSessionId();
    const header: SessionHeader = {
      id,
      cwd: this.ctx.cwd,
      createdAt: new Date().toISOString(),
      ...(options?.model ? { model: options.model } : {}),
    };
    const filePath = this.filePath(id);
    await writeFile(filePath, `${JSON.stringify({ type: "header", header } satisfies SessionLine)}\n`, "utf-8");
    return new SessionHandleImpl(id, filePath, []);
  }

  async open(id: string): Promise<SessionHandle> {
    const filePath = this.filePath(id);
    const raw = await readFile(filePath, "utf-8");
    const history: Message[] = [];
    let title: string | undefined;
    for (const line of parseLines(raw)) {
      if (line.type === "message") history.push(line.message);
      else if (line.type === "title") title = line.title;
    }
    return new SessionHandleImpl(id, filePath, history, title);
  }

  async latest(): Promise<string | undefined> {
    const infos = await this.list();
    return infos[0]?.id;
  }

  async list(): Promise<SessionInfo[]> {
    let entries: string[];
    try {
      entries = await readdir(this.dir);
    } catch {
      return [];
    }
    const infos: SessionInfo[] = [];
    for (const entry of entries) {
      if (!entry.endsWith(".jsonl")) continue;
      const filePath = join(this.dir, entry);
      try {
        const fileStat = await stat(filePath);
        const raw = await readFile(filePath, "utf-8");
        const lines = parseLines(raw);
        const header = lines.find((line) => line.type === "header");
        const title = lines.filter((line) => line.type === "title").pop();
        infos.push({
          id: entry.slice(0, -".jsonl".length),
          cwd: header?.type === "header" ? header.header.cwd : "",
          updatedAt: fileStat.mtimeMs,
          title: title?.type === "title" ? title.title : undefined,
          messageCount: lines.filter((line) => line.type === "message").length,
        });
      } catch {
        continue;
      }
    }
    infos.sort((a, b) => b.updatedAt - a.updatedAt);
    return infos;
  }

  private filePath(id: string): string {
    if (!/^[A-Za-z0-9-]+$/.test(id)) throw new Error(`invalid session id: ${id}`);
    return join(this.dir, `${id}.jsonl`);
  }
}

export interface SessionPluginConfig {
  enabled?: boolean;
}

export const sessionPlugin = definePlugin<SessionPluginConfig>({
  name: "session",
  provides: ["session"],
  apply(ctx: PluginContext, config: SessionPluginConfig = {}) {
    if (config.enabled === false) return;
    return ctx.effect(() => ctx.provide("session", new SessionServiceImpl(ctx)), "session.provide");
  },
});

/** Atomic rewrite helper for future compaction rewrites of a session file. */
export async function rewriteSessionFile(dir: string, id: string, lines: SessionLine[]): Promise<void> {
  const filePath = join(dir, `${id}.jsonl`);
  const tmp = `${filePath}.tmp`;
  await writeFile(tmp, lines.map((line) => JSON.stringify(line)).join("\n") + "\n", "utf-8");
  await rename(tmp, filePath);
}

declare module "../../kernel/types" {
  interface ServiceMap {
    session: SessionService;
  }
}
