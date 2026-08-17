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
 *   built per instance from declared inject/provides)
 * - reload() swaps a plugin atomically: the replacement activates first and
 *   takes over the old instance's service registrations, so consumers never
 *   see a gap; a failed replacement leaves the old instance untouched
 * - a plugin declaring `provides` cannot register services outside that list
 *   (fail-loud contract, code "service/undeclared")
 * - apply() may be async; effects registered after an await stay scoped
 *   because the effect snapshot diff is taken at settle time, and service
 *   ownership stays enforced because the owner travels via AsyncLocalStorage
 * - async activations can be bounded by activationTimeoutMs; teardown is
 *   bounded by teardownTimeoutMs (warn and move on, shutdown never wedges)
 * - plugin disposers are inertia-guarded (see onceDisposer)
 *
 * Operability: typed errors with stable codes (see ./errors), structured
 * log fields, a kernel event bus (on()), and introspection (inspect(),
 * plan()).
 */

import { Context, errorMessage, onceDisposer, withOwnerScope, type ServiceChange } from "./context";
import {
  ActivationError,
  ConfigValidationError,
  DisposedError,
  ReloadError,
  ResolutionError,
  UnmountError,
  activationFailure,
} from "./errors";
import type {
  Disposer,
  KernelOptions,
  LogFields,
  Logger,
  Plugin,
  StandardSchemaV1Issue,
  StandardSchemaV1Result,
} from "./types";
import { silentLogger } from "./types";

interface MountedPlugin {
  plugin: Plugin<never>;
  config: unknown;
  /** Per-mount identity: same-named plugins stay distinguishable. */
  instanceId: number;
  /** Atomic reload: replace registrations owned by this plugin name. */
  takeover?: string;
}

interface QueuedPlugin extends MountedPlugin {
  batch: number;
}

interface ActivePlugin extends MountedPlugin {
  dispose: Disposer | void;
  /** Ids of effects registered during apply(): scoped for unmount. */
  effectIds: number[];
  activatedAt: number;
  activationMs: number;
}

/** One use()/start() activation group: rolls back together on failure. */
interface ActivationBatch {
  remaining: number;
  activated: ActivePlugin[];
}

/** Identity carried by lifecycle events. */
export interface PluginInstanceRef {
  instanceId: number;
  name: string;
}

/** Kernel lifecycle events, subscribable via runtime.on(). */
export interface KernelEventMap {
  "plugin:activating": PluginInstanceRef;
  "plugin:activated": PluginInstanceRef;
  "plugin:failed": PluginInstanceRef & { error: unknown };
  "plugin:unmounted": PluginInstanceRef;
  "batch:rolled-back": { plugins: string[]; error: unknown };
  "service:provided": { key: string; owner: string | undefined };
  "service:removed": { key: string; owner: string | undefined };
  "runtime:disposed": Record<string, never>;
}

export interface ServiceInfo {
  key: string;
  owner: string | undefined;
}

export interface PluginInspectInfo extends PluginInstanceRef {
  status: "queued" | "activating" | "active";
  inject: string[];
  provides: string[];
  effectCount?: number;
  activatedAt?: number;
  activationMs?: number;
}

export interface RuntimeSnapshot {
  started: boolean;
  disposed: boolean;
  plugins: PluginInspectInfo[];
  services: ServiceInfo[];
  /** Service key -> names of active plugins injecting it. */
  consumers: Record<string, string[]>;
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
  private nextInstanceId = 0;
  private pumping = false;
  /** Reverse dependency graph: service key -> instance ids injecting it. */
  private consumers = new Map<string, Set<number>>();
  private activationTail: Promise<void> = Promise.resolve();
  private controller = new AbortController();
  private listeners = new Map<string, Set<(event: never) => void>>();
  /** Instance ids whose apply() is currently running. */
  private activating = new Set<number>();
  /** Instance ids with a reload() in flight (one replacement at a time). */
  private reloading = new Set<number>();
  private readonly activationTimeoutMs?: number;
  private readonly teardownTimeoutMs?: number;

  private constructor(options: KernelOptions) {
    this.activationTimeoutMs = options.activationTimeoutMs;
    this.teardownTimeoutMs = options.teardownTimeoutMs;
    this.ctx = new Context({
      cwd: options.cwd ?? process.cwd(),
      logger: options.logger ?? silentLogger,
      signal: this.controller.signal,
      captureEffectStacks: options.effectStackTraces,
      onServiceChange: (change) => this.emitServiceChange(change),
    });
  }

