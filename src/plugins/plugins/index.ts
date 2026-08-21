/**
 * Plugins loader: disk-based plugin discovery and hot reload.
 *
 * Spec (see docs/plugin-dev.md):
 * - Roots: `<cwd>/.flavorlite/plugins/` (project) then `~/.flavorlite/plugins/`
 *   (user); project entries shadow user ones by manifest name.
 * - Each plugin dir holds a `flavor-plugin.json` manifest and an ESM entry
 *   (default `index.js`) whose default export is a Plugin or Plugin[].
 * - init() imports only the selected startup profile; reload() verifies and
 *   atomically takes over registrations so edits take effect without a gap.
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
import { createHash } from "node:crypto";
import { z } from "zod";
import { definePlugin, errorMessage } from "../../kernel";
import type { Plugin, PluginContext } from "../../kernel/types";
import { Runtime } from "../../kernel/runtime";
import type { CommandsService } from "../commands";
import type { ToolRegistry } from "../tools";
import { PLUGIN_TEMPLATE_FILES } from "./template";
import { GeneratedPluginProcess } from "./generated-process";
import type { HookBusService } from "../hooks";
import type { PromptAssemble } from "../prompt";

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
const GENERATED_ALLOWED_INJECT = new Set(["hooks", "tools", "commands", "systemPrompt", "skills", "capabilities"]);

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
export type PluginActivation = "eager" | "dynamic" | "background" | "manual";
export type PluginProfile = "minimal" | "coding" | "full";

/** Governance view of the plugin that registered a tool (see ownerOfTool). */
export interface ToolOwnerInfo {
  name: string;
  origin: PluginOrigin;
  capabilities?: PluginCapability[];
  generatedFrom?: string;
}

