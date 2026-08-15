/**
 * TodoWrite tool: lightweight multi-step task tracking, in-process.
 * State lives on the registry instance so sessions render the latest list.
 */

import { definePlugin } from "../../../kernel";
import type { Plugin } from "../../../kernel/types";
import type { Tool } from "../registry";

export type TodoStatus = "pending" | "in_progress" | "done";

export interface TodoItem {
  id: string;
  content: string;
  status: TodoStatus;
}

export interface TodoStore {
  items(): TodoItem[];
  replace(items: TodoItem[]): void;
}

function createStore(): TodoStore {
  let current: TodoItem[] = [];
  return {
    items: () => current,
    replace: (items) => {
      current = items;
    },
  };
}

export function createTodoTool(store: TodoStore): Tool {
  return {
    name: "TodoWrite",
    category: "control",
    description:
      "Track non-trivial multi-step work as a todo list. Pass the full replacement list each call. Keep at most one item in_progress; mark items done after verification.",
    inputSchema: {
      type: "object",
      properties: {
        todos: {
          type: "array",
          description: "Full replacement list of todo items",
          items: {
            type: "object",
            properties: {
              id: { type: "string" },
              content: { type: "string" },
              status: { type: "string", enum: ["pending", "in_progress", "done"] },
            },
            required: ["id", "content", "status"],
          },
        },
      },
      required: ["todos"],
    },
    async execute(args) {
      const raw = args.todos;
      if (!Array.isArray(raw) || raw.length === 0) {
        return { content: "todos must be a non-empty array", isError: true };
      }
      const items: TodoItem[] = [];
      for (const entry of raw) {
        if (typeof entry !== "object" || entry === null) {
          return { content: "each todo must be an object with id, content, status", isError: true };
        }
        const record = entry as Record<string, unknown>;
        const status = record.status;
        if (typeof record.id !== "string" || typeof record.content !== "string" ||
          status !== "pending" && status !== "in_progress" && status !== "done") {
          return { content: "each todo needs id: string, content: string, status: pending|in_progress|done", isError: true };
        }
        items.push({ id: record.id, content: record.content, status });
      }
      const inProgress = items.filter((item) => item.status === "in_progress");
      if (inProgress.length > 1) {
        return { content: "keep at most one todo in_progress at a time", isError: true };
      }
      store.replace(items);
      const rendered = items
        .map((item) => `- [${item.status === "done" ? "x" : item.status === "in_progress" ? ">" : " "}] ${item.content}`)
        .join("\n");
      return { content: `Todo updated:\n${rendered}` };
    },
  };
}

export const todoToolPlugin: Plugin = definePlugin({
  name: "tool:todo",
  inject: ["tools"],
  provides: ["todos"],
  apply(ctx) {
    return ctx.effect(() => {
      const store = createStore();
      const disposeTodo = ctx.provide("todos", store);
      const disposeTool = ctx.get("tools").register(createTodoTool(store));
      return () => {
        disposeTool();
        disposeTodo();
      };
    }, "tool:todo.register");
  },
});

declare module "../../../kernel/types" {
  interface ServiceMap {
    todos: TodoStore;
  }
}
