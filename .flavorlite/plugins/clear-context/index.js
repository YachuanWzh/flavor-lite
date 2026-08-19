// clear-context — a flavor-lite plugin.
//
// /clear clears the terminal screen and resets the conversation context:
//   - the session file is rewritten to keep only its header, so the persisted
//     log no longer contains the forgotten history;
//   - a `loop/before-request` listener keeps every later request free of the
//     pre-clear messages, so the model stops seeing the old context even
//     though the in-memory session handle still carries it (the REPL owns
//     that handle; a plugin cannot replace it).
//
// How the trim stays exact: the loop appends every message to the session
// file before the request fires ("model-visible ⇔ logged"), and /clear
// rewrote that file to start fresh. So at request time,
//   fileMessageCount == post-clear messages,
//   request.length - fileMessageCount == pre-clear messages,
// regardless of whether the in-memory history is the original handle (which
// still holds the old messages) or a re-opened one (which does not, e.g.
// after /resume re-reads the rewritten file). A request must keep at least
// one message for most providers, so when the trim would remove everything
// the listener falls back to the newest user message.
import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

const CLEAR_SEQUENCE = "\x1b[2J\x1b[H";

export default {
  name: "clear-context",
  inject: ["hooks", "commands", "session"],
  apply(ctx) {
    return ctx.effect(() => {
      const disposers = [];
      // True once /clear ran in this process; resets on restart, which is
      // fine because a restarted REPL re-reads the already-rewritten file.
      let cleared = false;
      // Pre-clear message count, kept as a fallback when the file cannot be
      // read at request time.
      let clearedAt = 0;

      disposers.push(
        ctx.get("hooks").hook("loop/before-request", async (event, next) => {
          if (cleared) {
            try {
              const sessions = ctx.get("session");
              const sessionId = await sessions.latest();
              if (sessionId) {
                const raw = await readFile(join(sessions.dir, `${sessionId}.jsonl`), "utf-8");
                let fileCount = 0;
                for (const line of raw.split("\n")) {
                  const trimmed = line.trim();
                  if (!trimmed) continue;
                  let parsed;
                  try {
                    parsed = JSON.parse(trimmed);
                  } catch {
                    continue; // torn line; ignore
                  }
                  if (parsed?.type === "message") fileCount += 1;
                }
                const trimCount = Math.max(0, event.messages.length - fileCount);
                if (trimCount > 0 && trimCount < event.messages.length) {
                  event.messages = event.messages.slice(trimCount);
                } else if (trimCount >= event.messages.length && event.messages.length > 0) {
                  // Degenerate: file has no post-clear messages yet. Surface
                  // only the newest user message so the request stays valid.
                  event.messages = newestUserMessage(event.messages);
                }
                return next(event);
              }
            } catch {
              // Best-effort: fall through to the count-based trim below.
            }
            // Fallback: trim by the count recorded at clear time.
            if (event.messages.length > clearedAt) {
              const visible = event.messages.slice(clearedAt);
              event.messages = visible.length > 0 ? visible : newestUserMessage(event.messages);
            }
          }
          return next(event);
        }),
      );

      disposers.push(
        ctx.get("commands").register({
          name: "clear",
          description: "Clear the screen and reset the conversation context",
          async run() {
            const sessions = ctx.get("session");
            const sessionId = await sessions.latest();
            if (sessionId) {
              const filePath = join(sessions.dir, `${sessionId}.jsonl`);
              let headerLine = "";
              try {
                const raw = await readFile(filePath, "utf-8");
                let count = 0;
                for (const line of raw.split("\n")) {
                  const trimmed = line.trim();
                  if (!trimmed) continue;
                  const parsed = JSON.parse(trimmed);
                  if (parsed?.type === "header") headerLine = trimmed;
                  else if (parsed?.type === "message") count += 1;
                }
                cleared = true;
                clearedAt = count;
                // Persisted log starts fresh at the header; messages appended
                // from here on are the post-clear conversation.
                const tmp = `${filePath}.tmp`;
                await writeFile(tmp, headerLine ? `${headerLine}\n` : "", "utf-8");
                await rename(tmp, filePath);
              } catch {
                // The file rewrite is best-effort; the request-time trim still
                // keeps the old context away from the model.
                cleared = true;
              }
            }
            return `${CLEAR_SEQUENCE}context cleared`;
          },
        }),
      );

      return () => {
        for (const dispose of disposers.reverse()) dispose();
      };
    }, "clear-context.install");
  },
};

function newestUserMessage(messages) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === "user") return [messages[index]];
  }
  return [];
}
