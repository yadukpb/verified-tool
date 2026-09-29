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
  /** How long a request to this tool can stay in flight; see DefineToolOptions.maxInFlightMs. Unset: "not found" is never trusted. */
  maxInFlightMs?: number;
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
  /**
   * How long the gateway keeps waiting on an upstream call before giving up
   * on it. A timeout is ambiguous: the call may still commit. Default 10 minutes.
   */
  timeoutMs?: number;
  /**
   * How long the agent waits for an answer. If the upstream call is still
   * running by then, the agent is told it's in progress and to call again
   * later with the same key or arguments. The gateway keeps the request (it
   * isn't abandoned or re-sent) and records its real outcome when it
   * arrives, which the next call returns. Default 25s, under typical client
   * timeouts.
   */
  respondWithinMs?: number;
  /** Default: in memory, i.e. for the lifetime of this proxy process (one client session over stdio). */
  store?: EffectStore;
  /** How the marker is written into the `marker` argument. Default "\n\n<!-- {marker} -->". */
  markerTemplate?: string;
  /**
   * Name of the optional idempotency-key argument added to every protected
   * tool, or false to add none. Default "idempotency_key". When the agent
   * passes one, it is the effect's identity: a retry with the same key never
   * runs twice, even if the agent rewords the other arguments. The key is
   * removed before forwarding, unless the server's own schema defines it.
   */
  idempotencyKeyParam?: string | false;
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

const ARGS_META = "verified-tool/args";

