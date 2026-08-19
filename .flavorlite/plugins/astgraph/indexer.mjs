// astgraph indexer — full and incremental project indexing.
// Walks the workspace, extracts symbols per file (content-hash incremental),
// then resolves cross-file references into graph edges.

import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { relative, sep } from "node:path";

import {
  deleteEdgesForFile,
  deleteFileRecord,
  deleteUnresolvedRefsForFile,
  getFileRecord,
  insertEdge,
  insertUnresolvedRef,
  replaceNodes,
  setMetadata,
  upsertFileRecord,
} from "./db.mjs";
import { extract } from "./extract.mjs";
import { languageForFile, SUPPORTED_LANGUAGES } from "./grammars.mjs";
import { resolveImportPath, resolveRefs } from "./resolve.mjs";

/** Directory names never indexed, regardless of depth. */
const EXCLUDED_DIRS = new Set([
  "node_modules", "dist", "build", "out", "coverage", "release", ".git",
  ".flavor", ".flavorlite", ".claude", ".worktrees", ".cache", ".idea", ".vscode", "vendor",
]);

function toPosix(path) {
  return path.split(sep).join("/");
}

/** Walk the workspace and return code files as workspace-relative posix paths. */
export function listCodeFiles(workspace) {
  const files = [];
  const walk = (dir) => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); }
    catch { return; }
    for (const entry of entries) {
      const full = `${dir}/${entry.name}`;
      if (entry.isDirectory()) {
        if (!EXCLUDED_DIRS.has(entry.name)) walk(full);
      } else if (entry.isFile() && languageForFile(entry.name) !== undefined) {
        files.push(toPosix(relative(workspace, full)));
      }
    }
  };
  walk(workspace);
  return files.sort();
}

/** SHA-256 content hash used for incremental detection. */
export function contentHash(content) {
  return createHash("sha256").update(content).digest("hex");
}

async function indexOneFile(db, workspace, relativePath) {
  const content = readFileSync(`${workspace}/${relativePath}`, "utf8");
  const language = languageForFile(relativePath);
  const { nodes, edges, refs } = await extract(content, relativePath, language);

  deleteEdgesForFile(db, relativePath);
  deleteUnresolvedRefsForFile(db, relativePath);
  replaceNodes(db, relativePath, nodes);
  for (const edge of edges) insertEdge(db, edge);
  for (const ref of refs) {
    insertUnresolvedRef(db, {
      fromNodeId: ref.fromNodeId, referenceName: ref.referenceName,
      referenceKind: ref.referenceKind, line: ref.line, col: ref.col,
      filePath: ref.filePath, moduleSpecifier: ref.moduleSpecifier,
    });
  }
  let size;
  try { size = statSync(`${workspace}/${relativePath}`).size; } catch { size = content.length; }
  upsertFileRecord(db, {
    path: relativePath, contentHash: contentHash(content), language, size, nodeCount: nodes.length,
  });
  return { nodeCount: nodes.length };
}

/** Resolve every pending unresolved_ref whose module specifier points at an indexed file. */
function resolvePass(db, workspace) {
  const rows = db.prepare(`
    SELECT id, from_node_id, reference_name, reference_kind, line, col, file_path, module_specifier
    FROM unresolved_refs WHERE status = 'pending' AND module_specifier IS NOT NULL
  `).all();
  if (rows.length === 0) return 0;

  const nodesByFile = new Map();
  for (const file of db.prepare("SELECT DISTINCT file_path FROM nodes").all()) {
    nodesByFile.set(file.file_path, db.prepare(
      "SELECT id, name, is_exported FROM nodes WHERE file_path = ?",
    ).all(file.file_path).map((row) => ({ id: row.id, name: row.name, isExported: row.is_exported === 1 })));
  }
  const exists = (path) => {
    try { statSync(`${workspace}/${path}`); return true; } catch { return false; }
  };

  const refs = rows.map((row) => ({
    id: row.id, fromNodeId: row.from_node_id, referenceName: row.reference_name,
    referenceKind: row.reference_kind, line: row.line, col: row.col,
    filePath: row.file_path, moduleSpecifier: row.module_specifier,
  }));
  // Import statements live outside any function, so their refs carry no from-node.
  // Attribute them to a node that actually uses the binding (same file + name);
  // unused imports resolve silently without an edge.
  for (const ref of refs) {
    if (ref.fromNodeId !== null || ref.referenceKind !== "import") continue;
    const user = refs.find((other) => other.referenceKind !== "import"
      && other.referenceName === ref.referenceName
      && other.filePath === ref.filePath
      && other.fromNodeId !== null);
    ref.fromNodeId = user?.fromNodeId ?? null;
  }
  const { edges, resolvedIds } = resolveRefs(refs.filter((ref) => ref.fromNodeId !== null), nodesByFile, exists);
  for (const edge of edges) insertEdge(db, edge);
  if (resolvedIds.length > 0) {
    db.exec("BEGIN");
    try {
      const mark = db.prepare("DELETE FROM unresolved_refs WHERE id = ?");
      for (const id of resolvedIds) mark.run(id);
      db.exec("COMMIT");
    } catch (error) { db.exec("ROLLBACK"); throw error; }
  }
  return resolvedIds.length;
}

/**
 * Index (or re-index) a workspace into the graph database.
 *
 * Options:
 *   onlyPaths — restrict the pass to these workspace-relative paths (hook-driven sync).
 *               Disappeared files are still pruned; everything else is left untouched.
 * Returns { files, indexed, skipped, removed, resolved }.
 */
export async function indexProject(workspace, { db, onlyPaths } = {}) {
  const restrict = onlyPaths === undefined ? undefined : new Set(onlyPaths.map(toPosix));
  const diskFiles = listCodeFiles(workspace).filter((path) => restrict === undefined || restrict.has(path));

  let indexed = 0;
  let skipped = 0;
  for (const path of diskFiles) {
    const current = readFileSync(`${workspace}/${path}`, "utf8");
    const hash = contentHash(current);
    const record = getFileRecord(db, path);
    if (record !== undefined && record.contentHash === hash) { skipped += 1; continue; }
    await indexOneFile(db, workspace, path);
    indexed += 1;
  }

  // Prune files that no longer exist on disk.
  let removed = 0;
  const known = db.prepare("SELECT path FROM files").all();
  const diskSet = new Set(diskFiles);
  for (const row of known) {
    if (restrict !== undefined && !restrict.has(row.path)) continue;
    if (!diskSet.has(row.path)) {
      deleteEdgesForFile(db, row.path);
      deleteUnresolvedRefsForFile(db, row.path);
      replaceNodes(db, row.path, []);
      deleteFileRecord(db, row.path);
      removed += 1;
    }
  }

  const resolved = resolvePass(db, workspace);
  setMetadata(db, "last_index", JSON.stringify({ at: Date.now(), files: diskFiles.length, indexed, removed }));

  return { files: diskFiles.length, indexed, skipped, removed, resolved };
}

/** Exposed for diagnostics. */
export const INDEXER_LANGUAGES = SUPPORTED_LANGUAGES;
