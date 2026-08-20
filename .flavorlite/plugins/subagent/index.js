// subagent — a flavor-lite plugin. Edit, then run /plugin reload subagent.
//
// Adds one model-callable tool, `subagent_spawn`, that delegates a task to a
// child agent running its own loop with an isolated session and its own
// system-prompt section. Children can spawn children too; nesting is capped
// at maxDepth (default 3), and a deeper spawn is rejected by the tool so the
// child must finish the work itself.
//
// Depth tracking uses AsyncLocalStorage: the spawn tool reads the current
// nesting depth from the async context it runs in, and drives the child's
// loop inside that context, so grandchildren see depth + 1 automatically —
// no plumbing through the loop plugin.
//
// Report guarantee: the loop exits at the iteration cap without a final
// turn, so a child that spent every iteration on tool calls would hand back
// nothing. When the first run ends without text, the tool drives a short
// wrap-up run in the same session ("stop calling tools, write the report");
// if even that stays silent, a digest is reconstructed from the child's
// session log so the parent never sees a bare "(no output)".
//
// A plugin is a plain object: { name, inject?, provides?, apply(ctx, config) }.
// apply() registers effects and returns a disposer that undoes ALL of them.

import { AsyncLocalStorage } from "node:async_hooks";

const DEFAULT_MAX_DEPTH = 3;
const DEFAULT_MAX_ITERATIONS = 30;
const MAX_OUTPUT_CHARS = 12000;
/** Extra iterations reserved for the wrap-up run when the child never reported. */
const WRAP_UP_MAX_ITERATIONS = 2;

/** Nesting depth of the agent currently running (root = undefined → 0). */
const depthStorage = new AsyncLocalStorage();
/** Child prompt metadata scoped to one concurrent async execution. */
const childContextStorage = new AsyncLocalStorage();

export default {
  name: "subagent",
  inject: ["hooks", "tools", "systemPrompt", "agent"],
  provides: ["subagentRunner"],
  apply(ctx, config = {}) {
    const maxDepth = Number.isInteger(config.maxDepth) ? config.maxDepth : DEFAULT_MAX_DEPTH;
    const defaultMaxIterations = Number.isInteger(config.defaultMaxIterations)
      ? config.defaultMaxIterations
      : DEFAULT_MAX_ITERATIONS;
    return ctx.effect(() => {
      const disposers = [];
      const runner = {
        run(args, execCtx = {}) {
          return spawnTool(ctx, { maxDepth, defaultMaxIterations }).execute(args, execCtx);
        },
      };
      disposers.push(ctx.provide("subagentRunner", runner));

      // Guidance for every agent that sees the tool list: when to delegate.
      disposers.push(
        ctx.get("hooks").hook("prompt/assemble", async (event, next) => {
          event.sections.push({ name: "subagents", content: usageSection(maxDepth) });
          const child = childContextStorage.getStore();
          if (child) {
            event.sections.push({
              name: "subagent-context",
              content: childSection(child.task, child.role, child.depth, child.maxDepth, child.maxIterations),
            });
          }
          return next(event);
        }),
      );

      disposers.push(ctx.get("tools").register({
        ...spawnTool(ctx, { maxDepth, defaultMaxIterations }),
        execute: (args, execCtx) => runner.run(args, execCtx),
      }));

      // Unwind in reverse registration order on unmount/reload.
      return () => {
        for (const dispose of disposers.reverse()) dispose();
      };
    }, "subagent.install");
  },
};

function spawnTool(ctx, { maxDepth, defaultMaxIterations }) {
  return {
    name: "subagent_spawn",
    description:
      "Spawn a child agent that works independently on a well-scoped task and returns a final report. " +
      `Nesting is allowed up to ${maxDepth} levels; the child gets its own isolated history, tools, and permission policy. ` +
      "Use for large independent subtasks, long research trails, or work whose intermediate steps should stay out of this conversation.",
    category: "control",
    inputSchema: {
      type: "object",
      properties: {
        task: {
          type: "string",
          description:
            "The full, self-contained task for the child agent. The child cannot ask clarifying questions, so be precise.",
        },
        role: {
          type: "string",
          description: "Optional role or persona for the child agent, e.g. 'a code reviewer' or 'a research assistant'.",
        },
        maxIterations: {
          type: "number",
          description: `Optional iteration cap for the child loop (default ${defaultMaxIterations}).`,
        },
      },
      required: ["task"],
    },
    async execute(args, execCtx) {
      const task = typeof args.task === "string" && args.task.trim() ? args.task.trim() : undefined;
      if (!task) return { content: "Missing required argument: task", isError: true };

      // Root agent has no context → depth 1. A child at depth N spawns at N+1.
      const depth = (depthStorage.getStore() ?? 0) + 1;
      if (depth > maxDepth) {
        return {
          content:
            `Cannot spawn a subagent at depth ${depth}: the maximum nesting depth is ${maxDepth}. ` +
            "Finish the task yourself and report the results back to your parent.",
          isError: true,
        };
      }

      const role = typeof args.role === "string" && args.role.trim() ? args.role.trim() : undefined;
      const requested = typeof args.maxIterations === "number" ? Math.floor(args.maxIterations) : undefined;
      const maxIterations =
        requested !== undefined ? Math.max(1, Math.min(requested, DEFAULT_MAX_ITERATIONS)) : defaultMaxIterations;

      // The child gets its own session so its history never pollutes ours.
      // (Checked after the depth gate, so rejected spawns leave no orphan file.)
      const sessionService = ctx.tryGet("session");
      const session = sessionService ? await sessionService.create() : undefined;
      if (session) {
        // Await so the title line is on disk before the parent inspects sessions.
        await session.setTitle(childTitle(task, depth)).catch(() => {});
      }

      try {
        // Driving the child inside depthStorage.run(depth) is what makes the
        // child's own subagent_spawn calls see depth + 1.
        const result = await depthStorage.run(depth, () => childContextStorage.run(
          { task, role, depth, maxDepth, maxIterations },
          async () => {
          const signal = execCtx.signal;
          const first = await runChild(ctx, { input: task, session, maxIterations, signal });
          let { text, iterations, reason, warned } = first;

          // The loop exits at the iteration cap without a final turn, so a
          // child that spent every iteration on tool calls would hand back
          // nothing. Give it one short wrap-up run in the same session.
          if (reason !== "aborted" && !text.trim()) {
            const wrapUp = await runChild(ctx, {
              input: wrapUpPrompt(maxIterations),
              session,
              maxIterations: WRAP_UP_MAX_ITERATIONS,
              signal,
            });
            iterations += wrapUp.iterations;
            warned = warned || wrapUp.warned;
            if (wrapUp.text.trim()) {
              text = wrapUp.text;
              reason = wrapUp.reason;
            }
          }

          const body = text.trim() || sessionDigest(session);
            return report(body, { depth, maxDepth, iterations, reason, warned, sessionId: session?.id });
          },
        ));
        // The child loop titles its session with the task; restore the
        // subagent identity so /sessions listings stay meaningful.
        if (session) await session.setTitle(childTitle(task, depth)).catch(() => {});
        return result;
      } catch (error) {
        return {
          content: `Subagent failed: ${error instanceof Error ? error.message : String(error)}`,
          isError: true,
        };
      }
    },
  };
}

