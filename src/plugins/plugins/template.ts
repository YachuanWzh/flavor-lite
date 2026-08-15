/**
 * Embedded scaffold template for `/plugin new`. Kept in source (not read
 * from disk) so the published dist bundle stays self-contained. The
 * canonical browsable copy lives in `templates/plugin-template/` — keep
 * both in sync.
 */

export interface TemplateFile {
  path: string;
  render: (name: string) => string;
}

export const PLUGIN_TEMPLATE_FILES: TemplateFile[] = [
  {
    path: "flavor-plugin.json",
    render: (name) =>
      JSON.stringify(
        {
          name,
          version: "0.1.0",
          entry: "index.js",
          description: "Describe what this plugin does.",
        },
        null,
        2,
      ) + "\n",
  },
  {
    path: "index.js",
    render: (name) => `// ${name} — a flavor-lite plugin. Edit, then run /plugin reload ${name}.
//
// A plugin is a plain object: { name, inject?, provides?, apply(ctx, config) }.
// apply() registers effects and returns a disposer that undoes ALL of them.
// inject entries are SERVICE KEYS (not plugin names) that must already exist.
export default {
  name: "${name}",
  inject: ["hooks", "tools", "commands"],
  apply(ctx) {
    return ctx.effect(() => {
      const disposers = [];

      // 1) A tool the model can call (shows up in every request).
      disposers.push(
        ctx.get("tools").register({
          name: "${name}_hello",
          description: "Example tool from the ${name} plugin: returns a greeting.",
          category: "read",
          inputSchema: {
            type: "object",
            properties: { who: { type: "string", description: "Who to greet" } },
          },
          async execute(args) {
            return { content: \`Hello \${args.who ?? "world"} from ${name}!\` };
          },
        }),
      );

      // 2) A slash command for the REPL.
      disposers.push(
        ctx.get("commands").register({
          name: "${name}",
          description: "Example command from the ${name} plugin",
          run: () => "Hello from the ${name} plugin!",
        }),
      );

      // 3) A system-prompt section contributed via the prompt/assemble hook.
      disposers.push(
        ctx.get("hooks").hook("prompt/assemble", async (event, next) => {
          event.sections.push({
            name: "${name}",
            content: "Example guidance contributed by the ${name} plugin.",
          });
          return next(event);
        }),
      );

      // Unwind in reverse registration order on unmount/reload.
      return () => {
        for (const dispose of disposers.reverse()) dispose();
      };
    }, "${name}.install");
  },
};
`,
  },
  {
    path: "README.md",
    render: (name) => `# ${name}

A flavor-lite plugin. Full spec: \`docs/plugin-dev.md\` in the flavor-lite repo.

- Edit \`index.js\`, then run \`/plugin reload ${name}\` in the REPL — no restart.
- \`/plugin list\` shows load status; errors are reported there too.
- Config for \`apply(ctx, config)\` can be passed via the \`config\` field of
  \`flavor-plugin.json\`.
`,
  },
];
