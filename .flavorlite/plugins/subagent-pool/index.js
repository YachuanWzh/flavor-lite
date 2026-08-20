export async function runPool(tasks, options = {}) {
  if (!Array.isArray(tasks) || tasks.length === 0) throw new Error("tasks must be a non-empty array");
  const maxTasks = positiveInt(options.maxTasks, 8);
  if (tasks.length > maxTasks) throw new Error(`Too many tasks: ${tasks.length} (max ${maxTasks})`);
  if (options.maxConcurrency !== undefined && (!Number.isInteger(options.maxConcurrency) || options.maxConcurrency < 1 || options.maxConcurrency > 4)) {
    throw new Error("maxConcurrency must be an integer between 1 and 4");
  }
  const maxConcurrency = options.maxConcurrency ?? 2;
  const runner = options.runner;
  if (typeof runner !== "function") throw new Error("runner is required");
  const results = new Array(tasks.length);
  let nextIndex = 0;
  let stopped = false;
  const worker = async () => {
    for (;;) {
      if (stopped) return;
      const index = nextIndex++;
      if (index >= tasks.length) return;
      const task = tasks[index];
      if (!task || typeof task.task !== "string" || !task.task.trim()) {
        results[index] = { content: `Task ${index + 1} is missing task text`, isError: true };
        if (options.failFast) stopped = true;
        continue;
      }
      try { results[index] = await runner(task, options.execCtx ?? {}); }
      catch (error) { results[index] = { content: error instanceof Error ? error.message : String(error), isError: true }; }
      if (results[index]?.isError && options.failFast) stopped = true;
    }
  };
  await Promise.all(Array.from({ length: Math.min(maxConcurrency, tasks.length) }, () => worker()));
  for (let index = 0; index < results.length; index += 1) if (!results[index]) results[index] = { content: "Skipped after an earlier failure.", skipped: true };
  return results;
}

export default {
  name: "subagent-pool",
  inject: ["hooks", "tools", "subagentRunner"],
  apply(ctx, config = {}) {
    return ctx.effect(() => {
      const disposers = [];
      disposers.push(ctx.get("tools").register({
        name: "subagent_batch",
        description: "Run 1-8 independent child-agent tasks concurrently and return reports in input order. Use only when tasks can proceed without sharing intermediate results.",
        category: "control",
        inputSchema: {
          type: "object",
          properties: {
            tasks: { type: "array", minItems: 1, maxItems: config.maxTasks ?? 8, items: { type: "object", properties: { task: { type: "string" }, role: { type: "string" }, maxIterations: { type: "number" } }, required: ["task"] } },
            maxConcurrency: { type: "number", minimum: 1, maximum: Math.min(4, config.maxConcurrency ?? 4) },
            failFast: { type: "boolean" },
          },
          required: ["tasks"],
        },
        async execute(args, execCtx) {
          try {
            const runner = ctx.get("subagentRunner");
            const results = await runPool(args.tasks, {
              maxTasks: config.maxTasks,
              maxConcurrency: Math.min(args.maxConcurrency ?? 2, config.maxConcurrency ?? 4),
              failFast: args.failFast === true,
              execCtx,
              runner: (task, childExecCtx) => runner.run(task, childExecCtx),
            });
            const content = results.map((result, index) => `## subtask ${index + 1} · ${result.skipped ? "skipped" : result.isError ? "failed" : "complete"}\n\n${result.content}`).join("\n\n");
            return { content, ...(results.some((result) => result.isError) ? { isError: true } : {}) };
          } catch (error) { return { content: error instanceof Error ? error.message : String(error), isError: true }; }
        },
      }));
      disposers.push(ctx.get("hooks").hook("prompt/assemble", async (event, next) => { event.sections.push({ name: "subagent-pool", content: "Use subagent_batch when two or more substantial tasks are independent. Keep tasks self-contained, avoid concurrent edits to the same files, and use failFast when later work is pointless after a failure." }); return next(event); }));
      return () => { for (const dispose of disposers.reverse()) dispose(); };
    }, "subagent-pool.install");
  },
};

function positiveInt(value, fallback) { return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback; }
