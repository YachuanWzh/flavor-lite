/**
 * Recoverable, crash-safe file updates: file lock + atomic rename + .bak
 * backup. Ported from flavor-code's protected-file utility (zero deps).
 *
 * Every memory document goes through updateProtectedFile() so a torn write
 * (crash mid-rename) can always fall back to the previous .bak copy — the
 * memory index must never silently lose entries.
 */

import { randomUUID } from "node:crypto";
import { copyFile, mkdir, open, readFile, rename, rm, stat, unlink } from "node:fs/promises";
import { dirname } from "node:path";

const LOCK_WAIT_MS = 20;
const LOCK_TIMEOUT_MS = 2_000;
const STALE_LOCK_MS = 30_000;

/** Read a file with .bak fallback. Returns undefined when neither exists. */
export async function readRecoverableFile(path, decode) {
  let primaryError;
  try {
    return { value: await decode(await readFile(path, "utf8")), source: path };
  } catch (error) {
    primaryError = error;
  }

  const backup = `${path}.bak`;
  try {
    return { value: await decode(await readFile(backup, "utf8")), source: backup };
  } catch (backupError) {
    if (isCode(primaryError, "ENOENT") && isCode(backupError, "ENOENT")) return undefined;
    if (isCode(backupError, "ENOENT")) throw primaryError;
    throw new Error(
      `Primary and backup files are invalid for ${path}: ${message(primaryError)}; backup: ${message(backupError)}`,
    );
  }
}

/** Locked read-modify-write with atomic rename and .bak backup. */
export async function updateProtectedFile({ path, decode, encode, update, backupEncode, lockTimeoutMs, staleLockMs }) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  return withFileLock(path, async () => {
    const current = await readRecoverableFile(path, decode);
    const next = await update(current?.value);
    if (current !== undefined) {
      const backup = backupEncode === undefined
        ? await encode(current.value)
        : await backupEncode(current.value);
      await writeAtomic(`${path}.bak`, backup);
    }
    await writeAtomic(path, await encode(next));
    return next;
  }, lockTimeoutMs ?? LOCK_TIMEOUT_MS, staleLockMs ?? STALE_LOCK_MS);
}

async function withFileLock(path, operation, lockTimeoutMs, staleLockMs) {
  const lockPath = `${path}.lock`;
  const token = JSON.stringify({ pid: process.pid, nonce: randomUUID() });
  const deadline = Date.now() + lockTimeoutMs;
  let handle;
  while (handle === undefined) {
    try {
      handle = await open(lockPath, "wx", 0o600);
      await handle.writeFile(token, "utf8");
      await handle.sync();
    } catch (error) {
      await handle?.close().catch(() => undefined);
      handle = undefined;
      if (!isCode(error, "EEXIST")) throw error;
      await removeStaleLock(lockPath, staleLockMs);
      if (Date.now() >= deadline) throw new Error(`Timed out waiting for configuration lock ${lockPath}`);
      await delay(LOCK_WAIT_MS);
    }
  }

  await handle.close();
  try {
    return await operation();
  } finally {
    try {
      if ((await readFile(lockPath, "utf8")) === token) await rm(lockPath, { force: true });
    } catch (error) {
      if (!isCode(error, "ENOENT")) throw error;
    }
  }
}

async function removeStaleLock(path, staleLockMs) {
  try {
    const token = await readFile(path, "utf8");
    const metadata = await stat(path);
    if (Date.now() - metadata.mtimeMs <= staleLockMs) return;
    const owner = parseLockOwner(token);
    if (owner !== undefined && isProcessAlive(owner)) return;
    if (await readFile(path, "utf8") !== token) return;
    const stale = `${path}.stale-${process.pid}-${randomUUID()}`;
    try {
      await rename(path, stale);
      await rm(stale, { force: true });
    } catch (error) {
      if (!isCode(error, "ENOENT")) return;
    }
  } catch (error) {
    if (!isCode(error, "ENOENT")) throw error;
  }
}

function parseLockOwner(token) {
  try {
    const parsed = JSON.parse(token);
    if (typeof parsed !== "object" || parsed === null || !("pid" in parsed)) return undefined;
    const pid = parsed.pid;
    return typeof pid === "number" && Number.isSafeInteger(pid) && pid > 0 ? pid : undefined;
  } catch {
    const legacy = token.match(/^(\d+):/);
    if (legacy?.[1] === undefined) return undefined;
    const pid = Number(legacy[1]);
    return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined;
  }
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return isCode(error, "EPERM");
  }
}

async function writeAtomic(path, content) {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  let handle;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(content, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    try {
      await rename(temporary, path);
    } catch (error) {
      if (!isWindowsSharingError(error)) throw error;
      await copyFile(temporary, path);
      await unlink(temporary).catch(() => undefined);
    }
  } finally {
    await handle?.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

function isWindowsSharingError(error) {
  return typeof error === "object" && error !== null && "code" in error
    && ["EPERM", "EACCES", "EBUSY", "EEXIST"].includes(String(error.code));
}

function delay(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

function isCode(error, code) {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

function message(error) {
  return error instanceof Error ? error.message : String(error);
}
