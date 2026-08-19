// websearch — a flavor-lite plugin that lets the agent search the web.
//
// Providers (config.provider, default "duckduckgo"):
//   duckduckgo  free, no API key. Parses the lite HTML endpoint; the
//               "region" arg selects a locale (e.g. "cn-zh", "us-en").
//   brave       needs config.apiKey (or env WEBSEARCH_API_KEY).
//   custom      any JSON endpoint in SearXNG format — config.endpoint
//               (or env WEBSEARCH_ENDPOINT); "?q=" is appended.
//
// The named exports (searchWeb, htmlDecode, stripTags, parse*) are plain
// functions so they can be unit-tested without mounting the plugin.

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

const NAMED_ENTITIES = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ndash: "\u2013",
  mdash: "\u2014",
  hellip: "\u2026",
};

/** Decode HTML entities (&amp;, &lt;, &#39;, &#x27;, ...) to plain text. */
export function htmlDecode(input) {
  return input.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z][a-zA-Z0-9]*);/g, (match, entity) => {
    try {
      if (entity.startsWith("#x")) {
        const code = parseInt(entity.slice(2), 16);
        return Number.isFinite(code) && code >= 0 ? String.fromCodePoint(code) : match;
      }
      if (entity.startsWith("#")) {
        const code = parseInt(entity.slice(1), 10);
        return Number.isFinite(code) && code >= 0 ? String.fromCodePoint(code) : match;
      }
      return NAMED_ENTITIES[entity] ?? match;
    } catch {
      return match;
    }
  });
}

