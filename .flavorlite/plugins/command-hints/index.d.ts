/**
 * Type declarations for command-hints. The runtime entry is plain ESM
 * (index.js); this file only gives TypeScript consumers (tests, tools)
 * the shape of the exported helpers.
 */

export interface CompletionSuggestion {
  /** Text inserted on Tab. Omit for informational candidates (e.g. skills). */
  completion?: string;
  /** Plain-text line shown in the list. */
  display: string;
  /** Optional dimmed description shown after the display. */
  description?: string;
}

export interface CommandSource {
  list(): Array<{ name: string; description?: string }>;
}

export interface PluginSource {
  list(): Array<{ name: string; description?: string; status?: string }>;
}

export interface SkillSource {
  name: string;
  description?: string;
}

export interface CollectOptions {
  line: string;
  commands: CommandSource;
  plugins?: PluginSource;
  skills?: SkillSource[];
}

/** Build completion candidates for a line. */
export function collectSuggestions(options: CollectOptions): Promise<CompletionSuggestion[]>;

declare const plugin: {
  name: string;
  inject: string[];
  apply(ctx: unknown, config: unknown): unknown;
};

export default plugin;
