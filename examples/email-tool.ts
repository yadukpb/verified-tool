// Side effect you can't check at all: sending an email through a provider
// with no "did this send?" API. There is no honest reconcile() to write, so
// there isn't one. A lost response ends as "unknown", the effect stays
// blocked (no second email), and the provider's webhook settles it later.
// The same pattern fits SMS, push notifications, and outbound webhooks.
import { defineTool, settleOnEvent, type DefineToolOptions, type EffectStore } from "../src/index.js";
import type { FakeMailer, WebhookEvent } from "./fake-mailer.js";

export interface EmailArgs {
  refId: string;
  to: string;
  subject: string;
  body: string;
  bounce?: boolean;
}

export function makeEmailTool(
  mailer: FakeMailer,
  store: EffectStore,
  overrides: Partial<DefineToolOptions<EmailArgs, { messageId: string }>> = {}
) {
  return defineTool<EmailArgs, { messageId: string }>(
    // Attach the effect key as metadata so the webhook can say which effect it's about.
    (args, ctx) => mailer.send({ ...args, metadata: { effectKey: ctx.effectKey! } }),
    {
      name: "send_email",
      effectKey: (args) => `email:${args.refId}:${args.to}`,
      store,
      ...overrides,
    }
  );
}

/** Your webhook endpoint: turns the provider's delivery events into settled effects. */
export function settleFromWebhooks(mailer: FakeMailer, store: EffectStore) {
  const settle = settleOnEvent<WebhookEvent>(store, {
    effectKey: (e) => e.metadata.effectKey,
    outcome: (e) => (e.type === "delivered" ? "verified" : "failed"),
    result: (e) => ({ messageId: e.messageId }),
  });
  mailer.onWebhook((event) => void settle(event));
}
