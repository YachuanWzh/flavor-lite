/**
 * Terminal implementation of the `interaction` capability seam.
 * Permission prompts pause the REPL by closing/reopening readline control:
 * the agent loop awaits these answers while the host keeps rendering events.
 */

import * as readline from "node:readline/promises";
import type { InteractionService } from "../plugins/permission";

export interface TerminalInteractionOptions {
  /** Called before asking; the host uses it to pause prompt rendering. */
  onBeforeAsk?: () => void;
  onAfterAsk?: () => void;
}

export class TerminalInteraction implements InteractionService {
  constructor(private readonly options: TerminalInteractionOptions = {}) {}

  async ask(question: string): Promise<string | undefined> {
    this.options.onBeforeAsk?.();
    try {
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
