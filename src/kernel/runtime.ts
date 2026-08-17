/**
 * The runtime: mounts plugins, derives load order from declared service
 * dependencies (inject/provides), and owns ordered teardown.
 *
 * Unlike Cordis's reactive fibers, flavor-lite resolves ordering eagerly at
 * start() with a topological sort — deterministic, zero overhead at runtime,
 * and misconfiguration fails loud before anything runs.
 *
 * Stability machinery (all static, no runtime scheduling):
 * - a failed activation batch rolls back in reverse activation order
 * - resolution failures drop only the offending plugins (and, cascading,
 *   their dependents), so a broken mount never poisons later use() calls
 * - unmount refuses to leave dangling consumers (reverse dependency graph
 *   built from declared inject/provides)
 * - apply() may be async; effects registered after an await stay scoped
 *   because the effect snapshot diff is taken at settle time
 * - plugin disposers are inertia-guarded (see onceDisposer)
 */

import { Context, errorMessage, onceDisposer } from "./context";
import type {
  Disposer,
  KernelOptions,
  Logger,
  Plugin,
  StandardSchemaV1Issue,
  StandardSchemaV1Result,
} from "./types";
import { silentLogger } from "./types";

interface MountedPlugin {
  plugin: Plugin<never>;
  config: unknown;
}

interface QueuedPlugin extends MountedPlugin {
  batch: number;
}

interface ActivePlugin extends MountedPlugin {
  dispose: Disposer | void;
  /** Ids of effects registered during apply(): scoped for unmount. */
  effectIds: number[];
}

/** One use()/start() activation group: rolls back together on failure. */
interface ActivationBatch {
  remaining: number;
  activated: ActivePlugin[];
}

/** Resolution failure carrying the offending entries so they can be dropped. */
class ResolutionError extends Error {
  constructor(
    message: string,
    readonly entries: MountedPlugin[],
  ) {
    super(message);
  }
}

export class Runtime {
  readonly ctx: Context;
  private pending: MountedPlugin[] = [];
  private active: ActivePlugin[] = [];
  private started = false;
  private disposed = false;
  private queue: QueuedPlugin[] = [];
  private batches = new Map<number, ActivationBatch>();
  private nextBatchId = 0;
  private pumping = false;
  /** Reverse dependency graph: service key -> active plugin names injecting it. */
  private consumers = new Map<string, Set<string>>();
  private activationTail: Promise<void> = Promise.resolve();

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
   * Settles once every queued activation has finished; rejects when the
   * latest activation batch failed (failures are also logged). Hosts that
   * mount plugins with async apply() should await this before relying on
   * their services.
   */
  get ready(): Promise<void> {
    return this.activationTail;
  }

  /**
   * Queue a plugin for activation. Plugins activate in dependency order when
   * start() runs; mounting after start() activates immediately if deps exist.
   * Broken plugins are dropped at resolution (with their dependents) and
   * reported, so they can never poison a later use() call.
   */
  use<C>(plugin: Plugin<C>, config?: C): this {
    if (this.disposed) throw new Error("runtime is disposed");
    this.pending.push({ plugin: plugin as unknown as Plugin<never>, config });
    if (this.started) {
      const { ordered, errors } = this.resolvePending();
      let activationError: unknown;
      if (ordered.length > 0) {
        try {
          this.enqueue(ordered);
        } catch (error) {
          activationError = error;
        }
      }
      if (errors.length > 0) throw errors[0];
      if (activationError) throw activationError;
    }
    return this;
  }

  /** Activate all queued plugins in dependency order. Idempotent. */
  start(): this {
    if (this.started || this.disposed) return this;
    this.started = true;
    const { ordered, errors } = this.resolvePending();
    let activationError: unknown;
    if (ordered.length > 0) {
      try {
        this.enqueue(ordered);
      } catch (error) {
        activationError = error;
      }
    }
    // Nothing activated: allow retry after the caller fixes the mount list,
    // so a failed start never strands the runtime half-initialized.
    if ((activationError !== undefined || errors.length > 0) && this.active.length === 0 && this.queue.length === 0) {
      this.started = false;
    }
    if (errors.length > 0) throw errors[0];
    if (activationError) throw activationError;
    return this;
  }

