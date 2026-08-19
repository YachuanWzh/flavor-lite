// task-planner — a flavor-lite plugin for complex task planning.
//
// The agent decides when to use it (see the "task-planner" system-prompt
// section contributed below): for multi-step work it calls plan_start to
// decompose the job into atomic tasks, then plan_update after each task
// finishes or fails.
//
// Every plan tool call re-renders a color-coded task board straight to the
// terminal — running green, pending orange, error red, done dim — so the
// user always sees the live state. The model only receives a plain-text
// summary, so ANSI codes never pollute its context.

const TASK_STATUSES = ["pending", "running", "done", "error"];

// --- ANSI colors; degrade to plain text when stdout is not a TTY or
// NO_COLOR is set (same policy as src/host/render.ts). ---
const useColor =
  typeof process !== "undefined" &&
  process.stdout != null &&
  process.stdout.isTTY === true &&
  process.env.NO_COLOR === undefined;

function paint(code) {
  return (text) => (useColor ? `\u001b[${code}m${text}\u001b[0m` : text);
}

const green = paint("32");
const red = paint("31");
const dim = paint("2");
const bold = paint("1");
const orange = paint("38;5;208"); // 256-color orange

const STATUS_STYLE = {
  pending: { color: orange, marker: "•" },
  running: { color: green, marker: "▶" },
  done: { color: dim, marker: "✓" },
  error: { color: red, marker: "✗" },
};

/** Color-coded board written to the terminal. */
function renderBoard(plan) {
  const lines = [bold(plan.goal ? `Task Plan: ${plan.goal}` : "Task Plan")];
  plan.tasks.forEach((task, i) => {
    const style = STATUS_STYLE[task.status];
    lines.push(style.color(`${style.marker} ${i + 1}、${task.content} — ${task.status}`));
  });
  return lines.join("\n");
}

/** Plain-text state summary returned to the model. */
function plainBoard(plan) {
  const lines = [plan.goal ? `Task Plan: ${plan.goal}` : "Task Plan"];
  plan.tasks.forEach((task, i) => {
    lines.push(`${i + 1}、${task.content} — ${task.status}${task.detail ? ` (${task.detail})` : ""}`);
  });
  return lines.join("\n");
}

function show(plan) {
  process.stdout.write(`\n${renderBoard(plan)}\n\n`);
}

/** One active plan per plugin instance; hot reload starts fresh. */
function createStore() {
  let plan = null;
  return {
    get: () => plan,
    set: (next) => {
      plan = next;
    },
  };
}

function createStartTool(store) {
  return {
    name: "plan_start",
    category: "control",
    description:
      "Create a visible task board for complex multi-step work. Decompose the whole job into atomic tasks first: each task is one small, independently verifiable unit of work (e.g. \"add validation to X\", \"run the build and fix failures\"), never a giant compound step. The first task starts running and the rest pending; marking a task done auto-advances the next pending task. Replaces any previous plan. Do not use for trivial single-step requests.",
    inputSchema: {
      type: "object",
      properties: {
        goal: { type: "string", description: "Overall goal of the plan (optional)." },
        tasks: {
          type: "array",
          description: "Atomic tasks, in execution order.",
          items: {
            type: "object",
            properties: {
              content: { type: "string", description: "One atomic, verifiable task." },
              detail: { type: "string", description: "Acceptance criteria or notes (optional)." },
            },
            required: ["content"],
          },
        },
      },
      required: ["tasks"],
    },
    async execute(args) {
      const raw = args.tasks;
      if (!Array.isArray(raw) || raw.length === 0) {
        return { content: "plan_start requires a non-empty tasks array.", isError: true };
      }
      const tasks = [];
      for (const entry of raw) {
        const record = typeof entry === "object" && entry !== null ? entry : {};
        if (typeof record.content !== "string" || record.content.trim() === "") {
          return { content: "Every task needs a non-empty content string.", isError: true };
        }
        tasks.push({
          content: record.content.trim(),
          detail: typeof record.detail === "string" ? record.detail.trim() : "",
          status: tasks.length === 0 ? "running" : "pending",
        });
      }
      const plan = {
        goal: typeof args.goal === "string" ? args.goal.trim() : "",
        tasks,
      };
      const replaced = store.get() ? " (replaced the previous plan)" : "";
      store.set(plan);
      show(plan);
      return {
        content: `Plan created${replaced}. First task is running — call plan_update after each task finishes (done) or fails (error):\n${plainBoard(plan)}`,
      };
    },
  };
}

