import { createHash } from "node:crypto";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
  type CallToolResult,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { defineTool } from "./defineTool.js";
import { describeOutcome } from "./describe.js";
import { createMemoryStore } from "./stores.js";
import type { EffectStore, EscalationContext, ToolCallResult, TraceEvent } from "./types.js";

type Args = Record<string, unknown>;

export interface ProtectPolicy {
  /**
   * Argument names that identify the effect. Default: all arguments, so an
   * identical call is a duplicate and any change makes it a new effect.
   */
  effectKey?: string[];
  /** A string argument to append the marker to, so `reconcile` can find what was created. */
  marker?: string;
  /**
   * A read tool on the same server to call after a lost response. The effect
   * counts as done if the marker appears in its output. `{name}` in args is
   * replaced with that argument of the original call. Needs `marker`.
   */
  reconcile?: { tool: string; args?: Args };
  /**
   * How to read a result with isError: true. "ambiguous" (default) assumes
   * the tool may have acted before failing. "failed" trusts the server that
   * nothing happened, returns its error, and lets the agent retry.
   */
  errorResults?: "ambiguous" | "failed";
  /** Override the tool's idempotentHint annotation. */
  idempotent?: boolean;
}

export type ToolPolicy = "passthrough" | ProtectPolicy;

export interface VerifiedMcpProxyOptions {
  /** Per-tool policy by name. */
  tools?: Record<string, ToolPolicy>;
  /**
   * For tools with no policy that aren't annotated readOnlyHint. Default
   * "protect": identical calls run once, and an ambiguous failure blocks
   * repeats instead of letting the agent send them again.
   */
  default?: "protect" | "passthrough";
  /** Upstream call timeout; a timeout is treated as ambiguous. Default 60s. */
  timeoutMs?: number;
  /** Default: in memory, i.e. for the lifetime of this proxy process (one client session over stdio). */
  store?: EffectStore;
  /** How the marker is written into the `marker` argument. Default "\n\n<!-- {marker} -->". */
  markerTemplate?: string;
  onEscalate?: (ctx: EscalationContext<Args, CallToolResult>) => void | Promise<void>;
  trace?: (event: TraceEvent) => void;
}

class ToolErrorResult extends Error {
  constructor(readonly result: CallToolResult) {
    super("tool returned isError");
  }
}

// JSON-RPC errors that mean the server rejected the request before running the tool.
const REJECTED_BEFORE_RUNNING = new Set<number>([ErrorCode.InvalidParams, ErrorCode.MethodNotFound, ErrorCode.InvalidRequest]);

const canonical = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(canonical)
    : value && typeof value === "object"
      ? Object.fromEntries(Object.keys(value).sort().map((k) => [k, canonical((value as Args)[k])]))
      : value;

const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex").slice(0, 32);

const textOf = (r: CallToolResult) =>
  r.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("\n");

const fill = (template: Args | undefined, args: Args): Args =>
  JSON.parse(
    JSON.stringify(template ?? {}, (_k, v) =>
      typeof v === "string" ? v.replace(/\{(\w+)\}/g, (m, name) => (name in args ? String(args[name]) : m)) : v
    )
  );

const note = (text: string, isError = false): CallToolResult => ({ content: [{ type: "text", text }], isError });

/**
 * An MCP server that forwards to `upstream` and protects its write tools.
 * Read-only tools (readOnlyHint) pass through untouched. Every other tool
 * runs through defineTool: an identical call runs once, a timeout or
 * ambiguous error is reconciled (if configured) or reported as unknown with
 * an explicit "do not retry" to the model, and tools annotated
 * idempotentHint are retried after a timeout since repeating them is safe.
 */
