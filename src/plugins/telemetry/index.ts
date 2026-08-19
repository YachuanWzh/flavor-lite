/**
 * Telemetry plugin: the unified signal source. Every interesting runtime
 * fact lands in one append-only JSONL feed (.flavorlite/telemetry.jsonl):
 * tool calls and blocks, run outcomes, router recalls and feedback.
 *
 * Before this plugin, signals were scattered across router-memory.json,
 * error-monitor records and session files; reflection and governance
 * plugins now have a single stream to read (`events()` / `/telemetry stats`)
 * while the specialized stores keep their own state.
 *
 * Recording is fire-and-forget and never throws: a telemetry failure must
 * never break a tool call or a run.
 */

import { appendFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { definePlugin } from "../../kernel";
import type { PluginContext } from "../../kernel/types";
import type { CommandsService } from "../commands";
import type { HookBusService } from "../hooks";
import type { LoopAfterRun } from "../loop";
import type { AfterToolCall, BeforeToolCall } from "../tools/registry";

/** One recorded fact. `ts` is stamped by record(); producers set the rest. */
export interface TelemetryEvent {
  /** ISO timestamp assigned on record. */
  ts: string;
  /** Event family: tool.call | tool.blocked | run.end | router.* | custom. */
  type: string;
  [key: string]: unknown;
}

export interface TelemetryQuery {
  /** Keep only events of this exact type. */
  type?: string;
  /** Return at most this many events (the newest ones). */
  limit?: number;
}

export interface TelemetryService {
  /**
   * Append one event. Synchronous signature on purpose: hook handlers must
   * not await disk IO. Writes are serialized and errors only warned.
   */
  record(event: { type: string; [key: string]: unknown }): void;
  /** Read events back, oldest first. */
  events(query?: TelemetryQuery): Promise<TelemetryEvent[]>;
  /** Drop the whole feed. */
  clear(): Promise<void>;
  /** Absolute path of the JSONL file. */
  path(): string;
}

export interface TelemetryPluginConfig {
  /** Default on; when off, record() becomes a no-op. */
  enabled?: boolean;
  /** Feed location. Default <cwd>/.flavorlite/telemetry.jsonl. */
  path?: string;
  /** Rolling cap; the oldest events are trimmed past it. Default 5000. */
  maxEvents?: number;
}

const DEFAULT_MAX_EVENTS = 5000;
/** How many appends between rolling-cap trims (keeps writes cheap). */
const TRIM_CHECK_EVERY = 100;
/** How far `/telemetry stats` looks back. */
const STATS_WINDOW_MS = 24 * 60 * 60 * 1000;

class TelemetryServiceImpl implements TelemetryService {
  private queue: Promise<unknown> = Promise.resolve();
  private appends = 0;

  constructor(
    private readonly ctx: PluginContext,
    private readonly filePath: string,
    private readonly enabled: boolean,
    private readonly maxEvents: number,
  ) {}

  path(): string {
    return this.filePath;
  }

  record(event: { type: string; [key: string]: unknown }): void {
    if (!this.enabled) return;
    const stamped: TelemetryEvent = { ts: new Date().toISOString(), ...event };
    // Serialized chain: concurrent records never interleave their lines.
    this.queue = this.queue
      .then(() => this.append(stamped))
      .catch((error) => {
        this.ctx.logger.warn(`telemetry write failed: ${error instanceof Error ? error.message : String(error)}`);
      });
  }

  async events(query: TelemetryQuery = {}): Promise<TelemetryEvent[]> {
    // Let pending records land first so reads see what was just written.
    await this.queue;
    let list: TelemetryEvent[] = [];
    try {
      const raw = await readFile(this.filePath, "utf-8");
      for (const line of raw.split("\n")) {
        if (!line.trim()) continue;
        try {
          const parsed = JSON.parse(line) as TelemetryEvent;
          if (typeof parsed?.type === "string") list.push(parsed);
        } catch {
          /* a torn line never poisons the feed */
        }
      }
    } catch {
      /* missing file: empty feed */
    }
    if (query.type !== undefined) list = list.filter((event) => event.type === query.type);
    if (query.limit !== undefined && query.limit >= 0 && list.length > query.limit) {
      list = list.slice(list.length - query.limit);
    }
    return list;
  }

  async clear(): Promise<void> {
    await this.queue;
    await rm(this.filePath, { force: true });
  }

  private async append(event: TelemetryEvent): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    await appendFile(this.filePath, `${JSON.stringify(event)}\n`, "utf-8");
    this.appends += 1;
    if (this.appends % TRIM_CHECK_EVERY === 0) await this.trim();
  }

  /** Keep only the newest maxEvents lines; rewrite is atomic enough for a single host. */
  private async trim(): Promise<void> {
    const raw = await readFile(this.filePath, "utf-8");
    const lines = raw.split("\n").filter((line) => line.trim() !== "");
    if (lines.length <= this.maxEvents) return;
    await writeFile(this.filePath, `${lines.slice(-this.maxEvents).join("\n")}\n`, "utf-8");
  }
}

