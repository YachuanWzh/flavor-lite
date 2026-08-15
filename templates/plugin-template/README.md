# my-plugin

A flavor-lite plugin. Full spec: `docs/plugin-dev.md` in the flavor-lite repo.

- Edit `index.js`, then run `/plugin reload my-plugin` in the REPL — no restart.
- `/plugin list` shows load status; errors are reported there too.
- Config for `apply(ctx, config)` can be passed via the `config` field of
  `flavor-plugin.json`.
