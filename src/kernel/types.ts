/**
 * Kernel types. Everything downstream is a plugin built on these primitives.
 *
 * Faithful (but minimal) port of the Cordis ideas used by deepseek-harness:
 * - a context is a repository of services addressed by stable key
 * - registrations are reversible effects
 * - typed services/hooks via declaration merging on `ServiceMap` / `HookMap`
 */

export type Disposer = () => void | Promise<void>;

/**
 * Service map extended by plugins through declaration merging:
 *
 * ```ts
 * declare module "flavor-lite" {
 *   interface ServiceMap { myService: MyService }
 * }
 * ```
 */
// eslint-disable-next-line @typescript-eslint/no-empty-interface
export interface ServiceMap {}

/** Waterfall hook payloads extended by plugins through declaration merging. */
// eslint-disable-next-line @typescript-eslint/no-empty-interface
export interface HookMap {}

export interface Logger {
  debug(message: string): void;
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export const silentLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

/**
 * A plugin is a named registration function plus declarative dependency and
 * capability metadata. `inject` names required service keys (load order is
 * derived from them); `provides` names the service keys the plugin claims.
 */
export interface Plugin<C = unknown> {
  name: string;
  /** Service keys that must exist before this plugin activates. */
  inject?: string[];
  /** Service keys this plugin claims via ctx.provide(). Explicit > implicit. */
  provides?: string[];
  /** Registration is an effect: return a disposer to unwind. */
  apply: (ctx: PluginContext, config: C) => void | Disposer;
}

/** Identity helper so plugins read declaratively. */
export function definePlugin<C = unknown>(plugin: Plugin<C>): Plugin<C> {
  return plugin;
}

export interface KernelOptions {
  cwd?: string;
  logger?: Logger;
}

/**
 * Waterfall listener: around-middleware. Call `next(value)` to delegate to
 * the next listener; return without calling it to short-circuit the chain.
 */
export type WaterfallListener<T> = (value: T, next: (value: T) => Promise<T>) => Promise<T> | T;

export interface PluginContext {
  readonly cwd: string;
  readonly logger: Logger;

  /** Claim a service key. Last provider wins; disposing restores the previous one. */
  provide<K extends keyof ServiceMap>(key: K, service: ServiceMap[K]): Disposer;
  provide(key: string, service: unknown): Disposer;

  /** Resolve a service. Fails loud when absent — misconfiguration never hides. */
  get<K extends keyof ServiceMap>(key: K): ServiceMap[K];
  get(key: string): unknown;

  /** Resolve an optional service without failing. */
  tryGet<K extends keyof ServiceMap>(key: K): ServiceMap[K] | undefined;
  tryGet(key: string): unknown;

  /**
   * Track a reversible registration owned by the current plugin scope.
   * The setup runs immediately; its disposer (or returned function) is
   * invoked on teardown in reverse registration order.
   */
  effect<S>(setup: () => S, label?: string): S;
  effect(setup: () => Disposer | void, label?: string): void;

  /** True until the owning runtime starts disposing. */
  readonly active: boolean;
}
