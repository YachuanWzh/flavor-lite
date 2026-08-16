/**
 * Hooks capability seam: the waterfall bus as a plugin. The kernel keeps
 * only the service repository and the effect stack; around-middleware lives
 * here. Producers run pipelines via `hooks.waterfall()`, policy plugins
 * attach via `hooks.hook()` — unmount this plugin and no hook point exists.
 */

import { definePlugin } from "../../kernel";
import type { Disposer, HookMap, PluginContext, WaterfallListener } from "../../kernel/types";

export interface HookOptions {
  /** Run before every listener registered so far (outermost in the chain). */
  prepend?: boolean;
}

export interface HookBusService {
  /** Around-middleware pipeline. Listeners must call next() to delegate. */
  waterfall<K extends keyof HookMap>(name: K, value: HookMap[K]): Promise<HookMap[K]>;
  waterfall<T>(name: string, value: T): Promise<T>;

  /** Register an around-middleware listener. Returns a disposer. */
  hook<K extends keyof HookMap>(name: K, listener: WaterfallListener<HookMap[K]>, options?: HookOptions): Disposer;
  hook<T>(name: string, listener: WaterfallListener<T>, options?: HookOptions): Disposer;
}

class HookBus implements HookBusService {
  private hooks = new Map<string, WaterfallListener<unknown>[]>();

  async waterfall<T>(name: string, value: T): Promise<T> {
    const list = this.hooks.get(name) ?? [];
    let index = 0;
    const dispatch = async (current: T): Promise<T> => {
      const listener = list[index++] as WaterfallListener<T> | undefined;
      if (!listener) return current;
      return await listener(current, dispatch);
    };
    return dispatch(value);
  }

  hook<T>(name: string, listener: WaterfallListener<T>, options: HookOptions = {}): Disposer {
    const list = (this.hooks.get(name) ?? []) as WaterfallListener<unknown>[];
    // Prepend is for routers/policies that must observe the payload before
    // every other listener (they become the outermost middleware).
    if (options.prepend) list.unshift(listener as WaterfallListener<unknown>);
    else list.push(listener as WaterfallListener<unknown>);
    this.hooks.set(name, list);
    return () => {
      const index = list.indexOf(listener as WaterfallListener<unknown>);
      if (index >= 0) list.splice(index, 1);
    };
  }
}

export const hooksPlugin = definePlugin({
  name: "hooks",
  provides: ["hooks"],
  apply(ctx: PluginContext) {
    return ctx.effect(() => ctx.provide("hooks", new HookBus()), "hooks.provide");
  },
});

declare module "../../kernel/types" {
  interface ServiceMap {
    hooks: HookBusService;
  }
}