  /**
   * Unmount the first active plugin with this name: run its disposer,
   * release every effect it registered during apply(), and forget it.
   * Services it provided vanish as their registrations unwind, so a later
   * use() of a same-named plugin can re-provide them (hot reload). Returns
   * true when a plugin was unmounted.
   *
   * Refuses to leave dangling consumers: when another active plugin still
   * injects a service this plugin provides, unmount fails loud. Pass
   * `{ force: true }` to override (consumers will then fail on resolution).
   */
  async unmount(name: string, options: { force?: boolean } = {}): Promise<boolean> {
    if (this.disposed) throw new Error("runtime is disposed");
    const entry = this.active.find((candidate) => candidate.plugin.name === name);
    if (!entry) return false;
    if (!options.force) {
      const problems = this.danglingConsumers(entry);
      if (problems.length > 0) {
        throw new Error(
          `cannot unmount "${name}": ${problems.join("; ")}; unmount the dependents first or pass { force: true }`,
        );
      }
    }
    await this.teardown(entry);
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
    this.pending = [];
    this.queue = [];
    this.batches.clear();
    // Let in-flight activations settle first so their effects are released
    // by the teardown below instead of leaking past dispose.
    await this.activationTail.catch(() => {});
    for (const entry of [...this.active].reverse()) {
      try {
        await this.teardown(entry);
      } catch (error) {
        this.ctx.logger.warn(
          `plugin "${entry.plugin.name}" failed during dispose: ${errorMessage(error)}`,
        );
      }
    }
    this.active = [];
    await this.ctx.dispose();
  }

  // ---------------------------------------------------------------------
  // Activation pipeline
  // ---------------------------------------------------------------------

  /** Register an ordered batch and run the activation pump. */
  private enqueue(entries: MountedPlugin[]): void {
    if (entries.length === 0) return;
    const batch = this.nextBatchId++;
    this.batches.set(batch, { remaining: entries.length, activated: [] });
    for (const entry of entries) this.queue.push({ ...entry, batch });
    const outcome = this.drain();
    if (outcome instanceof Promise) this.track(outcome);
  }

  /**
   * Activate queued plugins strictly one at a time (so the ambient owner
   * scope and effect snapshots never interleave). Runs fully synchronously
   * while every apply() is sync; the first async apply hands the remainder
   * to the returned promise. Sync failures throw with their batch already
   * scheduled for rollback.
   */
  private drain(): void | Promise<void> {
    if (this.pumping) return; // nested use() during apply(): outer loop picks it up
    this.pumping = true;
    try {
      return this.drainLoop();
    } catch (error) {
      this.pumping = false;
      throw error;
    }
  }

  private drainLoop(): void | Promise<void> {
    while (this.queue.length > 0) {
      const entry = this.queue.shift()!;
      let result: ActivePlugin | Promise<ActivePlugin>;
      try {
        result = this.activateOne(entry);
      } catch (error) {
        // Roll back this batch, drop its queued remainder, fail loud.
        this.track(this.failBatch(entry.batch));
        throw error;
      }
      if (result instanceof Promise) {
        return this.drainAsync(entry, result);
      }
      this.commitActivated(entry, result);
    }
    this.pumping = false;
  }

  /** Take over the pump for an async apply(), then keep draining. */
  private async drainAsync(entry: QueuedPlugin, pending: Promise<ActivePlugin>): Promise<void> {
    let failure: unknown;
    try {
      const activeEntry = await pending;
      this.commitActivated(entry, activeEntry);
    } catch (error) {
      failure = error;
      this.ctx.logger.error(`plugin "${entry.plugin.name}" failed to activate: ${errorMessage(error)}`);
      await this.failBatch(entry.batch);
    }
    try {
      await this.drainRest();
    } catch (followUp) {
      // A later batch failed synchronously: its rollback is already tracked
      // and it was logged where it happened; surface the first failure.
      if (failure === undefined) failure = followUp;
    } finally {
      this.pumping = false;
    }
    if (failure !== undefined) throw failure;
  }