  static create(options: KernelOptions = {}): Runtime {
    return new Runtime(options);
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
    if (this.disposed) throw new DisposedError("runtime", "use()");
    this.pending.push({ plugin: plugin as unknown as Plugin<never>, config, instanceId: this.nextInstanceId++ });
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
    if (this.disposed) throw new DisposedError("runtime", "unmount()");
    const entry = this.active.find((candidate) => candidate.plugin.name === name);
    if (!entry) return false;
    if (!options.force) {
      const problems = this.danglingConsumers(entry);
      if (problems.length > 0) throw new UnmountError(name, problems);
    }
    await this.teardown(entry);
    this.emit("plugin:unmounted", { instanceId: entry.instanceId, name });
    return true;
  }

  /**
   * Atomically replace the first active plugin named `name` with a new
   * implementation: the replacement activates first and its provide() calls
   * take over the old instance's registrations; only then is the old
   * instance torn down, so consumers of its services never see a gap. When
   * the replacement fails to activate, the old instance stays mounted.
   * Returns false when no active plugin carries that name (use `use()`).
   *
   * The replacement must declare every service key the old instance
   * declared: keys it did not re-provide would vanish when the old instance
   * is torn down, leaving consumers dangling.
   */
  async reload<C>(name: string, plugin: Plugin<C>, config?: C): Promise<boolean> {
    if (this.disposed) throw new DisposedError("runtime", "reload()");
    const oldEntry = this.active.find((candidate) => candidate.plugin.name === name);
    if (!oldEntry) return false;
    if (this.reloading.has(oldEntry.instanceId)) {
      throw new ReloadError("reload/in-progress", `reload of "${name}" is already in progress`, { plugin: name });
    }
    const missing = (oldEntry.plugin.provides ?? []).filter((key) => !(plugin.provides ?? []).includes(key));
    if (missing.length > 0) {
      throw new ReloadError(
        "reload/provider-mismatch",
        `cannot reload "${name}": replacement "${plugin.name}" does not provide ${missing.map((key) => `"${key}"`).join(", ")}`,
        { plugin: name, replacement: plugin.name, missing },
      );
    }

    const entry: MountedPlugin = {
      plugin: plugin as unknown as Plugin<never>,
      config,
      instanceId: this.nextInstanceId++,
      takeover: name,
    };
    // Same fail-loud dependency check use() applies after start().
    const { errors } = this.resolveQueue([entry]);
    if (errors.length > 0) throw errors[0];

    this.reloading.add(oldEntry.instanceId);
    let failure: { error: unknown } | undefined;
    const offFailed = this.on("plugin:failed", (event) => {
      if (event.instanceId === entry.instanceId) failure = { error: event.error };
    });
    try {
      try {
        // Sync activation failures throw here (batch already rolled back);
        // async ones surface via `ready` and the plugin:failed capture.
        this.enqueue([entry]);
        await this.ready.catch(() => {});
      } catch (error) {
        // Sync failure: let the tracked partial-effect release settle, then
        // hand the taken-over services back to the old instance.
        await this.ready.catch(() => {});
        this.ctx.revertTakeovers(name);
        throw error;
      } finally {
        offFailed();
      }
      if (this.disposed) throw new DisposedError("runtime", "reload()");
      if (failure) {
        // The replacement's registrations are already unwound; put the old
        // instance's taken-over services back so it stays fully functional.
        this.ctx.revertTakeovers(name);
        throw failure.error;
      }
      const newEntry = this.active.find((candidate) => candidate.instanceId === entry.instanceId);
      if (!newEntry) {
        this.ctx.revertTakeovers(name);
        throw new ActivationError(`reload of "${name}" failed to activate its replacement`, plugin.name);
      }
      // Success: the replacement now owns the taken-over registrations; the
      // old instance's disposers skip whatever they no longer own.
      this.ctx.commitTakeovers(name);
      if (this.active.includes(oldEntry)) {
        await this.teardown(oldEntry);
        this.emit("plugin:unmounted", { instanceId: oldEntry.instanceId, name });
      }
      this.ctx.logger.debug(`reloaded "${name}" with "${plugin.name}"`, {
        plugin: plugin.name,
        instanceId: entry.instanceId,
        replaced: oldEntry.instanceId,
      });
      return true;
    } finally {
      this.reloading.delete(oldEntry.instanceId);
    }
  }

  /** Names of currently active plugins, in activation order. */
  activePlugins(): string[] {
    return this.active.map((entry) => entry.plugin.name);
  }

