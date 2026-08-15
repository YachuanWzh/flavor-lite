import { describe, expect, it } from "vitest";
import { Runtime, definePlugin, type PluginContext } from "../src/kernel";
import { hooksPlugin, type HookBusService } from "../src/plugins/hooks";

describe("kernel runtime", () => {
  it("activates plugins in dependency order regardless of mount order", () => {
    const order: string[] = [];
    const a = definePlugin({
      name: "a",
      inject: ["b-service"],
      apply(ctx) {
        order.push("a");
        expect(ctx.get("b-service")).toBe("B");
      },
    });
    const b = definePlugin({
      name: "b",
      provides: ["b-service"],
      apply(ctx) {
        order.push("b");
        ctx.provide("b-service", "B");
      },
    });

    const runtime = Runtime.create();
    runtime.use(a).use(b).start();
    expect(order).toEqual(["b", "a"]);
  });

  it("fails loud when a required service has no provider", () => {
    const broken = definePlugin({
      name: "broken",
      inject: ["missing"],
      apply() {},
    });
    expect(() => Runtime.create().use(broken).start()).toThrow(/requires service "missing"/);
  });

  it("fails loud on duplicate service providers", () => {
    const one = definePlugin({ name: "one", provides: ["dup"], apply() {} });
    const two = definePlugin({ name: "two", provides: ["dup"], apply() {} });
    expect(() => Runtime.create().use(one).use(two).start()).toThrow(/provided by both/);
  });

  it("fails loud on dependency cycles", () => {
    const x = definePlugin({ name: "x", inject: ["svc-y"], provides: ["svc-x"], apply() {} });
    const y = definePlugin({ name: "y", inject: ["svc-x"], provides: ["svc-y"], apply() {} });
    expect(() => Runtime.create().use(x).use(y).start()).toThrow(/cycle/);
  });

  it("provide/get restores the previous provider on dispose", () => {
    const runtime = Runtime.create();
    const disposeFirst = runtime.ctx.provide("greeting", "hello");
    const disposeSecond = runtime.ctx.provide("greeting", "bonjour");
    expect(runtime.ctx.get("greeting")).toBe("bonjour");
    disposeSecond();
    expect(runtime.ctx.get("greeting")).toBe("hello");
    disposeFirst();
    expect(runtime.ctx.tryGet("greeting")).toBeUndefined();
  });

  it("unwinds effects in reverse order on dispose", async () => {
    const order: string[] = [];
    const plugin = definePlugin({
      name: "effects",
      apply(ctx: PluginContext) {
        ctx.effect(() => {
          order.push("first-setup");
          return () => order.push("first-dispose");
        });
        ctx.effect(() => {
          order.push("second-setup");
          return () => order.push("second-dispose");
        });
      },
    });
    const runtime = Runtime.create().use(plugin);
    runtime.start();
    await runtime.dispose();
    expect(order).toEqual(["first-setup", "second-setup", "second-dispose", "first-dispose"]);
  });

  it("runs waterfall listeners as around-middleware and supports short-circuit", async () => {
    const runtime = Runtime.create().use(hooksPlugin);
    runtime.start();
    const hooks = runtime.ctx.get("hooks") as HookBusService;
    const trace: string[] = [];
    hooks.hook<number>("double", async (value, next) => {
      trace.push("outer-in");
      const result = await next(value + 1);
      trace.push("outer-out");
      return result * 10;
    });
    hooks.hook<number>("double", (value) => {
      trace.push("short-circuit");
      return value + 100; // never calls next()
    });
    hooks.hook<number>("double", () => {
      trace.push("unreachable");
      return 0;
    });

    const result = await hooks.waterfall<number>("double", 1);
    expect(trace).toEqual(["outer-in", "short-circuit", "outer-out"]);
    expect(result).toBe((1 + 1 + 100) * 10);
  });

  it("fails loud when a plugin injects hooks but the hooks plugin is not mounted", () => {
    const needy = definePlugin({
      name: "needy",
      inject: ["hooks"],
      apply() {},
    });
    expect(() => Runtime.create().use(needy).start()).toThrow(/requires service "hooks"/);
  });

  it("unmount runs the disposer, releases effects, and allows remount", async () => {
    const events: string[] = [];
    const makePlugin = (value: string) =>
      definePlugin({
        name: "svc",
        provides: ["svc"],
        apply(ctx) {
          events.push(`apply-${value}`);
          return ctx.effect(() => ctx.provide("svc", value), "svc.provide");
        },
      });
    const runtime = Runtime.create();
    runtime.use(makePlugin("v1")).start();
    expect(runtime.ctx.get("svc")).toBe("v1");

    expect(await runtime.unmount("svc")).toBe(true);
    expect(runtime.ctx.tryGet("svc")).toBeUndefined();

    runtime.use(makePlugin("v2")); // runtime already started: activates immediately
    expect(runtime.ctx.get("svc")).toBe("v2");
    expect(events).toEqual(["apply-v1", "apply-v2"]);
    expect(await runtime.unmount("missing")).toBe(false);
  });

  it("unmount releases only the unmounted plugin's effects regardless of order", async () => {
    const runtime = Runtime.create();
    const a = definePlugin({
      name: "a",
      provides: ["a-svc"],
      apply(ctx) {
        return ctx.effect(() => ctx.provide("a-svc", "A"), "a.provide");
      },
    });
    const b = definePlugin({
      name: "b",
      provides: ["b-svc"],
      apply(ctx) {
        return ctx.effect(() => ctx.provide("b-svc", "B"), "b.provide");
      },
    });
    runtime.use(a).use(b).start();
    await runtime.unmount("a"); // first-mounted plugin: must not touch b's effects
    expect(runtime.ctx.tryGet("a-svc")).toBeUndefined();
    expect(runtime.ctx.get("b-svc")).toBe("B");
  });
});