const manifestSchema = z.object({
  manifestVersion: z.literal(1).default(1),
  /** Compatible host plugin API major. flavor-lite implements API v1. */
  apiVersion: z.string().default("1"),
  name: z.string().min(1),
  version: z.string().optional(),
  entry: z.string().optional(),
  description: z.string().optional(),
  /**
   * eager (default): mounted at startup. dynamic: kept unloaded in the
   * catalog until the router recalls it (or /plugin reload targets it).
   */
  activation: z.enum(["eager", "dynamic", "background", "manual"]).default("eager"),
  /** Profiles in which the plugin is visible. Omitted = all profiles. */
  profiles: z.array(z.enum(["minimal", "coding", "full"])).optional(),
  /** Routing hints for the router plugin; never affect activation itself. */
  triggers: triggersSchema.optional(),
  /**
   * Service keys the plugins provide, declared so the loader can resolve
   * cross-plugin dependencies without importing every candidate entry.
   */
  provides: z.array(z.string()).optional(),
  requires: z
    .object({
      services: z.array(z.string()).optional(),
      executables: z.array(z.string()).optional(),
      environment: z.array(z.string()).optional(),
    })
    .optional(),
  engines: z.object({ node: z.string().optional() }).optional(),
  platforms: z.array(z.enum(["win32", "linux", "darwin"])).optional(),
  resourceBudget: z
    .object({
      memoryMB: z.number().positive().optional(),
      timeoutMs: z.number().int().positive().optional(),
      maxOutputChars: z.number().int().positive().optional(),
    })
    .optional(),
  lifecycle: z
    .object({
      state: z.enum(["active", "candidate", "quarantined"]).default("active"),
      reason: z.string().optional(),
      updatedAt: z.string().optional(),
    })
    .optional(),
  /** Optional module, relative to the plugin directory, exercised by verify(). */
  selfTest: z.string().optional(),
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
  activation: PluginActivation;
  apiVersion: string;
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
  requires?: PluginManifest["requires"];
  engines?: PluginManifest["engines"];
  platforms?: PluginManifest["platforms"];
  lifecycle?: PluginManifest["lifecycle"];
}

export interface PluginDoctorIssue {
  level: "error" | "warning" | "info";
  code: string;
  message: string;
  plugin?: string;
}

export interface PluginDoctorReport {
  ok: boolean;
  profile: PluginProfile;
  node: string;
  platform: NodeJS.Platform;
  loaded: number;
  unloaded: number;
  errors: number;
  issues: PluginDoctorIssue[];
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
  /** Plugin visibility/startup profile. Default coding. */
  profile?: PluginProfile;
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
  verifyAll(): Promise<VerifyReport[]>;
  doctor(): Promise<PluginDoctorReport>;
  explain(name: string): string;
  config(name: string, value?: Record<string, unknown>): Promise<Record<string, unknown>>;
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
  private readonly profile: PluginProfile;
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
    profile: PluginProfile = "coding",
  ) {
    this.watchEnabled = watchEnabled;
    this.watchDebounceMs = watchDebounceMs;
    this.profile = profile;
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
        const previous = this.records.get(name);
        if (previous?.status.status === "loaded") {
          const report = await this.verify(name);
          if (!report.ok) throw new Error(`replacement verification failed; old version kept active: ${report.error}`);
          const replacements = await this.importEntry(target);
          if (
            replacements.length !== previous.pluginNames.length
            || replacements.some((plugin, index) => plugin.name !== previous.pluginNames[index])
          ) {
            throw new Error("atomic reload requires replacement plugin names to match the active entry");
          }
          await this.toolRegistry()?.whenIdle(30_000);
          for (const plugin of replacements) {
            await this.runtime.reload(plugin.name, plugin, target.manifest.config as never);
          }
          this.records.set(name, {
            status: this.baseStatus(target, "loaded", replacements),
            pluginNames: replacements.map((plugin) => plugin.name),
          });
          await this.snapshot(target).catch((error) => {
            this.ctx.logger.warn(`plugin "${name}" snapshot failed: ${errorMessage(error)}`);
          });
        } else {
          await this.loadOne(target);
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
    if (target.manifest.lifecycle?.state === "candidate" || target.manifest.lifecycle?.state === "quarantined") {
      throw new Error(
        `plugin "${name}" is ${target.manifest.lifecycle.state}${target.manifest.lifecycle.reason ? `: ${target.manifest.lifecycle.reason}` : ""}; use /plugin reload explicitly after review`,
      );
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
      if (target.manifest.selfTest) {
        const selfTestPath = resolve(target.dir, target.manifest.selfTest);
        if (!existsSync(selfTestPath)) throw new Error(`selfTest entry not found: ${target.manifest.selfTest}`);
        const selfTestModule = await import(`${pathToFileURL(selfTestPath).href}?v=${Date.now()}`) as {
          default?: (context: { cwd: string; pluginDir: string }) => unknown | Promise<unknown>;
        };
        if (typeof selfTestModule.default !== "function") throw new Error("selfTest module must default-export a function");
        const result = await withTimeout(
          Promise.resolve(selfTestModule.default({ cwd: shadowCwd, pluginDir: target.dir })),
          VERIFY_TIMEOUT_MS,
        );
        if (result === false) throw new Error("selfTest returned false");
      }
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

  async verifyAll(): Promise<VerifyReport[]> {
    const { discovered } = await this.scan();
    const reports: VerifyReport[] = [];
    for (const target of discovered) reports.push(await this.verify(target.manifest.name));
    return reports;
  }

  async doctor(): Promise<PluginDoctorReport> {
    const issues: PluginDoctorIssue[] = [];
    const { discovered, scanErrors } = await this.scan();
    for (const status of scanErrors) {
      issues.push({ level: "error", code: "manifest", plugin: status.name, message: status.error ?? "invalid manifest" });
    }
    const provider = new Map<string, string>();
    for (const target of discovered) {
      const compatibility = manifestCompatibilityError(target.manifest);
      if (compatibility) issues.push({ level: "error", code: "compatibility", plugin: target.manifest.name, message: compatibility });
      for (const key of target.manifest.provides ?? []) {
        const previous = provider.get(key);
        if (previous) {
          issues.push({ level: "error", code: "duplicate-provider", plugin: target.manifest.name, message: `service "${key}" also declared by ${previous}` });
        } else provider.set(key, target.manifest.name);
      }
      for (const key of target.manifest.requires?.environment ?? []) {
        if (!process.env[key]) issues.push({ level: "warning", code: "missing-env", plugin: target.manifest.name, message: `environment variable ${key} is not set` });
      }
      for (const executable of target.manifest.requires?.executables ?? []) {
        if (!(await executableExists(executable))) issues.push({ level: "warning", code: "missing-executable", plugin: target.manifest.name, message: `executable "${executable}" was not found on PATH` });
      }
      if (target.manifest.lifecycle?.state && target.manifest.lifecycle.state !== "active") {
        issues.push({ level: "info", code: "lifecycle", plugin: target.manifest.name, message: `plugin is ${target.manifest.lifecycle.state}${target.manifest.lifecycle.reason ? `: ${target.manifest.lifecycle.reason}` : ""}` });
      }
    }
    for (const status of this.list().filter((entry) => entry.status === "error")) {
      if (!issues.some((issue) => issue.plugin === status.name && issue.message === status.error)) {
        issues.push({ level: "error", code: "load-error", plugin: status.name, message: status.error ?? "load failed" });
      }
    }
    const prompt = this.ctx.tryGet("systemPrompt") as { inspect?: () => Promise<{ totalChars: number }> } | undefined;
    if (prompt?.inspect) {
      const info = await prompt.inspect();
      issues.push({ level: "info", code: "prompt-size", message: `assembled prompt content: ${info.totalChars} chars` });
    }
    const toolCount = this.toolRegistry()?.list().length;
    if (toolCount !== undefined) issues.push({ level: "info", code: "tool-count", message: `registered tools: ${toolCount}` });
    const statuses = this.list();
    return {
      ok: !issues.some((issue) => issue.level === "error"),
      profile: this.profile,
      node: process.versions.node,
      platform: process.platform,
      loaded: statuses.filter((status) => status.status === "loaded").length,
      unloaded: statuses.filter((status) => status.status === "unloaded").length,
      errors: statuses.filter((status) => status.status === "error").length,
      issues,
    };
  }

  explain(name: string): string {
    const status = this.records.get(name)?.status;
    if (!status) return `plugin "${name}" not found`;
    return [
      `${status.name}@${status.version} (${status.status}, ${status.activation}, api v${status.apiVersion})`,
      `scope: ${status.scope}; profile: ${this.profile}`,
      `entry: ${status.dir}`,
      `provides: ${status.provides.join(", ") || "-"}`,
      `injects: ${status.inject.join(", ") || "-"}`,
      `tools: ${status.triggers?.tools?.join(", ") || "-"}`,
      `commands: ${status.triggers?.commands?.join(", ") || "-"}`,
      `capabilities: ${status.capabilities?.join(", ") || "-"}`,
      ...(status.error ? [`error: ${status.error}`] : []),
    ].join("\n");
  }

  async config(name: string, value?: Record<string, unknown>): Promise<Record<string, unknown>> {
    const target = await this.discover(name);
    if (!target) throw new Error(`plugin "${name}" not found`);
    if (value === undefined) return target.manifest.config ?? {};
    const raw = JSON.parse((await readFile(join(target.dir, MANIFEST_FILE), "utf-8"))) as Record<string, unknown>;
    raw.config = value;
    await writeFile(join(target.dir, MANIFEST_FILE), `${JSON.stringify(raw, null, 2)}\n`, "utf-8");
    await this.reload(name);
    return value;
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
            apiVersion: "?",
            error: `invalid ${MANIFEST_FILE}: ${errorMessage(error)}`,
            provides: [],
            inject: [],
            origin: "user",
          });
          continue;
        }
        const compatibility = manifestCompatibilityError(manifest);
        if (compatibility) {
          scanErrors.push({
            name: manifest.name,
            version: manifest.version ?? "0.0.0",
            dir,
            scope,
            status: "error",
            activation: manifest.activation,
            apiVersion: manifest.apiVersion,
            error: compatibility,
            provides: manifest.provides ?? [],
            inject: manifest.requires?.services ?? [],
            origin: manifest.origin,
            ...(manifest.requires ? { requires: manifest.requires } : {}),
            ...(manifest.engines ? { engines: manifest.engines } : {}),
            ...(manifest.platforms ? { platforms: manifest.platforms } : {}),
          });
          continue;
        }
        if (discovered.has(manifest.name)) continue; // earlier root shadows
        discovered.set(manifest.name, { dir, scope, manifest });
      }
    }
    return { discovered: [...discovered.values()], scanErrors };
  }

  /** Import only startup entries. Dynamic/manual entries stay manifest-only until ensure(). */
  private async loadAll(discovered: DiscoveredPlugin[]): Promise<void> {
    const visible = discovered.filter(
      (target) => !target.manifest.profiles || target.manifest.profiles.includes(this.profile),
    );
    const startupTargets = visible.filter((target) => this.startsAtBoot(target.manifest));
    const imported: ImportedEntry[] = [];
    for (const target of startupTargets) {
      try {
        imported.push({ target, plugins: await this.importEntry(target) });
      } catch (error) {
        this.failImport(target, errorMessage(error));
      }
    }

    const deferredProvides = new Map<string, string>();
    for (const target of visible) {
      if (this.startsAtBoot(target.manifest)) continue;
      for (const key of target.manifest.provides ?? []) deferredProvides.set(key, target.manifest.name);
    }
    const activeKeys = new Set(this.runtime.ctx.keys());
    const eager: ImportedEntry[] = [];
    for (const entry of imported) {
      const required = new Set([
        ...(entry.target.manifest.requires?.services ?? []),
        ...entry.plugins.flatMap((plugin) => plugin.inject ?? []),
      ]);
      const blocker = [...required].find((key) => !activeKeys.has(key) && deferredProvides.has(key));
      if (blocker !== undefined) {
        this.failImport(
          entry.target,
          `startup plugin requires service "${blocker}" provided by deferred plugin "${deferredProvides.get(blocker)}"; set that plugin's activation to "eager"`,
        );
        continue;
      }
      eager.push(entry);
    }

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

    for (const target of discovered) {
      if (this.records.has(target.manifest.name)) continue;
      this.records.set(target.manifest.name, {
        status: this.baseStatus(target, "unloaded"),
        pluginNames: [],
      });
    }
  }

  private startsAtBoot(manifest: PluginManifest): boolean {
    if (manifest.profiles && !manifest.profiles.includes(this.profile)) return false;
    if (manifest.activation === "eager") return true;
    return manifest.activation === "background" && this.profile !== "minimal";
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
    const required = new Set([
      ...(manifest.requires?.services ?? []),
      ...plugins.flatMap((plugin) => plugin.inject ?? []),
    ]);
    for (const key of required) {
      if (activeKeys.has(key)) continue;
      const providerTarget = byProvidedKey.get(key);
      if (!providerTarget || providerTarget.manifest.name === manifest.name) continue;
      if (this.records.get(providerTarget.manifest.name)?.status.status === "loaded") continue;
      // A failed provider surfaces loudly via activation below.
      await this.loadOne(providerTarget, [...visiting, manifest.name]).catch(() => {});
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
      if ((manifest.provides?.length ?? 0) > 0) {
        throw new Error("isolated generated plugins cannot provide host services; expose governed tools instead");
      }
      return [this.generatedProxy(target, entryPath)];
    }

    let mod: unknown;
    try {
      // Cache-bust query so reload() re-reads the file from disk.
      mod = await import(`${pathToFileURL(entryPath).href}?v=${Date.now()}`);
    } catch (error) {
      throw new Error(`import failed: ${errorMessage(error)}`);
    }
    const plugins = normalizeExport((mod as { default?: unknown }).default);
    const declared = [...new Set(manifest.provides ?? [])].sort();
    const implemented = [...new Set(plugins.flatMap((plugin) => plugin.provides ?? []))].sort();
    if (manifest.provides && declared.join("\0") !== implemented.join("\0")) {
      throw new Error(`manifest provides [${declared.join(", ")}] does not match entry provides [${implemented.join(", ")}]`);
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

  private generatedProxy(target: DiscoveredPlugin, entryPath: string): Plugin<unknown> {
    const manifest = target.manifest;
    return {
      name: manifest.name,
      inject: ["hooks", "tools", "commands"],
      provides: [],
      async apply(ctx) {
        const registry = ctx.get("tools") as ToolRegistry;
        const ownTools = new Set<string>();
        const capabilities = new Set(manifest.capabilities ?? []);
        const processHost = new GeneratedPluginProcess(
          entryPath,
          target.dir,
          manifest.config ?? {},
          async (toolName, args) => {
            if (ownTools.has(toolName)) return { content: "generated capability recursion is blocked", isError: true };
            const tool = registry.get(toolName);
            if (!tool) return { content: `capability tool "${toolName}" is unavailable`, isError: true };
            const required =
              tool.category === "write" ? "files"
              : tool.category === "shell" ? "shell"
              : tool.category === "control" ? "host"
              : /^websearch$/i.test(tool.name) ? "network"
              : undefined;
            if (required && !capabilities.has(required as PluginCapability)) {
              return { content: `generated plugin has not declared capability "${required}"`, isError: true };
            }
            return registry.execute(
              { id: `generated:${manifest.name}:${Date.now()}`, name: toolName, args },
              { cwd: ctx.cwd },
            );
          },
          manifest.resourceBudget?.timeoutMs ?? 10_000,
          manifest.resourceBudget?.memoryMB ?? 128,
          manifest.resourceBudget?.maxOutputChars ?? 100_000,
        );
        const descriptor = await processHost.start();
        if (descriptor.name !== manifest.name) {
          await processHost.dispose();
          throw new Error(`generated entry name "${descriptor.name}" must match manifest name "${manifest.name}"`);
        }
        const unsafeInject = descriptor.inject.find((key) => !GENERATED_ALLOWED_INJECT.has(key));
        if (unsafeInject) {
          await processHost.dispose();
          throw new Error(`generated plugin requested unavailable service "${unsafeInject}"`);
        }
        if (descriptor.provides.length > 0) {
          await processHost.dispose();
          throw new Error("isolated generated plugins cannot provide host services");
        }
        const disposers: Array<() => void | Promise<void>> = [];
        for (const tool of descriptor.tools) {
          ownTools.add(tool.name);
          disposers.push(registry.register({
            ...tool,
            async execute(args, execCtx) {
              return processHost.tool(tool.name, args, {
                cwd: execCtx.cwd,
                ...(execCtx.runId ? { runId: execCtx.runId } : {}),
                ...(execCtx.sessionId ? { sessionId: execCtx.sessionId } : {}),
              });
            },
          }));
        }
        const commands = ctx.get("commands") as CommandsService;
        for (const command of descriptor.commands) {
          disposers.push(commands.register({ ...command, run: (args) => processHost.command(command.name, args) }));
        }
        if (descriptor.promptHooks > 0) {
          const hooks = ctx.get("hooks") as HookBusService;
          disposers.push(hooks.hook<PromptAssemble>("prompt/assemble", async (event, next) => {
            const sections = await processHost.prompt({ cwd: event.cwd });
            event.sections.push(...sections.map((section) => ({ ...section, source: section.source ?? manifest.name })));
            return next(event);
          }));
        }
        return async () => {
          for (const dispose of disposers.reverse()) await dispose();
          await processHost.dispose();
        };
      },
    };
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
    const hash = (await hashPluginDir(target.dir)).slice(0, 12);
    const existing = await this.snapshotList(target.manifest.name);
    if (existing.at(-1)?.endsWith(`_${hash}`)) return;
    let stamp = `${new Date().toISOString().replace(/[:.]/g, "-")}_${hash}`;
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
      apiVersion: manifest.apiVersion,
      ...(manifest.description ? { description: manifest.description } : {}),
      ...(manifest.triggers ? { triggers: manifest.triggers } : {}),
      provides: plugins ? plugins.flatMap((plugin) => plugin.provides ?? []) : (manifest.provides ?? []),
      inject: plugins
        ? [...new Set([...(manifest.requires?.services ?? []), ...plugins.flatMap((plugin) => plugin.inject ?? [])])]
        : (manifest.requires?.services ?? []),
      origin: manifest.origin,
      ...(manifest.generatedFrom ? { generatedFrom: manifest.generatedFrom } : {}),
      ...(manifest.capabilities ? { capabilities: manifest.capabilities } : {}),
      ...(manifest.requires ? { requires: manifest.requires } : {}),
      ...(manifest.engines ? { engines: manifest.engines } : {}),
      ...(manifest.platforms ? { platforms: manifest.platforms } : {}),
      ...(manifest.lifecycle ? { lifecycle: manifest.lifecycle } : {}),
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

async function hashPluginDir(root: string): Promise<string> {
  const hash = createHash("sha256");
  const visit = async (dir: string): Promise<void> => {
    const entries = (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (entry.name === ".versions" || entry.name === "node_modules") continue;
      const path = join(dir, entry.name);
      hash.update(path.slice(root.length).replace(/\\/g, "/"));
      if (entry.isDirectory()) await visit(path);
      else hash.update(await readFile(path));
    }
  };
  await visit(root);
  return hash.digest("hex");
}

function manifestCompatibilityError(manifest: PluginManifest): string | undefined {
  if (!/^1(?:\.|$)/.test(manifest.apiVersion)) {
    return `unsupported plugin apiVersion "${manifest.apiVersion}" (host supports v1)`;
  }
  if (manifest.platforms && !manifest.platforms.includes(process.platform as "win32" | "linux" | "darwin")) {
    return `plugin does not support platform ${process.platform} (supports: ${manifest.platforms.join(", ")})`;
  }
  const range = manifest.engines?.node;
  if (range && !satisfiesNodeRange(process.versions.node, range)) {
    return `plugin requires Node ${range}; current Node is ${process.versions.node}`;
  }
  for (const source of manifest.triggers?.patterns ?? []) {
    try {
      new RegExp(source);
    } catch (error) {
      return `invalid triggers.patterns "${source}": ${errorMessage(error)}`;
    }
  }
  return undefined;
}

/** Deliberately small engine matcher: exact major and >=/> ranges cover plugin manifests without adding semver. */
function satisfiesNodeRange(current: string, range: string): boolean {
  const now = current.split(".").map((part) => Number(part));
  const match = /^\s*(>=|>)?\s*(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(range);
  if (!match) return true;
  const wanted = [Number(match[2]), Number(match[3] ?? 0), Number(match[4] ?? 0)];
  let comparison = 0;
  for (let index = 0; index < 3; index += 1) {
    comparison = (now[index] ?? 0) - (wanted[index] ?? 0);
    if (comparison !== 0) break;
  }
  if (match[1] === ">") return comparison > 0;
  if (match[1] === ">=") return comparison >= 0;
  return (now[0] ?? 0) === wanted[0];
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

async function executableExists(name: string): Promise<boolean> {
  if (!/^[A-Za-z0-9._+-]+$/.test(name)) return false;
  return new Promise<boolean>((resolvePromise) => {
    const child = spawn(process.platform === "win32" ? "where.exe" : "which", [name], {
      windowsHide: true,
      stdio: "ignore",
    });
    let settled = false;
    const finish = (value: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise(value);
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(false);
    }, 2_000);
    child.on("error", () => finish(false));
    child.on("close", (code) => finish(code === 0));
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
    description: "Manage plugins (/plugin list | doctor | explain | config | reload | verify | revert)",
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
                `${status.activation !== "eager" ? ` [${status.activation}]` : ""}` +
                `${status.lifecycle?.state && status.lifecycle.state !== "active" ? ` [${status.lifecycle.state}]` : ""}` +
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
        case "doctor": {
          const report = await loader.doctor();
          const head = `plugin doctor: ${report.ok ? "OK" : "FAILED"} | profile=${report.profile} node=${report.node} ${report.platform} | loaded=${report.loaded} unloaded=${report.unloaded} errors=${report.errors}`;
          return [
            head,
            ...report.issues.map((issue) => `  ${issue.level.toUpperCase()} ${issue.code}${issue.plugin ? ` [${issue.plugin}]` : ""}: ${issue.message}`),
          ].join("\n");
        }
        case "explain": {
          const name = rest[0];
          return name ? loader.explain(name) : "usage: /plugin explain <name>";
        }
        case "config": {
          const name = rest[0];
          if (!name) return "usage: /plugin config <name> [json-object]";
          try {
            if (rest.length === 1) return JSON.stringify(await loader.config(name), null, 2);
            const value = JSON.parse(rest.slice(1).join(" ")) as unknown;
            if (!value || typeof value !== "object" || Array.isArray(value)) return "config must be a JSON object";
            await loader.config(name, value as Record<string, unknown>);
            return `updated config and reloaded: ${name}`;
          } catch (error) {
            return `error: ${errorMessage(error)}`;
          }
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
          if (name === "--all") {
            const reports = await loader.verifyAll();
            return reports.map((report) => `${report.ok ? "OK" : "FAIL"} ${report.name}${report.error ? `: ${report.error}` : ""}`).join("\n");
          }
          if (!name) return "usage: /plugin verify <name|--all>";
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
          return `unknown subcommand "${sub}" (use: list | doctor | explain | config | reload | eject | new | verify | revert)`;
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
        config.profile ?? "coding",
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
