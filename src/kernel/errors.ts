/**
 * Typed kernel errors. Every failure the kernel can produce carries a stable
 * `code` plus structured `detail`, so hosts and monitoring can branch
 * programmatically instead of parsing messages. The `cause` chain preserves
 * the original error (e.g. the plugin's own throw).
 */

export type KernelErrorCode =
  | "runtime/disposed"
  | "resolution/missing-provider"
  | "resolution/cycle"
  | "resolution/duplicate-provider"
  | "activation/failed"
  | "activation/timeout"
  | "activation/invalid-config"
  | "service/ownership"
  | "service/undeclared"
  | "reload/provider-mismatch"
  | "reload/in-progress"
  | "unmount/dangling-consumers";

export class KernelError extends Error {
  readonly code: KernelErrorCode;
  /** Structured context (plugin names, service keys, ...) for logs/metrics. */
  readonly detail: Record<string, unknown>;

  constructor(
    code: KernelErrorCode,
    message: string,
    detail: Record<string, unknown> = {},
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = new.target.name;
    this.code = code;
    this.detail = detail;
  }
}

/** The runtime (or its context) has already been disposed. */
export class DisposedError extends KernelError {
  constructor(subject: string, operation: string) {
    super("runtime/disposed", `${subject} is disposed; cannot ${operation}`, {
      subject,
      operation,
    });
  }
}

export type ResolutionErrorCode =
  | "resolution/missing-provider"
  | "resolution/cycle"
  | "resolution/duplicate-provider";

/**
 * Dependency resolution failure. `entries` carries the mounted entries
 * implicated in the failure so the resolver can drop exactly them (with
 * dependents cascading) instead of poisoning the whole mount list.
 */
export class ResolutionError extends KernelError {
  readonly entries: readonly unknown[];

  constructor(code: ResolutionErrorCode, message: string, entries: readonly unknown[]) {
    super(code, message, { plugins: entries.map(pluginNameOf) });
    this.entries = entries;
  }
}

/** A plugin's apply() failed or exceeded the activation timeout. */
export class ActivationError extends KernelError {
  readonly plugin: string;

  constructor(
    message: string,
    plugin: string,
    code: "activation/failed" | "activation/timeout" = "activation/failed",
    detail: Record<string, unknown> = {},
    options?: ErrorOptions,
  ) {
    super(code, message, { plugin, ...detail }, options);
    this.plugin = plugin;
  }
}

/** Wrap a plugin activation failure; keeps kernel errors intact. */
export function activationFailure(plugin: string, error: unknown): ActivationError {
  if (error instanceof ActivationError) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new ActivationError(
    `plugin "${plugin}" failed to activate: ${message}`,
    plugin,
    "activation/failed",
    {},
    error instanceof Error ? { cause: error } : undefined,
  );
}

/** Plugin config failed its Standard Schema validation before apply(). */
export class ConfigValidationError extends KernelError {
  constructor(plugin: string, message: string) {
    super("activation/invalid-config", message, { plugin });
  }
}

/** Cross-plugin service override without `{ override: true }`. */
export class OwnershipError extends KernelError {
  constructor(serviceKey: string, currentOwner: string, newOwner: string) {
    super(
      "service/ownership",
      `service "${serviceKey}" is owned by plugin "${currentOwner}"; plugin "${newOwner}" cannot provide it (pass { override: true } to shadow deliberately)`,
      { serviceKey, currentOwner, newOwner },
    );
  }
}

/** A plugin provided a service key outside its declared `provides` list. */
export class UndeclaredServiceError extends KernelError {
  constructor(serviceKey: string, plugin: string, declared: readonly string[]) {
    super(
      "service/undeclared",
      `plugin "${plugin}" provides service "${serviceKey}", which is not in its declared provides [${declared.join(", ")}]`,
      { serviceKey, plugin, declared: [...declared] },
    );
  }
}

export type ReloadErrorCode = "reload/provider-mismatch" | "reload/in-progress";

/** Reload refused: the replacement is incompatible or one is already running. */
export class ReloadError extends KernelError {
  constructor(code: ReloadErrorCode, message: string, detail: Record<string, unknown> = {}) {
    super(code, message, detail);
  }
}

/** Unmount would leave active consumers of a provided service dangling. */
export class UnmountError extends KernelError {
  constructor(plugin: string, problems: string[]) {
    super(
      "unmount/dangling-consumers",
      `cannot unmount "${plugin}": ${problems.join("; ")}; unmount the dependents first or pass { force: true }`,
      { plugin, problems },
    );
  }
}

function pluginNameOf(entry: unknown): string {
  const name = (entry as { plugin?: { name?: unknown } } | undefined)?.plugin?.name;
  return typeof name === "string" ? name : "?";
}