  /** Continue draining inside an async continuation. */
  private async drainRest(): Promise<void> {
    const rest = this.drainLoop();
    if (rest instanceof Promise) await rest;
  }

  /**
   * Validate config and run apply() for one plugin. Sync plugins complete
   * synchronously; an async apply() returns a promise that commits the
   * entry at settle time. On async failure every effect registered so far
   * is released, so a half-started plugin cannot leak registrations.
   */
  private activateOne(entry: QueuedPlugin): ActivePlugin | Promise<ActivePlugin> {
    const { plugin } = entry;
    const existing = new Set(this.ctx.effectIds());

    const commit = (config: unknown, result: void | Disposer): ActivePlugin => {
      const effectIds = this.ctx.effectIds().filter((id) => !existing.has(id));
      return {
        plugin,
        config,
        dispose: typeof result === "function" ? onceDisposer(result) : undefined,
        effectIds,
      };
    };

    const finish = (config: unknown): ActivePlugin | Promise<ActivePlugin> => {
      let result: void | Disposer | Promise<void | Disposer>;
      this.ctx.setOwnerScope(plugin.name);
      try {
        result = plugin.apply(this.ctx, config as never);
      } finally {
        // Registrations after an await are unscoped: the ambient owner must
        // never leak into unrelated runtime code while apply() is pending.
        this.ctx.setOwnerScope(undefined);
      }
      if (result instanceof Promise) {
        return result.then(
          (dispose) => commit(config, dispose),
          async (error) => {
            const leaked = this.ctx.effectIds().filter((id) => !existing.has(id));
            await this.ctx.releaseEffects(leaked);
            throw error;
          },
        );
      }
      return commit(config, result);
    };

    if (!plugin.config) return finish(entry.config);

    const checked = (result: StandardSchemaV1Result<unknown>): unknown => {
      if (result.issues) {
        const lines = result.issues.map((issue) => ` - ${formatIssue(issue)}`);
        throw new Error(`plugin "${plugin.name}" has an invalid config:\n${lines.join("\n")}`);
      }
      return result.value;
    };
    const validation = plugin.config["~standard"].validate(entry.config);
    if (validation instanceof Promise) {
      return validation.then((result) => finish(checked(result)));
    }
    return finish(checked(validation));
  }

  /** Record a successfully activated entry: active list, batch, consumers. */
  private commitActivated(entry: QueuedPlugin, activeEntry: ActivePlugin): void {
    this.active.push(activeEntry);
    for (const key of entry.plugin.inject ?? []) {
      let set = this.consumers.get(key);
      if (!set) this.consumers.set(key, (set = new Set()));
      set.add(entry.plugin.name);
    }
    const batch = this.batches.get(entry.batch);
    if (batch) {
      batch.activated.push(activeEntry);
      batch.remaining -= 1;
      if (batch.remaining === 0) this.batches.delete(entry.batch);
    }
  }

  /**
   * Roll back a failed batch: teardown the activated members in reverse
   * order and drop whatever of the batch is still queued.
   */
  private failBatch(batchId: number): Promise<void> {
    const batch = this.batches.get(batchId);
    this.batches.delete(batchId);
    this.queue = this.queue.filter((queued) => queued.batch !== batchId);
    const activated = batch ? [...batch.activated].reverse() : [];
    return (async () => {
      for (const entry of activated) {
        try {
          await this.teardown(entry);
        } catch (error) {
          this.ctx.logger.warn(
            `plugin "${entry.plugin.name}" failed during rollback: ${errorMessage(error)}`,
          );
        }
      }
    })();
  }

  /** Keep async activation failures observable without crashing the process. */
  private track(outcome: Promise<void>): void {
    // Earlier failures were already logged; don't let them wedge later work.
    this.activationTail = this.activationTail.catch(() => {}).then(() => outcome);
    this.activationTail.catch(() => {});
  }

  // ---------------------------------------------------------------------
  // Teardown
  // ---------------------------------------------------------------------

