/**
 * Router plugin: on-demand plugin recall and silent ejection.
 *
 * Dynamic plugins (manifest "activation": "dynamic") stay unloaded in the
 * loader's catalog. Every model request passes through a three-level recall
 * funnel; every agent_end ejects whatever turned out to be idle:
 *
 * - L0 deterministic: manifest triggers (keywords / patterns) — author-
 *   controlled precision, microseconds.
 * - L1 inverted index: description/name/triggers tokens, IDF-weighted; the
 *   index is prebuilt on catalog changes, the query path is a pure lookup.
 * - L2 tool-name fallback (tools/before-call): an unknown tool call that a
 *   dynamic plugin claims mounts it on the spot — zero missed recalls.
 *
 * Adaptive feedback: recalled-but-unused pairs are demoted, used ones
 * boosted, via a small rolling local file (.flavorlite/router-memory.json).
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { definePlugin } from "../../kernel";
import type { PluginContext } from "../../kernel/types";
import type { Message } from "../../shared/messages";
import type { HookBusService } from "../hooks";
import type { BeforeLoopRequest, LoopAfterRun } from "../loop";
import type { PluginsLoaderService, PluginStatus } from "../plugins";
import type { ToolRegistry, BeforeToolCall, AfterToolCall } from "../tools";

export interface RouterPluginConfig {
  enabled?: boolean;
  /** Hard cap on plugins recalled per request. Default 2. */
  maxActivatePerTurn?: number;
  /** Minimum L1 score to recall. Default 1.0. */
  minScore?: number;
  /** Adaptive feedback memory. Default on. */
  feedback?: boolean;
  /** Memory file location. Default <cwd>/.flavorlite/router-memory.json. */
  memoryPath?: string;
  /** Dynamic plugins never ejected. */
  pinned?: string[];
  /** Score added per matching used memory entry. Default 2. */
  feedbackBoost?: number;
  /** Score subtracted per matching unused memory entry. Default 2. */
  feedbackPenalty?: number;
}

export interface RouterService {
  /** Score the input and return the plugin names to recall (no mounting). */
  route(input: string): Promise<string[]>;
}

interface MemoryEntry {
  fp: string[];
  plugin: string;
  used: boolean;
}

interface CandidateMatchers {
  keywords: string[];
  patterns: RegExp[];
}

interface RouterIndex {
  fingerprint: string;
  candidates: PluginStatus[];
  /** token -> postings over candidates. */
  postings: Map<string, Array<{ name: string; tf: number }>>;
  idf: Map<string, number>;
  matchers: Map<string, CandidateMatchers>;
}

const DEFAULT_MAX_ACTIVATE = 2;
const DEFAULT_MIN_SCORE = 1.0;
const MEMORY_LIMIT = 200;
const FINGERPRINT_TOKENS = 8;
const MEMORY_OVERLAP_MIN = 2;

const STOPWORDS = new Set([
  "the", "a", "an", "is", "are", "was", "were", "be", "to", "of", "in", "on",
  "for", "and", "or", "with", "please", "help", "can", "could", "you", "i",
  "my", "me", "it", "this", "that", "do", "does", "use", "using", "want",
  "need", "how", "what",
]);

/** Lowercase ascii words plus CJK single chars and bigrams. */
export function tokenize(text: string): string[] {
  const tokens: string[] = [];
  const lower = text.toLowerCase();
  for (const match of lower.matchAll(/[a-z0-9_]+/g)) {
    const token = match[0];
    if (token.length > 1 && !STOPWORDS.has(token)) tokens.push(token);
  }
  for (const run of lower.matchAll(/[\u4e00-\u9fff]+/g)) {
    const chars = run[0] ?? "";
    for (const char of chars) tokens.push(char);
    for (let i = 0; i + 1 < chars.length; i += 1) tokens.push(chars.slice(i, i + 2));
  }
  return tokens;
}

/** Stable input fingerprint: deduped sorted tokens, capped. */
export function fingerprint(tokens: string[]): string[] {
  return [...new Set(tokens)].sort().slice(0, FINGERPRINT_TOKENS);
}

function isMetaMessage(message: Message): boolean {
  return message.role === "user" && (message.content.startsWith("[steering]") || message.content.startsWith("[system]"));
}

/** The real user input of this turn: last user message that is not meta. */
function lastUserInput(messages: Message[]): string | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message && message.role === "user" && !isMetaMessage(message)) return message.content;
  }
  return undefined;
}

