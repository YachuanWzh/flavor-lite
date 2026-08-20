/** Type declarations for the pure-JS flavor-ui renderer (tests import it). */

export type FlavorUiStyle = "full" | "plain";

export interface FlavorUiPluginError {
  name: string;
  error: string;
}

export interface FlavorUiBannerInfo {
  version?: string;
  model?: string;
  mode?: string;
  sessionId?: string;
  plugins?: {
    loaded?: number;
    total?: number;
    errors?: FlavorUiPluginError[];
  };
}

export interface FlavorUiRenderer {
  render(event: unknown): void;
  renderUserInput(input: string): void;
  renderBanner(info?: FlavorUiBannerInfo): void;
  renderError(error: Error | string): void;
  renderNotice(message: string): void;
  /** Freeze in-place animations while the host prompts the user. */
  pauseAnimation?(): void;
  /** Register reversible visual semantics for a plugin's tools. */
  registerToolPresentation(
    matcher: string | RegExp | ((name: string, args: Record<string, unknown>) => boolean),
    presentation: FlavorUiToolPresentation,
  ): () => void;
  setStyle(style: FlavorUiStyle): void;
  styleName(): FlavorUiStyle;
}

export interface FlavorUiToolPresentation {
  badge: string;
  accent?: "graphite" | "ion" | "ultraviolet" | "mint" | "ember" | "amber";
  previewOnSuccess?: boolean;
}

export interface CreateRendererOptions {
  output?: { isTTY?: boolean; columns?: number; write(chunk: string): unknown };
  color?: boolean;
  tty?: boolean;
  style?: FlavorUiStyle;
  spinnerMs?: number;
  resolveTool?: (name: string) => { category?: "read" | "write" | "shell" | "control" } | undefined;
}

export function createRenderer(options?: CreateRendererOptions): FlavorUiRenderer;