  /**
   * Subscribe to kernel lifecycle events. Listener errors are warned and
   * swallowed — a broken observer can never break the kernel. The returned
   * disposer unsubscribes.
   */
  on<K extends keyof KernelEventMap>(type: K, listener: (event: KernelEventMap[K]) => void): Disposer {
    if (this.disposed) throw new DisposedError("runtime", "on()");
    let set = this.listeners.get(type);
    if (!set) this.listeners.set(type, (set = new Set()));
    set.add(listener as (event: never) => void);
    return () => {
      set.delete(listener as (event: never) => void);
    };
  }

  /**
   * Full kernel snapshot for monitoring and debugging: plugin instances
   * with status/timing, provided services with owners, and the consumer
   * graph. Cheap to call; built from live in-memory state.
   */
  inspect(): RuntimeSnapshot {
    const plugins: PluginInspectInfo[] = [];
    for (const entry of this.queue) {
      plugins.push({
        instanceId: entry.instanceId,
        name: entry.plugin.name,
        status: this.activating.has(entry.instanceId) ? "activating" : "queued",
        inject: entry.plugin.inject ?? [],
        provides: entry.plugin.provides ?? [],
      });
    }
    for (const entry of this.active) {
      plugins.push({
        instanceId: entry.instanceId,
        name: entry.plugin.name,
        status: "active",
        inject: entry.plugin.inject ?? [],
        provides: entry.plugin.provides ?? [],
        effectCount: entry.effectIds.length,
        activatedAt: entry.activatedAt,
        activationMs: entry.activationMs,
      });
    }
    const nameOf = this.instanceNames();
    const consumers: Record<string, string[]> = {};
    for (const [key, ids] of this.consumers) {
      consumers[key] = [...ids].map((id) => nameOf.get(id) ?? `#${id}`);
    }
    return {
      started: this.started,
      disposed: this.disposed,
      plugins,
      services: this.ctx.serviceOwners(),
      consumers,
    };
  }

  /**
   * Dry-run dependency resolution over what is pending: returns the
   * activation order and any resolution errors without activating anything
   * or consuming the pending list. Useful for CI validation of mount lists.
   */
  plan(): { ordered: string[]; errors: Error[] } {
    const { ordered, errors } = this.resolveQueue([...this.pending]);
    return { ordered: ordered.map((entry) => entry.plugin.name), errors };
  }

