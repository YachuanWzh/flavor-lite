import { afterEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { runEvalSuite } from "../src/evals";

describe("eval harness", () => {
  let root: string | undefined;
  let server: Server | undefined;

  afterEach(async () => {
    await new Promise<void>((resolvePromise) => server?.close(() => resolvePromise()) ?? resolvePromise());
    if (root) await rm(root, { recursive: true, force: true });
  });

  it("runs an isolated fixture against a local streaming provider and records checks", async () => {
    root = await mkdtemp(join(tmpdir(), "flavor-eval-test-"));
    const fixture = join(root, "fixture");
    await mkdir(fixture);
    await writeFile(join(fixture, "README.md"), "fixture", "utf-8");
    const suitePath = join(root, "suite.json");
    await writeFile(suitePath, JSON.stringify({
      id: "local-smoke",
      prompt: "Reply done.",
      fixture: "fixture",
      maxDurationMs: 5000,
      checks: [{ command: "node -e \"process.exit(0)\"" }],
    }), "utf-8");

    server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "done" }, finish_reason: "stop" }], usage: { prompt_tokens: 4, completion_tokens: 1 } })}\n\n`);
      response.end("data: [DONE]\n\n");
    });
    await new Promise<void>((resolvePromise) => server?.listen(0, "127.0.0.1", resolvePromise));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server did not bind");

    const report = await runEvalSuite(suitePath, {
      cwd: root,
      config: {
        model: "openai:fake",
        profile: "minimal",
        openai: { apiKey: "test", baseURL: `http://127.0.0.1:${address.port}/v1`, model: "fake" },
      },
    });
    expect(report, JSON.stringify(report, null, 2)).toMatchObject({ passed: true, passRate: 1 });
    expect(report.results[0]).toMatchObject({ id: "local-smoke", passed: true, inputTokens: 4, outputTokens: 1 });
    expect(report.results[0]?.checks[0]?.passed).toBe(true);
  });
});
