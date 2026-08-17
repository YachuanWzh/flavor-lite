import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  ActivationError,
  OwnershipError,
  ReloadError,
  ResolutionError,
  Runtime,
  UndeclaredServiceError,
  definePlugin,
  type LogFields,
  type Logger,
  type PluginContext,
} from "../src/kernel";
import { hooksPlugin, type HookBusService } from "../src/plugins/hooks";

/** Logger spy: async activation failures surface via logger.error. */
function spyLogger(): Logger & { errors: string[]; warns: string[] } {
  const errors: string[] = [];
  const warns: string[] = [];
  return {
    errors,
    warns,
    debug: () => {},
    info: () => {},
    warn: (message: string) => warns.push(message),
    error: (message: string) => errors.push(message),
  };
}

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

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

  it("rolls back already-activated plugins when a batch member fails, and allows retry", async () => {
    const events: string[] = [];
    const good = definePlugin({
      name: "good",
      provides: ["good-svc"],
      apply(ctx) {
        events.push("good-apply");
        ctx.effect(() => {
          const disposeProvide = ctx.provide("good-svc", "G");
          return () => {
            events.push("good-dispose");
            return disposeProvide();
          };
        }, "good.provide");
      },
    });
    const bad = definePlugin({
      name: "bad",
      apply() {
        throw new Error("boom");
      },
    });

    const runtime = Runtime.create();
    runtime.use(good).use(bad);
    expect(() => runtime.start()).toThrow(/boom/);
    await tick(); // rollback teardown is tracked asynchronously
    expect(runtime.ctx.tryGet("good-svc")).toBeUndefined();
    expect(runtime.activePlugins()).toEqual([]);
    expect(events).toEqual(["good-apply", "good-dispose"]);

    // Nothing activated: start() is retryable once the broken plugin is gone.
    runtime.use(good);
    runtime.start();
    expect(runtime.ctx.get("good-svc")).toBe("G");
    expect(runtime.activePlugins()).toEqual(["good"]);
  });

  it("a broken dynamic mount is dropped without poisoning later use() calls", () => {
    const runtime = Runtime.create();
    runtime.start();
    const broken = definePlugin({ name: "broken", inject: ["missing"], apply() {} });
    expect(() => runtime.use(broken)).toThrow(/requires service "missing"/);
    const ok = definePlugin({ name: "ok", provides: ["ok-svc"], apply(ctx) { ctx.provide("ok-svc", 1); } });
    runtime.use(ok); // must not re-resolve (and re-throw) the broken plugin
    expect(runtime.ctx.get("ok-svc")).toBe(1);
  });

  it("disposer inertia: teardown never runs a disposer twice", async () => {
    let disposerRuns = 0;
    let effectRuns = 0;
    const plugin = definePlugin({
      name: "guarded",
      provides: ["guarded-svc"],
      apply(ctx) {
        ctx.effect(() => {
          ctx.provide("guarded-svc", "G");
          return () => {
            effectRuns += 1;
          };
        }, "guarded.provide");
        return () => {
          disposerRuns += 1;
        };
      },
    });
    const runtime = Runtime.create().use(plugin);
    runtime.start();
    expect(await runtime.unmount("guarded")).toBe(true);
    expect(await runtime.unmount("guarded")).toBe(false); // gone: no second run
    await runtime.dispose();
    expect(disposerRuns).toBe(1);
    expect(effectRuns).toBe(1);
  });

  it("unmount refuses to leave dangling consumers unless forced", async () => {
    const provider = definePlugin({
      name: "provider",
      provides: ["dep-svc"],
      apply(ctx) {
        return ctx.effect(() => ctx.provide("dep-svc", "D"), "dep.provide");
      },
    });
    const consumer = definePlugin({
      name: "consumer",
      inject: ["dep-svc"],
      apply() {},
    });
    const runtime = Runtime.create();
    runtime.use(provider).use(consumer).start();

    await expect(runtime.unmount("provider")).rejects.toThrow(/still injected by "consumer"/);
    expect(runtime.ctx.get("dep-svc")).toBe("D"); // nothing was torn down

    await runtime.unmount("provider", { force: true }); // explicit override
    expect(runtime.ctx.tryGet("dep-svc")).toBeUndefined();

    // Once the dependent is gone, unmount is allowed again.
    const runtime2 = Runtime.create();
    runtime2.use(provider).use(consumer).start();
    await runtime2.unmount("consumer");
    expect(await runtime2.unmount("provider")).toBe(true);
  });

  it("scopes effects registered after awaits in an async apply, and tracks them via ready", async () => {
    const events: string[] = [];
    const asyncPlugin = definePlugin({
      name: "async",
      provides: ["async-svc"],
      async apply(ctx) {
        await Promise.resolve();
        ctx.effect(() => {
          const disposeProvide = ctx.provide("async-svc", "A");
          return () => {
            events.push("async-dispose");
            return disposeProvide();
          };
        }, "async.provide");
        return () => {
          events.push("async-return-dispose");
        };
      },
    });
    const runtime = Runtime.create();
    runtime.use(asyncPlugin).start();
    await runtime.ready;
    expect(runtime.ctx.get("async-svc")).toBe("A");
    expect(runtime.activePlugins()).toEqual(["async"]);

    await runtime.unmount("async");
    expect(runtime.ctx.tryGet("async-svc")).toBeUndefined();
    expect(events).toEqual(["async-return-dispose", "async-dispose"]);
  });

  it("releases partial effects and rejects ready when an async apply fails", async () => {
    const logger = spyLogger();
    const flaky = definePlugin({
      name: "flaky",
      provides: ["flaky-svc"],
      async apply(ctx) {
        ctx.effect(() => ctx.provide("flaky-svc", "F"), "flaky.provide");
        await Promise.resolve();
        throw new Error("async boom");
      },
    });
    const runtime = Runtime.create({ logger });
    runtime.use(flaky).start();
    await expect(runtime.ready).rejects.toThrow(/async boom/);
    await tick();
    expect(runtime.ctx.tryGet("flaky-svc")).toBeUndefined(); // partial effect released
    expect(runtime.activePlugins()).toEqual([]);
    expect(logger.errors.some((line) => line.includes("flaky"))).toBe(true);

    // The failure must not wedge the runtime: later mounts still work.
    const ok = definePlugin({ name: "ok", provides: ["ok-svc"], apply(ctx) { ctx.provide("ok-svc", 1); } });
    runtime.use(ok);
    expect(runtime.ctx.get("ok-svc")).toBe(1);
  });

  it("validates plugin config against a Standard Schema before apply", () => {
    const seen: unknown[] = [];
    const schemaPlugin = definePlugin({
      name: "schema",
      config: z.object({ level: z.coerce.number().min(1) }),
      apply(_ctx, config) {
        seen.push(config);
      },
    });

    const runtime = Runtime.create();
    runtime.use(schemaPlugin, { level: "3" } as never).start();
    expect(seen).toEqual([{ level: 3 }]); // validated + transformed value

    const broken = Runtime.create();
    expect(() => broken.use(schemaPlugin, { level: 0 } as never).start()).toThrow(
      /plugin "schema" has an invalid config.*at level/s,
    );
    expect(broken.activePlugins()).toEqual([]);
  });

  it("enforces service ownership: cross-plugin overrides fail loud unless explicit", async () => {
    const owner = definePlugin({
      name: "owner",
      provides: ["owned"],
      apply(ctx) {
        return ctx.effect(() => ctx.provide("owned", "v1"), "owner.provide");
      },
    });
    const intruder = definePlugin({
      name: "intruder",
      apply(ctx) {
        ctx.provide("owned", "v2");
      },
    });
    const runtime = Runtime.create();
    runtime.use(owner).start();
    expect(() => runtime.use(intruder)).toThrow(/owned by plugin "owner"/);
    expect(runtime.ctx.get("owned")).toBe("v1");

    // Deliberate shadowing is opt-in and unwinds back to the owner.
    const scoped = definePlugin({
      name: "scoped",
      apply(ctx) {
        return ctx.effect(() => ctx.provide("owned", "v2", { override: true }), "scoped.override");
      },
    });
    runtime.use(scoped);
    expect(runtime.ctx.get("owned")).toBe("v2");
    await runtime.unmount("scoped");
    expect(runtime.ctx.get("owned")).toBe("v1");
  });

  it("enforces service ownership across awaits in async apply", async () => {
    const owner = definePlugin({
      name: "owner",
      provides: ["als-owned"],
      apply(ctx) {
        ctx.provide("als-owned", "v1");
      },
    });
    const intruder = definePlugin({
      name: "intruder",
      async apply(ctx) {
        await Promise.resolve();
        // After an await the ambient owner still travels with this apply:
        // this must fail loud instead of silently overriding "owner".
        ctx.provide("als-owned", "v2");
      },
    });
    const runtime = Runtime.create();
    runtime.use(owner).start();
    runtime.use(intruder);
    await expect(runtime.ready).rejects.toThrow(/owned by plugin "owner"/);
    expect(runtime.ctx.get("als-owned")).toBe("v1");
  });

  it("distinguishes same-named plugin instances by instance id", async () => {
    const makePlugin = (key: string) =>
      definePlugin({
        name: "dup-name",
        provides: [key],
        apply(ctx) {
          return ctx.effect(() => ctx.provide(key, key), `${key}.provide`);
        },
      });
    const runtime = Runtime.create();
    runtime.use(makePlugin("svc-one")).use(makePlugin("svc-two")).start();
    const instances = runtime.inspect().plugins.filter((info) => info.name === "dup-name");
    expect(instances).toHaveLength(2);
    expect(instances[0]!.instanceId).not.toBe(instances[1]!.instanceId);

    // unmount targets the first instance only; the second keeps its service.
    expect(await runtime.unmount("dup-name")).toBe(true);
    expect(runtime.ctx.tryGet("svc-one")).toBeUndefined();
    expect(runtime.ctx.get("svc-two")).toBe("svc-two");
  });

  it("inspect() exposes services, owners, consumers and activation timing", () => {
    const provider = definePlugin({
      name: "provider",
      provides: ["ins-svc"],
      apply(ctx) {
        ctx.provide("ins-svc", 1);
      },
    });
    const consumer = definePlugin({ name: "consumer", inject: ["ins-svc"], apply() {} });
    const runtime = Runtime.create();
    runtime.use(provider).use(consumer).start();
    const snapshot = runtime.inspect();
    expect(snapshot.started).toBe(true);
    expect(snapshot.disposed).toBe(false);
    expect(snapshot.plugins.map((info) => `${info.name}:${info.status}`)).toEqual([
      "provider:active",
      "consumer:active",
    ]);
    expect(snapshot.services).toContainEqual({ key: "ins-svc", owner: "provider" });
    expect(snapshot.consumers["ins-svc"]).toEqual(["consumer"]);
    expect(typeof snapshot.plugins.find((info) => info.name === "provider")?.activationMs).toBe("number");
  });

  it("plan() dry-runs resolution without activating or consuming pending", () => {
    const runtime = Runtime.create();
    const a = definePlugin({ name: "a", inject: ["plan-b"], apply() {} });
    const b = definePlugin({ name: "b", provides: ["plan-b"], apply() {} });
    const broken = definePlugin({ name: "broken", inject: ["plan-nope"], apply() {} });
    runtime.use(a).use(b).use(broken);
    const outcome = runtime.plan();
    expect(outcome.ordered).toEqual(["b", "a"]);
    expect(outcome.errors).toHaveLength(1);
    expect(outcome.errors[0]).toBeInstanceOf(ResolutionError);
    expect(runtime.activePlugins()).toEqual([]); // nothing ran

    // plan() does not consume the pending list: start() sees the same mounts.
    expect(() => runtime.start()).toThrow(/requires service "plan-nope"/);
    expect(runtime.activePlugins()).toEqual(["b", "a"]);
  });

  it("fails async activations that exceed activationTimeoutMs", async () => {
    const slow = definePlugin({ name: "slow", apply: () => new Promise<void>(() => {}) });
    const runtime = Runtime.create({ activationTimeoutMs: 25 });
    runtime.use(slow).start();
    let caught: unknown;
    try {
      await runtime.ready;
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ActivationError);
    expect((caught as ActivationError).code).toBe("activation/timeout");

    // The runtime stays usable after a timeout failure.
    const ok = definePlugin({
      name: "ok",
      provides: ["ok-after-timeout"],
      apply(ctx) {
        ctx.provide("ok-after-timeout", 1);
      },
    });
    runtime.use(ok);
    expect(runtime.ctx.get("ok-after-timeout")).toBe(1);
  });

  it("warns and moves on when a disposer exceeds teardownTimeoutMs", async () => {
    const logger = spyLogger();
    const sticky = definePlugin({
      name: "sticky",
      apply: () => () => new Promise<void>(() => {}), // disposer never settles
    });
    const runtime = Runtime.create({ logger, teardownTimeoutMs: 25 });
    runtime.use(sticky).start();
    const startedAt = Date.now();
    await runtime.dispose();
    expect(Date.now() - startedAt).toBeLessThan(2000); // shutdown did not wedge
    expect(logger.warns.some((line) => line.includes("timed out"))).toBe(true);
  });

  it("aborts ctx.signal when dispose starts", async () => {
    const runtime = Runtime.create();
    let seen: AbortSignal | undefined;
    const observer = definePlugin({
      name: "observer",
      apply(ctx) {
        seen = ctx.signal;
      },
    });
    runtime.use(observer).start();
    expect(seen!.aborted).toBe(false);
    await runtime.dispose();
    expect(seen!.aborted).toBe(true);
  });

  it("emits lifecycle events for activation, services, unmount and dispose", async () => {
    const runtime = Runtime.create();
    const seen: string[] = [];
    const offs = [
      runtime.on("plugin:activated", (event) => seen.push(`activated:${event.name}`)),
      runtime.on("service:provided", (event) => seen.push(`provided:${event.key}`)),
      runtime.on("service:removed", (event) => seen.push(`removed:${event.key}`)),
      runtime.on("plugin:unmounted", (event) => seen.push(`unmounted:${event.name}`)),
      runtime.on("runtime:disposed", () => seen.push("disposed")),
    ];
    const plugin = definePlugin({
      name: "svc",
      provides: ["evt-svc"],
      apply(ctx) {
        return ctx.effect(() => ctx.provide("evt-svc", 1), "evt.provide");
      },
    });
    runtime.use(plugin).start();
    await runtime.unmount("svc");
    await runtime.dispose();
    for (const off of offs) off();
    expect(seen).toEqual([
      "provided:evt-svc",
      "activated:svc",
      "removed:evt-svc",
      "unmounted:svc",
      "disposed",
    ]);
  });

  it("logs activation failures with structured fields", async () => {
    const fields: Array<LogFields | undefined> = [];
    const logger: Logger = {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: (_message: string, errorFields?: LogFields) => {
        fields.push(errorFields);
      },
    };
    const flaky = definePlugin({
      name: "flaky-fields",
      async apply() {
        throw new Error("field boom");
      },
    });
    const runtime = Runtime.create({ logger });
    runtime.use(flaky).start();
    await expect(runtime.ready).rejects.toThrow(/field boom/);
    expect(fields.some((entry) => entry?.plugin === "flaky-fields" && entry?.phase === "activation")).toBe(true);
  });

  it("typed kernel errors carry stable codes and structured detail", () => {
    const broken = definePlugin({ name: "broken-codes", inject: ["code-nope"], apply() {} });
    let caught: unknown;
    try {
      Runtime.create().use(broken).start();
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ResolutionError);
    expect((caught as ResolutionError).code).toBe("resolution/missing-provider");
    expect((caught as ResolutionError).detail.plugins).toEqual(["broken-codes"]);

    // Ownership violations surface as ActivationError with the original cause.
    const runtime = Runtime.create();
    runtime
      .use(
        definePlugin({
          name: "o",
          provides: ["code-owned"],
          apply(ctx) {
            ctx.provide("code-owned", 1);
          },
        }),
      )
      .start();
    let ownership: unknown;
    try {
      runtime.use(
        definePlugin({
          name: "i",
          apply(ctx) {
            ctx.provide("code-owned", 2);
          },
        }),
      );
    } catch (error) {
      ownership = error;
    }
    expect(ownership).toBeInstanceOf(ActivationError);
    expect((ownership as ActivationError).code).toBe("activation/failed");
    expect(((ownership as ActivationError).cause as OwnershipError).code).toBe("service/ownership");
  });
});