  /** Tear down plugin disposers in reverse activation order, then the context. */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    // Cooperatively cancel in-flight plugin work before unwinding.
    this.controller.abort();
    this.pending = [];
    this.queue = [];
    this.batches.clear();
    // Let in-flight activations settle first so their effects are released
    // by the teardown below instead of leaking past dispose.
    await this.activationTail.catch(() => {});
    const errors: unknown[] = [];
    for (const entry of [...this.active].reverse()) {
      try {
        await this.teardown(entry);
      } catch (error) {
        errors.push(error);
        this.ctx.logger.warn(
          `plugin "${entry.plugin.name}" failed during dispose: ${errorMessage(error)}`,
          { plugin: entry.plugin.name, instanceId: entry.instanceId, error: errorMessage(error) },
        );
      }
    }
    this.active = [];
    try {
      await this.ctx.dispose();
    } catch (error) {
      errors.push(error);
      this.ctx.logger.warn(`context effects failed during dispose: ${errorMessage(error)}`, {
        phase: "dispose",
        error: errorMessage(error),
      });
    }
    // Guaranteed: observers can rely on disposal having run even when some
    // teardown steps failed (failures are aggregated and rethrown below).
    this.emit("runtime:disposed", {});
    if (errors.length > 0) {
      throw new AggregateError(errors, "one or more teardown steps failed during dispose");
    }
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
   * Activate queued plugins strictly one at a time (so effect snapshots
   * never interleave). Runs fully synchronously while every apply() is sync;
   * the first async apply hands the remainder to the returned promise. Sync
   * failures throw with their batch already scheduled for rollback.
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
        this.emit("plugin:failed", { instanceId: entry.instanceId, name: entry.plugin.name, error });
        this.track(this.failBatch(entry.batch, error));
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
      this.emit("plugin:failed", { instanceId: entry.instanceId, name: entry.plugin.name, error });
      this.ctx.logger.error(errorMessage(error), {
        plugin: entry.plugin.name,
        instanceId: entry.instanceId,
        phase: "activation",
        code: error instanceof Error ? (error as { code?: string }).code : undefined,
      });
      await this.failBatch(entry.batch, error);
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
   * Validate config and run apply() for one plugin, inside an ownership
   * scope that survives awaits. Sync plugins complete synchronously; an
   * async apply() returns a promise that commits the entry at settle time.
   * On async failure (or timeout) every effect registered so far is
   * released, so a half-started plugin cannot leak registrations.
   */
  private activateOne(entry: QueuedPlugin): ActivePlugin | Promise<ActivePlugin> {
    const { plugin } = entry;
    const existing = new Set(this.ctx.effectIds());
    const startedAt = Date.now();
    this.activating.add(entry.instanceId);
    this.emit("plugin:activating", { instanceId: entry.instanceId, name: plugin.name });

    const commit = (config: unknown, result: void | Disposer): ActivePlugin => {
      this.activating.delete(entry.instanceId);
      const effectIds = this.ctx.effectIds().filter((id) => !existing.has(id));
      return {
        plugin,
        config,
        instanceId: entry.instanceId,
        dispose: typeof result === "function" ? onceDisposer(result) : undefined,
        effectIds,
        activatedAt: startedAt,
        activationMs: Date.now() - startedAt,
      };
    };

    const releaseLeaked = async (): Promise<void> => {
      this.activating.delete(entry.instanceId);
      const leaked = this.ctx.effectIds().filter((id) => !existing.has(id));
      await this.ctx.releaseEffects(leaked);
    };

    const finish = (config: unknown): ActivePlugin | Promise<ActivePlugin> => {
      let result: void | Disposer | Promise<void | Disposer>;
      try {
        result = withOwnerScope(plugin.name, () => plugin.apply(this.ctx, config as never), {
          ...(plugin.provides ? { declared: plugin.provides } : {}),
          ...(entry.takeover ? { replaceOwner: entry.takeover } : {}),
        });
      } catch (error) {
        // Sync failure: unwind partial effects (tracked for ready), fail loud.
        this.activating.delete(entry.instanceId);
        const leaked = this.ctx.effectIds().filter((id) => !existing.has(id));
        if (leaked.length > 0) this.track(this.ctx.releaseEffects(leaked));
        throw activationFailure(plugin.name, error);
      }
      if (result instanceof Promise) {
        let outcome = result.then(
          (dispose) => commit(config, dispose),
          async (error) => {
            await releaseLeaked();
            throw activationFailure(plugin.name, error);
          },
        );
        if (this.activationTimeoutMs !== undefined) {
          outcome = this.withActivationTimeout(outcome, entry, releaseLeaked);
        }
        return outcome;
      }
      return commit(config, result);
    };

    if (!plugin.config) return finish(entry.config);

    const checked = (result: StandardSchemaV1Result<unknown>): unknown => {
      if (result.issues) {
        const lines = result.issues.map((issue) => ` - ${formatIssue(issue)}`);
        throw new ConfigValidationError(
          plugin.name,
          `plugin "${plugin.name}" has an invalid config:\n${lines.join("\n")}`,
        );
      }
      return result.value;
    };
    const validation = plugin.config["~standard"].validate(entry.config);
    if (validation instanceof Promise) {
      return validation.then((result) => finish(checked(result)));
    }
    return finish(checked(validation));
  }

