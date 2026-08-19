/**
 * command-hints — flavor-lite plugin.
 *
 * Slash-command completion for the interactive REPL: as soon as the input
 * line starts with "/", the host renders matching candidates below the line
 * with the typed prefix highlighted, and Tab completes the selected one.
 *
 * Candidate sources:
 * - commands: every registered /-command (host + plugins), e.g. /remember
 * - plugins:  every discovered plugin, completed as "/plugin reload <name>"
 * - skills:   every discovered SKILL.md (informational, not insertable)
 *
 * This plugin only supplies candidates. The terminal UI lives in the host's
 * "repl" service (src/host/completions.ts), which exists while the REPL is
 * running — under one-shot mode (-p) there is no REPL, so the plugin simply
 * no-ops via ctx.tryGet("repl").
 */

const SKILL_CACHE_MS = 5000;

/**
 * Build completion candidates for a line. Exported for tests; the default
 * export wires it into the host through the "repl" service.
 */
export async function collectSuggestions({ line, commands, skills, plugins }) {
  // Only a bare "/command" (no arguments) gets suggestions in this version.
  if (!line.startsWith("/") || line.includes(" ", 1)) return [];
  const typed = line.slice(1).toLowerCase();
  const suggestions = [];

  for (const command of commands.list()) {
    const name = command.name.toLowerCase();
    if (typed !== "" && name === typed) continue; // exact match: nothing left to complete
    if (!name.startsWith(typed)) continue;
    suggestions.push({
      display: `/${command.name}`,
      description: command.description,
      completion: `/${command.name}`,
    });
  }

  for (const status of plugins?.list() ?? []) {
    const name = status.name.toLowerCase();
    if (typed !== "" && name === typed) continue;
    if (!name.startsWith(typed)) continue;
    suggestions.push({
      display: status.name,
      description: `plugin — ${status.description ?? status.status}`,
      completion: `/plugin reload ${status.name}`,
    });
  }

  for (const skill of skills ?? []) {
    const name = skill.name.toLowerCase();
    if (typed !== "" && name === typed) continue;
    if (!name.startsWith(typed)) continue;
    suggestions.push({
      display: skill.name,
      description: `skill — ${skill.description}`,
    });
  }

  // Alphabetical across all sources: a stable order the user can rely on
  // while cycling with Tab, regardless of registration order.
  suggestions.sort((a, b) => (a.display < b.display ? -1 : a.display > b.display ? 1 : 0));

  return suggestions;
}

export default {
  name: "command-hints",
  inject: ["commands", "skills"],
  apply(ctx) {
    return ctx.effect(() => {
      const repl = ctx.tryGet("repl");
      if (!repl) return; // only meaningful inside the interactive REPL

      const commands = ctx.get("commands");
      const skills = ctx.get("skills");
      const plugins = ctx.tryGet("pluginsLoader");

      // Skills discovery touches the disk; cache it briefly per keystroke.
      let cache = { at: 0, list: [] };
      const loadSkills = async () => {
        if (Date.now() - cache.at >= SKILL_CACHE_MS) {
          cache = { at: Date.now(), list: await skills.discover() };
        }
        return cache.list;
      };

      return repl.registerCompleter({
        async complete(line) {
          return collectSuggestions({
            line,
            commands,
            skills: await loadSkills(),
            plugins,
          });
        },
      });
    }, "command-hints.install");
  },
};
