import { describe, expect, it, vi } from "vitest";
import { defineTool } from "../src/index.js";
import { EscalatedError, ToolFailedError } from "../src/types.js";

describe("defineTool", () => {
  it("returns verified when verify() confirms success", async () => {
    const tool = defineTool(async (args: { id: string }) => ({ id: args.id, sent: true }), {
      name: "test",
      verify: async () => "verified",
    });

    const result = await tool({ id: "1" });
    expect(result.ok).toBe(true);
    expect(result.outcome).toBe("verified");
    expect(result.attempts).toBe(1);
  });

  it("defaults to verified when no verify() is given (explicit tradeoff, not silent)", async () => {
    const tool = defineTool(async () => ({ done: true }), { name: "test" });
    const result = await tool(undefined as never);
    expect(result.outcome).toBe("verified");
  });

  it("retries on failed and eventually succeeds", async () => {
    let calls = 0;
    const tool = defineTool(
      async () => {
        calls += 1;
        return { ok: calls >= 2 };
      },
      {
        name: "test",
        maxRetries: 2,
        verify: async (result) => (result.ok ? "verified" : "failed"),
      }
    );

    const result = await tool(undefined as never);
    expect(result.outcome).toBe("verified");
    expect(calls).toBe(2);
  });

  it("throws ToolFailedError when retries are exhausted on failed", async () => {
    const tool = defineTool(async () => ({ ok: false }), {
      name: "test",
      maxRetries: 1,
      verify: async () => "failed",
    });

    await expect(tool(undefined as never)).rejects.toThrow(ToolFailedError);
  });

  it("escalates on unknown by default instead of guessing", async () => {
    const onEscalate = vi.fn();
    const tool = defineTool(async () => ({}), {
      name: "test",
      maxRetries: 0,
      verify: async () => "unknown",
      onEscalate,
    });

    const result = await tool(undefined as never);
    expect(result.ok).toBe(false);
    expect(result.outcome).toBe("unknown");
    expect(result.escalated).toBe(true);
    expect(onEscalate).toHaveBeenCalledOnce();
  });

  it("retries on unknown when policy.unknown is 'retry'", async () => {
    let calls = 0;
    const tool = defineTool(
      async () => {
        calls += 1;
        return { settled: calls >= 3 };
      },
      {
        name: "test",
        maxRetries: 3,
        policy: { unknown: "retry" },
        verify: async (result) => (result.settled ? "verified" : "unknown"),
      }
    );

    const result = await tool(undefined as never);
    expect(result.outcome).toBe("verified");
    expect(calls).toBe(3);
  });

  it("never re-runs a verified call for the same idempotency key", async () => {
    const fn = vi.fn(async (args: { orderId: string }) => ({ orderId: args.orderId }));
    const tool = defineTool(fn, {
      name: "test",
      idempotencyKey: (args) => args.orderId,
      verify: async () => "verified",
    });

    await tool({ orderId: "abc" });
    const second = await tool({ orderId: "abc" });

    expect(fn).toHaveBeenCalledOnce();
    expect(second.attempts).toBe(0);
    expect(second.outcome).toBe("verified");
  });

  it("treats a schema parse failure as a failed outcome", async () => {
    const tool = defineTool(async () => ({ unexpected: "shape" }), {
      name: "test",
      maxRetries: 0,
      schema: {
        parse: () => {
          throw new Error("bad shape");
        },
      },
    });

    await expect(tool(undefined as never)).rejects.toThrow(ToolFailedError);
  });

  it("treats a thrown error from fn() as a failed outcome, not a crash", async () => {
    const tool = defineTool(
      async () => {
        throw new Error("network blew up");
      },
      { name: "test", maxRetries: 0 }
    );

    await expect(tool(undefined as never)).rejects.toThrow(ToolFailedError);
  });

  it("throws EscalatedError when unknownPolicy is 'retry' and it's still unknown after retries", async () => {
    const tool = defineTool(async () => ({}), {
      name: "test",
      maxRetries: 1,
      policy: { unknown: "retry" },
      verify: async () => "unknown",
    });

    await expect(tool(undefined as never)).rejects.toThrow(EscalatedError);
  });
});