class Router implements RouterService {
  private index: RouterIndex | undefined;
  private memory: MemoryEntry[] = [];
  private memoryLoad: Promise<void> | undefined;
  /** plugin name -> fingerprint of the input that recalled it this run. */
  private recalledRun = new Map<string, string[]>();
  private usedToolsRun = new Set<string>();
  private l2UsedRun = new Set<string>();

  private readonly enabled: boolean;
  private readonly maxActivate: number;
  private readonly minScore: number;
  private readonly feedback: boolean;
  private readonly memoryPath: string;
  private readonly pinned: string[];
  private readonly boost: number;
  private readonly penalty: number;

  constructor(
    private readonly ctx: PluginContext,
    private readonly loader: PluginsLoaderService,
    private readonly tools: ToolRegistry,
    config: RouterPluginConfig = {},
  ) {
    this.enabled = config.enabled ?? true;
    this.maxActivate = config.maxActivatePerTurn ?? DEFAULT_MAX_ACTIVATE;
    this.minScore = config.minScore ?? DEFAULT_MIN_SCORE;
    this.feedback = config.feedback ?? true;
    this.memoryPath = config.memoryPath ?? join(ctx.cwd, ".flavorlite", "router-memory.json");
    this.pinned = config.pinned ?? [];
    this.boost = config.feedbackBoost ?? 2;
    this.penalty = config.feedbackPenalty ?? 2;
  }

  async route(input: string): Promise<string[]> {
    if (!this.enabled) return [];
    const index = this.buildIndex();
    if (index.candidates.length === 0) return [];

    // L0: deterministic author-declared triggers.
    const lower = input.toLowerCase();
    const l0: Array<{ name: string; hits: number }> = [];
    for (const candidate of index.candidates) {
      const matcher = index.matchers.get(candidate.name);
      let hits = 0;
      for (const keyword of matcher?.keywords ?? []) {
        if (keyword && lower.includes(keyword.toLowerCase())) hits += 1;
      }
      for (const pattern of matcher?.patterns ?? []) {
        if (pattern.test(input)) hits += 1;
      }
      if (hits > 0) l0.push({ name: candidate.name, hits });
    }
    if (l0.length > 0) {
      l0.sort((a, b) => b.hits - a.hits);
      return l0.slice(0, this.maxActivate).map((entry) => entry.name);
    }

    // L1: inverted-index scoring with optional feedback adjustment.
    if (this.feedback) await this.ensureMemory();
    const queryTokens = tokenize(input);
    const scores = new Map<string, number>();
    for (const token of queryTokens) {
      const postings = index.postings.get(token);
      const idf = index.idf.get(token);
      if (!postings || idf === undefined) continue;
      for (const posting of postings) {
        scores.set(posting.name, (scores.get(posting.name) ?? 0) + posting.tf * idf);
      }
    }
    if (this.feedback) {
      const uniqueQuery = [...new Set(queryTokens)];
      for (const candidate of index.candidates) {
        const adjustment = this.feedbackAdjustment(candidate.name, uniqueQuery);
        if (adjustment !== 0) scores.set(candidate.name, (scores.get(candidate.name) ?? 0) + adjustment);
      }
    }
    return [...scores.entries()]
      .filter(([, score]) => score >= this.minScore)
      .sort((a, b) => b[1] - a[1])
      .slice(0, this.maxActivate)
      .map(([name]) => name);
  }

  /** loop/before-request (prepended): recall, mount, announce, refresh tools. */
  async onBeforeRequest(event: BeforeLoopRequest): Promise<void> {
    if (!this.enabled) return;
    const input = lastUserInput(event.messages);
    if (!input) return;

    const recalled = await this.route(input);
    if (recalled.length === 0) return;

    const mounted: string[] = [];
    for (const name of recalled) {
      try {
        await this.loader.ensure(name);
      } catch (error) {
        this.ctx.logger.warn(`router failed to recall plugin "${name}": ${error instanceof Error ? error.message : String(error)}`);
        continue;
      }
      const status = this.loader.list().find((entry) => entry.name === name);
      if (status?.status === "loaded") mounted.push(name);
    }
    if (mounted.length === 0) return;

    const fp = fingerprint(tokenize(input));
    for (const name of mounted) {
      if (!this.recalledRun.has(name)) this.recalledRun.set(name, fp);
    }
    const summary = mounted
      .map((name) => {
        const status = this.loader.list().find((entry) => entry.name === name);
        return status?.description ? `${name}: ${status.description}` : name;
      })
      .join("; ");
    event.messages.push({
      role: "user",
      content: `[system] Plugins activated for this task: ${summary}. Their tools are now available.`,
    });
    // The loop snapshots tool schemas at run start; refresh after mounting.
    event.tools = this.tools.schemas();
  }

