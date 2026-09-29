// A small MCP server shaped like a GitHub MCP server, with fault injection.
// Imported directly by tests (in-memory transport), or run with --stdio.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

export type Fault = "hang" | "reject" | "slow";
const SLOW_MS = 300;

export function createFakeGitHubMcp() {
  const issues: { number: number; title: string; body: string; labels: string[] }[] = [];
  const faults: Fault[] = [];
  const hang = () => new Promise(() => {});
  const server = new McpServer({ name: "fake-github", version: "1.0.0" });

  server.registerTool(
    "create_issue",
    {
      description: "Open an issue",
      inputSchema: { title: z.string(), body: z.string() },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async ({ title, body }) => {
      const fault = faults.shift();
      if (fault === "reject") return { content: [{ type: "text", text: "422: title is too long" }], isError: true };
      if (fault === "slow") await new Promise((r) => setTimeout(r, SLOW_MS)); // commits late, then answers
      const issue = { number: issues.length + 1, title, body, labels: [] };
      issues.push(issue);
      if (fault === "hang") await hang(); // created, but the response never arrives
      return { content: [{ type: "text", text: `Created issue #${issue.number}` }] };
    }
  );

  server.registerTool(
    "list_issues",
    { description: "List issues", inputSchema: {}, annotations: { readOnlyHint: true } },
    async () => ({ content: [{ type: "text", text: JSON.stringify(issues) }] })
  );

  server.registerTool(
    "add_label",
    {
      description: "Add a label to an issue (adding it twice has no extra effect)",
      inputSchema: { number: z.number(), label: z.string() },
      annotations: { readOnlyHint: false, idempotentHint: true },
    },
    async ({ number, label }) => {
      const fault = faults.shift();
      const issue = issues.find((i) => i.number === number);
      if (!issue) return { content: [{ type: "text", text: "404" }], isError: true };
      if (!issue.labels.includes(label)) issue.labels.push(label);
      if (fault === "hang") await hang();
      return { content: [{ type: "text", text: `Labelled #${number} ${label}` }] };
    }
  );

  // A tool whose server already supports idempotency keys natively.
  const nativeSeen = new Map<string, number>();
  server.registerTool(
    "create_ticket",
    {
      description: "Open a support ticket",
      inputSchema: { title: z.string(), idempotency_key: z.string().optional() },
      annotations: { readOnlyHint: false },
    },
    async ({ title, idempotency_key }) => {
      if (idempotency_key && nativeSeen.has(idempotency_key)) {
        return { content: [{ type: "text", text: `Ticket #${nativeSeen.get(idempotency_key)} (replayed)` }] };
      }
      const issue = { number: issues.length + 1, title, body: "", labels: [] };
      issues.push(issue);
      if (idempotency_key) nativeSeen.set(idempotency_key, issue.number);
      return { content: [{ type: "text", text: `Ticket #${issue.number} key=${idempotency_key ?? "none"}` }] };
    }
  );

  // Test control; configure the proxy to pass it through.
  server.registerTool(
    "_fault",
    { inputSchema: { kind: z.enum(["hang", "reject", "slow"]) } },
    async ({ kind }) => {
      faults.push(kind);
      return { content: [{ type: "text", text: "ok" }] };
    }
  );
  server.registerTool("_count", { inputSchema: { title: z.string() } }, async ({ title }) => ({
    content: [{ type: "text", text: String(issues.filter((i) => i.title === title).length) }],
  }));

  return { server, issues, faults };
}

if (process.argv.includes("--stdio")) {
  await createFakeGitHubMcp().server.connect(new StdioServerTransport());
}
