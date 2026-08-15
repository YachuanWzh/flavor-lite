/**
 * Plugins loader: disk-based plugin discovery and hot reload.
 *
 * Spec (see docs/plugin-dev.md):
 * - Roots: `<cwd>/.flavorlite/plugins/` (project) then `~/.flavorlite/plugins/`
 *   (user); project entries shadow user ones by manifest name.
 * - Each plugin dir holds a `flavor-plugin.json` manifest and an ESM entry
 *   (default `index.js`) whose default export is a Plugin or Plugin[].
 * - init() mounts everything once at startup; reload() unmounts and
 *   re-imports (cache-busted) so edits take effect without a restart.
 * - A broken plugin never crashes the host: it is marked `error` and the
 *   rest keeps running.
 */

import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { definePlugin, errorMessage } from "../../kernel";
import type { Plugin, PluginContext } from "../../kernel/types";
import type { Runtime } from "../../kernel/runtime";
import type { CommandsService } from "../commands";
import { PLUGIN_TEMPLATE_FILES } from "./template";

const MANIFEST_FILE = "flavor-plugin.json";

const manifestSchema = z.object({
  name: z.string().min(1),
  version: z.string().optional(),
  entry: z.string().optional(),
  description: z.string().optional(),
  /** Passed as the `config` argument of every plugin's apply(). */
  config: z.record(z.string(), z.unknown()).optional(),
});

export type PluginManifest = z.infer<typeof manifestSchema>;

export type PluginLoadStatus = "loaded" | "error" | "unloaded";

export interface PluginStatus {
  name: string;
  version: string;
  /** Absolute path of the plugin directory. */
  dir: string;
  scope: "project" | "user";
  status: PluginLoadStatus;
  error?: string;
  /** Service keys declared by the loaded plugins' `provides`. */
  provides: string[];
}

export interface PluginsLoaderConfig {
  /** The runtime plugins are mounted on (passed by the composition root). */
  runtime: Runtime;
  /** Discovery roots, earliest shadows. Defaults to project + user dirs. */
  roots?: string[];
}

export interface PluginsLoaderService {
  /** Discover and load every plugin once. Called by the host at startup. */
  init(): Promise<void>;
  /** Reload one plugin by name, or everything when omitted. */
  reload(name?: string): Promise<string[]>;
  /** Status of every discovered plugin (loaded or errored). */
  list(): PluginStatus[];
  /** Scaffold a new plugin dir from the template. Returns the dir. */
  scaffold(name: string): Promise<string>;
}

interface DiscoveredPlugin {
  dir: string;
  scope: "project" | "user";
  manifest: PluginManifest;
}

interface LoadedRecord {
  status: PluginStatus;
  /** Plugin names mounted on the runtime, for unmount on reload. */
  pluginNames: string[];
}

const PLUGIN_NAME_PATTERN = /^[a-zA-Z][a-zA-Z0-9_-]*$/;

function defaultRoots(cwd: string): Array<{ root: string; scope: "project" | "user" }> {
  return [
    { root: join(cwd, ".flavorlite", "plugins"), scope: "project" },
    { root: join(homedir(), ".flavorlite", "plugins"), scope: "user" },
  ];
}

class PluginsLoader implements PluginsLoaderService {
  private records = new Map<string, LoadedRecord>();
  private initialized = false;

  constructor(
    private readonly ctx: PluginContext,
    private readonly runtime: Runtime,
    private readonly roots: Array<{ root: string; scope: "project" | "user" }>,
  ) {}

  async init(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;
    await this.reload();
  }

  async reload(name?: string): Promise<string[]> {
    const { discovered, scanErrors } = await this.scan();

    if (name !== undefined) {
      const target = discovered.find((entry) => entry.manifest.name === name);
      if (target) {
        await this.unload(name);
        await this.load(target);
        return [name];
      }
      const broken = scanErrors.find((entry) => entry.name === name || this.recordDirName(name) === entry.name);
      if (broken) {
        await this.unload(name);
        this.records.set(name, { status: broken, pluginNames: [] });
        return [name];
      }
      throw new Error(`plugin "${name}" not found (searched: ${this.roots.map((entry) => entry.root).join(", ")})`);
    }

    // Full reload: unmount everything known, then rebuild from disk.
    for (const key of [...this.records.keys()]) await this.unload(key);
    this.records.clear();
    for (const errorStatus of scanErrors) this.records.set(errorStatus.name, { status: errorStatus, pluginNames: [] });
    for (const target of discovered) await this.load(target);
    return discovered.map((entry) => entry.manifest.name);
  }

