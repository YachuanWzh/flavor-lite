/**
 * The runtime: mounts plugins, derives load order from declared service
 * dependencies (inject/provides), and owns ordered teardown.
 *
 * Unlike Cordis's reactive fibers, flavor-lite resolves ordering eagerly at
 * start() with a topological sort — deterministic, zero overhead at runtime,
 * and misconfiguration fails loud before anything runs.
 */

import { Context } from "./context";
import type { Disposer, KernelOptions, Logger, Plugin } from "./types";
import { silentLogger } from "./types";

interface MountedPlugin {
  plugin: Plugin<never>;
  config: unknown;
}

export class Runtime {
  readonly ctx: Context;
  private pending: MountedPlugin[] = [];
  private activeDisposers: { name: string; dispose: Disposer | void }[] = [];
  private started = false;
  private disposed = false;

  private constructor(ctx: Context) {
    this.ctx = ctx;
  }

  static create(options: KernelOptions = {}): Runtime {
    const logger = options.logger ?? silentLogger;
    const cwd = options.cwd ?? process.cwd();
    return new Runtime(new Context({ cwd, logger }));
  }

  get logger(): Logger {
    return this.ctx.logger;
  }

  /**
   * Queue a plugin for activation. Plugins activate in dependency order when
   * start() runs; mounting after start() activates immediately if deps exist.
   */
  use<C>(plugin: Plugin<C>, config?: C): this {
    if (this.disposed) throw new Error("runtime is disposed");
    this.pending.push({ plugin: plugin as Plugin<never>, config });
    if (this.started) {
      const ordered = this.resolveOrder(this.pending);
      this.pending = [];
      this.activate(ordered);
    }
    return this;
  }

  /** Activate all queued plugins in dependency order. Idempotent. */
  start(): this {
    if (this.started || this.disposed) return this;
    this.started = true;
    const ordered = this.resolveOrder(this.pending);
    this.pending = [];
    this.activate(ordered);
    return this;
  }

  /** Tear down plugin disposers in reverse activation order, then the context. */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    for (const { name, dispose } of this.activeDisposers.reverse()) {
      if (!dispose) continue;
      try {
        await dispose();
      } catch (error) {
        this.ctx.logger.warn(`plugin "${name}" failed during dispose: ${error instanceof Error ? error.message : error}`);
      }
    }
    this.activeDisposers = [];
    await this.ctx.dispose();
  }

  private activate(plugins: MountedPlugin[]): void {
    for (const { plugin, config } of plugins) {
      const result = plugin.apply(this.ctx, config as never);
      this.activeDisposers.push({ name: plugin.name, dispose: result });
    }
  }

  /**
   * Topological sort: a plugin naming `inject` keys activates after the
   * plugins providing those keys. Cycles and missing providers fail loud.
   * Plugins already activated (services present) satisfy dependencies.
   */
  private resolveOrder(plugins: MountedPlugin[]): MountedPlugin[] {
    const providedExisting = new Set(this.ctx.keys());

    const provider = new Map<string, MountedPlugin>();
    for (const entry of plugins) {
      for (const key of entry.plugin.provides ?? []) {
        if (provider.has(key)) {
          throw new Error(`service "${key}" is provided by both "${provider.get(key)!.plugin.name}" and "${entry.plugin.name}"`);
        }
        provider.set(key, entry);
      }
    }

    const order: MountedPlugin[] = [];
    const state = new Map<MountedPlugin, "visiting" | "done">();

    const visit = (entry: MountedPlugin, chain: string[]): void => {
      const status = state.get(entry);
      if (status === "done") return;
      if (status === "visiting") {
        throw new Error(`plugin dependency cycle: ${[...chain, entry.plugin.name].join(" -> ")}`);
      }
      state.set(entry, "visiting");
      for (const key of entry.plugin.inject ?? []) {
        if (providedExisting.has(key)) continue;
        const upstream = provider.get(key);
        if (!upstream) {
          throw new Error(`plugin "${entry.plugin.name}" requires service "${key}", but no mounted plugin provides it`);
        }
        visit(upstream, [...chain, entry.plugin.name]);
      }
      state.set(entry, "done");
      order.push(entry);
    };

    for (const entry of plugins) visit(entry, []);
    return order;
  }
}
