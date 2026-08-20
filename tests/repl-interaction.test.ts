import { describe, expect, it, vi } from "vitest";
import { questionWithReadline, TerminalInteraction } from "../src/host/interaction";
import { submittedInputClearSequence } from "../src/host/repl";

describe("REPL terminal ownership", () => {
  it("asks through the existing readline interface exactly once", async () => {
    const question = vi.fn((prompt: string, callback: (answer: string) => void) => callback("y"));
    await expect(questionWithReadline({ question }, "Allow Shell? ")).resolves.toBe("y");
    expect(question).toHaveBeenCalledOnce();

    const interaction = new TerminalInteraction({
      question: (prompt) => questionWithReadline({ question }, prompt),
    });
    await expect(interaction.confirm("Allow Shell?")).resolves.toBe(true);
    expect(question).toHaveBeenCalledTimes(2);
  });

  it("clears submitted input and returns to its original row before UI redraw", () => {
    const oneRow = submittedInputClearSequence("› ", "query", 80);
    expect(oneRow).toBe("\x1b[1A\r\x1b[2K\r");
    expect(oneRow).not.toContain("\x1b[1B");

    const wrapped = submittedInputClearSequence("› ", "123456789", 6);
    expect(wrapped).toBe("\x1b[2A\r\x1b[2K\x1b[1B\x1b[2K\x1b[1A\r");
  });
});
