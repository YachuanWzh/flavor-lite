// astgraph query layer — anchor search, K-hop traversal, blast radius and
// subgraph context assembly. All coordinates are 1-based to match Read/editor use.

const NODE_FIELDS = "id, kind, name, qualified_name, file_path, language, start_line, end_line, signature, docstring, is_exported, is_async";

function mapNode(row) {
  if (row === undefined) return undefined;
  return {
    id: row.id, kind: row.kind, name: row.name, qualifiedName: row.qualified_name,
    filePath: row.file_path, language: row.language,
    startLine: row.start_line, endLine: row.end_line,
    signature: row.signature ?? undefined, docstring: row.docstring ?? undefined,
    isExported: row.is_exported === 1, isAsync: row.is_async === 1,
  };
}

/** Fetch one node by id, or undefined. */
export function getNode(db, id) {
  return mapNode(db.prepare(`SELECT ${NODE_FIELDS} FROM nodes WHERE id = ?`).get(id));
}

/** Split camelCase/PascalCase/snake_case identifiers into lowercase word segments. */
export function identifierSegments(name) {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((segment) => segment.toLowerCase());
}

function queryWords(query) {
  return query
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 0);
}

/**
 * Anchor search: FTS5 first (prefix-matched terms), then identifier-segment
 * matching so natural-language words ("order cancel") hit camelCase symbols.
 * Returns scored node records, best first.
 */
export function search(db, query, { limit = 20 } = {}) {
  const words = queryWords(query);
  if (words.length === 0) return [];

  const scored = new Map();

  // FTS pass — each query word as a prefix term.
  try {
    const match = words.map((word) => `${word}*`).join(" ");
    const rows = db.prepare(`
      SELECT n.${NODE_FIELDS.split(", ").join(", n.")}, rank
      FROM nodes_fts
      JOIN nodes n ON n.rowid = nodes_fts.rowid
      WHERE nodes_fts MATCH ?
      ORDER BY rank LIMIT ?
    `).all(match, limit * 2);
    for (const row of rows) scored.set(row.id, { node: mapNode(row), score: 100 - Math.min(50, Math.max(0, row.rank)) });
  } catch { /* Invalid MATCH syntax falls through to segment matching. */ }

  // Segment pass — words of the query appear as camelCase segments of node names.
  const candidates = db.prepare(`SELECT ${NODE_FIELDS} FROM nodes`).all();
  for (const row of candidates) {
    const segments = identifierSegments(row.name).concat(identifierSegments(row.qualified_name));
    const matched = words.filter((word) => segments.some((segment) => segment === word || segment.startsWith(word)));
    if (matched.length === 0) continue;
    const score = matched.length * 25 + (matched.length === words.length ? 20 : 0);
    const existing = scored.get(row.id);
    if (existing === undefined || existing.score < score) {
      scored.set(row.id, { node: mapNode(row), score });
    }
  }

  return [...scored.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((entry) => entry.node);
}

/** Nodes that call the target (reverse call edges). */
export function callers(db, id) {
  return db.prepare(`
    SELECT DISTINCT n.${NODE_FIELDS.split(", ").join(", n.")}
    FROM edges e JOIN nodes n ON n.id = e.source
    WHERE e.target = ? AND e.kind IN ('calls', 'imports')
  `).all(id).map(mapNode);
}

/** Nodes the target calls (forward call edges). */
export function callees(db, id) {
  return db.prepare(`
    SELECT DISTINCT n.${NODE_FIELDS.split(", ").join(", n.")}
    FROM edges e JOIN nodes n ON n.id = e.target
    WHERE e.source = ? AND e.kind IN ('calls', 'imports')
  `).all(id).map(mapNode);
}

/**
 * K-hop blast radius from a node.
 *   direction "up"   — who depends on me (callers chain)
 *   direction "down" — what I depend on (callees chain)
 *   direction "both" — union
 */
export function impact(db, id, { hops = 2, direction = "up", limit = 200 } = {}) {
  const visited = new Map();
  const frontier = [id];
  for (let hop = 1; hop <= hops && frontier.length > 0; hop += 1) {
    const next = [];
    for (const current of frontier) {
      let rows = [];
      if (direction === "up" || direction === "both") {
        rows = rows.concat(db.prepare("SELECT source AS other FROM edges WHERE target = ?").all(current));
      }
      if (direction === "down" || direction === "both") {
        rows = rows.concat(db.prepare("SELECT target AS other FROM edges WHERE source = ?").all(current));
      }
      for (const row of rows) {
        if (row.other === id || visited.has(row.other)) continue;
        visited.set(row.other, hop);
        next.push(row.other);
        if (visited.size >= limit) break;
      }
      if (visited.size >= limit) break;
    }
    frontier.length = 0;
    frontier.push(...next);
  }
  const nodes = [...visited.entries()]
    .map(([nodeId, hop]) => ({ ...getNode(db, nodeId), hop }))
    .filter((node) => node.name !== undefined)
    .sort((a, b) => a.hop - b.hop);
  return { origin: getNode(db, id), nodes, hops };
}

/**
 * Subgraph context assembly: the anchor plus its K-hop callers and callees,
 * rendered as precise file:start-end read ranges for the agent.
 */
export function subgraphContext(db, id, { hops = 1, limit = 50 } = {}) {
  const origin = getNode(db, id);
  if (origin === undefined) return { anchor: undefined, context: [] };

  const result = impact(db, id, { hops, direction: "both", limit });
  const seen = new Map([[origin.filePath, origin]]);
  const entries = [origin, ...result.nodes];
  for (const node of entries) {
    const existing = seen.get(node.filePath);
    if (existing === undefined || node.startLine < existing.startLine) {
      // Prefer the widest node per file only when ranges are identical; otherwise
      // keep each node individually below.
      seen.set(node.filePath, node);
    }
  }

  const context = entries
    .map((node) => ({
      nodeId: node.id, name: node.name, kind: node.kind,
      filePath: node.filePath, startLine: node.startLine, endLine: node.endLine,
      signature: node.signature, docstring: node.docstring,
    }))
    .sort((a, b) => a.filePath.localeCompare(b.filePath) || a.startLine - b.startLine);

  return { anchor: origin, context };
}
