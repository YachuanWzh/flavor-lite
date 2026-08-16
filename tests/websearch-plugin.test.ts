import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Runtime } from "../src/kernel";
import { commandsPlugin, type CommandsService } from "../src/plugins/commands";
import { hooksPlugin } from "../src/plugins/hooks";
import { pluginsLoaderPlugin, type PluginsLoaderService } from "../src/plugins/plugins";
import { promptPlugin } from "../src/plugins/prompt";
import { toolsPlugin, type ToolRegistry } from "../src/plugins/tools";
import {
  htmlDecode,
  parseBraveResults,
  parseDuckDuckGoLite,
  parseSearxngResults,
  searchWeb,
  stripTags,
} from "../.flavorlite/plugins/websearch/index.js";

const PLUGIN_DIR = join(process.cwd(), ".flavorlite", "plugins", "websearch");

const DDG_HTML = `<!DOCTYPE html>
<html>
<body>
  <div class="result">
    <a rel="nofollow" href="https://example.com/guide" class="result-link">Example <b>Guide</b> &amp; Docs</a>
    <td class="result-snippet">A snippet about the <b>guide</b> &amp; its docs&#x27; details.</td>
  </div>
  <div class="result">
    <a rel="nofollow" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.org%2Fpage%3Fa%3D1" class="result-link">Redirected <b>Page</b></a>
    <td class="result-snippet">Second result snippet.</td>
  </div>
</body>
</html>`;

const BRAVE_JSON = {
  web: {
    results: [
      { title: "Brave Result One", url: "https://brave.example/1", description: "desc one" },
      { title: "", url: "https://brave.example/empty", description: "no title" },
      { title: "Brave Result Two", url: "https://brave.example/2" },
    ],
  },
};

const SEARX_JSON = {
  results: [
    { title: "Sx One", url: "https://sx.example/1", content: "content one" },
    { title: "Sx Two", url: "https://sx.example/2", description: "desc fallback" },
  ],
};

function stubFetch(impl: typeof fetch) {
  const mock = vi.fn(impl);
  vi.stubGlobal("fetch", mock);
  return mock;
}

describe("websearch plugin: HTML helpers", () => {
  it("decodes named and numeric entities", () => {
    expect(htmlDecode("a &amp; b &lt;c&gt; &quot;q&quot;")).toBe('a & b <c> "q"');
    expect(htmlDecode("&#39;quoted&#x27;")).toBe("'quoted'");
    expect(htmlDecode("&#x4E2D;&#25991;")).toBe("中文");
    expect(htmlDecode("&unknown;")).toBe("&unknown;");
  });

  it("strips tags, decodes entities, and collapses whitespace", () => {
    expect(stripTags("<b>Hello</b>  <i>world</i>")).toBe("Hello world");
    expect(stripTags("<td class=\"result-snippet\">a\n  b &amp; c</td>")).toBe("a b & c");
  });
});

describe("websearch plugin: parsers", () => {
  it("parses DuckDuckGo lite HTML with highlights and redirect links", () => {
    const results = parseDuckDuckGoLite(DDG_HTML);
    expect(results).toHaveLength(2);
    expect(results[0]).toEqual({
      title: "Example Guide & Docs",
      url: "https://example.com/guide",
      snippet: "A snippet about the guide & its docs' details.",
    });
    // DDG /l/?uddg= redirects are unwrapped to the real URL.
    expect(results[1]).toEqual({
      title: "Redirected Page",
      url: "https://example.org/page?a=1",
      snippet: "Second result snippet.",
    });
  });

  it("parses Brave API JSON and drops entries without a title", () => {
    const results = parseBraveResults(BRAVE_JSON);
    expect(results).toHaveLength(2);
    expect(results[0]).toEqual({ title: "Brave Result One", url: "https://brave.example/1", snippet: "desc one" });
    expect(results[1]).toEqual({ title: "Brave Result Two", url: "https://brave.example/2", snippet: "" });
    expect(parseBraveResults({ web: {} })).toEqual([]);
    expect(parseBraveResults(null)).toEqual([]);
  });

  it("parses SearXNG JSON using content with description fallback", () => {
    const results = parseSearxngResults(SEARX_JSON);
    expect(results).toEqual([
      { title: "Sx One", url: "https://sx.example/1", snippet: "content one" },
      { title: "Sx Two", url: "https://sx.example/2", snippet: "desc fallback" },
    ]);
    expect(parseSearxngResults({ results: [] })).toEqual([]);
  });
});

