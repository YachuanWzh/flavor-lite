/**
 * The context implementation: a repository of services and a stack of
 * reversible effects. One context backs one runtime. Everything else —
 * waterfall hooks included — is a plugin built on these two primitives.
 */

import { AsyncLocalStorage } from "node:async_hooks";

import { DisposedError, OwnershipError } from "./errors";
import type { Disposer, Logger, PluginContext, ProvideOptions } from "./types";

/**
 * Ambient plugin ownership, propagated across awaits. The runtime wraps
 * every plugin.apply() in withOwnerScope(plugin.name, ...); AsyncLocalStorage
 * carries the owner through the whole async body, so registrations made
 * after an await are attributed exactly like sync ones.
 */
const ownerStorage = new AsyncLocalStorage<string | undefined>();

/** Run fn with an ambient owner scope; async continuations inherit it. */
export function withOwnerScope<T>(owner: string | undefined, fn: () => T): T {
  return ownerStorage.run(owner, fn);
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
    const currentOwner = this.owners.get(key);
    const newOwner = ownerStorage.getStore();
    if (currentOwner && newOwner && currentOwner !== newOwner && !options?.override) {
      throw new OwnershipError(key, currentOwner, newOwner);
    }
    const previous = this.services.has(key)
      ? { value: this.services.get(key), owner: this.owners.get(key) }
      : undefined;
    this.services.set(key, service);
    this.owners.set(key, newOwner);
    this.notifyServiceChange({ type: "provided", key, owner: newOwner });
    return onceDisposer(() => {
      // Restore the previous provider when this registration unwinds, so a
      // scoped override never leaves a dangling key behind.
      if (previous === undefined) {
        this.services.delete(key);
        this.owners.delete(key);
        this.notifyServiceChange({ type: "removed", key, owner: newOwner });
      } else {
        this.services.set(key, previous.value);
        this.owners.set(key, previous.owner);
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
