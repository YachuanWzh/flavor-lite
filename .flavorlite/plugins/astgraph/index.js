// astgraph — a flavor-lite plugin (ported from flavor-code src/init/astgraph).
//
// Code graph for precise navigation: builds a SQLite index of functions,
// classes, interfaces, types and their call/import/heritage edges, then
// exposes five agent tools and an /ast command.
//
//   tools     ast_search / ast_callers / ast_callees / ast_impact / ast_context
//   command   /ast       init | sync | status | search | impact | callers | callees | context | help
//   hooks     tools/after-call (incremental sync after file-modifying tools)
//
// Heavy lifting is lazy: activation only registers handlers; WASM grammars
// and the database load on first use.
//
// Data lives at <cwd>/.flavorlite/astgraph/index.db (WAL mode, node:sqlite).
// Requires Node >= 22.5 for node:sqlite; on older runtimes the plugin loads
// but every query reports a friendly error.

import { existsSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";

export default {
  name: "astgraph",
  inject: ["hooks", "tools", "commands"],
  apply(ctx) {
    return ctx.effect(() => {
      const root = ctx.cwd;
      const hooks = ctx.get("hooks");
      const tools = ctx.get("tools");
      const commands = ctx.get("commands");
      const disposers = [];

      function dbPath() {
        return join(root, ".flavorlite", "astgraph", "index.db");
      }

      async function mod(name) {
        return import(new URL(`./${name}`, import.meta.url).href);
      }

      /** Open the graph database when it exists; otherwise undefined (not indexed yet). */
      async function openIndex() {
        const path = dbPath();
        if (!existsSync(path)) return undefined;
        const { openDb } = await mod("db.mjs");
        return { db: openDb(path), path };
      }

      async function runIndex(options = {}) {
        const { openDb } = await mod("db.mjs");
        const { indexProject } = await mod("indexer.mjs");
        const db = openDb(dbPath());
        try {
          return await indexProject(root, { db, ...options });
        } finally {
          db.close();
        }
      }

      function workspaceRelative(path) {
        if (path === undefined) return undefined;
        const candidate = isAbsolute(path) ? relative(root, path) : path;
        return candidate.split("\\").join("/").replace(/^\.\//, "");
      }

      const notIndexed = { ok: false, error: "astgraph index not built. Ask the user to run /ast init." };

      async function withDb(fn) {
        const index = await openIndex();
        if (index === undefined) return notIndexed;
        try {
          return await fn(index.db, root);
        } finally {
          index.db.close();
        }
      }

      // --- argument coercion (JSON Schema describes, execute enforces) ----

      function coerceInt(value, fallback, min, max) {
        const n = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : NaN;
        if (!Number.isFinite(n)) return fallback;
        return Math.min(max, Math.max(min, Math.floor(n)));
      }

      function coerceDirection(value) {
        return value === "up" || value === "down" || value === "both" ? value : "up";
      }

      function requireString(value, label) {
        if (typeof value === "string" && value.trim() !== "") return value.trim();
        return undefined;
      }

      // --- tools ----------------------------------------------------------

      const nodeInput = {
        type: "object",
        properties: {
          id: { type: "string", description: "Node id, e.g. 'src/order.ts#cancelOrder' (find with ast_search)" },
        },
        required: ["id"],
      };

      const searchSchema = {
        type: "object",
        properties: {
          query: { type: "string", description: "Natural-language or symbol keywords, e.g. '订单 取消' or 'cancelOrder'" },
          limit: { type: "number", minimum: 1, maximum: 50, description: "Max results (default 10)" },
        },
        required: ["query"],
      };

      const impactSchema = {
        type: "object",
        properties: {
          id: { type: "string", description: "Node id, e.g. 'src/order.ts#cancelOrder'" },
          hops: { type: "number", minimum: 1, maximum: 5, description: "Traversal depth (default 2)" },
          direction: { type: "string", enum: ["up", "down", "both"], description: "up=who depends on me, down=what I depend on (default up)" },
        },
        required: ["id"],
      };

      const contextSchema = {
        type: "object",
        properties: {
          id: { type: "string", description: "Node id, e.g. 'src/order.ts#cancelOrder'" },
          hops: { type: "number", minimum: 1, maximum: 3, description: "Subgraph depth (default 1)" },
        },
        required: ["id"],
      };

      const toolsList = [
        {
          name: "ast_search",
          description: "Search the code graph for anchor symbols by keyword (full-text + identifier segments). Use before grep/read when locating where a change belongs.",
          category: "read",
          inputSchema: searchSchema,
          async execute(args) {
            const query = requireString(args.query, "query");
            if (query === undefined) return { content: "Missing required argument: query", isError: true };
            const out = await withDb(async (db) => {
              const { search } = await mod("query.mjs");
              return { results: search(db, query, { limit: coerceInt(args.limit, 10, 1, 50) }) };
            });
            return { content: JSON.stringify(out) };
          },
        },
        {
          name: "ast_callers",
          description: "List the functions/classes that call or import a node in the code graph (upward dependencies).",
          category: "read",
          inputSchema: nodeInput,
          async execute(args) {
            const id = requireString(args.id, "id");
            if (id === undefined) return { content: "Missing required argument: id", isError: true };
            const out = await withDb(async (db) => {
              const { callers, getNode } = await mod("query.mjs");
              const node = getNode(db, id);
              return node === undefined ? { error: `Unknown node id "${id}"` } : { node, callers: callers(db, id) };
            });
            return { content: JSON.stringify(out) };
          },
        },
        {
          name: "ast_callees",
          description: "List the functions a node calls or imports (downward dependencies).",
          category: "read",
          inputSchema: nodeInput,
          async execute(args) {
            const id = requireString(args.id, "id");
            if (id === undefined) return { content: "Missing required argument: id", isError: true };
            const out = await withDb(async (db) => {
              const { callees, getNode } = await mod("query.mjs");
              const node = getNode(db, id);
              return node === undefined ? { error: `Unknown node id "${id}"` } : { node, callees: callees(db, id) };
            });
            return { content: JSON.stringify(out) };
          },
        },
        {
          name: "ast_impact",
          description: "Compute the K-hop blast radius of changing a node: who depends on it (up) or what it depends on (down). Use to scope a modification safely.",
          category: "read",
          inputSchema: impactSchema,
          async execute(args) {
            const id = requireString(args.id, "id");
            if (id === undefined) return { content: "Missing required argument: id", isError: true };
            const hops = coerceInt(args.hops, 2, 1, 5);
            const direction = coerceDirection(args.direction);
            const out = await withDb(async (db) => {
              const { impact, getNode } = await mod("query.mjs");
              if (getNode(db, id) === undefined) return { error: `Unknown node id "${id}"` };
              return impact(db, id, { hops, direction });
            });
            return { content: JSON.stringify(out) };
          },
        },
        {
          name: "ast_context",
          description: "Assemble the precise subgraph around a node: file paths and line ranges of the anchor, its callers and callees. Read only these ranges instead of grepping.",
          category: "read",
          inputSchema: contextSchema,
          async execute(args) {
            const id = requireString(args.id, "id");
            if (id === undefined) return { content: "Missing required argument: id", isError: true };
            const out = await withDb(async (db) => {
              const { subgraphContext } = await mod("query.mjs");
              return subgraphContext(db, id, { hops: coerceInt(args.hops, 1, 1, 3) });
            });
            return { content: JSON.stringify(out) };
          },
        },
      ];
      for (const tool of toolsList) disposers.push(tools.register(tool));

      // --- /ast command ---------------------------------------------------

      const HELP_TEXT = [
        "/ast init                Build the full code graph (.flavorlite/astgraph/index.db)",
        "/ast sync [path...]      Incrementally re-index (defaults to changed files only)",
        "/ast status              Show graph statistics",
        "/ast search <query>      Find anchor symbols (FTS + identifier segments)",
        "/ast callers <node-id>   Who calls this node",
        "/ast callees <node-id>   What this node calls",
        "/ast impact <node-id> [--hops N] [--direction up|down|both]  Blast radius",
        "/ast context <node-id> [--hops N]  Precise file:line read ranges around a node",
        "",
        "Node ids look like 'src/order.ts#cancelOrder'. Agent tools: ast_search, ast_callers, ast_callees, ast_impact, ast_context.",
      ].join("\n");

      function parseFlag(args, name, fallback) {
        const index = args.indexOf(name);
        if (index < 0) return fallback;
        const value = Number(args[index + 1]);
        return Number.isFinite(value) ? value : fallback;
      }

      function parseStringFlag(args, name, fallback) {
        const index = args.indexOf(name);
        return index < 0 ? fallback : args[index + 1] ?? fallback;
      }

      async function commandAst(sub, rest) {
        switch (sub) {
          case "init": {
            const result = await runIndex();
            return { command: "init", workspace: root, db: dbPath(), ...result };
          }
          case "sync": {
            const onlyPaths = rest.map((path) => workspaceRelative(path)).filter((path) => path !== undefined);
            const result = await runIndex(onlyPaths.length > 0 ? { onlyPaths } : {});
            return { command: "sync", ...result };
          }
          case "status": {
            const index = await openIndex();
            if (index === undefined) return { command: "status", indexed: false, hint: "Run /ast init first." };
            try {
              const { stats, getMetadata } = await mod("db.mjs");
              const lastIndex = getMetadata(index.db, "last_index");
              return {
                command: "status", indexed: true, db: index.path,
                ...stats(index.db),
                lastIndex: lastIndex === undefined ? undefined : JSON.parse(lastIndex),
              };
            } finally {
              index.db.close();
            }
          }
          default: {
            const nodeId = rest[0];
            if (
              ["search", "callers", "callees", "impact", "context"].includes(sub) &&
              (sub === "search" ? rest.length === 0 : nodeId === undefined)
            ) {
              return { command: sub, error: `Missing ${sub === "search" ? "query" : "node id"}. See /ast help.` };
            }
            const index = await openIndex();
            if (index === undefined) return { command: sub, error: "Graph not built. Run /ast init first." };
            try {
              const { search, callers, callees, impact, subgraphContext, getNode } = await mod("query.mjs");
              if (sub === "search") {
                return { command: sub, query: rest.join(" "), results: search(index.db, rest.join(" ")) };
              }
              const anchor = getNode(index.db, nodeId);
              if (anchor === undefined) return { command: sub, error: `Unknown node id "${nodeId}". Use /ast search to find anchors.` };
              if (sub === "callers") return { command: sub, node: anchor, callers: callers(index.db, nodeId) };
              if (sub === "callees") return { command: sub, node: anchor, callees: callees(index.db, nodeId) };
              const hops = Math.min(5, Math.max(1, parseFlag(rest, "--hops", 2)));
              const direction = parseStringFlag(rest, "--direction", "up");
              if (sub === "impact") {
                return {
                  command: sub, ...impact(index.db, nodeId, {
                    hops, direction: ["up", "down", "both"].includes(direction) ? direction : "up",
                  }),
                };
              }
              return { command: "context", ...subgraphContext(index.db, nodeId, { hops }) };
            } finally {
              index.db.close();
            }
          }
        }
      }

      disposers.push(
        commands.register({
          name: "ast",
          description: "Build and query the code AST graph (/ast init | sync | status | search | impact | callers | callees | context | help)",
          async run(argsLine) {
            const [sub, ...rest] = argsLine.trim() === "" ? [] : argsLine.trim().split(/\s+/);
            if (sub === undefined || sub === "help") return HELP_TEXT;
            try {
              const result = await commandAst(sub, rest);
              return typeof result === "string" ? result : JSON.stringify(result, null, 2);
            } catch (error) {
              return `error: ${error instanceof Error ? error.message : String(error)}`;
            }
          },
        }),
      );

      // --- incremental sync after file-modifying tools -------------------

      /** Extract workspace-relative code file paths from a tool call's args. */
      function changedPaths(toolName, args) {
        const paths = [];
        if (toolName === "Edit" || toolName === "Write") {
          if (typeof args.path === "string") paths.push(args.path);
        } else if (toolName === "ApplyPatch" && typeof args.patch === "string") {
          for (const line of args.patch.split("\n")) {
            if (!line.startsWith("+++ ")) continue;
            const target = line.slice(4).trim().replace(/^b\//, "");
            if (target !== "/dev/null") paths.push(target);
          }
        }
        return paths
          .map((path) => workspaceRelative(path))
          .filter((path) => path !== undefined && /\.(ts|tsx|js|jsx|mjs|cjs|mts|cts)$/.test(path));
      }

      // Fire-and-forget semantics: never block or fail the agent's edit.
      let syncing = Promise.resolve();
      disposers.push(
        hooks.hook("tools/after-call", async (event, next) => {
          if (!event.result.isError) {
            const paths = changedPaths(event.toolCall.name, event.args);
            if (paths.length > 0) {
              syncing = syncing
                .then(() => runIndex({ onlyPaths: paths }))
                .catch((error) => ctx.logger.debug(`astgraph sync skipped: ${error?.message ?? error}`));
            }
          }
          return next(event);
        }),
      );

      return () => {
        for (const dispose of disposers.reverse()) dispose();
      };
    }, "astgraph.install");
  },
};
