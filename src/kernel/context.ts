/**
 * The context implementation: a repository of services and a stack of
 * reversible effects. One context backs one runtime. Everything else —
 * waterfall hooks included — is a plugin built on these two primitives.
 */

import type { Disposer, Logger, PluginContext } from "./types";

interface EffectRecord {
  label: string;
  dispose: Disposer | void;
}

export class Context implements PluginContext {
  readonly cwd: string;
  readonly logger: Logger;

  private services = new Map<string, unknown>();
  private effects: EffectRecord[] = [];
  private disposed = false;

  constructor(options: { cwd: string; logger: Logger }) {
    this.cwd = options.cwd;
    this.logger = options.logger;
  }

  get active(): boolean {
    return !this.disposed;
  }

  provide(key: string, service: unknown): Disposer {
    this.assertActive("provide");
    const previous = this.services.has(key) ? this.services.get(key) : undefined;
    this.services.set(key, service);
    return () => {
      // Restore the previous provider when this registration unwinds, so a
      // scoped override never leaves a dangling key behind.
      if (previous === undefined) this.services.delete(key);
      else this.services.set(key, previous);
    };
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
    const dispose = typeof result === "function" ? (result as unknown as Disposer) : undefined;
    this.effects.push({ label: label ?? setup.name ?? "effect", dispose });
    return result;
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
