// astgraph TypeScript/JavaScript structural extractor.
// Walks the tree-sitter syntax tree and produces:
//   nodes — functions, classes, methods, interfaces, type aliases, variables
//   edges — intra-file calls / extends / implements
//   refs  — cross-file references (imports + unresolved calls/heritage) resolved later
//
// Lines are 1-based in all outputs so they match editor/Read tool coordinates.

import { parseSource } from "./grammars.mjs";

const DECLARATION_KINDS = new Map([
  ["function_declaration", "function"],
  ["class_declaration", "class"],
  ["interface_declaration", "interface"],
  ["type_alias_declaration", "type"],
]);

/** Extract the doc text from a `/** ... */` or `// ...` comment node. */
function docstringFrom(commentNode) {
  if (commentNode === null || commentNode.type !== "comment") return undefined;
  const text = commentNode.text;
  if (text.startsWith("/**") || text.startsWith("/*!")) {
    return text
      .replace(/^\/\*+[!*]?/, "")
      .replace(/\*+\/$/, "")
      .split("\n")
      .map((line) => line.replace(/^\s*\*+\s?/, "").trim())
      .filter((line) => line.length > 0)
      .join("\n") || undefined;
  }
  if (text.startsWith("//")) return text.replace(/^\/\/+\s?/, "").trim() || undefined;
  return undefined;
}

function firstLine(text, limit = 240) {
  const line = text.split("\n")[0].trim();
  return line.length > limit ? `${line.slice(0, limit)}…` : line;
}

function signatureOf(node) {
  const text = node.text;
  const brace = text.indexOf("{");
  const head = brace >= 0 ? text.slice(0, brace) : text.split("\n")[0];
  return firstLine(head.replace(/\s+/g, " "));
}

function nameOf(node) {
  const nameNode = node.childForFieldName("name");
  return nameNode === null ? undefined : nameNode.text;
}

function isAsync(node) {
  return node.children.some((child) => child.type === "async");
}

