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

interface ActivePlugin extends MountedPlugin {
  dispose: Disposer | void;
  /** Ids of effects registered during apply(): scoped for unmount. */
  effectIds: number[];
}

export class Runtime {
  readonly ctx: Context;
  private pending: MountedPlugin[] = [];
  private active: ActivePlugin[] = [];
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
      try {
        const ordered = this.resolveOrder(this.pending);
        this.pending = [];
        this.activate(ordered);
      } catch (error) {
        // A plugin that fails resolution must not stay queued: it would be
        // re-resolved (and re-thrown) by every later use() call, poisoning
        // all subsequent activations.
        this.pending = [];
        throw error;
      }
    }
    return this;
  }

  /** Activate all queued plugins in dependency order. Idempotent. */
  start(): this {
    if (this.started || this.disposed) return this;
    this.started = true;
    try {
      const ordered = this.resolveOrder(this.pending);
      this.pending = [];
      this.activate(ordered);
    } catch (error) {
      this.pending = [];
      throw error;
    }
    return this;
  }

  /**
   * Unmount the first active plugin with this name: run its disposer,
   * release every effect it registered during apply(), and forget it.
   * Services it provided vanish as their registrations unwind, so a later
   * use() of a same-named plugin can re-provide them (hot reload). Effects
   * must be registered synchronously inside apply() to be scoped correctly.
   * Returns true when a plugin was unmounted.
   */
  async unmount(name: string): Promise<boolean> {
    if (this.disposed) throw new Error("runtime is disposed");
    const index = this.active.findIndex((entry) => entry.plugin.name === name);
    if (index < 0) return false;
    const entry = this.active[index];
    if (!entry) return false;
    this.active.splice(index, 1);
    try {
      if (entry.dispose) await entry.dispose();
    } finally {
      await this.ctx.releaseEffects(entry.effectIds);
    }
    return true;
  }

  /** Names of currently active plugins, in activation order. */
  activePlugins(): string[] {
    return this.active.map((entry) => entry.plugin.name);
  }

  /** Tear down plugin disposers in reverse activation order, then the context. */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    for (const entry of this.active.reverse()) {
      if (!entry.dispose) continue;
      try {
        await entry.dispose();
      } catch (error) {
        this.ctx.logger.warn(`plugin "${entry.plugin.name}" failed during dispose: ${error instanceof Error ? error.message : error}`);
      }
    }
    this.active = [];
    await this.ctx.dispose();
  }

  private activate(plugins: MountedPlugin[]): void {
    for (const { plugin, config } of plugins) {
      const existing = new Set(this.ctx.effectIds());
      const result = plugin.apply(this.ctx, config as never);
      const effectIds = this.ctx.effectIds().filter((id) => !existing.has(id));
      this.active.push({ plugin, config, dispose: result, effectIds });
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
