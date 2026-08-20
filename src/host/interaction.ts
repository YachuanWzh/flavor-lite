/**
 * Terminal implementation of the `interaction` capability seam, plus its
 * plugin wrapper. Interactive REPLs inject their existing readline interface
 * so permission answers have one stdin listener and one terminal echo; other
 * hosts fall back to a short-lived standalone interface.
 */

import * as readline from "node:readline/promises";
import { definePlugin } from "../kernel";
import type { PluginContext } from "../kernel/types";
import type { InteractionService } from "../plugins/permission";

export interface TerminalInteractionOptions {
  /** Called before asking; the host uses it to pause prompt rendering. */
  onBeforeAsk?: () => void;
  onAfterAsk?: () => void;
  /** Ask through an existing host-owned readline interface. */
  question?: (prompt: string) => Promise<string>;
}

export interface ReadlineQuestioner {
  question(prompt: string, callback: (answer: string) => void): void;
}

/** Promise adapter that keeps one readline interface in sole control of stdin. */
export function questionWithReadline(rl: ReadlineQuestioner, prompt: string): Promise<string> {
  return new Promise((resolve) => rl.question(prompt, resolve));
}

export class TerminalInteraction implements InteractionService {
  constructor(private readonly options: TerminalInteractionOptions = {}) {}

  async ask(question: string): Promise<string | undefined> {
    this.options.onBeforeAsk?.();
    try {
      if (this.options.question) {
        const answer = await this.options.question(`${question} `);
        return answer.trim() === "" ? undefined : answer.trim();
      }
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      try {
        const answer = await rl.question(`${question} `);
        return answer.trim() === "" ? undefined : answer.trim();
      } finally {
        rl.close();
      }
    } finally {
      this.options.onAfterAsk?.();
    }
  }

  async confirm(question: string): Promise<boolean> {
    const answer = await this.ask(`${question} (y/N)`);
    return typeof answer === "string" && /^(y|yes)$/i.test(answer);
  }
}

export type TerminalInteractionPluginConfig = TerminalInteractionOptions;

/** Mounts the terminal interaction as the `interaction` service. */
export const terminalInteractionPlugin = definePlugin<TerminalInteractionPluginConfig>({
  name: "interaction",
  provides: ["interaction"],
  apply(ctx: PluginContext, config: TerminalInteractionPluginConfig = {}) {
    return ctx.effect(() => ctx.provide("interaction", new TerminalInteraction(config)), "interaction.provide");
  },
});