  /** Forget the entry, unwind its disposer, release its scoped effects. */
  private async teardown(entry: ActivePlugin): Promise<void> {
    const index = this.active.indexOf(entry);
    if (index >= 0) this.active.splice(index, 1);
    for (const key of entry.plugin.inject ?? []) {
      const set = this.consumers.get(key);
      if (set) {
        set.delete(entry.plugin.name);
        if (set.size === 0) this.consumers.delete(key);
      }
    }
    try {
      if (entry.dispose) await entry.dispose();
    } finally {
      await this.ctx.releaseEffects(entry.effectIds);
    }
  }

  /** Active consumers (other than the plugin itself) of its provided keys. */
  private danglingConsumers(entry: ActivePlugin): string[] {
    const problems: string[] = [];
    for (const key of entry.plugin.provides ?? []) {
      const consumers = [...(this.consumers.get(key) ?? [])].filter(
        (name) => name !== entry.plugin.name,
      );
      if (consumers.length > 0) {
        problems.push(
          `service "${key}" is still injected by ${consumers.map((name) => `"${name}"`).join(", ")}`,
        );
      }
    }
    return problems;
  }

  // ---------------------------------------------------------------------
  // Dependency resolution
  // ---------------------------------------------------------------------

  /**
   * Resolve everything pending, dropping broken plugins instead of letting
   * them poison later mounts: each resolution failure removes the offending
   * entries (dependents cascade on the next pass) and is reported. Healthy
   * plugins still activate.
   */
  private resolvePending(): { ordered: MountedPlugin[]; errors: Error[] } {
    let queue = this.pending;
    this.pending = [];
    const ordered: MountedPlugin[] = [];
    const errors: Error[] = [];
    while (queue.length > 0) {
      try {
        ordered.push(...this.resolveOrder(queue));
        break;
      } catch (error) {
        if (!(error instanceof ResolutionError)) throw error;
        errors.push(error);
        const bad = new Set(error.entries);
        queue = queue.filter((entry) => !bad.has(entry));
      }
    }
    return { ordered, errors };
  }

  /**
   * Topological sort: a plugin naming `inject` keys activates after the
   * plugins providing those keys. Cycles, missing providers and duplicate
   * claims fail loud, naming the offending plugins. Plugins already
   * activated (services present) satisfy dependencies.
   */
  private resolveOrder(plugins: MountedPlugin[]): MountedPlugin[] {
    const providedExisting = new Set(this.ctx.keys());

    const provider = new Map<string, MountedPlugin>();
    for (const entry of plugins) {
      for (const key of entry.plugin.provides ?? []) {
        const existing = provider.get(key);
        if (existing) {
          throw new ResolutionError(
            `service "${key}" is provided by both "${existing.plugin.name}" and "${entry.plugin.name}"`,
            [existing, entry],
          );
        }
        provider.set(key, entry);
      }
    }

    const order: MountedPlugin[] = [];
    const state = new Map<MountedPlugin, "visiting" | "done">();

    const visit = (entry: MountedPlugin, chain: MountedPlugin[]): void => {
      const status = state.get(entry);
      if (status === "done") return;
      if (status === "visiting") {
        throw new ResolutionError(
          `plugin dependency cycle: ${[...chain, entry].map((link) => link.plugin.name).join(" -> ")}`,
          [...chain, entry],
        );
      }
      state.set(entry, "visiting");
      for (const key of entry.plugin.inject ?? []) {
        if (providedExisting.has(key)) continue;
        const upstream = provider.get(key);
        if (!upstream) {
          throw new ResolutionError(
            `plugin "${entry.plugin.name}" requires service "${key}", but no mounted plugin provides it`,
            [entry],
          );
        }
        visit(upstream, [...chain, entry]);
      }
      state.set(entry, "done");
      order.push(entry);
    };

    for (const entry of plugins) visit(entry, []);
    return order;
  }
}

function formatIssue(issue: StandardSchemaV1Issue): string {
  const path = (issue.path ?? [])
    .map((segment) => (typeof segment === "object" ? String(segment.key) : String(segment)))
    .join(".");
  return path ? `${issue.message} (at ${path})` : issue.message;
}
