// astgraph graph database — SQLite-backed node/edge graph (codegraph-inspired).
// Uses node:sqlite with WAL mode so concurrent readers never block on a writer.

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS schema_versions (
    version INTEGER PRIMARY KEY,
    applied_at INTEGER NOT NULL,
    description TEXT
);

CREATE TABLE IF NOT EXISTS files (
    path TEXT PRIMARY KEY,
    content_hash TEXT NOT NULL,
    language TEXT NOT NULL,
    size INTEGER NOT NULL,
    modified_at INTEGER NOT NULL DEFAULT 0,
    indexed_at INTEGER NOT NULL DEFAULT 0,
    node_count INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS nodes (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    name TEXT NOT NULL,
    qualified_name TEXT NOT NULL,
    file_path TEXT NOT NULL,
    language TEXT NOT NULL,
    start_line INTEGER NOT NULL,
    end_line INTEGER NOT NULL,
    signature TEXT,
    docstring TEXT,
    is_exported INTEGER NOT NULL DEFAULT 0,
    is_async INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS edges (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source TEXT NOT NULL,
    target TEXT NOT NULL,
    kind TEXT NOT NULL,
    line INTEGER,
    col INTEGER,
    FOREIGN KEY (source) REFERENCES nodes(id) ON DELETE CASCADE,
    FOREIGN KEY (target) REFERENCES nodes(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS unresolved_refs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    from_node_id TEXT,
    reference_name TEXT NOT NULL,
    reference_kind TEXT NOT NULL,
    line INTEGER NOT NULL,
    col INTEGER NOT NULL,
    file_path TEXT NOT NULL DEFAULT '',
    module_specifier TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    FOREIGN KEY (from_node_id) REFERENCES nodes(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_nodes_name ON nodes(name);
CREATE INDEX IF NOT EXISTS idx_nodes_lower_name ON nodes(lower(name));
CREATE INDEX IF NOT EXISTS idx_nodes_file_path ON nodes(file_path);
CREATE INDEX IF NOT EXISTS idx_nodes_kind ON nodes(kind);
CREATE INDEX IF NOT EXISTS idx_edges_source_kind ON edges(source, kind);
CREATE INDEX IF NOT EXISTS idx_edges_target_kind ON edges(target, kind);
CREATE UNIQUE INDEX IF NOT EXISTS idx_edges_identity
  ON edges(source, target, kind, IFNULL(line, -1), IFNULL(col, -1));
CREATE INDEX IF NOT EXISTS idx_unresolved_from ON unresolved_refs(from_node_id);
CREATE INDEX IF NOT EXISTS idx_unresolved_name ON unresolved_refs(reference_name);

CREATE VIRTUAL TABLE IF NOT EXISTS nodes_fts USING fts5(
    name,
    qualified_name,
    signature,
    docstring,
    content='nodes',
    content_rowid='rowid'
);

CREATE TRIGGER IF NOT EXISTS nodes_ai AFTER INSERT ON nodes BEGIN
    INSERT INTO nodes_fts(rowid, name, qualified_name, signature, docstring)
    VALUES (NEW.rowid, NEW.name, NEW.qualified_name, NEW.signature, NEW.docstring);
END;

CREATE TRIGGER IF NOT EXISTS nodes_ad AFTER DELETE ON nodes BEGIN
    INSERT INTO nodes_fts(nodes_fts, rowid, name, qualified_name, signature, docstring)
    VALUES ('delete', OLD.rowid, OLD.name, OLD.qualified_name, OLD.signature, OLD.docstring);
END;

CREATE TRIGGER IF NOT EXISTS nodes_au AFTER UPDATE ON nodes BEGIN
    INSERT INTO nodes_fts(nodes_fts, rowid, name, qualified_name, signature, docstring)
    VALUES ('delete', OLD.rowid, OLD.name, OLD.qualified_name, OLD.signature, OLD.docstring);
    INSERT INTO nodes_fts(rowid, name, qualified_name, signature, docstring)
    VALUES (NEW.rowid, NEW.name, NEW.qualified_name, NEW.signature, NEW.docstring);
END;

CREATE TABLE IF NOT EXISTS project_metadata (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at INTEGER NOT NULL
);
`;

/** Open (creating when absent) the graph database at `path`. Returns a DatabaseSync. */
export function openDb(path) {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA synchronous = NORMAL");
  db.exec(SCHEMA);
  const version = db.prepare("SELECT COUNT(*) AS count FROM schema_versions").get();
  if (version.count === 0) {
    db.prepare("INSERT INTO schema_versions(version, applied_at, description) VALUES (?, ?, ?)")
      .run(1, Date.now(), "Initial astgraph schema");
  }
  return db;
}

/** Insert or replace the tracking record for one source file. */
export function upsertFileRecord(db, record) {
  db.prepare(`
    INSERT INTO files(path, content_hash, language, size, modified_at, indexed_at, node_count)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(path) DO UPDATE SET
      content_hash = excluded.content_hash,
      language = excluded.language,
      size = excluded.size,
      modified_at = excluded.modified_at,
      indexed_at = excluded.indexed_at,
      node_count = excluded.node_count
  `).run(
    record.path, record.contentHash, record.language, record.size,
    record.modifiedAt ?? Date.now(), record.indexedAt ?? Date.now(), record.nodeCount ?? 0,
  );
}

/** Read the tracking record for one source file, or undefined when absent. */
export function getFileRecord(db, path) {
  const row = db.prepare("SELECT * FROM files WHERE path = ?").get(path);
  if (row === undefined) return undefined;
  return {
    path: row.path, contentHash: row.content_hash, language: row.language,
    size: row.size, modifiedAt: row.modified_at, indexedAt: row.indexed_at,
    nodeCount: row.node_count,
  };
}

/** Delete a file record; nodes cascade (and with them edges + refs + FTS rows). */
export function deleteFileRecord(db, path) {
  db.prepare("DELETE FROM nodes WHERE file_path = ?").run(path);
  db.prepare("DELETE FROM files WHERE path = ?").run(path);
}

/**
 * Replace every node belonging to a file. Runs inside one transaction; the FTS
 * triggers keep nodes_fts in sync.
 */
export function replaceNodes(db, filePath, nodes) {
  const insert = db.prepare(`
    INSERT OR REPLACE INTO nodes(
      id, kind, name, qualified_name, file_path, language,
      start_line, end_line, signature, docstring, is_exported, is_async
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const clear = db.prepare("DELETE FROM nodes WHERE file_path = ?");
  db.exec("BEGIN");
  try {
    clear.run(filePath);
    for (const node of nodes) {
      insert.run(
        node.id, node.kind, node.name, node.qualifiedName, node.filePath, node.language,
        node.startLine, node.endLine, node.signature ?? null, node.docstring ?? null,
        node.isExported ? 1 : 0, node.isAsync ? 1 : 0,
      );
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

/** Insert one edge; duplicate (source, target, kind, line, col) rows are ignored. */
export function insertEdge(db, edge) {
  db.prepare(`
    INSERT OR IGNORE INTO edges(source, target, kind, line, col) VALUES (?, ?, ?, ?, ?)
  `).run(edge.source, edge.target, edge.kind, edge.line ?? null, edge.col ?? null);
}

/** Delete every edge whose source OR target belongs to a file. */
export function deleteEdgesForFile(db, filePath) {
  db.prepare(`
    DELETE FROM edges WHERE source IN (SELECT id FROM nodes WHERE file_path = ?)
       OR target IN (SELECT id FROM nodes WHERE file_path = ?)
  `).run(filePath, filePath);
}

/** Insert one unresolved cross-file reference (status 'pending'). */
export function insertUnresolvedRef(db, ref) {
  db.prepare(`
    INSERT INTO unresolved_refs(from_node_id, reference_name, reference_kind, line, col, file_path, module_specifier, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')
  `).run(ref.fromNodeId, ref.referenceName, ref.referenceKind, ref.line, ref.col, ref.filePath, ref.moduleSpecifier ?? null);
}

/** Delete every unresolved reference originating from a file. */
export function deleteUnresolvedRefsForFile(db, filePath) {
  db.prepare("DELETE FROM unresolved_refs WHERE file_path = ?").run(filePath);
}

/** Summary counters used by /ast status. */
export function stats(db) {
  const files = db.prepare("SELECT COUNT(*) AS count FROM files").get().count;
  const nodes = db.prepare("SELECT COUNT(*) AS count FROM nodes").get().count;
  const edges = db.prepare("SELECT COUNT(*) AS count FROM edges").get().count;
  const unresolved = db.prepare("SELECT COUNT(*) AS count FROM unresolved_refs WHERE status = 'pending'").get().count;
  return { files, nodes, edges, unresolved };
}

/** Store a provenance metadata value. */
export function setMetadata(db, key, value) {
  db.prepare(`
    INSERT INTO project_metadata(key, value, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).run(key, value, Date.now());
}

/** Read a provenance metadata value, or undefined when absent. */
export function getMetadata(db, key) {
  const row = db.prepare("SELECT value FROM project_metadata WHERE key = ?").get(key);
  return row?.value;
}