describe("kernel contract & atomic reload", () => {
  it("fails loud when a plugin provides a service outside its declared provides", () => {
    const greedy = definePlugin({
      name: "greedy",
      provides: ["declared-svc"],
      apply(ctx) {
        ctx.provide("undeclared-svc", 1);
      },
    });
    let caught: unknown;
    try {
      Runtime.create().use(greedy).start();
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ActivationError);
    expect((caught as ActivationError).code).toBe("activation/failed");
    const cause = (caught as ActivationError).cause as UndeclaredServiceError;
    expect(cause).toBeInstanceOf(UndeclaredServiceError);
    expect(cause.code).toBe("service/undeclared");
    expect(cause.detail.serviceKey).toBe("undeclared-svc");
  });

  it("leaves implicit plugins (no provides declaration) unchecked", () => {
    const implicit = definePlugin({
      name: "implicit",
      apply(ctx) {
        ctx.provide("implicit-svc", 1);
      },
    });
    const runtime = Runtime.create().use(implicit);
    runtime.start();
    expect(runtime.ctx.get("implicit-svc")).toBe(1);
  });

  it("reload swaps a provider atomically: consumers never see a gap", async () => {
    const makeProvider = (value: string) =>
      definePlugin({
        name: "svc",
        provides: ["svc"],
        apply(ctx) {
          return ctx.effect(() => ctx.provide("svc", value), "svc.provide");
        },
      });
    const consumer = definePlugin({ name: "consumer", inject: ["svc"], apply() {} });
    const runtime = Runtime.create();
    runtime.use(makeProvider("v1")).use(consumer).start();
    expect(runtime.ctx.get("svc")).toBe("v1");

    // unmount is refused while a consumer injects the service; reload is
    // the safe swap.
    await expect(runtime.unmount("svc")).rejects.toThrow(/still injected by "consumer"/);

    expect(await runtime.reload("svc", makeProvider("v2"))).toBe(true);
    expect(runtime.ctx.get("svc")).toBe("v2");
    expect(runtime.activePlugins()).toEqual(["consumer", "svc"]);

    // The replacement owns the key now: unmounting it removes the service
    // instead of resurrecting the replaced instance's value.
    await runtime.unmount("consumer");
    expect(await runtime.unmount("svc")).toBe(true);
    expect(runtime.ctx.tryGet("svc")).toBeUndefined();
    expect(await runtime.reload("svc", makeProvider("v3"))).toBe(false);
  });

  it("reload restores the old instance's services when the replacement fails", async () => {
    const makeProvider = (value: string, fail = false) =>
      definePlugin({
        name: "svc",
        provides: ["svc"],
        async apply(ctx) {
          // Take the service over first, then fail: the botched swap must
          // still leave the old instance fully functional.
          ctx.effect(() => ctx.provide("svc", value), "svc.provide");
          await Promise.resolve();
          if (fail) throw new Error("replacement boom");
        },
      });
    const runtime = Runtime.create();
    runtime.use(makeProvider("v1")).start();
    await runtime.ready;

    await expect(runtime.reload("svc", makeProvider("v2", true))).rejects.toThrow(/replacement boom/);
    expect(runtime.ctx.get("svc")).toBe("v1"); // reverted, not dangling
    expect(runtime.activePlugins()).toEqual(["svc"]);

    expect(await runtime.reload("svc", makeProvider("v2"))).toBe(true);
    expect(runtime.ctx.get("svc")).toBe("v2");
  });

  it("reload refuses a replacement that drops declared services", async () => {
    const provider = definePlugin({
      name: "svc",
      provides: ["svc"],
      apply(ctx) {
        ctx.provide("svc", "v1");
      },
    });
    const narrower = definePlugin({ name: "svc", provides: [], apply() {} });
    const runtime = Runtime.create();
    runtime.use(provider).start();
    let caught: unknown;
    try {
      await runtime.reload("svc", narrower);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ReloadError);
    expect((caught as ReloadError).code).toBe("reload/provider-mismatch");
    expect(runtime.ctx.get("svc")).toBe("v1");
  });

  it("reload never takes over services owned by other plugins", async () => {
    const runtime = Runtime.create();
    runtime
      .use(
        definePlugin({
          name: "a",
          provides: ["a-svc"],
          apply(ctx) {
            ctx.provide("a-svc", "A1");
          },
        }),
      )
      .use(
        definePlugin({
          name: "c",
          provides: ["c-svc"],
          apply(ctx) {
            ctx.provide("c-svc", "C1");
          },
        }),
      )
      .start();
    const greedy = definePlugin({
      name: "a",
      provides: ["a-svc", "c-svc"],
      apply(ctx) {
        ctx.provide("a-svc", "A2"); // takeover: allowed
        ctx.provide("c-svc", "C2"); // owned by "c": must fail loud
      },
    });
    await expect(runtime.reload("a", greedy)).rejects.toThrow(/owned by plugin "c"/);
    expect(runtime.ctx.get("a-svc")).toBe("A1"); // taken-over key reverted
    expect(runtime.ctx.get("c-svc")).toBe("C1");
  });

  it("dispose aggregates teardown errors and still emits runtime:disposed", async () => {
    const logger = spyLogger();
    const runtime = Runtime.create({ logger });
    let disposedSeen = false;
    runtime.on("runtime:disposed", () => {
      disposedSeen = true;
    });
    const flaky = definePlugin({
      name: "flaky-dispose",
      apply() {
        return () => {
          throw new Error("disposer boom");
        };
      },
    });
    runtime.use(flaky).start();
    // A scoped effect whose disposer fails surfaces at context-level teardown.
    runtime.ctx.effect(() => () => {
      throw new Error("effect boom");
    });
    let caught: unknown;
    try {
      await runtime.dispose();
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(AggregateError);
    expect((caught as AggregateError).errors).toHaveLength(2);
    expect(disposedSeen).toBe(true); // guaranteed even when teardown failed
  });
});