  /** tools/before-call (prepended): L2 fallback for unknown tool names. */
  async onBeforeToolCall(event: BeforeToolCall): Promise<void> {
    if (!this.enabled || event.tool) return;
    const owner = this.toolOwner(event.toolCall.name);
    if (!owner) return;
    try {
      await this.loader.ensure(owner);
      // Whether activation succeeded or not, count the attempt as usage: a
      // failure must not immediately eject the plugin again.
      this.l2UsedRun.add(owner);
    } catch (error) {
      this.ctx.logger.warn(`router failed to mount tool provider "${owner}": ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  onAfterToolCall(event: AfterToolCall): void {
    this.usedToolsRun.add(event.toolCall.name);
  }

  /** loop/after-run: record feedback, eject idle dynamic plugins, reset. */
  async onAfterRun(): Promise<void> {
    try {
      if (this.feedback && this.recalledRun.size > 0) await this.recordFeedback();
      if (this.enabled) await this.ejectIdle();
    } catch (error) {
      this.ctx.logger.warn(`router lifecycle failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      this.recalledRun.clear();
      this.usedToolsRun.clear();
      this.l2UsedRun.clear();
    }
  }

  /** Plugins whose declared tools ran this turn (plus L2 mounts). */
  private usedPlugins(): Set<string> {
    const used = new Set<string>(this.l2UsedRun);
    for (const status of this.loader.list()) {
      if (status.status !== "loaded") continue;
      for (const tool of status.triggers?.tools ?? []) {
        if (this.usedToolsRun.has(tool)) used.add(status.name);
      }
    }
    return used;
  }

  private async ejectIdle(): Promise<void> {
    const used = this.usedPlugins();
    // Decide against a snapshot of what was loaded this turn: ejecting one
    // plugin must not erase another's reverse dependency mid-pass.
    const loaded = this.loader.list().filter((status) => status.activation === "dynamic" && status.status === "loaded");
    const toEject: string[] = [];
    for (const status of loaded) {
      if (this.pinned.includes(status.name) || used.has(status.name)) continue;
      if (this.hasReverseDep(status, loaded)) continue;
      toEject.push(status.name);
    }
    for (const name of toEject) {
      await this.loader.eject(name);
      this.ctx.logger.debug(`router ejected idle plugin "${name}"`);
    }
  }

  /** True when another plugin loaded this turn injects a service this one provides. */
  private hasReverseDep(status: PluginStatus, loaded: PluginStatus[]): boolean {
    if (status.provides.length === 0) return false;
    const provided = new Set(status.provides);
    return loaded.some(
      (other) => other.name !== status.name && other.inject.some((key) => provided.has(key)),
    );
  }

  /** The unloaded dynamic plugin declaring this tool name, if any. */
  private toolOwner(toolName: string): string | undefined {
    for (const status of this.loader.list()) {
      if (status.activation !== "dynamic" || status.status !== "unloaded") continue;
      if (status.triggers?.tools?.includes(toolName)) return status.name;
    }
    return undefined;
  }

  private async recordFeedback(): Promise<void> {
    await this.ensureMemory();
    for (const [name, fp] of this.recalledRun) {
      const used = this.l2UsedRun.has(name) || this.pluginUsedByTools(name);
      this.memory.push({ fp, plugin: name, used });
    }
    this.memory = this.memory.slice(-MEMORY_LIMIT);
    await mkdir(dirname(this.memoryPath), { recursive: true });
    await writeFile(this.memoryPath, JSON.stringify(this.memory), "utf-8");
  }

  private pluginUsedByTools(name: string): boolean {
    const status = this.loader.list().find((entry) => entry.name === name);
    return (status?.triggers?.tools ?? []).some((tool) => this.usedToolsRun.has(tool));
  }

  private feedbackAdjustment(name: string, queryTokens: string[]): number {
    let adjustment = 0;
    const querySet = new Set(queryTokens);
    for (const entry of this.memory) {
      if (entry.plugin !== name) continue;
      let overlap = 0;
      for (const token of entry.fp) {
        if (querySet.has(token)) overlap += 1;
      }
      if (overlap < MEMORY_OVERLAP_MIN) continue;
      adjustment += entry.used ? this.boost : -this.penalty;
    }
    return adjustment;
  }

  private ensureMemory(): Promise<void> {
    if (!this.memoryLoad) {
      this.memoryLoad = readFile(this.memoryPath, "utf-8")
        .then((raw) => {
          const parsed: unknown = JSON.parse(raw);
          if (!Array.isArray(parsed)) return;
          this.memory = parsed.filter(
            (entry): entry is MemoryEntry =>
              typeof entry === "object" &&
              entry !== null &&
              Array.isArray((entry as MemoryEntry).fp) &&
              typeof (entry as MemoryEntry).plugin === "string" &&
              typeof (entry as MemoryEntry).used === "boolean",
          );
        })
        .catch(() => {
          /* missing or corrupt memory file: start fresh */
        });
    }
    return this.memoryLoad;
  }

  /** Rebuild the routing index only when the catalog changed. */
  private buildIndex(): RouterIndex {
    const catalog = this.loader.catalog();
    const fingerprintCatalog = catalog.map((entry) => `${entry.name}:${entry.version}:${entry.status}`).join("|");
    if (this.index && this.index.fingerprint === fingerprintCatalog) return this.index;

    const candidates = catalog.filter((entry) => entry.activation === "dynamic" && entry.status === "unloaded");
    const docs = new Map<string, Map<string, number>>();
    const matchers = new Map<string, CandidateMatchers>();
    for (const candidate of candidates) {
      const text = [
        candidate.name,
        candidate.description ?? "",
        ...(candidate.triggers?.tools ?? []),
        ...(candidate.triggers?.keywords ?? []),
      ].join(" ");
      const tf = new Map<string, number>();
      for (const token of tokenize(text)) tf.set(token, (tf.get(token) ?? 0) + 1);
      docs.set(candidate.name, tf);

      const patterns: RegExp[] = [];
      for (const source of candidate.triggers?.patterns ?? []) {
        try {
          patterns.push(new RegExp(source, "i"));
        } catch {
          /* validated at load; defensive skip */
        }
      }
      matchers.set(candidate.name, { keywords: candidate.triggers?.keywords ?? [], patterns });
    }

    const postings = new Map<string, Array<{ name: string; tf: number }>>();
    for (const [name, tf] of docs) {
      for (const [token, count] of tf) {
        const list = postings.get(token) ?? [];
        list.push({ name, tf: count });
        postings.set(token, list);
      }
    }
    const idf = new Map<string, number>();
    const docCount = candidates.length;
    for (const [token, list] of postings) idf.set(token, Math.log(1 + docCount / list.length));

    this.index = { fingerprint: fingerprintCatalog, candidates, postings, idf, matchers };
    return this.index;
  }
}

export const routerPlugin = definePlugin<RouterPluginConfig>({
  name: "router",
  inject: ["hooks", "pluginsLoader", "agent", "tools"],
  provides: ["router"],
  apply(ctx: PluginContext, config: RouterPluginConfig = {}) {
    return ctx.effect(() => {
      const hooks = ctx.get("hooks") as HookBusService;
      const loader = ctx.get("pluginsLoader") as PluginsLoaderService;
      const tools = ctx.get("tools") as ToolRegistry;
      const router = new Router(ctx, loader, tools, config);
      const disposeService = ctx.provide("router", router);
      // Prepended so recall runs before compaction trims, and the tool
      // fallback runs before permission judges an unknown tool.
      const disposeBeforeRequest = hooks.hook<BeforeLoopRequest>(
        "loop/before-request",
        async (event, next) => {
          await router.onBeforeRequest(event);
          return next(event);
        },
        { prepend: true },
      );
      const disposeBeforeCall = hooks.hook<BeforeToolCall>(
        "tools/before-call",
        async (event, next) => {
          await router.onBeforeToolCall(event);
          return next(event);
        },
        { prepend: true },
      );
      const disposeAfterCall = hooks.hook<AfterToolCall>("tools/after-call", async (event, next) => {
        router.onAfterToolCall(event);
        return next(event);
      });
      const disposeAfterRun = hooks.hook<LoopAfterRun>("loop/after-run", async (_event, next) => {
        await router.onAfterRun();
        return next(_event);
      });
      return () => {
        disposeAfterRun();
        disposeAfterCall();
        disposeBeforeCall();
        disposeBeforeRequest();
        disposeService();
      };
    }, "router.install");
  },
});

declare module "../../kernel/types" {
  interface ServiceMap {
    router: RouterService;
  }
}