export async function extract(source, filePath, language) {
  const tree = await parseSource(source, language);

  /** @type {Array<object>} */
  const nodes = [];
  /** @type {Array<object>} */
  const edges = [];
  /** @type {Array<object>} */
  const refs = [];
  /** Map local symbol name → node id (methods registered as name only for call matching). */
  const localNames = new Map();
  /** Map imported binding name → module specifier. */
  const imports = new Map();
  /** Map declaration AST node id → node record, for enclosing-scope lookup.
   *  Keyed by numeric node.id because web-tree-sitter returns fresh node object
   *  instances on every navigation (parent/childForFieldName), so object identity
   *  cannot be used as a Map key. */
  const scopeByNodeId = new Map();

  const makeNode = (astNode, kind, name, qualifiedName, exported, extra = {}) => {
    // The docstring lives on the top-level statement's preceding sibling (comments
    // attach to program/export_statement, not to the inner declaration node).
    const docSource = extra.docSource ?? astNode;
    const record = {
      id: `${filePath}#${qualifiedName}`,
      kind,
      name,
      qualifiedName,
      filePath,
      language,
      startLine: astNode.startPosition.row + 1,
      endLine: astNode.endPosition.row + 1,
      signature: signatureOf(astNode),
      docstring: docstringFrom(docSource.previousSibling),
      isExported: exported,
      isAsync: extra.isAsync ?? false,
      ...extra,
    };
    delete record.docSource;
    nodes.push(record);
    scopeByNodeId.set(astNode.id, record);
    if (!localNames.has(name)) localNames.set(name, record.id);
    return record;
  };

  const collectDeclaration = (statement, exported) => {
    const inner = statement.type === "export_statement" ? statement.namedChildren.find((child) => DECLARATION_KINDS.has(child.type) || child.type === "lexical_declaration" || child.type === "abstract_class_declaration") : statement;
    const target = inner ?? statement;
    const kind = DECLARATION_KINDS.get(target.type);
    if (kind !== undefined) {
      const name = nameOf(target);
      if (name !== undefined) {
        // Comments attach to the top-level statement (export_statement / declaration),
        // so the docstring is read from the statement's preceding sibling.
        makeNode(target, kind, name, name, exported, {
          ...(kind === "function" ? { isAsync: isAsync(target) } : {}),
          docSource: statement,
        });
        if (target.type === "class_declaration" || target.type === "abstract_class_declaration") collectClassMembers(target, exported);
        collectHeritage(target, exported);
      }
      return;
    }
    if (target.type === "lexical_declaration") {
      for (const declarator of target.namedChildren.filter((child) => child.type === "variable_declarator")) {
        const name = declarator.childForFieldName("name")?.text;
        const value = declarator.childForFieldName("value");
        if (name === undefined || value === null) continue;
        const isFunction = value.type === "arrow_function" || value.type === "function_expression" || value.type === "function";
        makeNode(declarator, isFunction ? "function" : "variable", name, name, exported, {
          isAsync: isFunction && value.children.some((child) => child.type === "async"),
          docSource: statement,
        });
      }
    }
  };

  const collectClassMembers = (classNode, classExported) => {
    const className = nameOf(classNode);
    const body = classNode.childForFieldName("body");
    if (body === null) return;
    for (const member of body.namedChildren) {
      if (member.type !== "method_definition") continue;
      const name = member.childForFieldName("name")?.text;
      if (name === undefined) continue;
      const qualified = `${className}.${name}`;
      makeNode(member, "method", name, qualified, classExported, { isAsync: isAsync(member) });
    }
  };

  const collectHeritage = (classNode, _exported) => {
    const heritage = classNode.namedChildren.find((child) => child.type === "class_heritage");
    if (heritage === undefined) return;
    const sourceName = nameOf(classNode);
    if (sourceName === undefined) return;
    const sourceId = `${filePath}#${sourceName}`;
    for (const clause of heritage.namedChildren) {
      const kind = clause.type === "extends_clause" ? "extends" : clause.type === "implements_clause" ? "implements" : undefined;
      if (kind === undefined) continue;
      for (const typeNode of clause.namedChildren.filter((child) => child.type === "type_identifier" || child.type === "identifier")) {
        const typeName = typeNode.text;
        if (localNames.has(typeName)) {
          edges.push({ source: sourceId, target: localNames.get(typeName), kind, line: typeNode.startPosition.row + 1, col: typeNode.startPosition.column });
        } else {
          refs.push({
            fromNodeId: sourceId, referenceName: typeName, referenceKind: kind,
            line: typeNode.startPosition.row + 1, col: typeNode.startPosition.column,
            filePath, moduleSpecifier: undefined,
          });
        }
      }
    }
  };

  // Pass 1 — top-level declarations and imports.
  for (const statement of tree.rootNode.namedChildren) {
    if (statement.type === "import_statement") {
      const sourceNode = statement.childForFieldName("source");
      const moduleSpecifier = sourceNode === null ? undefined : sourceNode.text.replace(/^["']|["']$/g, "");
      for (const clause of statement.namedChildren.filter((child) => child.type === "import_clause")) {
        for (const named of clause.namedChildren.filter((child) => child.type === "named_imports")) {
          for (const specifier of named.namedChildren.filter((child) => child.type === "import_specifier")) {
            const nameNode = specifier.childForFieldName("name");
            if (nameNode === null) continue;
            const importedName = nameNode.text;
            imports.set(importedName, moduleSpecifier);
            refs.push({
              fromNodeId: null, referenceName: importedName, referenceKind: "import",
              line: nameNode.startPosition.row + 1, col: nameNode.startPosition.column,
              filePath, moduleSpecifier,
            });
          }
        }
        const defaultName = clause.namedChildren.find((child) => child.type === "identifier");
        if (defaultName !== undefined) {
          imports.set(defaultName.text, moduleSpecifier);
          refs.push({
            fromNodeId: null, referenceName: defaultName.text, referenceKind: "import",
            line: defaultName.startPosition.row + 1, col: defaultName.startPosition.column,
            filePath, moduleSpecifier,
          });
        }
      }
      continue;
    }
    collectDeclaration(statement, statement.type === "export_statement");
  }

  // Pass 2 — call expressions anywhere in the file.
  const enclosingScope = (node) => {
    let cursor = node.parent;
    while (cursor !== null) {
      const record = scopeByNodeId.get(cursor.id);
      if (record !== undefined) return record;
      cursor = cursor.parent;
    }
    return undefined;
  };

  const visitCalls = (node) => {
    if (node.type === "call_expression") {
      const callee = node.childForFieldName("function");
      if (callee !== null && callee.type === "identifier") {
        const name = callee.text;
        const scope = enclosingScope(node);
        if (scope !== undefined) {
          if (localNames.has(name) && localNames.get(name) !== scope.id) {
            edges.push({ source: scope.id, target: localNames.get(name), kind: "calls", line: callee.startPosition.row + 1, col: callee.startPosition.column });
          } else if (!localNames.has(name)) {
            refs.push({
              fromNodeId: scope.id, referenceName: name, referenceKind: "call",
              line: callee.startPosition.row + 1, col: callee.startPosition.column,
              filePath, moduleSpecifier: imports.get(name),
            });
          }
        }
      }
    }
    for (const child of node.namedChildren) visitCalls(child);
  };
  visitCalls(tree.rootNode);

  return { nodes, edges, refs, imports: Object.fromEntries(imports) };
}
