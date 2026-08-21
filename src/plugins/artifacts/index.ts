import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { definePlugin } from "../../kernel";
import type { PluginContext } from "../../kernel/types";
import type { ArtifactRef } from "../tools/registry";

export interface ArtifactPutOptions {
  runId?: string;
  mimeType?: string;
  description?: string;
  extension?: string;
}

export interface ArtifactService {
  put(content: string | Uint8Array, options?: ArtifactPutOptions): Promise<ArtifactRef>;
  read(id: string): Promise<string | Uint8Array | undefined>;
  list(limit?: number): Promise<ArtifactRef[]>;
  prune(): Promise<number>;
  root(): string;
}

export interface ArtifactsPluginConfig {
  path?: string;
  maxFiles?: number;
  maxAgeDays?: number;
}

class ArtifactStore implements ArtifactService {
  constructor(
    private readonly rootPath: string,
    private readonly maxFiles: number,
    private readonly maxAgeMs: number,
  ) {}

  root(): string {
    return this.rootPath;
  }

  async put(content: string | Uint8Array, options: ArtifactPutOptions = {}): Promise<ArtifactRef> {
    await mkdir(this.rootPath, { recursive: true });
    const id = randomUUID();
    const extension = sanitizeExtension(options.extension ?? extensionFor(options.mimeType));
    const fileName = `${new Date().toISOString().replace(/[:.]/g, "-")}-${id}${extension}`;
    const path = join(this.rootPath, fileName);
    await writeFile(path, content);
    const size = typeof content === "string" ? Buffer.byteLength(content) : content.byteLength;
    void this.prune().catch(() => {});
    return {
      id,
      path,
      size,
      ...(options.mimeType ? { mimeType: options.mimeType } : {}),
      ...(options.description ? { description: options.description } : {}),
    };
  }

  async read(id: string): Promise<string | Uint8Array | undefined> {
    const match = (await this.entries()).find((entry) => entry.name.includes(id));
    if (!match) return undefined;
    const data = await readFile(join(this.rootPath, match.name));
    return isTextExtension(match.name) ? data.toString("utf-8") : data;
  }

  async list(limit = 50): Promise<ArtifactRef[]> {
    const entries = await this.entries();
    return entries.slice(0, Math.max(0, limit)).map((entry) => ({
      id: artifactId(entry.name),
      path: join(this.rootPath, entry.name),
      size: entry.size,
    }));
  }

  async prune(): Promise<number> {
    const entries = await this.entries();
    const cutoff = Date.now() - this.maxAgeMs;
    const remove = entries.filter((entry, index) => index >= this.maxFiles || entry.mtimeMs < cutoff);
    await Promise.all(remove.map((entry) => rm(join(this.rootPath, entry.name), { force: true })));
    return remove.length;
  }

  private async entries(): Promise<Array<{ name: string; size: number; mtimeMs: number }>> {
    let names: string[];
    try {
      names = await readdir(this.rootPath);
    } catch {
      return [];
    }
    const entries = await Promise.all(
      names.map(async (name) => {
        const info = await stat(join(this.rootPath, name));
        return { name, size: info.size, mtimeMs: info.mtimeMs };
      }),
    );
    return entries.sort((a, b) => b.mtimeMs - a.mtimeMs);
  }
}

function extensionFor(mimeType?: string): string {
  if (mimeType === "application/json") return ".json";
  if (mimeType === "text/markdown") return ".md";
  return ".txt";
}

function sanitizeExtension(extension: string): string {
  const value = extension.startsWith(".") ? extension : `.${extension}`;
  return /^\.[a-zA-Z0-9]{1,10}$/.test(value) ? value : ".bin";
}

function isTextExtension(path: string): boolean {
  return /\.(?:txt|md|json|jsonl|log|diff|patch)$/i.test(path);
}

function artifactId(name: string): string {
  return /([0-9a-f]{8}-[0-9a-f-]{27,})/i.exec(name)?.[1] ?? name;
}

export const artifactsPlugin = definePlugin<ArtifactsPluginConfig>({
  name: "artifacts",
  provides: ["artifacts"],
  apply(ctx: PluginContext, config: ArtifactsPluginConfig = {}) {
    const root = config.path ?? join(ctx.cwd, ".flavorlite", "artifacts");
    const service = new ArtifactStore(root, Math.max(1, config.maxFiles ?? 200), Math.max(1, config.maxAgeDays ?? 14) * 86_400_000);
    return ctx.effect(() => ctx.provide("artifacts", service), "artifacts.provide");
  },
});

declare module "../../kernel/types" {
  interface ServiceMap {
    artifacts: ArtifactService;
  }
}
