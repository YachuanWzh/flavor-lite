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
 * - Optional directory watching (default on): new plugins appear in the
 *   catalog on their own and removed ones are unmounted; loaded plugins are
 *   never touched by a sync, so an in-flight run is never disturbed.
 * - A broken plugin never crashes the host: it is marked `error` and the
 *   rest keeps running.
 */

import { existsSync, watch, type FSWatcher } from "node:fs";
import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { definePlugin, errorMessage } from "../../kernel";
import type { Plugin, PluginContext } from "../../kernel/types";
import { Runtime } from "../../kernel/runtime";
import type { CommandsService } from "../commands";
import type { ToolRegistry } from "../tools";
import { PLUGIN_TEMPLATE_FILES } from "./template";

const MANIFEST_FILE = "flavor-plugin.json";
/** Last-known-good copies kept per plugin for revert(). */
const MAX_SNAPSHOTS = 5;
/** Sandbox activation must settle fast or the plugin is suspect. */
const VERIFY_TIMEOUT_MS = 5000;
const GENERATED_SOURCE_LIMIT = 1_000_000;
const GENERATED_FORBIDDEN = [
  { pattern: /(?:from\s*|import\s*\(|require\s*\()\s*["'](?:node:)?(?:fs|fs\/promises|child_process|cluster|worker_threads|vm|net|tls|dgram|dns|http|https)["']/i, reason: "direct host module access" },
  { pattern: /\b(?:eval\s*\(|new\s+Function\s*\()/i, reason: "dynamic code execution" },
  { pattern: /\bprocess\s*\.\s*(?:env|exit|kill|chdir|binding|dlopen)\b/i, reason: "direct process control" },
  { pattern: /\b(?:fetch|WebSocket)\s*\(/i, reason: "direct network access" },
  { pattern: /\.get\s*\(\s*["'](?:tools|commands)["']\s*\)\s*\.\s*execute\s*\(/i, reason: "nested execution bypass" },
] as const;
const GENERATED_ALLOWED_INJECT = new Set(["hooks", "tools", "commands", "systemPrompt", "skills"]);
const GENERATED_PREFLIGHT_SCRIPT = String.raw`
const url = process.argv[1];
const config = JSON.parse(process.argv[2] || "{}");
const mod = await import(url);
const exported = Array.isArray(mod.default) ? mod.default : [mod.default];
const noop = () => {};
const services = {
  hooks: { hook: () => noop, waterfall: async (_name, value) => value },
  tools: { register: () => noop, list: () => [], schemas: () => [], get: () => undefined },
  commands: { register: () => noop, list: () => [], execute: async () => undefined },
  systemPrompt: { add: () => noop, assemble: async () => "" },
  skills: { discover: async () => [], usedInRun: async () => [] },
};
const ctx = {
  cwd: process.cwd(),
  logger: { debug: noop, info: noop, warn: noop, error: noop },
  get(key) { if (!(key in services)) throw new Error("unsafe/missing preflight service: " + key); return services[key]; },
  tryGet(key) { return services[key]; },
  provide: () => noop,
  effect: async (fn) => await fn(),
};
for (const plugin of exported) {
  if (!plugin || typeof plugin.apply !== "function") throw new Error("invalid generated plugin export");
  const dispose = await plugin.apply(ctx, config);
  if (typeof dispose === "function") await dispose();
}
`;

const triggersSchema = z.object({
  /** Case-insensitive substrings that recall the plugin (router L0). */
  keywords: z.array(z.string()).optional(),
  /** Regex sources, precompiled at load; an invalid one errors the plugin. */
  patterns: z.array(z.string()).optional(),
  /** Tool names the plugin registers; powers the router's tool fallback. */
  tools: z.array(z.string()).optional(),
  /** Command names the plugin registers. */
  commands: z.array(z.string()).optional(),
});

export type PluginTriggers = z.infer<typeof triggersSchema>;

/** Capabilities a generated plugin may exercise (manifest contract). */
export const PLUGIN_CAPABILITIES = ["shell", "network", "files", "host"] as const;
export type PluginCapability = (typeof PLUGIN_CAPABILITIES)[number];
export type PluginOrigin = "user" | "generated";

/** Governance view of the plugin that registered a tool (see ownerOfTool). */
export interface ToolOwnerInfo {
  name: string;
  origin: PluginOrigin;
  capabilities?: PluginCapability[];
  generatedFrom?: string;
}

const manifestSchema = z.object({
  name: z.string().min(1),
  version: z.string().optional(),
  entry: z.string().optional(),
  description: z.string().optional(),
  /**
   * eager (default): mounted at startup. dynamic: kept unloaded in the
   * catalog until the router recalls it (or /plugin reload targets it).
   */
  activation: z.enum(["eager", "dynamic"]).default("eager"),
  /** Routing hints for the router plugin; never affect activation itself. */
  triggers: triggersSchema.optional(),
  /**
   * Service keys the plugins provide, declared so the loader can resolve
   * cross-plugin dependencies without importing every candidate entry.
   */
  provides: z.array(z.string()).optional(),
  /** Passed as the `config` argument of every plugin's apply(). */
  config: z.record(z.string(), z.unknown()).optional(),
  /**
   * Provenance: "user" plugins are written by a human; "generated" ones were
   * scaffolded by the agent (evolve_improve / /ladder to-plugin). The
   * permission plugin holds generated plugins to tighter defaults, so the
   * marker is the hook governance hangs off.
   */
  origin: z.enum(["user", "generated"]).default("user"),
  /** Where a generated plugin came from: session id or ISO timestamp. */
  generatedFrom: z.string().optional(),
  /**
   * Capabilities a generated plugin may exercise: "shell" (run commands),
   * "network" (reach the internet), "files" (write files), "host" (control
   * the machine). The permission plugin refuses undeclared ones, so a
   * generated plugin without this field is read-only by default.
   */
  capabilities: z.array(z.enum(PLUGIN_CAPABILITIES)).optional(),
});

export type PluginManifest = z.infer<typeof manifestSchema>;

export type PluginLoadStatus = "loaded" | "error" | "unloaded";

/** Outcome of a sandbox dry-run (loader.verify). */
export interface VerifyReport {
  ok: boolean;
  name: string;
  /** Service keys the plugins registered via ctx.provide(). */
  provided: string[];
  /** Tool names registered against the stub registry. */
  tools: string[];
  /** Command names registered against the stub command service. */
  commands: string[];
  error?: string;
}

export interface PluginStatus {
  name: string;
  version: string;
  /** Absolute path of the plugin directory. */
  dir: string;
  scope: "project" | "user";
  status: PluginLoadStatus;
  /** dynamic plugins stay in the catalog until the router recalls them. */
  activation: "eager" | "dynamic";
  description?: string;
  /** Routing hints from the manifest (router only). */
  triggers?: PluginTriggers;
  error?: string;
  /** Service keys declared by the loaded plugins' `provides`. */
  provides: string[];
  /** Service keys declared by the loaded plugins' `inject`. */
  inject: string[];
  /** Provenance marker from the manifest; permission governs "generated" tighter. */
  origin: PluginOrigin;
  /** Provenance of generated plugins (session id or timestamp). */
  generatedFrom?: string;
  /** Declared capabilities of generated plugins (shell/network/files/host). */
  capabilities?: PluginCapability[];
}

export interface PluginsLoaderConfig {
  /** The runtime plugins are mounted on (passed by the composition root). */
  runtime: Runtime;
  /** Discovery roots, earliest shadows. Defaults to project + user dirs. */
  roots?: string[];
  /** Watch the roots and sync the catalog on change. Default true. */
  watch?: boolean;
  /** Debounce window for watch events in ms. Default 250. */
  watchDebounceMs?: number;
}

export interface PluginsLoaderService {
  /** Discover and load every plugin once. Called by the host at startup. */
  init(): Promise<void>;
  /** Reload one plugin by name, or everything when omitted. */
  reload(name?: string): Promise<string[]>;
  /** Status of every discovered plugin (loaded, unloaded, or errored). */
  list(): PluginStatus[];
  /** Routing catalog for the router plugin: same data as list(). */
  catalog(): PluginStatus[];
  /** Load one plugin by name (recursing into its declared deps); no-op when loaded. */
  ensure(name: string): Promise<void>;
  /** Unload one loaded plugin; it returns to the catalog as unloaded. */
  eject(name: string): Promise<void>;
  /** Scaffold a new plugin dir from the template. Returns the dir. */
  scaffold(name: string): Promise<string>;
  /**
   * Sandbox smoke test: import the entry and dry-run it on a shadow runtime
   * with stubbed dependencies, without touching the live host. Reports what
   * the plugin would register.
   */
  verify(name: string): Promise<VerifyReport>;
  /**
   * Restore the latest last-known-good snapshot over the plugin dir and
   * reload. Snapshots are taken on every successful activation.
   */
  revert(name: string): Promise<string>;
  /**
   * Governance lookup: the manifest info of the plugin that registered a
   * tool, so permission can hold generated plugins to tighter defaults.
   * Undefined for tools registered outside the disk loader (builtins).
   */
  ownerOfTool(toolName: string): ToolOwnerInfo | undefined;
}

interface DiscoveredPlugin {
  dir: string;
  scope: "project" | "user";
  manifest: PluginManifest;
}

/** A discovered entry whose module was imported successfully. */
interface ImportedEntry {
  target: DiscoveredPlugin;
  plugins: Plugin<unknown>[];
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
  /** Catalog of the last scan; ensure() resolves deps against it. */
  private discoveredCache: DiscoveredPlugin[] = [];
  /** Tool name -> manifest name of the plugin that registered it. */
  private toolOwners = new Map<string, string>();
  private readonly watchEnabled: boolean;
  private readonly watchDebounceMs: number;
  private readonly watchedRoots = new Set<string>();
  private watchers: FSWatcher[] = [];
  private syncTimer: NodeJS.Timeout | undefined;
  private syncing = false;
  private dirty = false;

  constructor(
    private readonly ctx: PluginContext,
    private readonly runtime: Runtime,
    private readonly roots: Array<{ root: string; scope: "project" | "user" }>,
    watchEnabled = true,
    watchDebounceMs = 250,
  ) {
    this.watchEnabled = watchEnabled;
    this.watchDebounceMs = watchDebounceMs;
  }

  async init(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;
    await this.reload();
    this.startWatch();
  }

  async reload(name?: string): Promise<string[]> {
    const { discovered, scanErrors } = await this.scan();
    this.discoveredCache = discovered;

    if (name !== undefined) {
      const target = discovered.find((entry) => entry.manifest.name === name);
      if (target) {
        await this.unload(name);
        try {
          await this.loadOne(target);
        } catch (error) {
          // Reload is an operator action: record the failure in the catalog
          // instead of throwing, and leave the old version unmounted.
          this.failImport(target, errorMessage(error));
          if ((await this.snapshotList(name)).length > 0) {
            this.ctx.logger.warn(`hint: /plugin revert ${name} restores the last good version`);
          }
        }
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
    await this.loadAll(discovered);
    return discovered.map((entry) => entry.manifest.name);
  }

  list(): PluginStatus[] {
    return [...this.records.values()].map((record) => record.status);
  }

  catalog(): PluginStatus[] {
    return this.list();
  }

  async ensure(name: string): Promise<void> {
    const record = this.records.get(name);
    if (record?.status.status === "loaded") return;
    const target = await this.discover(name);
    if (!target) {
      throw new Error(`plugin "${name}" not found (searched: ${this.roots.map((entry) => entry.root).join(", ")})`);
    }
    await this.loadOne(target);
  }

  /** Locate a discovered plugin by manifest name, rescanning if needed. */
  private async discover(name: string): Promise<DiscoveredPlugin | undefined> {
    let target = this.discoveredCache.find((entry) => entry.manifest.name === name);
    if (!target) {
      const { discovered } = await this.scan();
      this.discoveredCache = discovered;
      target = discovered.find((entry) => entry.manifest.name === name);
    }
    return target;
  }

  async eject(name: string): Promise<void> {
    const record = this.records.get(name);
    if (!record || record.status.status !== "loaded") return;
    await this.unload(name);
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
    // The root may not have existed when init() started watching.
    this.startWatch();
    return dir;
  }

  /**
   * Sandbox smoke test: import the entry, then dry-run mount it on a shadow
   * runtime with an isolated cwd and stubbed dependencies. Nothing touches
   * the live host — no real tools execute, no files in the project change.
   */
  async verify(name: string): Promise<VerifyReport> {
    const report: VerifyReport = { ok: false, name, provided: [], tools: [], commands: [] };
    const target = await this.discover(name);
    if (!target) {
      report.error = `plugin "${name}" not found (searched: ${this.roots.map((entry) => entry.root).join(", ")})`;
      return report;
    }

    let plugins: Plugin<unknown>[];
    try {
      plugins = await this.importEntry(target);
    } catch (error) {
      report.error = errorMessage(error);
      return report;
    }

    const shadowCwd = await mkdtemp(join(tmpdir(), "flavor-verify-"));
    const shadow = Runtime.create({ cwd: shadowCwd });
    const sink = { tools: report.tools, commands: report.commands };
    const providedByEntry = new Set(plugins.flatMap((plugin) => plugin.provides ?? []));
    for (const key of new Set(plugins.flatMap((plugin) => plugin.inject ?? []))) {
      if (providedByEntry.has(key)) continue;
      shadow.use(stubPlugin(key, sink));
    }
    for (const plugin of plugins) shadow.use(plugin, target.manifest.config as never);

    try {
      shadow.start();
      await withTimeout(shadow.ready, VERIFY_TIMEOUT_MS);
      const pluginNames = new Set(plugins.map((plugin) => plugin.name));
      report.provided = shadow.ctx
        .serviceOwners()
        .filter((info) => info.owner !== undefined && pluginNames.has(info.owner))
        .map((info) => info.key);
      report.ok = true;
    } catch (error) {
      report.error = errorMessage(error);
    } finally {
      try {
        await shadow.dispose();
      } catch (error) {
        // A broken disposer would break hot reload too: fail the dry run.
        if (report.ok) {
          report.ok = false;
          report.error = `disposer failed during teardown: ${errorMessage(error)}`;
        }
      }
      await rm(shadowCwd, { recursive: true, force: true });
    }
    return report;
  }

  async revert(name: string): Promise<string> {
    const stamps = await this.snapshotList(name);
    if (stamps.length === 0) {
      throw new Error(`no snapshot for plugin "${name}" (snapshots are taken on every successful load)`);
    }
    const latest = stamps[stamps.length - 1]!;
    const source = join(this.versionsRoot(), name, latest);
    const dir = (await this.discover(name))?.dir ?? this.records.get(name)?.status.dir;
    if (!dir) throw new Error(`plugin "${name}" not found`);

    await rm(dir, { recursive: true, force: true });
    await cp(source, dir, { recursive: true });
    await this.reload(name);
    const record = this.records.get(name);
    if (record?.status.status !== "loaded") {
      throw new Error(
        `restored snapshot ${latest} but "${name}" still fails to load: ${record?.status.error ?? record?.status.status ?? "unknown"}`,
      );
    }
    return `reverted "${name}" to snapshot ${latest}`;
  }

  /** Close all watchers and cancel any pending sync. Called on unmount. */
  stopWatch(): void {
    for (const watcher of this.watchers) watcher.close();
    this.watchers = [];
    this.watchedRoots.clear();
    if (this.syncTimer) {
      clearTimeout(this.syncTimer);
      this.syncTimer = undefined;
    }
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
            activation: "eager",
            error: `invalid ${MANIFEST_FILE}: ${errorMessage(error)}`,
            provides: [],
            inject: [],
            origin: "user",
          });
          continue;
        }
        if (discovered.has(manifest.name)) continue; // earlier root shadows
        discovered.set(manifest.name, { dir, scope, manifest });
      }
    }
    return { discovered: [...discovered.values()], scanErrors };
  }

  /**
   * Full-reload load path: import every entry first, then activate eagers in
   * dependency order (a plugin may inject a service another one needs, so
   * scan order is not enough). Dynamic entries only join the catalog.
   */
  private async loadAll(discovered: DiscoveredPlugin[]): Promise<void> {
    const imported: ImportedEntry[] = [];
    for (const target of discovered) {
      try {
        imported.push({ target, plugins: await this.importEntry(target) });
      } catch (error) {
        this.failImport(target, errorMessage(error));
      }
    }

    // Services claimed by dynamic plugins: an eager plugin needing one of
    // these could never be satisfied deterministically, so fail loud.
    const dynamicProvides = new Map<string, string>();
    for (const entry of imported) {
      if (entry.target.manifest.activation !== "dynamic") continue;
      for (const plugin of entry.plugins) {
        for (const key of plugin.provides ?? []) dynamicProvides.set(key, entry.target.manifest.name);
      }
    }
    const activeKeys = new Set(this.runtime.ctx.keys());

    const eager: ImportedEntry[] = [];
    for (const entry of imported) {
      if (entry.target.manifest.activation === "dynamic") continue;
      const blocked = entry.plugins
        .flatMap((plugin) => plugin.inject ?? [])
        .filter((key) => !activeKeys.has(key) && dynamicProvides.has(key));
      const blocker = blocked[0];
      if (blocker !== undefined) {
        this.failImport(
          entry.target,
          `eager plugin requires service "${blocker}" provided by dynamic plugin "${dynamicProvides.get(blocker)}" ` +
            `\u2014 set that plugin's activation to "eager"`,
        );
        continue;
      }
      eager.push(entry);
    }

    // Duplicate providers among eager disk plugins fail loud per plugin.
    const provider = new Map<string, string>();
    const unique: ImportedEntry[] = [];
    for (const entry of eager) {
      const keys = entry.plugins.flatMap((plugin) => plugin.provides ?? []);
      const conflict = keys.find((key) => provider.has(key));
      if (conflict !== undefined) {
        this.failImport(entry.target, `service "${conflict}" is already provided by plugin "${provider.get(conflict)}"`);
        continue;
      }
      for (const key of keys) provider.set(key, entry.target.manifest.name);
      unique.push(entry);
    }

    for (const entry of this.topoSort(unique)) await this.mountEntry(entry);

    // Dynamic entries: catalogued, not mounted \u2014 the router recalls them.
    for (const entry of imported) {
      if (entry.target.manifest.activation !== "dynamic") continue;
      this.records.set(entry.target.manifest.name, {
        status: this.baseStatus(entry.target, "unloaded", entry.plugins),
        pluginNames: [],
      });
    }
  }

  /**
   * Load one entry, resolving cross-plugin dependencies first: an inject key
   * that is not active yet must come from a manifest-declared provider
   * (`provides` in flavor-plugin.json), which is loaded recursively.
   */
  private async loadOne(target: DiscoveredPlugin, visiting: string[] = []): Promise<void> {
    const { manifest } = target;
    if (visiting.includes(manifest.name)) {
      throw new Error(`plugin dependency cycle: ${[...visiting, manifest.name].join(" -> ")}`);
    }
    const plugins = await this.importEntry(target);

    const byProvidedKey = new Map<string, DiscoveredPlugin>();
    for (const candidate of this.discoveredCache) {
      for (const key of candidate.manifest.provides ?? []) byProvidedKey.set(key, candidate);
    }
    const activeKeys = new Set(this.runtime.ctx.keys());
    for (const plugin of plugins) {
      for (const key of plugin.inject ?? []) {
        if (activeKeys.has(key)) continue;
        const providerTarget = byProvidedKey.get(key);
        if (!providerTarget || providerTarget.manifest.name === manifest.name) continue;
        if (this.records.get(providerTarget.manifest.name)?.status.status === "loaded") continue;
        // A failed provider surfaces loudly via activation below.
        await this.loadOne(providerTarget, [...visiting, manifest.name]).catch(() => {});
      }
    }

    await this.mountEntry({ target, plugins });
  }

  /** Import and validate an entry without activating it. Throws on failure. */
  private async importEntry(target: DiscoveredPlugin): Promise<Plugin<unknown>[]> {
    const { dir, manifest } = target;
    const entryPath = resolve(dir, manifest.entry ?? "index.js");
    if (!existsSync(entryPath)) throw new Error(`entry not found: ${manifest.entry ?? "index.js"}`);
    if (manifest.origin === "generated") {
      await auditGeneratedSource(dir);
      await preflightGeneratedImport(entryPath, dir, manifest.config ?? {});
    }

    let mod: unknown;
    try {
      // Cache-bust query so reload() re-reads the file from disk.
      mod = await import(`${pathToFileURL(entryPath).href}?v=${Date.now()}`);
    } catch (error) {
      throw new Error(`import failed: ${errorMessage(error)}`);
    }
    const plugins = normalizeExport((mod as { default?: unknown }).default);
    if (manifest.origin === "generated") {
      const unsafeInject = plugins.flatMap((plugin) => plugin.inject ?? []).find((key) => !GENERATED_ALLOWED_INJECT.has(key));
      if (unsafeInject) {
        throw new Error(
          `generated plugin safety audit failed: service "${unsafeInject}" is not available to generated code; ` +
          "expose the behavior as a governed tool instead",
        );
      }
    }

    // Trigger patterns must compile, or the plugin is unusable for routing.
    for (const source of manifest.triggers?.patterns ?? []) {
      try {
        new RegExp(source);
      } catch (error) {
        throw new Error(`invalid triggers.patterns "${source}": ${errorMessage(error)}`);
      }
    }
    return plugins;
  }

  /** Activate an imported entry on the runtime; failures become error records. */
  private async mountEntry(entry: ImportedEntry): Promise<void> {
    const { target, plugins } = entry;
    const active = new Set(this.runtime.activePlugins());
    for (const plugin of plugins) {
      if (active.has(plugin.name)) {
        this.failImport(target, `plugin name "${plugin.name}" is already active (plugin names must be unique)`);
        return;
      }
    }

    const mounted: string[] = [];
    try {
      for (const plugin of plugins) {
        // Runtime is started at this point, so use() activates immediately.
        const toolsBefore = this.registeredToolNames();
        this.runtime.use(plugin, target.manifest.config as never);
        // Plugins with async apply() fail via ready, not via use().
        await this.runtime.ready;
        // Attribute tools registered during activation to this manifest, so
        // permission can govern them by origin/capabilities (3.8).
        this.attributeNewTools(toolsBefore, target.manifest.name);
        mounted.push(plugin.name);
      }
    } catch (error) {
      for (const mountedName of mounted.reverse()) await this.runtime.unmount(mountedName);
      this.failImport(target, `activation failed: ${errorMessage(error)}`);
      return;
    }

    this.records.set(target.manifest.name, {
      status: this.baseStatus(target, "loaded", plugins),
      pluginNames: mounted,
    });
    // Keep a last-known-good copy so revert() can undo a bad edit.
    try {
      await this.snapshot(target);
    } catch (error) {
      this.ctx.logger.warn(`plugin "${target.manifest.name}" snapshot failed: ${errorMessage(error)}`);
    }
  }

  private versionsRoot(): string {
    return join(this.ctx.cwd, ".flavorlite", "plugins", ".versions");
  }

  private toolRegistry(): ToolRegistry | undefined {
    return this.ctx.tryGet("tools") as ToolRegistry | undefined;
  }

  private registeredToolNames(): Set<string> {
    const registry = this.toolRegistry();
    return new Set(registry ? registry.list().map((tool) => tool.name) : []);
  }

  /** Map every tool added since `before` to the owning manifest name. */
  private attributeNewTools(before: Set<string>, owner: string): void {
    const registry = this.toolRegistry();
    if (!registry) return;
    for (const tool of registry.list()) {
      if (!before.has(tool.name)) this.toolOwners.set(tool.name, owner);
    }
  }

  ownerOfTool(toolName: string): ToolOwnerInfo | undefined {
    const owner = this.toolOwners.get(toolName);
    if (!owner) return undefined;
    const status = this.records.get(owner)?.status;
    if (!status || status.status !== "loaded") return undefined;
    return {
      name: owner,
      origin: status.origin,
      ...(status.capabilities ? { capabilities: status.capabilities } : {}),
      ...(status.generatedFrom ? { generatedFrom: status.generatedFrom } : {}),
    };
  }

  /** Copy the plugin dir into .versions/<name>/<iso-stamp>, newest last. */
  private async snapshot(target: DiscoveredPlugin): Promise<void> {
    if (!existsSync(target.dir)) return;
    const base = join(this.versionsRoot(), target.manifest.name);
    let stamp = new Date().toISOString().replace(/[:.]/g, "-");
    // Rapid successive loads must never clobber each other's snapshots.
    while (existsSync(join(base, stamp))) stamp = `${stamp}_`;
    await cp(target.dir, join(base, stamp), { recursive: true });
    const stamps = await this.snapshotList(target.manifest.name);
    // ISO stamps sort lexicographically; drop anything beyond the cap.
    while (stamps.length > MAX_SNAPSHOTS) {
      await rm(join(base, stamps.shift()!), { recursive: true, force: true });
    }
  }

  private async snapshotList(name: string): Promise<string[]> {
    try {
      return (await readdir(join(this.versionsRoot(), name))).sort();
    } catch {
      return [];
    }
  }

  /** Topological order over entries: inject keys pull providers forward. */
  private topoSort(entries: ImportedEntry[]): ImportedEntry[] {
    const provider = new Map<string, ImportedEntry>();
    for (const entry of entries) {
      for (const plugin of entry.plugins) {
        for (const key of plugin.provides ?? []) provider.set(key, entry);
      }
    }
    const existing = new Set(this.runtime.ctx.keys());
    const order: ImportedEntry[] = [];
    const state = new Map<ImportedEntry, "visiting" | "done">();
    const visit = (entry: ImportedEntry, chain: string[]): void => {
      const status = state.get(entry);
      if (status === "done") return;
      if (status === "visiting") {
        throw new Error(`plugin dependency cycle: ${[...chain, entry.target.manifest.name].join(" -> ")}`);
      }
      state.set(entry, "visiting");
      for (const plugin of entry.plugins) {
        for (const key of plugin.inject ?? []) {
          if (existing.has(key)) continue;
          const upstream = provider.get(key);
          if (!upstream) continue; // absent service fails loud at mount
          visit(upstream, [...chain, entry.target.manifest.name]);
        }
      }
      state.set(entry, "done");
      order.push(entry);
    };
    for (const entry of entries) visit(entry, []);
    return order;
  }

  private baseStatus(target: DiscoveredPlugin, status: PluginLoadStatus, plugins?: Plugin<unknown>[]): PluginStatus {
    const { dir, scope, manifest } = target;
    return {
      name: manifest.name,
      version: manifest.version ?? "0.0.0",
      dir,
      scope,
      status,
      activation: manifest.activation,
      ...(manifest.description ? { description: manifest.description } : {}),
      ...(manifest.triggers ? { triggers: manifest.triggers } : {}),
      provides: plugins ? plugins.flatMap((plugin) => plugin.provides ?? []) : [],
      inject: plugins ? [...new Set(plugins.flatMap((plugin) => plugin.inject ?? []))] : [],
      origin: manifest.origin,
      ...(manifest.generatedFrom ? { generatedFrom: manifest.generatedFrom } : {}),
      ...(manifest.capabilities ? { capabilities: manifest.capabilities } : {}),
    };
  }

  private failImport(target: DiscoveredPlugin, error: string): void {
    this.records.set(target.manifest.name, {
      status: { ...this.baseStatus(target, "error"), error },
      pluginNames: [],
    });
    this.ctx.logger.warn(`plugin "${target.manifest.name}" failed to load: ${error}`);
  }

  private async unload(name: string): Promise<void> {
    const record = this.records.get(name);
    if (!record) return;
    const remaining: string[] = [];
    for (const pluginName of [...record.pluginNames].reverse()) {
      try {
        await this.runtime.unmount(pluginName);
      } catch (error) {
        // Still mounted (e.g. the kernel refuses while a dependent injects
        // its service): keep tracking it so eject/reload can retry later.
        remaining.push(pluginName);
        this.ctx.logger.warn(`plugin "${pluginName}" failed during unmount: ${errorMessage(error)}`);
      }
    }
    if (remaining.length > 0) {
      this.records.set(name, {
        status: { ...record.status, status: "loaded" },
        pluginNames: remaining.reverse(),
      });
      return;
    }
    // Fully unloaded: drop tool ownership so a reincarnation never inherits
    // stale governance, and back to the catalog the record goes.
    for (const [toolName, owner] of [...this.toolOwners]) {
      if (owner === name) this.toolOwners.delete(toolName);
    }
    this.records.set(name, {
      status: { ...record.status, status: "unloaded", provides: [], inject: [] },
      pluginNames: [],
    });
  }

  /** Directory name of a previously loaded record, for matching scan errors. */
  private recordDirName(name: string): string | undefined {
    const dir = this.records.get(name)?.status.dir;
    return dir === undefined ? undefined : dir.split(/[\\/]/).pop();
  }

  /**
   * Watch every root for plugin changes (idempotent per root). Recursive so
   * edits inside a plugin dir are seen too; missing roots are skipped —
   * scaffold() retries once it creates one.
   */
  private startWatch(): void {
    if (!this.watchEnabled) return;
    for (const { root } of this.roots) {
      if (this.watchedRoots.has(root) || !existsSync(root)) continue;
      try {
        const watcher = watch(root, { recursive: true }, () => this.scheduleSync());
        watcher.on("error", () => watcher.close());
        this.watchers.push(watcher);
        this.watchedRoots.add(root);
      } catch {
        /* unsupported or vanished root: catalog stays scan/reload driven */
      }
    }
  }

  private scheduleSync(): void {
    if (this.syncTimer) clearTimeout(this.syncTimer);
    this.syncTimer = setTimeout(() => {
      this.syncTimer = undefined;
      void this.sync();
    }, this.watchDebounceMs);
    // Watchers must never keep the process alive.
    this.syncTimer.unref?.();
  }

  /**
   * Reconcile the catalog with disk after a watch event:
   * - new plugins enter the catalog (eagers mount, dynamics stay unloaded);
   * - removed plugins are unmounted and dropped;
   * - unloaded records refresh their metadata (manifest edits change routing);
   * - loaded plugins are never touched, so an in-flight run stays intact
   *   (use /plugin reload <name> to hot-swap one deliberately).
   */
  private async sync(): Promise<void> {
    if (this.syncing) {
      this.dirty = true;
      return;
    }
    this.syncing = true;
    try {
      const { discovered, scanErrors } = await this.scan();
      this.discoveredCache = discovered;
      const seen = new Set<string>();

      for (const errorStatus of scanErrors) {
        seen.add(errorStatus.name);
        const existing = this.records.get(errorStatus.name);
        // A broken manifest must not yank a running plugin out mid-flight.
        if (!existing || existing.status.status !== "loaded") {
          this.records.set(errorStatus.name, { status: errorStatus, pluginNames: [] });
        }
      }

      for (const target of discovered) {
        const name = target.manifest.name;
        seen.add(name);
        const record = this.records.get(name);
        if (!record) {
          if (target.manifest.activation === "dynamic") {
            this.records.set(name, { status: this.baseStatus(target, "unloaded"), pluginNames: [] });
          } else {
            try {
              await this.loadOne(target);
            } catch (error) {
              this.failImport(target, errorMessage(error));
            }
          }
        } else if (record.status.status !== "loaded") {
          if (target.manifest.activation === "dynamic") {
            // Refresh routing metadata (triggers/description) from the manifest.
            this.records.set(name, { status: this.baseStatus(target, "unloaded"), pluginNames: [] });
          } else {
            // A repaired eager plugin should run: mount it like at startup.
            try {
              await this.loadOne(target);
            } catch (error) {
              this.failImport(target, errorMessage(error));
            }
          }
        }
      }

      for (const name of [...this.records.keys()]) {
        if (seen.has(name)) continue;
        await this.unload(name);
        this.records.delete(name);
      }
    } catch (error) {
      this.ctx.logger.warn(`plugin watch sync failed: ${errorMessage(error)}`);
    } finally {
      this.syncing = false;
      if (this.dirty) {
        this.dirty = false;
        this.scheduleSync();
      }
    }
  }
}

/**
 * Generated code is untrusted. It may register tools/hooks against the host,
 * but it cannot import host-effect modules or use ambient process/network
 * escape hatches. Side effects must go through injected, governed services.
 */
async function auditGeneratedSource(root: string): Promise<void> {
  const files: string[] = [];
  const visit = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === ".versions") continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (/\.(?:c|m)?js$/i.test(entry.name)) files.push(path);
    }
  };
  await visit(root);
  let total = 0;
  for (const file of files) {
    const source = await readFile(file, "utf-8");
    total += source.length;
    if (total > GENERATED_SOURCE_LIMIT) throw new Error("generated plugin safety audit failed: source exceeds 1 MB");
    for (const rule of GENERATED_FORBIDDEN) {
      if (rule.pattern.test(source)) {
        throw new Error(
          `generated plugin safety audit failed (${rule.reason}) in ${file}. ` +
          "Use injected flavor-lite services so permission checks remain enforceable.",
        );
      }
    }
  }
}

/** Import generated code in a killable, filesystem-read-only subprocess first. */
async function preflightGeneratedImport(entryPath: string, root: string, config: Record<string, unknown>): Promise<void> {
  const url = pathToFileURL(entryPath).href;
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const child = spawn(
      process.execPath,
      [
        "--permission",
        `--allow-fs-read=${root}`,
        "--input-type=module",
        "--eval",
        GENERATED_PREFLIGHT_SCRIPT,
        url,
        JSON.stringify(config),
      ],
      { cwd: root, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
    );
    let stderr = "";
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (error) rejectPromise(error);
      else resolvePromise();
    };
    child.stderr.on("data", (chunk) => {
      stderr = `${stderr}${String(chunk)}`.slice(-4000);
    });
    child.on("error", (error) => finish(new Error(`generated plugin preflight failed: ${error.message}`)));
    child.on("close", (code) => {
      if (code === 0) finish();
      else finish(new Error(`generated plugin preflight failed (exit ${code}): ${stderr.trim() || "unknown error"}`));
    });
    timer = setTimeout(() => {
      child.kill();
      finish(new Error(`generated plugin preflight timed out after ${VERIFY_TIMEOUT_MS}ms`));
    }, VERIFY_TIMEOUT_MS);
  });
}

/** One shadow service standing in for a missing dependency during verify(). */
function stubPlugin(key: string, sink: { tools: string[]; commands: string[] }): Plugin<never> {
  return {
    name: `verify-stub:${key}`,
    provides: [key],
    apply(ctx: PluginContext) {
      return ctx.effect(() => ctx.provide(key, buildStub(key, sink)), `verify-stub:${key}.provide`);
    },
  };
}

/** Functional stand-ins so a dry run registers things but touches nothing. */
function buildStub(key: string, sink: { tools: string[]; commands: string[] }): unknown {
  switch (key) {
    case "hooks":
      return {
        hook: () => () => {},
        waterfall: async <T>(_name: string, value: T): Promise<T> => value,
      };
    case "tools":
      return {
        register: (tool: { name: string }) => {
          sink.tools.push(tool.name);
          return () => {};
        },
        list: () => [],
        schemas: () => [],
        get: () => undefined,
        execute: async () => ({ content: "verify sandbox: execution is disabled", isError: false }),
      };
    case "commands":
      return {
        register: (command: { name: string }) => {
          sink.commands.push(command.name);
          return () => {};
        },
        execute: async () => "verify sandbox: commands are disabled",
      };
    case "pluginsLoader":
      return {
        init: async () => {},
        reload: async () => [] as string[],
        list: () => [],
        catalog: () => [],
        ensure: async () => {},
        eject: async () => {},
        scaffold: async (): Promise<string> => {
          throw new Error("verify sandbox: disk writes are disabled");
        },
        verify: async () => ({ ok: false, name: "", provided: [], tools: [], commands: [], error: "nested verify" }),
        revert: async (): Promise<string> => {
          throw new Error("verify sandbox: disk writes are disabled");
        },
        ownerOfTool: () => undefined,
      };
    default:
      return permissiveStub();
  }
}

/** Absorbs arbitrary property reads and calls so unknown deps dry-run inert. */
function permissiveStub(): unknown {
  const target = function noop(): void {};
  return new Proxy(target, {
    get(_target, prop) {
      // Never look thenable to await, never break console/log formatting.
      if (prop === "then" || typeof prop === "symbol") return undefined;
      return permissiveStub();
    },
    apply() {
      return undefined;
    },
  });
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolvePromise, rejectPromise) => {
    const timer = setTimeout(
      () => rejectPromise(new Error(`activation did not settle within ${ms}ms (apply() may be waiting on real services)`)),
      ms,
    );
    timer.unref?.();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolvePromise(value);
      },
      (error) => {
        clearTimeout(timer);
        rejectPromise(error);
      },
    );
  });
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
    description: "Manage plugins (/plugin list | reload [name] | eject <name> | new <name> | verify <name> | revert <name>)",
    async run(args) {
      const [sub, ...rest] = args.trim() === "" ? [] : args.trim().split(/\s+/);
      switch (sub ?? "list") {
        case "list": {
          const statuses = loader.list();
          if (statuses.length === 0) return "no plugins found (.flavorlite/plugins/ is empty)";
          return statuses
            .map((status) => {
              const flags =
                `[${status.scope}]` +
                `${status.activation === "dynamic" ? " [dynamic]" : ""}` +
                `${status.origin === "generated" ? " [generated]" : ""}`;
              const head = `  ${status.name.padEnd(16)} ${status.version.padEnd(8)} ${status.status.padEnd(8)} ${flags}`;
              const caps = status.capabilities && status.capabilities.length > 0 ? `\n    capabilities: ${status.capabilities.join(", ")}` : "";
              const detail =
                status.status === "error"
                  ? `\n    error: ${status.error}`
                  : (status.provides.length > 0 ? `\n    provides: ${status.provides.join(", ")}` : "") + caps;
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
        case "eject": {
          const name = rest[0];
          if (!name) return "usage: /plugin eject <name>";
          try {
            await loader.eject(name);
            const status = loader.list().find((entry) => entry.name === name);
            if (!status) return `plugin "${name}" not found`;
            return `ejected: ${name} (status: ${status.status})`;
          } catch (error) {
            return `error: ${errorMessage(error)}`;
          }
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
        case "verify": {
          const name = rest[0];
          if (!name) return "usage: /plugin verify <name>";
          const report = await loader.verify(name);
          if (!report.ok) return `verify FAILED: ${name}\n  ${report.error ?? "unknown error"}`;
          return [
            `verify OK: ${name}`,
            `  provides: ${report.provided.join(", ") || "-"}`,
            `  tools: ${report.tools.join(", ") || "-"}`,
            `  commands: ${report.commands.join(", ") || "-"}`,
          ].join("\n");
        }
        case "revert": {
          const name = rest[0];
          if (!name) return "usage: /plugin revert <name>";
          try {
            return await loader.revert(name);
          } catch (error) {
            return `error: ${errorMessage(error)}`;
          }
        }
        default:
          return `unknown subcommand "${sub}" (use: list | reload [name] | eject <name> | new <name> | verify <name> | revert <name>)`;
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
      const loader = new PluginsLoader(
        ctx,
        config.runtime,
        roots,
        config.watch ?? true,
        config.watchDebounceMs ?? 250,
      );
      const disposeService = ctx.provide("pluginsLoader", loader);
      const disposeCommand = registerPluginCommand(ctx, loader);
      return () => {
        loader.stopWatch();
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
