<!-- flavor-code:start -->
## Overview

- Project: flavor-lite
- Languages: TypeScript
- Package manager: npm

## Layout

- `src`
- `tests`

## Search

- A code graph index is available (`.flavor/astgraph/index.db`): pair `ast_search` with `grep`/`glob` to locate symbols, and use `ast_callers`/`ast_callees`/`ast_impact`/`ast_context` to trace reachability instead of reading files broadly.

## Build

- `npm run build`

## Test

- `npm test`

## Quality

No verified lint or format command detected.

## Conventions

- Respect `tsconfig.json`.
- Respect `vitest.config.ts`.

## Cautions

- Do not read or copy secrets from environment files.
- Do not inspect dependency directories or generated output unless explicitly required.

## flavor-lite plugins
- Read \templates to build a plugin for flavor-lite
<!-- flavor-code:end -->
