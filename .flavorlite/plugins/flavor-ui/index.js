/**
 * flavor-ui — a timeline UI for the flavor-lite terminal.
 *
 * Provides the "ui" service: when this plugin is loaded, the host delegates
 * event rendering to it (see src/host/render.ts) — live tool cards with a
 * spinner, per-turn stat lines, styled errors, and an echoed prompt for the
 * user's input. Unload or `/plugin reload` away and the host falls back to
 * the default plain rendering.
 *
 * Config (flavor-plugin.json):
 *   { "style": "full" }   // default; "plain" disables spinner animation
 *
 * In the REPL:
 *   /ui         show the current style
 *   /ui on|off  switch between full (animated) and plain (static) style
 */

import { createRenderer } from "./renderer.js";

export default {
  name: "flavor-ui",
  inject: ["commands"],
  provides: ["ui"],
  apply(ctx, config = {}) {
    return ctx.effect(() => {
      const disposers = [];
      const renderer = createRenderer({ style: config.style === "plain" ? "plain" : "full" });

      // Take over terminal rendering for as long as this plugin is mounted.
      disposers.push(ctx.provide("ui", renderer));

      // /ui — inspect and switch the rendering style.
      disposers.push(
        ctx.get("commands").register({
          name: "ui",
          description: "flavor-ui: show style, or switch with /ui on|off",
          run(args) {
            const arg = args.trim().toLowerCase();
            if (arg === "on") {
              renderer.setStyle("full");
              return "flavor-ui: full style (animated tool cards)";
            }
            if (arg === "off") {
              renderer.setStyle("plain");
              return "flavor-ui: plain style (static tool lines)";
            }
            if (arg !== "") return `unknown option "${args.trim()}" (use: on | off)`;
            const name = renderer.styleName() === "full" ? "full style (animated)" : "plain style (static)";
            return `flavor-ui: ${name} — /ui on|off to switch`;
          },
        }),
      );

      // Tab-completion for /ui (the "repl" service only exists in the REPL).
      const repl = ctx.tryGet("repl");
      if (repl) {
        disposers.push(
          repl.registerCompleter({
            complete(line) {
              if (line === "/ui" || line === "/ui ") {
                return [
                  { display: "on", completion: "/ui on", description: "animated tool cards" },
                  { display: "off", completion: "/ui off", description: "static tool lines" },
                ];
              }
              return [];
            },
          }),
        );
      }

      return () => {
        for (const dispose of disposers.reverse()) dispose();
      };
    }, "flavor-ui.install");
  },
};
