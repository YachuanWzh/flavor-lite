/**
 * The context implementation: a repository of services and a stack of
 * reversible effects. One context backs one runtime. Everything else —
 * waterfall hooks included — is a plugin built on these two primitives.
 */

import { AsyncLocalStorage } from "node:async_hooks";

import { DisposedError, OwnershipError, UndeclaredServiceError } from "./errors";
import type { Disposer, Logger, PluginContext, ProvideOptions } from "./types";

/**
 * Ambient plugin ownership, propagated across awaits. The runtime wraps
 * every plugin.apply() in withOwnerScope(plugin.name, ...); AsyncLocalStorage
 * carries the owner through the whole async body, so registrations made
 * after an await are attributed exactly like sync ones.
 */
export interface OwnerScopeExtras {
  /** Declared service keys: provide() outside this list fails loud. */
  declared?: readonly string[];
  /** Atomic reload: replace registrations currently owned by this plugin name. */
  replaceOwner?: string;
}

interface OwnerScope extends OwnerScopeExtras {
  owner: string;
}

const ownerStorage = new AsyncLocalStorage<OwnerScope | undefined>();

/** Run fn with an ambient owner scope; async continuations inherit it. */
export function withOwnerScope<T>(owner: string | undefined, fn: () => T, extras?: OwnerScopeExtras): T {
  return ownerStorage.run(owner ? { owner, ...extras } : undefined, fn);
}

/** Service registration change, surfaced by the runtime as kernel events. */
export interface ServiceChange {
  type: "provided" | "removed";
  key: string;
  owner: string | undefined;
}

interface EffectRecord {
  id: number;
  label: string;
  dispose: Disposer | void;
  stack?: string;
}

/** Effect registration diagnostics (stacks only when captured). */
export interface EffectDiagnostic {
  id: number;
  label: string;
  stack?: string;
}

/** One taken-over registration, revertible until the reload commits. */
interface TakeoverRecord {
  replaceOwner: string;
  key: string;
  previous: { value: unknown; owner: string | undefined; registration: number };
}

export interface ContextOptions {
  cwd: string;
  logger: Logger;
  /** Aborted when the owning runtime starts disposing. */
  signal?: AbortSignal;
  /** Capture registration stacks for effects (diagnostics only). */
  captureEffectStacks?: boolean;
  /** Invoked whenever a service registration appears or unwinds. */
  onServiceChange?: (change: ServiceChange) => void;
}

/**
 * Disposer inertia: the first call runs the cleanup (synchronously when the
 * disposer is sync); concurrent or repeat calls join the same run instead of
 * re-running it. Protects registrations racing unmount() and dispose(), so
 * teardown can never double-free.
 */
export function onceDisposer(dispose: Disposer): Disposer {
  let run: Promise<void> | undefined;
  let started = false;
  return () => {
    if (started) return run;
    started = true;
    const result = dispose();
    if (result instanceof Promise) {
      run = result;
      // Duplicate callers may not await; keep a stray rejection handled.
      run.catch(() => {});
    }
    return run;
  };
}

export class Context implements PluginContext {
  readonly cwd: string;
  readonly logger: Logger;
  readonly signal: AbortSignal;

  private services = new Map<string, unknown>();
  /** Owning plugin per key; undefined when claimed outside an apply(). */
  private owners = new Map<string, string | undefined>();
  /** Current registration token per key; superseded disposers unwind nothing. */
  private registrations = new Map<string, number>();
  private nextRegistration = 0;
  /** Pending takeovers (atomic reload); reverted on failure, dropped on commit. */
  private takeovers: TakeoverRecord[] = [];
  private effects: EffectRecord[] = [];
  private nextEffectId = 0;
  private disposed = false;
  private readonly captureEffectStacks: boolean;
  private readonly onServiceChange?: (change: ServiceChange) => void;

  constructor(options: ContextOptions) {
    this.cwd = options.cwd;
    this.logger = options.logger;
    this.signal = options.signal ?? new AbortController().signal;
    this.captureEffectStacks = options.captureEffectStacks ?? false;
    this.onServiceChange = options.onServiceChange;
  }

  get active(): boolean {
    return !this.disposed;
  }

  provide(key: string, service: unknown, options?: ProvideOptions): Disposer {
    this.assertActive("provide");
    const scope = ownerStorage.getStore();
    const newOwner = scope?.owner;
    const currentOwner = this.owners.get(key);
    // Contract: a plugin declaring `provides` may not register outside it.
    if (scope?.declared && !scope.declared.includes(key)) {
      throw new UndeclaredServiceError(key, newOwner ?? "?", scope.declared);
    }
    // Takeover (atomic reload): replace a registration owned by the plugin
    // being replaced — no ownership error, no restore-on-unwind. The
    // displaced registration is bookkept so a failed reload can revert it.
    const takeover = scope?.replaceOwner !== undefined && currentOwner === scope.replaceOwner;
    if (!takeover && currentOwner && newOwner && currentOwner !== newOwner && !options?.override) {
      throw new OwnershipError(key, currentOwner, newOwner);
    }
    const previous =
      this.services.has(key) && !takeover
        ? {
            value: this.services.get(key),
            owner: this.owners.get(key),
            registration: this.registrations.get(key) ?? -1,
          }
        : undefined;
    if (takeover) {
      this.takeovers.push({
        replaceOwner: scope!.replaceOwner!,
        key,
        previous: {
          value: this.services.get(key),
          owner: this.owners.get(key),
          registration: this.registrations.get(key) ?? -1,
        },
      });
    }
    const registration = this.nextRegistration++;
    this.services.set(key, service);
    this.owners.set(key, newOwner);
    this.registrations.set(key, registration);
    this.notifyServiceChange({ type: "provided", key, owner: newOwner });
    return onceDisposer(() => {
      // Superseded by a newer registration (e.g. an atomic reload took the
      // key over): the current registration owns the unwinding now, so
      // unwinding here would clobber it.
      if (this.registrations.get(key) !== registration) return;
      if (previous === undefined) {
        this.services.delete(key);
        this.owners.delete(key);
        this.registrations.delete(key);
        this.notifyServiceChange({ type: "removed", key, owner: newOwner });
      } else {
        // Restore the previous provider when this registration unwinds, so a
        // scoped override never leaves a dangling key behind.
        this.services.set(key, previous.value);
        this.owners.set(key, previous.owner);
        this.registrations.set(key, previous.registration);
        this.notifyServiceChange({ type: "provided", key, owner: previous.owner });
      }
    });
  }