/** Drive one child loop run to completion and collect its outcome. */
async function runChild(ctx, { input, session, maxIterations, signal }) {
  const agent = ctx.get("agent");
  let text = "";
  let iterations = 0;
  let reason = "finished";
  let warned = false;
  for await (const event of agent.run({
    input,
    session,
    maxIterations,
    ...(signal ? { signal } : {}),
  })) {
    if (event.type === "text_delta") text += event.text;
    else if (event.type === "agent_end") {
      iterations = event.iterations;
      reason = event.reason;
    } else if (event.type === "warning") {
      warned = true;
    }
  }
  return { text, iterations, reason, warned };
}

function wrapUpPrompt(budget) {
  return (
    `Your iteration budget (${budget}) is exhausted; this is your last chance to answer. ` +
    "Do NOT call any more tools. Using everything you learned so far, write your final report now as plain text."
  );
}

function report(text, { depth, maxDepth, iterations, reason, warned, sessionId }) {
  const body = truncate(text.trim(), MAX_OUTPUT_CHARS) || "(subagent produced no text output)";
  const sessionNote = sessionId ? `, session ${sessionId}` : "";
  const head = `[subagent report — depth ${depth}/${maxDepth}, ${iterations} iteration(s), ${reason}${warned ? ", warnings emitted" : ""}${sessionNote}]`;
  return { content: `${head}\n\n${body}` };
}

/**
 * Last-resort reconstruction: the child never wrote a report, so summarize
 * what it actually did from its session log.
 */
function sessionDigest(session) {
  if (!session) return "";
  const calls = [];
  for (const message of session.messages()) {
    if (message.role !== "assistant" || !message.toolCalls) continue;
    for (const toolCall of message.toolCalls) {
      const args = toolCall.args ?? {};
      const target = [args.path, args.pattern, args.command, args.regex, args.query, args.task].find(
        (value) => typeof value === "string" && value.trim(),
      );
      calls.push(target ? `${toolCall.name}: ${firstLine(target).slice(0, 100)}` : toolCall.name);
    }
  }
  if (calls.length === 0) return "";
  return [
    "(The child spent its whole budget on tool calls and never wrote a report; this digest was reconstructed from its session log.)",
    ...calls.map((call) => `- ${call}`),
  ].join("\n");
}

function childSection(task, role, depth, maxDepth, maxIterations) {
  const lines = [
    `You are a subagent spawned by your parent agent. You are at nesting depth ${depth} of ${maxDepth}.`,
    `Assigned task: ${task}`,
  ];
  if (role) lines.push(`Role: ${role}`);
  lines.push(
    "- Work independently using the available tools.",
    `- You have at most ${maxIterations} iterations; stop exploring early enough to keep your last iteration(s) free for the final report — work you never report is lost to the parent.`,
    "- The parent agent receives ONLY this final report, so end with a concise summary of what you did and the key results.",
    `- You may spawn your own subagents (subagent_spawn) only while depth < ${maxDepth}; deeper spawns are rejected by the runtime. Prefer doing the work yourself over delegating further.`,
  );
  return lines.join("\n");
}

function usageSection(maxDepth) {
  return [
    `- Use the subagent_spawn tool to delegate a well-scoped piece of work to a child agent (up to ${maxDepth} levels of nesting).`,
    "- Good candidates: large independent subtasks, long research trails, or experiments whose intermediate steps should not pollute this conversation.",
    "- The child runs with its own isolated history and returns only a final report. Give it one clear, self-contained task string — it cannot ask clarifying questions.",
    "- Size the task to the child's iteration budget: 'explore the whole repo' is usually too broad; prefer scoped tasks like 'summarize the docs' or 'explain how module X works'.",
    "- Do not spawn subagents for trivial lookups; do that work yourself.",
  ].join("\n");
}

function childTitle(task, depth) {
  return `subagent (depth ${depth}): ${firstLine(task).slice(0, 60)}`;
}

function firstLine(text) {
  return text.split("\n", 1)[0] ?? text;
}

function truncate(text, max) {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n…[output truncated at ${max} chars]`;
}
