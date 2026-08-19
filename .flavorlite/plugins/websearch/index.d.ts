/**
 * Type declarations for the websearch plugin's plain-JS entry.
 *
 * The plugin itself is pure ESM JavaScript (zero-dependency, no build step)
 * and is intentionally NOT part of the tsc program. This companion .d.ts
 * lets TypeScript consumers (e.g. the test suite) import it with types.
 * It mirrors the named exports of index.js.
 */

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

export interface SearchToolResult {
  content: string;
  isError?: boolean;
}

export interface SearchExecContext {
  cwd?: string;
  signal?: AbortSignal;
}

export function htmlDecode(input: string): string;
export function stripTags(input: string): string;
export function parseDuckDuckGoLite(html: string): SearchResult[];
export function parseBraveResults(json: unknown): SearchResult[];
export function parseSearxngResults(json: unknown): SearchResult[];
export function searchWeb(
  config?: Record<string, unknown>,
  args?: Record<string, unknown>,
  execCtx?: SearchExecContext,
): Promise<SearchToolResult>;
