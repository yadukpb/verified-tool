#!/usr/bin/env node
// verified-tool-mcp [--config policy.json] -- <upstream server command> [args...]
// Runs the upstream MCP server as a child process and serves a protected copy of it over stdio.
import { readFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createVerifiedMcpProxy, type VerifiedMcpProxyOptions } from "./mcp.js";

const argv = process.argv.slice(2);
const split = argv.indexOf("--");
if (split === -1 || split === argv.length - 1) {
  process.stderr.write("usage: verified-tool-mcp [--config policy.json] -- <command> [args...]\n");
  process.exit(2);
}

const own = argv.slice(0, split);
const [command, ...args] = argv.slice(split + 1);
const configAt = own.indexOf("--config");
const config: VerifiedMcpProxyOptions = configAt === -1 ? {} : JSON.parse(readFileSync(own[configAt + 1], "utf8"));

// stdout carries the protocol, so anything human-readable goes to stderr.
const log = (line: string) => process.stderr.write(`[verified-tool] ${line}\n`);

const upstream = new Client({ name: "verified-tool-mcp", version: "0.3.0" });
await upstream.connect(
  new StdioClientTransport({ command, args, env: process.env as Record<string, string>, stderr: "inherit" })
);

const server = createVerifiedMcpProxy(upstream, {
  ...config,
  onEscalate: (ctx) => {
    log(`outcome unknown for ${ctx.toolName} ${JSON.stringify(ctx.args)}; not retried`);
  },
});
await server.connect(new StdioServerTransport());

const shutdown = async () => {
  await upstream.close().catch(() => {});
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
server.onclose = shutdown;
