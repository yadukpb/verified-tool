/**
 * A stand-in for a transactional email provider. There is no API to ask
 * "did this send?": the only way to learn the outcome is a webhook, which
 * arrives later and echoes back the metadata you attached (SendGrid calls
 * this custom_args, Postmark calls it Metadata).
 */

export class MailerTimeoutError extends Error {
  name = "MailerTimeoutError";
}

export interface WebhookEvent {
  type: "delivered" | "bounced";
  messageId: string;
  metadata: Record<string, string>;
}

export class FakeMailer {
  faults: "lost_response"[] = [];
  sent: { messageId: string; to: string; subject: string }[] = [];
  private listeners: ((e: WebhookEvent) => void)[] = [];

  constructor(private readonly webhookDelayMs = 300) {}

  onWebhook(listener: (e: WebhookEvent) => void) {
    this.listeners.push(listener);
  }

  async send(p: { to: string; subject: string; body: string; metadata: Record<string, string>; bounce?: boolean }) {
    const fault = this.faults.shift();
    const messageId = `msg_${this.sent.length + 1}`;
    this.sent.push({ messageId, to: p.to, subject: p.subject });
    setTimeout(() => {
      const event: WebhookEvent = { type: p.bounce ? "bounced" : "delivered", messageId, metadata: p.metadata };
      for (const l of this.listeners) l(event);
    }, this.webhookDelayMs);
    if (fault === "lost_response") throw new MailerTimeoutError("POST /mail/send timed out");
    return { messageId, accepted: true };
  }

  count(to: string, subject: string): number {
    return this.sent.filter((m) => m.to === to && m.subject === subject).length;
  }
}
