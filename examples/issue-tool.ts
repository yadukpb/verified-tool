// Side effect with no idempotency key but a readable result: creating an
// issue/ticket. The trick is to write the effect key into the thing you
// create, so reconcile() can find it again without the lost response.
// The same pattern fits Jira tickets, Slack messages, calendar events, and
// database rows (use a unique column instead of a body marker).
import { defineTool, type DefineToolOptions } from "../src/index.js";
import type { FakeGitHub, Issue } from "./fake-github.js";

export interface IssueArgs {
  incidentId: string;
  title: string;
  body: string;
}

export const markerFor = (effectKey: string) => `<!-- verified-tool:${effectKey} -->`;

// Must cover how far back a crashed run's issue could be (at least leaseMs).
const LOOKBACK_MS = 10 * 60_000;

export function makeIssueTool(gh: FakeGitHub, overrides: Partial<DefineToolOptions<IssueArgs, Issue>> = {}) {
  return defineTool<IssueArgs, Issue>(
    (args, ctx) => gh.createIssue({ title: args.title, body: `${args.body}\n\n${markerFor(ctx.effectKey!)}` }),
    {
      name: "create_issue",
      effectKey: (args) => `issue:${args.incidentId}`,
      verify: async (issue) => ((await gh.getIssue(issue.number)) ? "verified" : "unknown"),
      // List the repo directly rather than using search: the search index
      // lags, and an empty result from a lagging index is not proof of absence.
      reconcile: async ({ effectKey }) => {
        const recent = await gh.listRecent(Date.now() - LOOKBACK_MS);
        const found = recent.find((i) => i.body.includes(markerFor(effectKey!)));
        return found ? { outcome: "verified", result: found } : { outcome: "failed" };
      },
      poll: { attempts: 3, delayMs: 50 },
      ...overrides,
    }
  );
}