export function createVerifiedMcpProxy(upstream: Client, options: VerifiedMcpProxyOptions = {}): Server {
  const store = options.store ?? createMemoryStore();
  const timeout = options.timeoutMs ?? 60_000;
  const markerTemplate = options.markerTemplate ?? "\n\n<!-- {marker} -->";
  const markerFor = (key: string) => `verified-tool:${key}`;

  let toolList: Promise<Tool[]> | undefined;
  const listAll = async () => {
    const tools: Tool[] = [];
    let cursor: string | undefined;
    do {
      const page = await upstream.listTools(cursor ? { cursor } : undefined);
      tools.push(...page.tools);
      cursor = page.nextCursor;
    } while (cursor);
    return tools;
  };
  const annotationsOf = async (name: string) => (await (toolList ??= listAll())).find((t) => t.name === name)?.annotations;

  const protectedTools = new Map<string, (args: Args) => Promise<CallToolResult>>();

  function protect(name: string, policy: ProtectPolicy, idempotent: boolean) {
    const errorResults = new WeakMap<Args, CallToolResult>();

    const tool = defineTool<Args, CallToolResult>(
      async (args, ctx) => {
        let sent = args;
        if (policy.marker && typeof args[policy.marker] === "string") {
          sent = { ...args, [policy.marker]: args[policy.marker] + markerTemplate.replace("{marker}", markerFor(ctx.effectKey!)) };
        }
        const result = (await upstream.callTool({ name, arguments: sent }, undefined, { timeout })) as CallToolResult;
        if (result.isError) {
          errorResults.set(args, result);
          throw new ToolErrorResult(result);
        }
        return result;
      },
      {
        name,
        store,
        effectKey: (args) => {
          const picked = policy.effectKey ? Object.fromEntries(policy.effectKey.map((k) => [k, args[k]])) : args;
          return `mcp:${name}:${digest(picked)}`;
        },
        classifyError: (error) => {
          if (error instanceof ToolErrorResult) return policy.errorResults === "failed" ? "not_executed" : "ambiguous";
          if (error instanceof McpError && REJECTED_BEFORE_RUNNING.has(error.code)) return "not_executed";
          return "ambiguous";
        },
        reconcile:
          policy.reconcile && policy.marker
            ? async (ctx) => {
                const r = (await upstream.callTool(
                  { name: policy.reconcile!.tool, arguments: fill(policy.reconcile!.args, ctx.args) },
                  undefined,
                  { timeout }
                )) as CallToolResult;
                if (r.isError) return { outcome: "unknown" };
                return textOf(r).includes(markerFor(ctx.effectKey!)) ? { outcome: "verified" } : { outcome: "failed" };
              }
            : undefined,
        downstreamIdempotent: idempotent,
        // The agent decides whether to try again after a real failure; only retry here when repeating is harmless.
        maxExecutions: idempotent ? 2 : 1,
        poll: { attempts: 3, delayMs: 300 },
        onEscalate: options.onEscalate,
        trace: options.trace,
      }
    );

    return async (args: Args): Promise<CallToolResult> => {
      const callArgs = { ...args };
      const r: ToolCallResult<CallToolResult> = await tool(callArgs);
      switch (r.reason) {
        case "verified":
        case "trusted":
          return r.result!;
        case "cached":
          return {
            ...r.result!,
            content: [
              { type: "text", text: `${name} was already completed earlier with these arguments, so it was not repeated. The original result follows.` },
              ...(r.result?.content ?? []),
            ],
          };
        case "failed":
        case "exhausted":
          return errorResults.get(callArgs) ?? note(describeOutcome(r, name), true);
        default:
          return note(describeOutcome({ ...r, result: undefined }, name), r.outcome !== "verified");
      }
    };
  }

  async function handlerFor(name: string) {
    const configured = options.tools?.[name];
    if (configured === "passthrough") return undefined;
    const annotations = await annotationsOf(name);
    if (!configured && (annotations?.readOnlyHint || options.default === "passthrough")) return undefined;
    let handler = protectedTools.get(name);
    if (!handler) {
      const policy = configured ?? {};
      handler = protect(name, policy, policy.idempotent ?? annotations?.idempotentHint === true);
      protectedTools.set(name, handler);
    }
    return handler;
  }

  const server = new Server({ name: "verified-tool-mcp-proxy", version: "0.3.0" }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async (request) => {
    const page = await upstream.listTools(request.params);
    toolList = undefined; // the tool set may have changed; re-read annotations lazily
    return page;
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args = {} } = request.params;
    const handler = await handlerFor(name);
    if (!handler) return (await upstream.callTool({ name, arguments: args }, undefined, { timeout })) as CallToolResult;
    return handler(args);
  });

  return server;
}
