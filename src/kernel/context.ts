/**
 * The context implementation: a repository of services and a stack of
 * reversible effects. One context backs one runtime. Everything else —
 * waterfall hooks included — is a plugin built on these two primitives.
 */

import type { Disposer, Logger, PluginContext, ProvideOptions } from "./types";

interface EffectRecord {
  id: number;
  label: string;
  dispose: Disposer | void;
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

  private services = new Map<string, unknown>();
  /** Owning plugin per key; undefined when claimed outside an apply(). */
  private owners = new Map<string, string | undefined>();
  /** Plugin whose apply() is running right now (set by the runtime). */
  private ownerScope: string | undefined;
  private effects: EffectRecord[] = [];
  private nextEffectId = 0;
  private disposed = false;

  constructor(options: { cwd: string; logger: Logger }) {
    this.cwd = options.cwd;
    this.logger = options.logger;
  }

  get active(): boolean {
    return !this.disposed;
  }

  provide(key: string, service: unknown, options?: ProvideOptions): Disposer {
    this.assertActive("provide");
    const currentOwner = this.owners.get(key);
    const newOwner = this.ownerScope;
    if (currentOwner && newOwner && currentOwner !== newOwner && !options?.override) {
      throw new Error(
        `service "${key}" is owned by plugin "${currentOwner}"; plugin "${newOwner}" cannot provide it (pass { override: true } to shadow deliberately)`,
      );
    }
    const previous = this.services.has(key)
      ? { value: this.services.get(key), owner: this.owners.get(key) }
      : undefined;
    this.services.set(key, service);
    this.owners.set(key, newOwner);
    return onceDisposer(() => {
      // Restore the previous provider when this registration unwinds, so a
      // scoped override never leaves a dangling key behind.
      if (previous === undefined) {
        this.services.delete(key);
        this.owners.delete(key);
      } else {
        this.services.set(key, previous.value);
        this.owners.set(key, previous.owner);
      }
    });
  }

  /** @internal The runtime sets the ambient owner around plugin.apply(). */
  setOwnerScope(owner: string | undefined): void {
    this.ownerScope = owner;
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

  effect<S>(setup: () => S, label?: string): S {
    this.assertActive("effect");
    const result = setup();
    const dispose = typeof result === "function" ? onceDisposer(result as unknown as Disposer) : undefined;
    this.effects.push({ id: this.nextEffectId++, label: label ?? setup.name ?? "effect", dispose });
    return result;
  }

  /** Ids of the currently tracked effects (the runtime scopes plugins with this). */
  effectIds(): number[] {
    return this.effects.map((record) => record.id);
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
        this.logger.warn(`effect "${record.label}" failed during release: ${errorMessage(error)}`);
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
        this.logger.warn(`effect "${record.label}" failed during dispose: ${errorMessage(error)}`);
      }
    }
    this.effects = [];
    this.services.clear();
    this.owners.clear();
    if (errors.length > 0) {
      throw new AggregateError(errors, "one or more effects failed to dispose");
    }
  }

  private assertActive(operation: string): void {
    if (this.disposed) throw new Error(`context is disposed; cannot ${operation}`);
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