/** Aggregate the last 24h into one glanceable block for /telemetry stats. */
function summarize(events: TelemetryEvent[]): string {
  const cutoff = Date.now() - STATS_WINDOW_MS;
  const recent = events.filter((event) => Date.parse(event.ts) >= cutoff);
  if (recent.length === 0) return "no telemetry events in the last 24h";

  const calls = recent.filter((event) => event.type === "tool.call");
  const failures = calls.filter((event) => event.isError === true);
  const blocked = recent.filter((event) => event.type === "tool.blocked");
  const runs = recent.filter((event) => event.type === "run.end");
  const finished = runs.filter((event) => event.reason === "finished");
  const recalls = recent.filter((event) => event.type === "router.recall");
  const feedback = recent.filter((event) => event.type === "router.feedback");

  const perTool = new Map<string, { calls: number; errors: number }>();
  for (const event of calls) {
    const name = typeof event.tool === "string" ? event.tool : "?";
    const entry = perTool.get(name) ?? { calls: 0, errors: 0 };
    entry.calls += 1;
    if (event.isError === true) entry.errors += 1;
    perTool.set(name, entry);
  }
  const toolLines = [...perTool.entries()]
    .sort((a, b) => b[1].calls - a[1].calls)
    .slice(0, 10)
    .map(([name, entry]) => `  ${name.padEnd(24)} ${entry.calls} call${entry.calls === 1 ? "" : "s"}${entry.errors > 0 ? `, ${entry.errors} error${entry.errors === 1 ? "" : "s"}` : ""}`);

  let feedbackUsed = 0;
  let feedbackUnused = 0;
  for (const event of feedback) {
    for (const entry of (event.entries as Array<{ used?: boolean }>) ?? []) {
      if (entry.used === true) feedbackUsed += 1;
      else feedbackUnused += 1;
    }
  }

  return [
    `telemetry: last 24h (${recent.length} events)`,
    `  runs: ${runs.length} (${finished.length} finished)`,
    `  tool calls: ${calls.length} (${failures.length} failed), blocked: ${blocked.length}`,
    `  router: ${recalls.length} recall${recalls.length === 1 ? "" : "s"}, feedback ${feedbackUsed} used / ${feedbackUnused} unused`,
    ...(toolLines.length > 0 ? ["  top tools:", ...toolLines] : []),
  ].join("\n");
}

export const telemetryPlugin = definePlugin<TelemetryPluginConfig>({
  name: "telemetry",
  inject: ["hooks"],
  provides: ["telemetry"],
  apply(ctx: PluginContext, config: TelemetryPluginConfig = {}) {
    return ctx.effect(() => {
      const hooks = ctx.get("hooks") as HookBusService;
      const filePath = config.path ?? join(ctx.cwd, ".flavorlite", "telemetry.jsonl");
      const service = new TelemetryServiceImpl(ctx, filePath, config.enabled ?? true, config.maxEvents ?? DEFAULT_MAX_EVENTS);
      const disposeService = ctx.provide("telemetry", service);

      // Prepended so this listener stays outermost: permission short-circuits
      // blocked calls (returns without next()), and only an outer listener
      // still sees the final decision afterwards.
      const disposeBefore = hooks.hook<BeforeToolCall>(
        "tools/before-call",
        async (event, next) => {
          const result = await next(event);
          if (result.block) {
            service.record({
              type: "tool.blocked",
              tool: result.toolCall.name,
              ...(result.reason ? { reason: result.reason } : {}),
            });
          }
          return result;
        },
        { prepend: true },
      );
      const disposeAfter = hooks.hook<AfterToolCall>("tools/after-call", async (event, next) => {
        const result = await next(event);
        service.record({
          type: "tool.call",
          tool: result.toolCall.name,
          isError: Boolean(result.result.isError),
        });
        return result;
      });
      const disposeRun = hooks.hook<LoopAfterRun>("loop/after-run", async (event, next) => {
        const result = await next(event);
        service.record({ type: "run.end", ...result });
        return result;
      });

      const commands = ctx.tryGet("commands") as CommandsService | undefined;
      const disposeCommand = commands
        ? commands.register({
            name: "telemetry",
            description: "Unified signal feed (/telemetry [show [n]] | stats | clear)",
            async run(args) {
              const [sub, arg] = args.trim() === "" ? [] : args.trim().split(/\s+/);
              switch (sub ?? "stats") {
                case "stats":
                  return summarize(await service.events());
                case "show": {
                  const limit = Number.parseInt(arg ?? "20", 10);
                  const events = await service.events(Number.isFinite(limit) ? { limit } : {});
                  if (events.length === 0) return "telemetry feed is empty";
                  return events
                    .map((event) => `${event.ts} ${event.type} ${JSON.stringify({ ...event, ts: undefined, type: undefined })}`)
                    .join("\n");
                }
                case "clear":
                  await service.clear();
                  return "telemetry feed cleared";
                default:
                  return `unknown subcommand "${sub}" (use: show [n] | stats | clear)`;
              }
            },
          })
        : () => {};

      return () => {
        disposeCommand();
        disposeRun();
        disposeAfter();
        disposeBefore();
        disposeService();
      };
    }, "telemetry.install");
  },
});

declare module "../../kernel/types" {
  interface ServiceMap {
    telemetry: TelemetryService;
  }
}
