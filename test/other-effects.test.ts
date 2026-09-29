import { describe, expect, it, vi } from "vitest";
import { createMemoryStore, resolveEffect } from "../src/index.js";
import { makeEmailTool, settleFromWebhooks } from "../examples/email-tool.js";
import { FakeGitHub, GitHubTimeoutError } from "../examples/fake-github.js";
import { FakeMailer, MailerTimeoutError } from "../examples/fake-mailer.js";
import { makeIssueTool, markerFor } from "../examples/issue-tool.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("creating an issue (no idempotency key; reconcile by a marker in the body)", () => {
  const incident = { incidentId: "inc-42", title: "Checkout 500s", body: "Error rate above 5%." };

  it("baseline: a naive retry after a lost response opens a duplicate issue", async () => {
    const gh = new FakeGitHub();
    gh.faults = ["lost_response"];
    for (let i = 0; i < 2; i++) {
      try {
        await gh.createIssue(incident);
        break;
      } catch (e) {
        if (!(e instanceof GitHubTimeoutError)) throw e;
      }
    }
    expect(gh.count("Checkout 500s")).toBe(2);
  });

  it("finds the issue by its marker instead of creating another", async () => {
    const gh = new FakeGitHub();
    gh.faults = ["lost_response"];
    const r = await makeIssueTool(gh)(incident);

    expect(r).toMatchObject({ ok: true, reason: "reconciled", executions: 1 });
    expect(r.result?.number).toBe(1);
    expect(gh.count("Checkout 500s")).toBe(1);
  });

  it("a lagging search index: safe by default, a duplicate once you declare an in-flight bound (why reconcile must read its own writes)", async () => {
    const searchReconcile = (gh: FakeGitHub) => async ({ effectKey }: { effectKey?: string }) => {
      const hits = await gh.search(markerFor(effectKey!));
      return hits.length ? { outcome: "verified" as const, result: hits[0] } : { outcome: "failed" as const };
    };

    const safe = new FakeGitHub(5_000);
    safe.faults = ["lost_response"];
    const r = await makeIssueTool(safe, { reconcile: searchReconcile(safe) })(incident);
    expect(r.outcome).toBe("unknown");
    expect(safe.count("Checkout 500s")).toBe(1);

    const trap = new FakeGitHub(5_000);
    trap.faults = ["lost_response"];
    await makeIssueTool(trap, { reconcile: searchReconcile(trap), maxInFlightMs: 0 })(incident);
    expect(trap.count("Checkout 500s")).toBe(2);
  });

  it("the agent asking again for the same incident gets the existing issue", async () => {
    const gh = new FakeGitHub();
    const createIssue = makeIssueTool(gh);
    await createIssue(incident);
    const again = await createIssue({ ...incident, body: "reworded by the model" });

    expect(again).toMatchObject({ reason: "cached", executions: 0 });
    expect(gh.count("Checkout 500s")).toBe(1);
  });
});

describe("sending an email (no way to check; settled by webhook)", () => {
  const email = { refId: "order-7", to: "anil@example.com", subject: "Your refund", body: "£12.00 is on its way." };

  it("baseline: a naive retry after a lost response sends the email twice", async () => {
    const mailer = new FakeMailer();
    mailer.faults = ["lost_response"];
    for (let i = 0; i < 2; i++) {
      try {
        await mailer.send({ ...email, metadata: {} });
        break;
      } catch (e) {
        if (!(e instanceof MailerTimeoutError)) throw e;
      }
    }
    expect(mailer.count(email.to, email.subject)).toBe(2);
  });

  it("a lost response ends as unknown and escalates, and the email isn't resent", async () => {
    const mailer = new FakeMailer(10_000);
    mailer.faults = ["lost_response"];
    const onEscalate = vi.fn();
    const send = makeEmailTool(mailer, createMemoryStore(), { onEscalate });

    const first = await send(email);
    const second = await send(email);

    expect(first).toMatchObject({ outcome: "unknown", reason: "ambiguous", escalated: true, executions: 1 });
    expect(second).toMatchObject({ outcome: "unknown", executions: 0, escalated: false });
    expect(onEscalate).toHaveBeenCalledOnce();
    expect(mailer.count(email.to, email.subject)).toBe(1);
  });

  it("the delivery webhook settles it, so the next call reports sent without resending", async () => {
    const mailer = new FakeMailer(50);
    mailer.faults = ["lost_response"];
    const store = createMemoryStore();
    settleFromWebhooks(mailer, store);
    const send = makeEmailTool(mailer, store);

    await send(email);
    await sleep(100);
    const later = await send(email);

    expect(later).toMatchObject({ ok: true, reason: "cached", executions: 0 });
    expect(mailer.count(email.to, email.subject)).toBe(1);
  });

  it("a bounce webhook clears the effect, so a corrected retry is allowed", async () => {
    const mailer = new FakeMailer(50);
    mailer.faults = ["lost_response"];
    const store = createMemoryStore();
    settleFromWebhooks(mailer, store);
    const send = makeEmailTool(mailer, store);

    await send({ ...email, bounce: true });
    await sleep(100);
    const retry = await send(email);

    expect(retry).toMatchObject({ ok: true, executions: 1 });
    expect(mailer.count(email.to, email.subject)).toBe(2);
  });

  it("a webhook that settles an effect while a call still holds it can't be overwritten by that call", async () => {
    const store = createMemoryStore();
    await store.claim("k", { state: "claimed", owner: "running-call", claimedAt: Date.now() });

    expect(await resolveEffect(store, "k", "verified")).toBe(true);
    expect(await store.replace("k", "running-call", { state: "unresolved", owner: "running-call", claimedAt: 0 })).toBe(false);
    expect((await store.get("k"))?.state).toBe("settled");
  });
});