  get(key: string): unknown {
    if (!this.services.has(key)) {
      throw new Error(
        `Service "${key}" is not available. Mount the plugin that provides it before the plugins that inject it.`,
      );
    }
    return this.services.get(key);
  }

  tryGet(key: string): unknown {
    return this.services.get(key);
  }

  /** Snapshot of currently provided service keys. */
  keys(): string[] {
    return [...this.services.keys()];
  }

  /** Snapshot of currently provided services with their owning plugin. */
  serviceOwners(): Array<{ key: string; owner: string | undefined }> {
    return [...this.services.keys()].map((key) => ({ key, owner: this.owners.get(key) }));
  }

  effect<S>(setup: () => S, label?: string): S {
    this.assertActive("effect");
    const result = setup();
    const dispose = typeof result === "function" ? onceDisposer(result as unknown as Disposer) : undefined;
    this.effects.push({
      id: this.nextEffectId++,
      label: label ?? setup.name ?? "effect",
      dispose,
      stack: this.captureEffectStacks ? new Error().stack : undefined,
    });
    return result;
  }

  /** Ids of the currently tracked effects (the runtime scopes plugins with this). */
  effectIds(): number[] {
    return this.effects.map((record) => record.id);
  }

  /** Registration diagnostics for every live effect (stacks when captured). */
  effectDiagnostics(): EffectDiagnostic[] {
    return this.effects.map((record) => ({ id: record.id, label: record.label, stack: record.stack }));
  }

  /**
   * Unwind exactly the given effect records (reverse registration order) and
   * remove them from the stack. Runtime.unmount uses this to release
   * everything a plugin registered via ctx.effect() during apply() —
   * id-based, so unmount order between plugins never matters. Errors are
   * warned, not thrown, so one bad disposer cannot strand the rest.
   */
  async releaseEffects(ids: number[]): Promise<void> {
    const wanted = new Set(ids);
    const kept: EffectRecord[] = [];
    const released: EffectRecord[] = [];
    for (const record of this.effects) {
      (wanted.has(record.id) ? released : kept).push(record);
    }
    this.effects = kept;
    for (const record of released.reverse()) {
      if (!record.dispose) continue;
      try {
        await record.dispose();
      } catch (error) {
        this.logger.warn(`effect "${record.label}" failed during release: ${errorMessage(error)}`, {
          effect: record.label,
          error: errorMessage(error),
        });
      }
    }
  }

  /**
   * Restore every registration taken over from `replaceOwner` (reverse
   * order). Runtime.reload calls this when the replacement failed, so the
   * old instance's services survive a botched swap. Runtime-internal.
   */
  revertTakeovers(replaceOwner: string): void {
    const pending = this.takeovers.filter((record) => record.replaceOwner === replaceOwner);
    this.takeovers = this.takeovers.filter((record) => record.replaceOwner !== replaceOwner);
    for (const record of pending.reverse()) {
      this.services.set(record.key, record.previous.value);
      this.owners.set(record.key, record.previous.owner);
      this.registrations.set(record.key, record.previous.registration);
      this.notifyServiceChange({ type: "provided", key: record.key, owner: record.previous.owner });
    }
  }

  /**
   * Drop the pending takeovers for `replaceOwner`: the replacement is now
   * responsible for those keys. Runtime.reload calls this once the
   * replacement has activated. Runtime-internal.
   */
  commitTakeovers(replaceOwner: string): void {
    this.takeovers = this.takeovers.filter((record) => record.replaceOwner !== replaceOwner);
  }

  /** Unwind every effect in reverse registration order. Idempotent. */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    const errors: unknown[] = [];
    for (const record of this.effects.reverse()) {
      if (!record.dispose) continue;
      try {
        await record.dispose();
      } catch (error) {
        errors.push(error);
        this.logger.warn(`effect "${record.label}" failed during dispose: ${errorMessage(error)}`, {
          effect: record.label,
          error: errorMessage(error),
        });
      }
    }
    this.effects = [];
    this.services.clear();
    this.owners.clear();
    this.registrations.clear();
    this.takeovers = [];
    if (errors.length > 0) {
      throw new AggregateError(errors, "one or more effects failed to dispose");
    }
  }

  private notifyServiceChange(change: ServiceChange): void {
    if (!this.onServiceChange) return;
    try {
      this.onServiceChange(change);
    } catch (error) {
      // Event listeners must never break service registration.
      this.logger.warn(`service change listener failed for "${change.key}": ${errorMessage(error)}`, {
        serviceKey: change.key,
        error: errorMessage(error),
      });
    }
  }

  private assertActive(operation: string): void {
    if (this.disposed) throw new DisposedError("context", operation);
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
