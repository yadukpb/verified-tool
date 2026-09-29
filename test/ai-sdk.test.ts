// Runs the adapter inside a real AI SDK agent loop (generateText with tool
// calls), with a scripted model that behaves like the one measured in
// langchain-ai/langgraph#8464: after an error it re-sends the same call.
import { generateText, stepCountIs, tool } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { withVerification } from "../src/ai-sdk.js";
import { createMemoryStore } from "../src/index.js";
import { FakeStripe } from "../examples/fake-stripe.js";

const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 5, text: 5, reasoning: 0 },
};

/** Calls charge_card, then (whatever it was told) calls it again with a new call id, then answers. */
function resendingModel() {
  const results = new Map<string, string>(); // toolCallId -> output; each prompt repeats earlier results
  let step = 0;
  const model = new MockLanguageModelV4({
    doGenerate: async ({ prompt }) => {
      for (const m of prompt) {
        if (m.role !== "tool") continue;
        for (const part of m.content) if (part.type === "tool-result") results.set(part.toolCallId, JSON.stringify(part.output));
      }
      step += 1;
      if (step <= 2) {
        return {
          content: [{ type: "tool-call", toolCallId: `call_${step}`, toolName: "charge_card", input: JSON.stringify({ orderId: "o988", amountCents: 1200 }) }],
          finishReason: { unified: "tool-calls", raw: "tool_use" },
          usage,
          warnings: [],
        };
      }
      return { content: [{ type: "text", text: "Done." }], finishReason: { unified: "stop", raw: "end_turn" }, usage, warnings: [] };
    },
  });
  return { model, seenToolResults: () => [...results.values()] };
}

const inputSchema = z.object({ orderId: z.string(), amountCents: z.number() });

describe("AI SDK agent loop", () => {
  it("baseline: a plain tool double charges when the model re-sends after a lost response", async () => {
    const stripe = new FakeStripe();
    stripe.faults = ["lost_response"];
    const { model } = resendingModel();
    await generateText({
      model,
      prompt: "Charge order o988 £12",
      stopWhen: stepCountIs(5),
      tools: { charge_card: tool({ inputSchema, execute: (input) => stripe.createCharge(input) }) },
    });
    expect(stripe.countCharges("o988")).toBe(2);
  });

  it("withVerification: one charge, and the model is told not to repeat it", async () => {
    const stripe = new FakeStripe();
    stripe.faults = ["lost_response"];
    const { model, seenToolResults } = resendingModel();
    const toolCallIds: string[] = [];

    const charge_card = withVerification(
      tool({
        inputSchema,
        execute: (input, { toolCallId }) => {
          toolCallIds.push(toolCallId);
          return stripe.createCharge(input);
        },
      }),
      {
        name: "charge_card",
        effectKey: (input) => `charge:${input.orderId}`,
        store: createMemoryStore(),
        reconcile: async ({ args }) => {
          const [found] = await stripe.searchByOrder(args.orderId);
          return found ? { outcome: "verified", result: found } : { outcome: "failed" };
        },
      }
    );

    await generateText({ model, prompt: "Charge order o988 £12", stopWhen: stepCountIs(5), tools: { charge_card } });

    expect(stripe.countCharges("o988")).toBe(1);
    expect(toolCallIds).toEqual(["call_1"]); // AI SDK call options reach execute; the re-send never executed
    const [first, second] = seenToolResults();
    expect(first).toMatch(/"reason":"reconciled"/);
    expect(first).toMatch(/Do not repeat it/);
    expect(second).toMatch(/"reason":"cached"/);
  });

  it("keeps the rest of the tool definition", () => {
    const t = withVerification(tool({ description: "Charge a card", inputSchema, execute: async () => ({}) }), { name: "c" });
    expect(t.description).toBe("Charge a card");
    expect(t.inputSchema).toBe(inputSchema);
  });
});
