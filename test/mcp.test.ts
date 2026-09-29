import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";
import { createVerifiedMcpProxy, type VerifiedMcpProxyOptions } from "../src/mcp.js";
import { createFakeGitHubMcp } from "./fixtures/fake-github-mcp.js";

const TIMEOUT = 150;
const text = (r: unknown) => (r as CallToolResult).content.map((c) => (c.type === "text" ? c.text : "")).join("\n");

async function connect(server: { connect(t: InMemoryTransport): Promise<void> }) {
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "1" });
  await Promise.all([server.connect(a), client.connect(b)]);
  return client;
}

/** agent -> proxy -> fake GitHub, all in memory. */
async function setup(options: VerifiedMcpProxyOptions = {}) {
  const gh = createFakeGitHubMcp();
  const upstream = await connect(gh.server);
  const agent = await connect(createVerifiedMcpProxy(upstream, { timeoutMs: TIMEOUT, ...options }));
  return { gh, agent };
}

const issue = { title: "Checkout 500s", body: "Error rate above 5%." };
const withReconcile: VerifiedMcpProxyOptions = {
  tools: { create_issue: { marker: "body", reconcile: { tool: "list_issues" } } },
};

describe("MCP proxy", () => {
  it("baseline: without the proxy, an agent re-sending after a timeout opens a duplicate", async () => {
    const gh = createFakeGitHubMcp();
    const agent = await connect(gh.server);
    gh.faults.push("hang");
    await expect(agent.callTool({ name: "create_issue", arguments: issue }, undefined, { timeout: TIMEOUT })).rejects.toThrow(/timed out/i);
    await agent.callTool({ name: "create_issue", arguments: issue });
    expect(gh.issues).toHaveLength(2);
  });

  it("zero config: after a timeout, identical re-sends are blocked and the agent is told not to retry", async () => {
    const { gh, agent } = await setup();
    gh.faults.push("hang");

    const first = await agent.callTool({ name: "create_issue", arguments: issue });
    const again = await agent.callTool({ name: "create_issue", arguments: issue });

    expect(first.isError).toBe(true);
    expect(text(first)).toMatch(/not known whether create_issue took effect\. Do not retry it/);
    expect(text(again)).toMatch(/Do not retry it/);
    expect(gh.issues).toHaveLength(1);
  });

  it("zero config: an identical call after success returns the original result instead of running again", async () => {
    const { gh, agent } = await setup();
    await agent.callTool({ name: "create_issue", arguments: issue });
    const again = await agent.callTool({ name: "create_issue", arguments: issue });

    expect(text(again)).toMatch(/already completed earlier.*not repeated/);
    expect(text(again)).toMatch(/Created issue #1/);
    expect(gh.issues).toHaveLength(1);
  });

  it("zero config: a call with different arguments is a new effect", async () => {
    const { gh, agent } = await setup();
    await agent.callTool({ name: "create_issue", arguments: issue });
    await agent.callTool({ name: "create_issue", arguments: { ...issue, title: "Search is slow" } });
    expect(gh.issues).toHaveLength(2);
  });

  it("with a marker and a reconcile tool: finds the issue after the timeout and reports success", async () => {
    const { gh, agent } = await setup(withReconcile);
    gh.faults.push("hang");

    const r = await agent.callTool({ name: "create_issue", arguments: issue });

    expect(r.isError).toBe(false);
    expect(text(r)).toMatch(/create_issue succeeded\. The first response was lost/);
    expect(gh.issues).toHaveLength(1);
    expect(gh.issues[0].body).toMatch(/<!-- verified-tool:mcp:create_issue:[0-9a-f]{32} -->$/);
  });

  it("effectKey names the arguments that identify the effect: same title, reworded body, still one issue", async () => {
    const { gh, agent } = await setup({ tools: { create_issue: { effectKey: ["title"] } } });
    await agent.callTool({ name: "create_issue", arguments: issue });
    const again = await agent.callTool({ name: "create_issue", arguments: { ...issue, body: "Reworded by the model." } });

    expect(text(again)).toMatch(/already completed earlier/);
    expect(gh.issues).toHaveLength(1);
  });

  it("read-only tools pass straight through", async () => {
    const { agent } = await setup();
    const a = await agent.callTool({ name: "list_issues", arguments: {} });
    const b = await agent.callTool({ name: "list_issues", arguments: {} });
    expect(text(a)).toBe("[]");
    expect(text(b)).toBe("[]");
  });

  it("tools annotated idempotentHint are retried after a timeout, since repeating is harmless", async () => {
    const { gh, agent } = await setup({ tools: { _fault: "passthrough" } });
    await agent.callTool({ name: "create_issue", arguments: issue });
    gh.faults.push("hang");

    const r = await agent.callTool({ name: "add_label", arguments: { number: 1, label: "incident" } });

    expect(r.isError).toBeFalsy();
    expect(text(r)).toBe("Labelled #1 incident");
    expect(gh.issues[0].labels).toEqual(["incident"]);
  });

  it("errorResults 'failed': the server's own error is returned and the agent may retry", async () => {
    const { gh, agent } = await setup({ tools: { create_issue: { errorResults: "failed" } } });
    gh.faults.push("reject");

    const first = await agent.callTool({ name: "create_issue", arguments: issue });
    const retry = await agent.callTool({ name: "create_issue", arguments: issue });

    expect(first.isError).toBe(true);
    expect(text(first)).toBe("422: title is too long");
    expect(text(retry)).toBe("Created issue #1");
  });

  it("lists every upstream tool, offering idempotency_key only on write tools that don't already have one", async () => {
    const { agent } = await setup({ tools: { _fault: "passthrough", _count: "passthrough" } });
    const { tools } = await agent.listTools();
    const hasKey = Object.fromEntries(tools.map((t) => [t.name, "idempotency_key" in (t.inputSchema.properties ?? {})]));

    expect(Object.keys(hasKey).sort()).toEqual(["_count", "_fault", "add_label", "create_issue", "create_ticket", "list_issues"]);
    expect(hasKey).toMatchObject({ create_issue: true, add_label: true, list_issues: false, _fault: false, _count: false });
    const createIssue = tools.find((t) => t.name === "create_issue")!;
    expect((createIssue.inputSchema.properties as any).idempotency_key.description).toMatch(/call again with the same idempotency_key/);
    expect(createIssue.inputSchema.required).toEqual(["title", "body"]); // the key stays optional
  });
});

describe("MCP proxy: idempotency keys", () => {
  it("a retry with the same key after a timeout is blocked even when the agent rewords the arguments", async () => {
    const { gh, agent } = await setup();
    gh.faults.push("hang");

    await agent.callTool({ name: "create_issue", arguments: { ...issue, idempotency_key: "inc-42" } });
    const reworded = await agent.callTool({
      name: "create_issue",
      arguments: { title: "Checkout returning 500", body: "Rewritten by the model.", idempotency_key: "inc-42" },
    });

    expect(text(reworded)).toMatch(/Do not retry it/);
    expect(gh.issues).toHaveLength(1);
  });

  it("without a key, the same reworded retry would be a second issue", async () => {
    const { gh, agent } = await setup();
    gh.faults.push("hang");

    await agent.callTool({ name: "create_issue", arguments: issue });
    await agent.callTool({ name: "create_issue", arguments: { title: "Checkout returning 500", body: "Rewritten by the model." } });

    expect(gh.issues).toHaveLength(2);
  });

  it("the same key and arguments after success return the original result", async () => {
    const { gh, agent } = await setup();
    await agent.callTool({ name: "create_issue", arguments: { ...issue, idempotency_key: "k1" } });
    const again = await agent.callTool({ name: "create_issue", arguments: { ...issue, idempotency_key: "k1" } });

    expect(text(again)).toMatch(/already completed earlier with idempotency_key "k1"/);
    expect(text(again)).toMatch(/Created issue #1/);
    expect(again._meta?.["verified-tool/args"]).toBeUndefined();
    expect(gh.issues).toHaveLength(1);
  });

  it("reusing a key for a different request is refused, like Stripe does", async () => {
    const { gh, agent } = await setup();
    await agent.callTool({ name: "create_issue", arguments: { ...issue, idempotency_key: "k1" } });
    const misuse = await agent.callTool({ name: "create_issue", arguments: { title: "Unrelated", body: "x", idempotency_key: "k1" } });

    expect(misuse.isError).toBe(true);
    expect(text(misuse)).toMatch(/already used for a different create_issue request/);
    expect(gh.issues).toHaveLength(1);
  });

  it("strips the key before forwarding to a server that doesn't know it", async () => {
    const gh = createFakeGitHubMcp();
    const upstream = await connect(gh.server);
    const forwarded: unknown[] = [];
    const callTool = upstream.callTool.bind(upstream);
    upstream.callTool = ((params: { arguments?: unknown }, ...rest: never[]) => {
      forwarded.push(params.arguments);
      return callTool(params as never, ...rest);
    }) as typeof upstream.callTool;
    const agent = await connect(createVerifiedMcpProxy(upstream));

    await agent.callTool({ name: "create_issue", arguments: { ...issue, idempotency_key: "k1" } });
    expect(forwarded).toEqual([issue]);
  });

  it("forwards the key untouched to a server whose schema already defines it", async () => {
    const { agent } = await setup();
    const { tools } = await agent.listTools();
    const ticket = tools.find((t) => t.name === "create_ticket")!;

    const r = await agent.callTool({ name: "create_ticket", arguments: { title: "Refund", idempotency_key: "t-1" } });
    expect(text(r)).toBe("Ticket #1 key=t-1");
    expect((ticket.inputSchema.properties as any).idempotency_key.description).toBeUndefined(); // the server's own definition, not ours
  });
});

describe("verified-tool-mcp CLI over stdio", () => {
  it("wraps a real MCP server process: timeout, reconcile, no duplicate", async () => {
    const root = fileURLToPath(new URL("..", import.meta.url));
    const config = join(mkdtempSync(join(tmpdir(), "vt-mcp-")), "policy.json");
    writeFileSync(
      config,
      JSON.stringify({ ...withReconcile, timeoutMs: 300, tools: { ...withReconcile.tools, _fault: "passthrough", _count: "passthrough" } })
    );

    const agent = new Client({ name: "agent", version: "1" });
    await agent.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: ["--import", "tsx", "src/mcp-cli.ts", "--config", config, "--", process.execPath, "--import", "tsx", "test/fixtures/fake-github-mcp.ts", "--stdio"],
        cwd: root,
        stderr: "pipe",
      })
    );

    await agent.callTool({ name: "_fault", arguments: { kind: "hang" } });
    const r = await agent.callTool({ name: "create_issue", arguments: issue });
    const again = await agent.callTool({ name: "create_issue", arguments: issue });
    const count = await agent.callTool({ name: "_count", arguments: { title: issue.title } });
    await agent.close();

    expect(text(r)).toMatch(/succeeded\. The first response was lost/);
    expect(text(again)).toMatch(/already completed earlier/);
    expect(text(count)).toBe("1");
  }, 20_000);
});