  list(): PluginStatus[] {
    return [...this.records.values()].map((record) => record.status);
  }

  async scaffold(name: string): Promise<string> {
    if (!PLUGIN_NAME_PATTERN.test(name)) {
      throw new Error(`invalid plugin name "${name}" (letters, digits, - and _, starting with a letter)`);
    }
    const dir = join(this.ctx.cwd, ".flavorlite", "plugins", name);
    if (existsSync(dir)) throw new Error(`plugin dir already exists: ${dir}`);
    await mkdir(dir, { recursive: true });
    for (const file of PLUGIN_TEMPLATE_FILES) {
      await writeFile(join(dir, file.path), file.render(name), "utf-8");
    }
    return dir;
  }

  /** Scan every root. Broken manifests become error statuses, never throws. */
  private async scan(): Promise<{ discovered: DiscoveredPlugin[]; scanErrors: PluginStatus[] }> {
    const discovered = new Map<string, DiscoveredPlugin>();
    const scanErrors: PluginStatus[] = [];
    for (const { root, scope } of this.roots) {
      let entries: string[];
      try {
        entries = await readdir(root);
      } catch {
        continue; // roots are optional
      }
      for (const entry of entries) {
        const dir = join(root, entry);
        const raw = await readFileSafe(join(dir, MANIFEST_FILE));
        if (raw === undefined) continue; // directory without a manifest is not a plugin
        let manifest: PluginManifest;
        try {
          manifest = manifestSchema.parse(JSON.parse(raw));
        } catch (error) {
          scanErrors.push({
            name: entry,
            version: "-",
            dir,
            scope,
            status: "error",
            error: `invalid ${MANIFEST_FILE}: ${errorMessage(error)}`,
            provides: [],
          });
          continue;
        }
        if (discovered.has(manifest.name)) continue; // earlier root shadows
        discovered.set(manifest.name, { dir, scope, manifest });
      }
    }
    return { discovered: [...discovered.values()], scanErrors };
  }

  private async load(target: DiscoveredPlugin): Promise<void> {
    const { dir, scope, manifest } = target;
    const base: PluginStatus = {
      name: manifest.name,
      version: manifest.version ?? "0.0.0",
      dir,
      scope,
      status: "unloaded",
      provides: [],
    };
    const fail = (error: string): void => {
      this.records.set(manifest.name, { status: { ...base, status: "error", error }, pluginNames: [] });
      this.ctx.logger.warn(`plugin "${manifest.name}" failed to load: ${error}`);
    };

    const entryPath = resolve(dir, manifest.entry ?? "index.js");
    if (!existsSync(entryPath)) {
      fail(`entry not found: ${manifest.entry ?? "index.js"}`);
      return;
    }

    let mod: unknown;
    try {
      // Cache-bust query so reload() re-reads the file from disk.
      mod = await import(`${pathToFileURL(entryPath).href}?v=${Date.now()}`);
    } catch (error) {
      fail(`import failed: ${errorMessage(error)}`);
      return;
    }

    let plugins: Plugin<unknown>[];
    try {
      plugins = normalizeExport((mod as { default?: unknown }).default);
    } catch (error) {
      fail(errorMessage(error));
      return;
    }

    const active = new Set(this.runtime.activePlugins());
    for (const plugin of plugins) {
      if (active.has(plugin.name)) {
        fail(`plugin name "${plugin.name}" is already active (plugin names must be unique)`);
        return;
      }
    }

    const mounted: string[] = [];
    try {
      for (const plugin of plugins) {
        // Runtime is started at this point, so use() activates immediately.
        this.runtime.use(plugin, manifest.config as never);
        mounted.push(plugin.name);
      }
    } catch (error) {
      for (const mountedName of mounted.reverse()) await this.runtime.unmount(mountedName);
      fail(`activation failed: ${errorMessage(error)}`);
      return;
    }

    this.records.set(manifest.name, {
      status: {
        ...base,
        status: "loaded",
        provides: plugins.flatMap((plugin) => plugin.provides ?? []),
      },
      pluginNames: mounted,
    });
  }