/** Strip HTML tags and collapse whitespace. */
export function stripTags(input) {
  return htmlDecode(input.replace(/<[^>]*>/g, ""))
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Parse DuckDuckGo's lite HTML results page.
 * Returns [{ title, url, snippet }]. Pure function, no network access.
 */
export function parseDuckDuckGoLite(html) {
  const results = [];
  const anchorPattern = /<a[^>]*class=["'][^"']*result-link[^"']*["'][^>]*>(.*?)<\/a>/gs;
  // Backreference (\1) ties the closing tag to the opening one, so a snippet
  // containing nested inline tags (e.g. <b>highlights</b>) is captured whole.
  const snippetPattern = /<([a-zA-Z][a-zA-Z0-9]*)[^>]*class=["'][^"']*result-snippet[^"']*["'][^>]*>(.*?)<\/\1>/gs;

  const anchors = [...html.matchAll(anchorPattern)];
  const snippets = [...html.matchAll(snippetPattern)];

  anchors.forEach((anchor, index) => {
    const tag = anchor[0].slice(0, anchor[0].indexOf(">") + 1);
    const hrefMatch = /href=["']([^"']*)["']/.exec(tag);
    const url = hrefMatch ? normalizeHref(hrefMatch[1]) : "";
    if (!url) return;
    const title = stripTags(anchor[1]);
    if (!title) return;
    const snippetMatch = snippets[index];
    results.push({
      title,
      url,
      snippet: snippetMatch ? stripTags(snippetMatch[2]) : "",
    });
  });
  return results;
}

/** Normalize a result href; unwrap DuckDuckGo's /l/?uddg= redirects. */
function normalizeHref(href) {
  try {
    const url = new URL(href, "https://lite.duckduckgo.com/");
    if (url.hostname === "duckduckgo.com" && url.pathname.startsWith("/l/")) {
      const target = url.searchParams.get("uddg");
      if (target) return target;
    }
    return url.toString();
  } catch {
    return href;
  }
}

/** Parse a Brave Search API response (json.web.results[]). */
export function parseBraveResults(json) {
  if (!json || !Array.isArray(json.web?.results)) return [];
  return json.web.results
    .map((entry) => ({
      title: String(entry.title ?? "").trim(),
      url: String(entry.url ?? "").trim(),
      snippet: String(entry.description ?? "").trim(),
    }))
    .filter((entry) => entry.title && entry.url);
}

/** Parse a SearXNG-style JSON response (json.results[]). */
export function parseSearxngResults(json) {
  if (!json || !Array.isArray(json.results)) return [];
  return json.results
    .map((entry) => ({
      title: String(entry.title ?? "").trim(),
      url: String(entry.url ?? "").trim(),
      snippet: String(entry.content ?? entry.description ?? "").trim(),
    }))
    .filter((entry) => entry.title && entry.url);
}

function clamp(value, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return max;
  return Math.min(max, Math.max(min, Math.round(n)));
}

/** fetch() a URL as text with a hard timeout, chained to the caller's signal. */
async function fetchText(url, { headers = {}, signal, timeoutMs = 15000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("request timed out")), timeoutMs);
  const onAbort = () => controller.abort(signal?.reason ?? new Error("aborted"));
  if (signal) {
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  }
  try {
    const response = await fetch(url, { headers, redirect: "follow", signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
    return await response.text();
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener("abort", onAbort);
  }
}

async function duckDuckGoSearch({ query, region, maxResults, timeoutMs, signal }) {
  const params = new URLSearchParams({ q: query, kl: region ?? "wt-wt" });
  const html = await fetchText(`https://lite.duckduckgo.com/lite/?${params}`, {
    headers: { "User-Agent": USER_AGENT, Accept: "text/html" },
    signal,
    timeoutMs,
  });
  return parseDuckDuckGoLite(html).slice(0, maxResults);
}

async function braveSearch({ query, apiKey, maxResults, timeoutMs, signal }) {
  const params = new URLSearchParams({ q: query, count: String(maxResults) });
  const text = await fetchText(`https://api.search.brave.com/res/v1/web/search?${params}`, {
    headers: { "X-Subscription-Token": apiKey, Accept: "application/json" },
    signal,
    timeoutMs,
  });
  return parseBraveResults(JSON.parse(text)).slice(0, maxResults);
}

async function customSearch({ query, endpoint, maxResults, timeoutMs, signal }) {
  const separator = endpoint.includes("?") ? "&" : "?";
  const url = `${endpoint}${separator}q=${encodeURIComponent(query)}&format=json`;
  const text = await fetchText(url, {
    headers: { Accept: "application/json" },
    signal,
    timeoutMs,
  });
  return parseSearxngResults(JSON.parse(text)).slice(0, maxResults);
}

/**
 * Run a web search. config comes from flavor-plugin.json ("config" field)
 * merged with environment variables; args come from the model tool call.
 * Never throws — returns { content, isError } for the tool registry.
 */
export async function searchWeb(config = {}, args = {}, execCtx = {}) {
  const query = typeof args.query === "string" ? args.query.trim() : "";
  if (!query) return { content: "Missing required argument: query", isError: true };

  const provider = config.provider ?? "duckduckgo";
  const maxResults = clamp(args.maxResults ?? config.maxResults ?? 5, 1, 10);
  const timeoutMs = clamp(config.timeoutMs ?? 15000, 1000, 60000);
  const apiKey = config.apiKey ?? process.env.WEBSEARCH_API_KEY;
  const endpoint = config.endpoint ?? process.env.WEBSEARCH_ENDPOINT;
  const signal = execCtx.signal;

  try {
    let results;
    if (provider === "brave") {
      if (!apiKey) {
        return { content: 'Brave provider requires "apiKey" in the plugin config or the WEBSEARCH_API_KEY environment variable.', isError: true };
      }
      results = await braveSearch({ query, apiKey, maxResults, timeoutMs, signal });
    } else if (provider === "custom") {
      if (!endpoint) {
        return { content: 'Custom provider requires "endpoint" in the plugin config or the WEBSEARCH_ENDPOINT environment variable.', isError: true };
      }
      results = await customSearch({ query, endpoint, maxResults, timeoutMs, signal });
    } else {
      const region = typeof args.region === "string" ? args.region : (config.region ?? "wt-wt");
      results = await duckDuckGoSearch({ query, region, maxResults, timeoutMs, signal });
    }

    if (results.length === 0) return { content: `No results found for "${query}".` };

    const lines = results.map((result, index) => {
      const snippet = result.snippet ? `\n   ${result.snippet}` : "";
      return `${index + 1}. ${result.title}\n   URL: ${result.url}${snippet}`;
    });
    return { content: lines.join("\n\n") };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { content: `Web search failed (provider: ${provider}): ${message}`, isError: true };
  }
}

function createWebsearchTool(config) {
  return {
    name: "websearch",
    category: "read",
    description:
      "Search the web for current information (news, docs, versions, facts, URLs). Use when the answer may be newer than your training data or when you need external information beyond the local workspace. Returns ranked results with title, URL, and snippet.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "The search query, e.g. \"flavor-lite plugin API\"." },
        maxResults: { type: "integer", minimum: 1, maximum: 10, description: "Number of results to return (default 5)." },
        region: { type: "string", description: 'DuckDuckGo region code, e.g. "cn-zh", "us-en", "de-de" (default "wt-wt" = worldwide).' },
      },
      required: ["query"],
    },
    async execute(args, execCtx) {
      return searchWeb(config, args, execCtx);
    },
  };
}

export default {
  name: "websearch",
  inject: ["tools", "hooks", "commands"],
  apply(ctx, config = {}) {
    return ctx.effect(() => {
      const disposers = [];

      disposers.push(ctx.get("tools").register(createWebsearchTool(config)));

      disposers.push(
        ctx.get("hooks").hook("prompt/assemble", async (event, next) => {
          event.sections.push({
            name: "websearch",
            content:
              "Use the `websearch` tool to fetch current information from the web when the answer may have changed since your training data, or when the workspace does not contain what you need.",
          });
          return next(event);
        }),
      );

      disposers.push(
        ctx.get("commands").register({
          name: "websearch",
          description: "Search the web and print the results",
          run: async (args) => {
            if (!args) return "Usage: /websearch <query>";
            const result = await searchWeb(config, { query: args }, {});
            return result.isError ? `Error: ${result.content}` : result.content;
          },
        }),
      );

      return () => {
        for (const dispose of disposers.reverse()) dispose();
      };
    }, "websearch.install");
  },
};