describe("websearch plugin: searchWeb (mocked fetch)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.WEBSEARCH_API_KEY;
    delete process.env.WEBSEARCH_ENDPOINT;
  });

  it("requires a query", async () => {
    const result = await searchWeb({}, {}, {});
    expect(result.isError).toBe(true);
    expect(result.content).toContain("query");
  });

  it("queries DuckDuckGo lite and formats results", async () => {
    const fetchMock = stubFetch(async (input) => {
      return new Response(DDG_HTML, { status: 200, headers: { "Content-Type": "text/html" } });
    });
    const result = await searchWeb({}, { query: "flavor-lite" }, {});

    const url = String(fetchMock.mock.calls[0]?.[0]);
    expect(url).toContain("lite.duckduckgo.com/lite/?");
    expect(url).toContain("q=flavor-lite");
    expect(url).toContain("kl=wt-wt");
    const headers = fetchMock.mock.calls[0]?.[1]?.headers as Record<string, string> | undefined;
    expect(headers).toMatchObject({ "User-Agent": expect.any(String) });

    expect(result.isError).toBeUndefined();
    expect(result.content).toContain("1. Example Guide & Docs");
    expect(result.content).toContain("URL: https://example.com/guide");
    expect(result.content).toContain("A snippet about the guide & its docs' details.");
    expect(result.content).toContain("2. Redirected Page");
  });

  it("honors region and maxResults args for DuckDuckGo", async () => {
    const fetchMock = stubFetch(async () => new Response(DDG_HTML, { status: 200 }));
    await searchWeb({}, { query: "node", region: "cn-zh", maxResults: 3 }, {});
    const url = String(fetchMock.mock.calls[0]?.[0]);
    expect(url).toContain("kl=cn-zh");
  });

  it("reports empty results", async () => {
    stubFetch(async () => new Response("<html><body>No more results.</body></html>", { status: 200 }));
    const result = await searchWeb({}, { query: "zzz" }, {});
    expect(result.isError).toBeUndefined();
    expect(result.content).toContain('No results found for "zzz"');
  });

  it("returns HTTP errors instead of throwing", async () => {
    stubFetch(async () => new Response("nope", { status: 429 }));
    const result = await searchWeb({}, { query: "x" }, {});
    expect(result.isError).toBe(true);
    expect(result.content).toContain("HTTP 429");
  });

  it("surfaces malformed provider JSON as an error", async () => {
    stubFetch(async () => new Response("not json", { status: 200 }));
    const result = await searchWeb({ provider: "custom", endpoint: "https://sx.local/search" }, { query: "x" }, {});
    expect(result.isError).toBe(true);
    expect(result.content).toContain("Web search failed");
  });

  it("brave provider requires an api key", async () => {
    const result = await searchWeb({ provider: "brave" }, { query: "x" }, {});
    expect(result.isError).toBe(true);
    expect(result.content).toContain("WEBSEARCH_API_KEY");
  });

  it("brave provider sends the key header and clamps maxResults", async () => {
    const manyResults = {
      web: {
        results: Array.from({ length: 12 }, (_, i) => ({
          title: `Brave Result ${i + 1}`,
          url: `https://brave.example/${i + 1}`,
          description: `desc ${i + 1}`,
        })),
      },
    };
    const fetchMock = stubFetch(async () =>
      new Response(JSON.stringify(manyResults), { status: 200, headers: { "Content-Type": "application/json" } }),
    );
    const result = await searchWeb({ provider: "brave", apiKey: "test-key" }, { query: "x", maxResults: 99 }, {});

    const url = String(fetchMock.mock.calls[0]?.[0]);
    expect(url).toContain("api.search.brave.com/res/v1/web/search");
    expect(url).toContain("count=10");
    const headers = fetchMock.mock.calls[0]?.[1]?.headers as Record<string, string> | undefined;
    expect(headers).toMatchObject({ "X-Subscription-Token": "test-key" });

    expect(result.isError).toBeUndefined();
    expect(result.content).toContain("1. Brave Result 1");
    expect(result.content).not.toContain("Brave Result 11");
    expect(result.content.match(/\d+\. /g)).toHaveLength(10);
  });

  it("brave provider falls back to the WEBSEARCH_API_KEY env var", async () => {
    process.env.WEBSEARCH_API_KEY = "env-key";
    const fetchMock = stubFetch(async () =>
      new Response(JSON.stringify(BRAVE_JSON), { status: 200, headers: { "Content-Type": "application/json" } }),
    );
    await searchWeb({ provider: "brave" }, { query: "x" }, {});
    const headers = fetchMock.mock.calls[0]?.[1]?.headers as Record<string, string> | undefined;
    expect(headers).toMatchObject({ "X-Subscription-Token": "env-key" });
  });

  it("custom provider requires an endpoint", async () => {
    const result = await searchWeb({ provider: "custom" }, { query: "x" }, {});
    expect(result.isError).toBe(true);
    expect(result.content).toContain("WEBSEARCH_ENDPOINT");
  });

  it("custom provider appends q and format=json to the endpoint", async () => {
    const fetchMock = stubFetch(async () =>
      new Response(JSON.stringify(SEARX_JSON), { status: 200, headers: { "Content-Type": "application/json" } }),
    );
    const result = await searchWeb(
      { provider: "custom", endpoint: "https://searx.example.com/search" },
      { query: "hello world" },
      {},
    );
    const url = String(fetchMock.mock.calls[0]?.[0]);
    expect(url).toBe("https://searx.example.com/search?q=hello%20world&format=json");
    expect(result.content).toContain("1. Sx One");
  });
});

describe("websearch plugin: disk-plugin integration", () => {
  it("loads through the plugins loader, registers the tool, and runs /websearch", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "websearch-plugin-"));
    const pluginsRoot = join(tmp, ".flavorlite", "plugins");
    try {
      await cp(PLUGIN_DIR, join(pluginsRoot, "websearch"), { recursive: true });

      const runtime = Runtime.create({ cwd: tmp });
      runtime
        .use(hooksPlugin)
        .use(toolsPlugin)
        .use(commandsPlugin)
        .use(promptPlugin)
        .use(pluginsLoaderPlugin, { runtime, roots: [pluginsRoot], watch: false });
      runtime.start();
      const loader = runtime.ctx.get("pluginsLoader") as PluginsLoaderService;
      await loader.init();
      try {
        const status = loader.list().find((entry) => entry.name === "websearch");
        expect(status?.status).toBe("loaded");

        const tools = runtime.ctx.get("tools") as ToolRegistry;
        expect(tools.get("websearch")?.category).toBe("read");

        // The REPL command dispatches to the real tool with a mocked fetch.
        const fetchMock = stubFetch(async () => new Response(DDG_HTML, { status: 200 }));
        const commands = runtime.ctx.get("commands") as CommandsService;
        const out = await commands.execute("/websearch hello");
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(out).toContain("1. Example Guide & Docs");
        expect(out).toContain("URL: https://example.com/guide");
      } finally {
        await runtime.dispose();
      }
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});
