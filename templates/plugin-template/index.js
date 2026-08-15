// my-plugin — a flavor-lite plugin. Edit, then run /plugin reload my-plugin.
//
// A plugin is a plain object: { name, inject?, provides?, apply(ctx, config) }.
// apply() registers effects and returns a disposer that undoes ALL of them.
// inject entries are SERVICE KEYS (not plugin names) that must already exist.
export default {
  name: "my-plugin",
  inject: ["hooks", "tools", "commands"],
  apply(ctx) {
    return ctx.effect(() => {
      const disposers = [];

      // 1) A tool the model can call (shows up in every request).
      disposers.push(
        ctx.get("tools").register({
          name: "my-plugin_hello",
          description: "Example tool from the my-plugin plugin: returns a greeting.",
          category: "read",
          inputSchema: {
            type: "object",
            properties: { who: { type: "string", description: "Who to greet" } },
          },
          async execute(args) {
            return { content: `Hello ${args.who ?? "world"} from my-plugin!` };
          },
        }),
      );

      // 2) A slash command for the REPL.
      disposers.push(
        ctx.get("commands").register({
          name: "my-plugin",
          description: "Example command from the my-plugin plugin",
          run: () => "Hello from the my-plugin plugin!",
        }),
      );

      // 3) A system-prompt section contributed via the prompt/assemble hook.
      disposers.push(
        ctx.get("hooks").hook("prompt/assemble", async (event, next) => {
          event.sections.push({
            name: "my-plugin",
            content: "Example guidance contributed by the my-plugin plugin.",
          });
          return next(event);
        }),
      );

      // Unwind in reverse registration order on unmount/reload.
      return () => {
        for (const dispose of disposers.reverse()) dispose();
      };
    }, "my-plugin.install");
  },
};
