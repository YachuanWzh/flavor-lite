/**
 * Configuration: multi-source merge, validated with zod, fail loud.
 * Precedence (lowest → highest): user config (~/.flavorlite/config.json),
 * project config (.flavorlite/flavor.json), environment variables, CLI options.
 * A tiny .env loader keeps the dependency count at one (zod).
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { PERMISSION_MODES, type PermissionMode } from "../plugins/permission";

const configSchema = z
  .object({
    model: z.string().optional(),
    mode: z.enum(PERMISSION_MODES).optional(),
    maxIterations: z.number().int().positive().optional(),
    maxPromptChars: z.number().int().positive().optional(),
    maxToolOutputChars: z.number().int().positive().optional(),
    profile: z.enum(["minimal", "coding", "full"]).optional(),
    artifacts: z
      .object({
        path: z.string().optional(),
        maxFiles: z.number().int().positive().optional(),
        maxAgeDays: z.number().positive().optional(),
      })
      .partial()
      .optional(),
    openai: z
      .object({
        apiKey: z.string().optional(),
        baseURL: z.string().optional(),
        model: z.string().optional(),
      })
      .partial()
      .optional(),
    anthropic: z
      .object({
        apiKey: z.string().optional(),
        baseURL: z.string().optional(),
        model: z.string().optional(),
      })
      .partial()
      .optional(),
  })
  .partial();

export type FlavorConfig = z.infer<typeof configSchema>;

function readJsonFile(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return undefined; // missing or unreadable file is not an error
  }
}

/** Minimal KEY=VALUE .env loader; never overrides real environment variables. */
export function loadDotEnv(cwd: string): void {
  const raw = readFileSyncSafe(join(cwd, ".env"));
  if (raw === undefined) return;
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

function readFileSyncSafe(path: string): string | undefined {
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return undefined;
  }
}

function deepMerge(base: FlavorConfig, override: FlavorConfig): FlavorConfig {
  const result = { ...base };
  for (const [key, value] of Object.entries(override) as Array<[keyof FlavorConfig, unknown]>) {
    if (value === undefined) continue;
    const existing = result[key];
    if (existing && typeof existing === "object" && value && typeof value === "object") {
      (result as Record<string, unknown>)[key] = { ...existing, ...(value as object) };
    } else {
      (result as Record<string, unknown>)[key] = value;
    }
  }
  return result;
}

function fromEnv(): FlavorConfig {
  const env = process.env;
  const config: FlavorConfig = {};
  if (env.FLAVOR_MODEL) config.model = env.FLAVOR_MODEL;
  if (env.FLAVOR_MODE && (PERMISSION_MODES as readonly string[]).includes(env.FLAVOR_MODE)) {
    config.mode = env.FLAVOR_MODE as PermissionMode;
  }
  if (env.FLAVOR_PROFILE && ["minimal", "coding", "full"].includes(env.FLAVOR_PROFILE)) {
    config.profile = env.FLAVOR_PROFILE as "minimal" | "coding" | "full";
  }
  if (env.FLAVOR_MAX_PROMPT_CHARS && Number.isFinite(Number(env.FLAVOR_MAX_PROMPT_CHARS))) {
    config.maxPromptChars = Number(env.FLAVOR_MAX_PROMPT_CHARS);
  }
  if (env.FLAVOR_MAX_TOOL_OUTPUT_CHARS && Number.isFinite(Number(env.FLAVOR_MAX_TOOL_OUTPUT_CHARS))) {
    config.maxToolOutputChars = Number(env.FLAVOR_MAX_TOOL_OUTPUT_CHARS);
  }
  if (env.OPENAI_API_KEY || env.OPENAI_BASE_URL || env.FLAVOR_OPENAI_MODEL) {
    config.openai = {
      ...(env.OPENAI_API_KEY ? { apiKey: env.OPENAI_API_KEY } : {}),
      ...(env.OPENAI_BASE_URL ? { baseURL: env.OPENAI_BASE_URL } : {}),
      ...(env.FLAVOR_OPENAI_MODEL ? { model: env.FLAVOR_OPENAI_MODEL } : {}),
    };
  }
  if (env.ANTHROPIC_API_KEY || env.ANTHROPIC_BASE_URL || env.FLAVOR_ANTHROPIC_MODEL) {
    config.anthropic = {
      ...(env.ANTHROPIC_API_KEY ? { apiKey: env.ANTHROPIC_API_KEY } : {}),
      ...(env.ANTHROPIC_BASE_URL ? { baseURL: env.ANTHROPIC_BASE_URL } : {}),
      ...(env.FLAVOR_ANTHROPIC_MODEL ? { model: env.FLAVOR_ANTHROPIC_MODEL } : {}),
    };
  }
  return config;
}

/** Merge every config source and validate. Invalid config fails loud here. */
export function loadConfig(cwd: string, overrides?: FlavorConfig): FlavorConfig {
  loadDotEnv(cwd);
  let merged: FlavorConfig = {};
  const userConfig = readJsonFile(join(homedir(), ".flavorlite", "config.json"));
  if (userConfig !== undefined) merged = deepMerge(merged, parseConfig(userConfig, "~/.flavorlite/config.json"));
  const projectConfig = readJsonFile(join(cwd, ".flavorlite", "flavor.json"));
  if (projectConfig !== undefined) merged = deepMerge(merged, parseConfig(projectConfig, ".flavorlite/flavor.json"));
  merged = deepMerge(merged, fromEnv());
  if (overrides) merged = deepMerge(merged, overrides);
  return merged;
}

function parseConfig(raw: unknown, source: string): FlavorConfig {
  const result = configSchema.safeParse(raw);
  if (!result.success) {
    const issue = result.error.issues[0];
    throw new Error(`invalid config in ${source}: ${issue?.path.join(".")} — ${issue?.message}`);
  }
  return result.data;
}