function createUpdateTool(store) {
  return {
    name: "plan_update",
    category: "control",
    description:
      "Update one task's status on the task board, then re-renders the board. Call it immediately after a task finishes (done), fails (error), or when you begin it (running). Only one task may be running at a time. Marking a task done while nothing is running auto-advances the next pending task to running.",
    inputSchema: {
      type: "object",
      properties: {
        index: { type: "integer", minimum: 1, description: "1-based task index as shown on the board." },
        status: {
          type: "string",
          enum: TASK_STATUSES,
          description: "New status: pending, running, done, or error.",
        },
      },
      required: ["index", "status"],
    },
    async execute(args) {
      const plan = store.get();
      if (!plan) {
        return { content: "No active plan. Call plan_start first.", isError: true };
      }
      const rawIndex = args.index;
      const index =
        typeof rawIndex === "number"
          ? rawIndex
          : typeof rawIndex === "string" && /^\d+$/.test(rawIndex)
            ? Number(rawIndex)
            : NaN;
      if (!Number.isInteger(index) || index < 1 || index > plan.tasks.length) {
        return { content: `index must be an integer between 1 and ${plan.tasks.length}.`, isError: true };
      }
      const status = args.status;
      if (!TASK_STATUSES.includes(status)) {
        return { content: `status must be one of: ${TASK_STATUSES.join(", ")}.`, isError: true };
      }

      const task = plan.tasks[index - 1];
      if (task.status === status) {
        show(plan);
        return { content: `Task ${index} is already ${status}.` };
      }
      if (status === "running") {
        const running = plan.tasks.find((t) => t.status === "running");
        if (running && running !== task) {
          show(plan);
          return {
            content: `Task ${plan.tasks.indexOf(running) + 1} (${running.content}) is still running. Mark it done or error first, then start this one.`,
            isError: true,
          };
        }
      }

      task.status = status;
      // Auto-advance: once a done transition leaves no running task, promote
      // the first pending one so the board always shows what to do next.
      if (status === "done" && !plan.tasks.some((t) => t.status === "running")) {
        const next = plan.tasks.find((t) => t.status === "pending");
        if (next) next.status = "running";
      }
      show(plan);
      return { content: `Task ${index} updated to ${status}:\n${plainBoard(plan)}` };
    },
  };
}

function createViewTool(store) {
  return {
    name: "plan_view",
    category: "read",
    description:
      "Show the current task board: re-renders it to the terminal in color and returns the plain-text state.",
    inputSchema: { type: "object", properties: {} },
    async execute() {
      const plan = store.get();
      if (!plan) return { content: "No active plan." };
      show(plan);
      return { content: plainBoard(plan) };
    },
  };
}

const GUIDANCE = [
  "- task-planner: for complex multi-step work, call plan_start before editing to create a visible task board. Decompose the work into atomic tasks — each task is one small, independently verifiable unit (e.g. \"add validation to X\", \"run the build and fix failures\"); never one giant compound task.",
  "- Keep the board current: call plan_update immediately after each task finishes (done) or fails (error). plan_start marks the first task running; marking a task done auto-advances the next pending task.",
  "- Do not use plan tools for trivial single-step requests — the board is for work with several meaningful steps.",
].join("\n");

export default {
  name: "task-planner",
  inject: ["tools", "hooks"],
  apply(ctx) {
    return ctx.effect(() => {
      const disposers = [];
      const store = createStore();

      disposers.push(ctx.get("tools").register(createStartTool(store)));
      disposers.push(ctx.get("tools").register(createUpdateTool(store)));
      disposers.push(ctx.get("tools").register(createViewTool(store)));
      disposers.push(
        ctx.get("hooks").hook("prompt/assemble", async (event, next) => {
          event.sections.push({ name: "task-planner", content: GUIDANCE });
          return next(event);
        }),
      );

      // Unwind in reverse registration order on unmount/reload.
      return () => {
        for (const dispose of disposers.reverse()) dispose();
      };
    }, "task-planner.install");
  },
};