  private async unload(name: string): Promise<void> {
    const record = this.records.get(name);
    if (!record) return;
    for (const pluginName of record.pluginNames.reverse()) {
      try {
        await this.runtime.unmount(pluginName);
      } catch (error) {
        this.ctx.logger.warn(`plugin "${pluginName}" failed during unmount: ${errorMessage(error)}`);
      }
    }
    this.records.delete(name);
  }

  /** Directory name of a previously loaded record, for matching scan errors. */
  private recordDirName(name: string): string | undefined {
    const dir = this.records.get(name)?.status.dir;
    return dir === undefined ? undefined : dir.split(/[\\/]/).pop();
  }
}

function normalizeExport(exported: unknown): Plugin<unknown>[] {
  if (exported === undefined || exported === null) {
    throw new Error("entry module must have a default export: a plugin or an array of plugins");
  }
  const list = Array.isArray(exported) ? exported : [exported];
  if (list.length === 0) throw new Error("default export array must not be empty");
  for (const item of list) {
    const candidate = item as Partial<Plugin<unknown>> | null;
    if (
      !candidate ||
      typeof candidate !== "object" ||
      typeof candidate.name !== "string" ||
      typeof candidate.apply !== "function"
    ) {
      throw new Error('default export items must be plugins: { name, apply(ctx, config), inject?, provides? }');
    }
  }
  return list as Plugin<unknown>[];
}

async function readFileSafe(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf-8");
  } catch {
    return undefined;
  }
}

function registerPluginCommand(ctx: PluginContext, loader: PluginsLoader): () => void {
  const commands = ctx.tryGet("commands") as CommandsService | undefined;
  if (!commands) return () => {};
  return commands.register({
    name: "plugin",
    description: "Manage plugins (/plugin list | reload [name] | new <name>)",
    async run(args) {
      const [sub, ...rest] = args.trim() === "" ? [] : args.trim().split(/\s+/);
      switch (sub ?? "list") {
        case "list": {
          const statuses = loader.list();
          if (statuses.length === 0) return "no plugins found (.flavorlite/plugins/ is empty)";
          return statuses
            .map((status) => {
              const head = `  ${status.name.padEnd(16)} ${status.version.padEnd(8)} ${status.status.padEnd(7)} [${status.scope}]`;
              const detail =
                status.status === "error"
                  ? `\n    error: ${status.error}`
                  : status.provides.length > 0
                    ? `\n    provides: ${status.provides.join(", ")}`
                    : "";
              return head + detail;
            })
            .join("\n");
        }
        case "reload": {
          const target = rest[0];
          let names: string[];
          try {
            names = await loader.reload(target);
          } catch (error) {
            return `error: ${errorMessage(error)}`;
          }
          const statuses = loader.list();
          const failed = statuses.filter((status) => names.includes(status.name) && status.status === "error");
          const lines = [
            `reloaded: ${names.join(", ") || "none"}`,
            ...failed.map((status) => `error in "${status.name}": ${status.error}`),
          ];
          return lines.join("\n");
        }
        case "new": {
          const name = rest[0];
          if (!name) return "usage: /plugin new <name>";
          try {
            const dir = await loader.scaffold(name);
            return `created plugin scaffold at ${dir}\nedit index.js, then run /plugin reload ${name}`;
          } catch (error) {
            return `error: ${errorMessage(error)}`;
          }
        }
        default:
          return `unknown subcommand "${sub}" (use: list | reload [name] | new <name>)`;
      }
    },
  });
}

export const pluginsLoaderPlugin = definePlugin<PluginsLoaderConfig>({
  name: "plugins-loader",
  provides: ["pluginsLoader"],
  apply(ctx: PluginContext, config: PluginsLoaderConfig) {
    if (!config?.runtime) throw new Error("pluginsLoaderPlugin requires config.runtime");
    return ctx.effect(() => {
      const roots = (config.roots ?? defaultRoots(ctx.cwd)).map((root) =>
        typeof root === "string"
          ? { root: isAbsolute(root) ? root : resolve(ctx.cwd, root), scope: "project" as const }
          : root,
      );
      const loader = new PluginsLoader(ctx, config.runtime, roots);
      const disposeService = ctx.provide("pluginsLoader", loader);
      const disposeCommand = registerPluginCommand(ctx, loader);
      return () => {
        disposeCommand();
        disposeService();
      };
    }, "plugins-loader.install");
  },
});

declare module "../../kernel/types" {
  interface ServiceMap {
    pluginsLoader: PluginsLoaderService;
  }
}
