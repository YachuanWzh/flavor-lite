# filediff

A flavor-lite plugin that prints a colored `+/-` diff of a file's changes to
the terminal right after a file-modifying tool runs.

## Display rules

| Scenario | Display |
|---|---|
| New file | Every line in green `+ xxxx` |
| Deleted file | Every line in red `- xxxx` |
| Edited file | Per change block: red removed lines `- xxxx` first, then green added lines `+ xxxx`, each on its own line |

Example:

```
── src/foo.ts  modified (+2 −1)
- const a = 1;
+ const a = 2;
+ const b = 3;
```

## Supported tool calls

- `Write` / `Edit` / `ApplyPatch` (and any write-category tool with a
  `path`/`file_path` argument)
- `Shell` delete commands: `rm`, `unlink`, `del`, `erase`, `rmdir`, `rd`
- `Shell` move commands: `mv`, `move`, `ren`, `rename` (the source shows as a
  deletion; the destination shows as new/modified)

Deleting/moving a directory recursively scans it (capped at `maxTreeFiles`
files). The diff is written straight to stdout (the terminal) and never
touches the model-visible tool result, so ANSI codes do not pollute the
context.

## Configuration

Set in the `config` field of `flavor-plugin.json`:

| Key | Default | Meaning |
|---|---|---|
| `color` | `"auto"` | `"auto"` (colorize only on a TTY without `NO_COLOR`), `"always"`, `"never"` |
| `maxDiffLines` | `500` | Maximum diff lines printed before truncation |
| `maxFileBytes` | `524288` | Files larger than this are skipped (binary / huge files) |
| `maxTreeFiles` | `200` | Maximum files scanned when deleting/moving a directory |

## Usage

```text
/plugin list                # check load status
/plugin reload filediff     # hot-reload after editing index.js, no restart
```

## Limitations

- Shell writes via pipes/redirection (e.g. `echo x > f`, `git checkout -- f`)
  are not recognized.
- Binary files and files larger than `maxFileBytes` are not diffed.
- The diff shows only changed lines, not surrounding context.
