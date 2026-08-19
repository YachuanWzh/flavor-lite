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
  setStyle(style: FlavorUiStyle): void;
  styleName(): FlavorUiStyle;
}

export interface CreateRendererOptions {
  output?: { isTTY?: boolean; write(chunk: string): unknown };
  color?: boolean;
  tty?: boolean;
  style?: FlavorUiStyle;
  spinnerMs?: number;
}

export function createRenderer(options?: CreateRendererOptions): FlavorUiRenderer;