  /**
   * Bound an async activation: reject with code "activation/timeout" when
   * apply() does not settle in time. The abandoned apply keeps a cleanup
   * handler — whatever it registers after the timeout is still unwound once
   * it finally settles (plugins should watch ctx.signal to settle promptly).
   */
  private withActivationTimeout(
    outcome: Promise<ActivePlugin>,
    entry: QueuedPlugin,
    releaseLeaked: () => Promise<void>,
  ): Promise<ActivePlugin> {
    const ms = this.activationTimeoutMs!;
    return new Promise<ActivePlugin>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(
          new ActivationError(
            `plugin "${entry.plugin.name}" timed out while activating after ${ms}ms`,
            entry.plugin.name,
            "activation/timeout",
            { timeoutMs: ms },
          ),
        );
        void releaseLeaked();
        // Late settle of the abandoned apply: unwind its leftovers quietly.
        outcome.then(
          () => this.track(releaseLeaked()),
          () => this.track(releaseLeaked()),
        );
      }, ms);
      outcome.then(
        (value) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(value);
        },
        (error) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          reject(error);
        },
      );
    });
  }

  /** Record a successfully activated entry: active list, batch, consumers. */
  private commitActivated(entry: QueuedPlugin, activeEntry: ActivePlugin): void {
    this.active.push(activeEntry);
    this.emit("plugin:activated", { instanceId: entry.instanceId, name: entry.plugin.name });
    for (const key of entry.plugin.inject ?? []) {
      let set = this.consumers.get(key);
      if (!set) this.consumers.set(key, (set = new Set()));
      set.add(entry.instanceId);
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
  private failBatch(batchId: number, error?: unknown): Promise<void> {
    const batch = this.batches.get(batchId);
    this.batches.delete(batchId);
    this.queue = this.queue.filter((queued) => queued.batch !== batchId);
    const activated = batch ? [...batch.activated].reverse() : [];
    if (activated.length > 0) {
      this.emit("batch:rolled-back", { plugins: activated.map((entry) => entry.plugin.name), error });
    }
    return (async () => {
      for (const entry of activated) {
        try {
          await this.teardown(entry);
        } catch (teardownError) {
          this.ctx.logger.warn(
            `plugin "${entry.plugin.name}" failed during rollback: ${errorMessage(teardownError)}`,
            { plugin: entry.plugin.name, instanceId: entry.instanceId, error: errorMessage(teardownError) },
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
        set.delete(entry.instanceId);
        if (set.size === 0) this.consumers.delete(key);
      }
    }
    const fields: LogFields = { plugin: entry.plugin.name, instanceId: entry.instanceId };
    try {
      if (entry.dispose) {
        await this.settle(
          Promise.resolve(entry.dispose()),
          `plugin "${entry.plugin.name}" disposer timed out during teardown`,
          fields,
        );
      }
    } finally {
      await this.settle(
        this.ctx.releaseEffects(entry.effectIds),
        `plugin "${entry.plugin.name}" effect release timed out during teardown`,
        fields,
      );
    }
  }

  /**
   * Await cleanup, but (when teardownTimeoutMs is set) warn and move on
   * instead of hanging forever: shutdown must always make progress. The
   * abandoned cleanup keeps a stray-rejection guard.
   */
  private async settle(cleanup: Promise<void>, timeoutWarning: string, fields: LogFields): Promise<void> {
    const ms = this.teardownTimeoutMs;
    if (ms === undefined) return cleanup;
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        this.ctx.logger.warn(timeoutWarning, { ...fields, timeoutMs: ms });
        cleanup.catch(() => {});
        resolve();
      }, ms);
      cleanup.then(
        () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve();
        },
        (error) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          reject(error);
        },
      );
    });
  }

  /** Active consumers (other than the plugin itself) of its provided keys. */
  private danglingConsumers(entry: ActivePlugin): string[] {
    const nameOf = this.instanceNames();
    const problems: string[] = [];
    for (const key of entry.plugin.provides ?? []) {
      const consumers = [...(this.consumers.get(key) ?? [])]
        .filter((id) => id !== entry.instanceId)
        .map((id) => nameOf.get(id) ?? `#${id}`);
      if (consumers.length > 0) {
        problems.push(
          `service "${key}" is still injected by ${consumers.map((name) => `"${name}"`).join(", ")}`,
        );
      }
    }
    return problems;
  }

  private instanceNames(): Map<number, string> {
    return new Map(this.active.map((candidate) => [candidate.instanceId, candidate.plugin.name]));
  }

  // ---------------------------------------------------------------------
  // Kernel events
  // ---------------------------------------------------------------------

  private emit<K extends keyof KernelEventMap>(type: K, event: KernelEventMap[K]): void {
    const set = this.listeners.get(type);
    if (!set) return;
    for (const listener of [...set]) {
      try {
        (listener as (event: KernelEventMap[K]) => void)(event);
      } catch (error) {
        this.ctx.logger.warn(`kernel event listener for "${type}" failed: ${errorMessage(error)}`, {
          event: type,
          error: errorMessage(error),
        });
      }
    }
  }

  private emitServiceChange(change: ServiceChange): void {
    if (change.type === "provided") {
      this.emit("service:provided", { key: change.key, owner: change.owner });
    } else {
      this.emit("service:removed", { key: change.key, owner: change.owner });
    }
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
    const queue = this.pending;
    this.pending = [];
    return this.resolveQueue(queue);
  }

  /** Pure resolution over a queue snapshot (plan() relies on it not mutating). */
  private resolveQueue(queue: MountedPlugin[]): { ordered: MountedPlugin[]; errors: Error[] } {
    let remaining = queue;
    const ordered: MountedPlugin[] = [];
    const errors: Error[] = [];
    while (remaining.length > 0) {
      try {
        ordered.push(...this.resolveOrder(remaining));
        break;
      } catch (error) {
        if (!(error instanceof ResolutionError)) throw error;
        errors.push(error);
        const bad = new Set(error.entries);
        remaining = remaining.filter((entry) => !bad.has(entry));
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
            "resolution/duplicate-provider",
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
          "resolution/cycle",
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
            "resolution/missing-provider",
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