const keyDescription = (param: string) =>
  `Optional. A unique key you choose for this action, e.g. "refund-order-7". ` +
  `If a call times out or its result is unclear, call again with the same ${param}: the action will not run twice, ` +
  `and you will get its real result. Use a new key for a new action.`;

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
  const timeout = options.timeoutMs ?? 600_000;
  const respondWithinMs = options.respondWithinMs ?? 25_000;
  const markerTemplate = options.markerTemplate ?? "\n\n<!-- {marker} -->";
  const markerFor = (key: string) => `verified-tool:${key}`;
  const keyParam = options.idempotencyKeyParam === undefined ? "idempotency_key" : options.idempotencyKeyParam;

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
  const toolNamed = async (name: string) => (await (toolList ??= listAll())).find((t) => t.name === name);

  const isProtected = (tool: Tool | undefined, name: string) => {
    const configured = options.tools?.[name];
    if (configured === "passthrough") return false;
    if (configured) return true;
    return !(tool?.annotations?.readOnlyHint || options.default === "passthrough");
  };
  const declaresKey = (tool: Tool | undefined) =>
    !!keyParam && !!(tool?.inputSchema.properties as Args | undefined)?.[keyParam];

  const protectedTools = new Map<string, (args: Args) => Promise<CallToolResult>>();

  function protect(name: string, policy: ProtectPolicy, idempotent: boolean, nativeKey: boolean) {
    const errorResults = new WeakMap<Args, CallToolResult>();
    const agentKeys = new WeakMap<Args, string>();

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
        // Remember what this effect was, so a reused key with different arguments can be refused.
        return { ...result, _meta: { ...result._meta, [ARGS_META]: digest(args) } };
      },
      {
        name,
        store,
        effectKey: (args) => {
          const agentKey = agentKeys.get(args);
          if (agentKey) return `mcp:${name}:key:${digest(agentKey)}`;
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
        maxInFlightMs: policy.maxInFlightMs,
        // The agent decides whether to try again after a real failure; only retry here when repeating is harmless.
        maxExecutions: idempotent ? 2 : 1,
        poll: { attempts: 3, delayMs: 300 },
        onEscalate: options.onEscalate,
        trace: options.trace,
      }
    );

    const clean = (r: CallToolResult | undefined): CallToolResult => {
      if (!r?._meta || !(ARGS_META in r._meta)) return r ?? { content: [] };
      const { [ARGS_META]: _, ...meta } = r._meta;
      return { ...r, _meta: Object.keys(meta).length ? meta : undefined };
    };

    return async (args: Args): Promise<CallToolResult> => {
      const raw = keyParam ? args[keyParam] : undefined;
      const agentKey = typeof raw === "string" && raw !== "" ? raw : undefined;
      const callArgs: Args = { ...args };
      if (keyParam && !nativeKey) delete callArgs[keyParam];
      if (agentKey) agentKeys.set(callArgs, agentKey);

      const stillRunning = () =>
        note(
          `${name} is still running. It has not been sent twice and will not be. ` +
            `Call ${name} again later with the same ${agentKey ? `${keyParam} "${agentKey}"` : "arguments"} to get its result. ` +
            `Don't tell the user it's done yet.`
        );

      // Answer the agent in time, but never abandon the upstream request: it
      // keeps running, holds its claim, and records its real outcome.
      const pending = tool(callArgs);
      let timer: ReturnType<typeof setTimeout> | undefined;
      const slow = new Promise<"slow">((resolve) => {
        timer = setTimeout(() => resolve("slow"), respondWithinMs);
        (timer as { unref?: () => void }).unref?.();
      });
      const first = await Promise.race([pending, slow]);
      clearTimeout(timer);
      if (first === "slow") {
        pending.catch(() => {}); // settles the store on its own; nobody is waiting on it here
        return stillRunning();
      }

      const r: ToolCallResult<CallToolResult> = first;
      switch (r.reason) {
        case "in_flight":
          return stillRunning();
        case "verified":
        case "trusted":
          return clean(r.result);
        case "cached": {
          const recorded = r.result?._meta?.[ARGS_META];
          if (agentKey && recorded !== undefined && recorded !== digest(callArgs)) {
            return note(
              `${keyParam} "${agentKey}" was already used for a different ${name} request, so nothing was done. Use a new ${keyParam} for a new action.`,
              true
            );
          }
          const how = agentKey ? `with ${keyParam} "${agentKey}"` : "with these arguments";
          return {
            ...clean(r.result),
            content: [
              { type: "text", text: `${name} was already completed earlier ${how}, so it was not repeated. The original result follows.` },
              ...(r.result?.content ?? []),
            ],
          };
        }
        case "failed":
        case "exhausted":
          return errorResults.get(callArgs) ?? note(describeOutcome(r, name), true);
        default:
          return note(describeOutcome({ ...r, result: undefined }, name), r.outcome !== "verified");
      }
    };
  }

  async function handlerFor(name: string) {
    const tool = await toolNamed(name);
    if (!isProtected(tool, name)) return undefined;
    let handler = protectedTools.get(name);
    if (!handler) {
      const configured = options.tools?.[name];
      const policy = configured && configured !== "passthrough" ? configured : {};
      handler = protect(name, policy, policy.idempotent ?? tool?.annotations?.idempotentHint === true, declaresKey(tool));
      protectedTools.set(name, handler);
    }
    return handler;
  }

  /** Offer an idempotency key on every protected tool that doesn't already have one. */
  const withKeyParam = (tool: Tool): Tool => {
    if (!keyParam || !isProtected(tool, tool.name) || declaresKey(tool)) return tool;
    return {
      ...tool,
      inputSchema: {
        ...tool.inputSchema,
        properties: { ...tool.inputSchema.properties, [keyParam]: { type: "string", description: keyDescription(keyParam) } },
      },
    };
  };

  const server = new Server({ name: "verified-tool-mcp-proxy", version: "0.3.0" }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async (request) => {
    const page = await upstream.listTools(request.params);
    toolList = undefined; // the tool set may have changed; re-read annotations lazily
    return { ...page, tools: page.tools.map(withKeyParam) };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args = {} } = request.params;
    const handler = await handlerFor(name);
    if (!handler) return (await upstream.callTool({ name, arguments: args }, undefined, { timeout })) as CallToolResult;
    return handler(args);
  });

  return server;
}
