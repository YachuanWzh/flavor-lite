import { describe, expect, it } from "vitest";
import { Runtime, definePlugin, type PluginContext } from "../src/kernel";

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
    const runtime = Runtime.create();
    const trace: string[] = [];
    runtime.ctx.hook<number>("double", async (value, next) => {
      trace.push("outer-in");
      const result = await next(value + 1);
      trace.push("outer-out");
      return result * 10;
    });
    runtime.ctx.hook<number>("double", (value) => {
      trace.push("short-circuit");
      return value + 100; // never calls next()
    });
    runtime.ctx.hook<number>("double", () => {
      trace.push("unreachable");
      return 0;
    });

    const result = await runtime.ctx.waterfall<number>("double", 1);
    expect(trace).toEqual(["outer-in", "short-circuit", "outer-out"]);
    expect(result).toBe((1 + 1 + 100) * 10);
  });
});
