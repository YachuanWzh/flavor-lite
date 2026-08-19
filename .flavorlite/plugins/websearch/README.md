# websearch

A flavor-lite plugin that gives the agent a `websearch` tool for fetching
current information from the internet — news, docs, package versions, facts,
or anything that may be newer than the model's training data.

## Install

Put this directory at `.flavorlite/plugins/websearch/` inside your project
(that is where it already lives in this repo), then load it:

```text
/plugin reload websearch
/plugin list        # should show websearch: loaded
```

## Usage

The model can call the `websearch` tool in any turn. It accepts:

| Argument | Type | Description |
|---|---|---|
| `query` | string (required) | The search query |
| `maxResults` | int (optional, 1–10) | Number of results, default 5 |
| `region` | string (optional) | DuckDuckGo region code, e.g. `cn-zh`, `us-en`, `de-de`; default `wt-wt` (worldwide) |

For a quick manual check from the REPL:

```text
/websearch flavor-lite plugin api
```

## Providers

| Provider | Config | Notes |
|---|---|---|
| `duckduckgo` (default) | none | Free, no API key. Parses the `lite.duckduckgo.com` HTML endpoint. Can be rate-limited or blocked in some networks. |
| `brave` | `apiKey` | Uses the [Brave Search API](https://brave.com/search/api/). Needs a subscription key. |
| `custom` | `endpoint` | Any SearXNG-style JSON endpoint (`?q=` is appended), e.g. a self-hosted SearXNG instance. |

Configuration lives in the `config` field of `flavor-plugin.json` (it is
passed to `apply(ctx, config)` automatically):

```json
{
  "name": "websearch",
  "config": {
    "provider": "brave",
    "apiKey": "…",
    "maxResults": 5,
    "timeoutMs": 15000
  }
}
```

For a custom SearXNG-style endpoint:

```json
{
  "name": "websearch",
  "config": {
    "provider": "custom",
    "endpoint": "https://searx.example.com/search"
  }
}
```

Environment variables `WEBSEARCH_API_KEY` and `WEBSEARCH_ENDPOINT` are used
as fallbacks, so secrets don't have to live in the manifest.

## Notes

- The tool is `category: "read"`, so it is allowed in every permission mode.
- `timeoutMs` is clamped to 1 000–60 000 ms (default 15 000 ms). Timeouts
  and HTTP errors are returned to the model as errors, never thrown.
- The `websearch` command in the REPL is a thin wrapper around the tool; use
  it to verify a provider without starting a conversation.
- The plugin is pure ESM with zero dependencies; only Node's built-in
  `fetch` is used.

## Development

Run the unit tests from the repo root:

```text
npm test -- tests/websearch-plugin.test.ts
```

The parsing functions (`parseDuckDuckGoLite`, `parseBraveResults`,
`parseSearxngResults`, `htmlDecode`, `stripTags`) and `searchWeb` are named
exports of `index.js` so they can be tested without mounting the plugin.
