// Side effect with no idempotency key but a readable result: creating an
// issue/ticket. markerRecipe writes the effect key into the thing you
// create, so reconcile() can find it again without the lost response.
// The same pattern fits Jira tickets, Slack messages, calendar events, and
// database rows (use a unique column instead of a body marker).
import { defineTool, markerRecipe, type DefineToolOptions } from "../src/index.js";
import type { FakeGitHub, Issue } from "./fake-github.js";

export interface IssueArgs {
  incidentId: string;
  title: string;
  body: string;
}

export const markerFor = (effectKey: string) => `verified-tool:${effectKey}`;

// Must cover how far back a crashed run's issue could be (at least leaseMs).
const LOOKBACK_MS = 10 * 60_000;

export function makeIssueTool(gh: FakeGitHub, overrides: Partial<DefineToolOptions<IssueArgs, Issue>> = {}) {
  const marker = markerRecipe<IssueArgs, Issue>({
    inject: (args, m) => ({ ...args, body: `${args.body}\n\n<!-- ${m} -->` }),
    // List the repo directly rather than using search: the search index lags.
    list: () => gh.listRecent(Date.now() - LOOKBACK_MS),
    text: (issue) => issue.body,
    marker: markerFor,
  });

  return defineTool<IssueArgs, Issue>(
    marker.wrap((args) => gh.createIssue({ title: args.title, body: args.body })),
    {
      name: "create_issue",
      effectKey: (args) => `issue:${args.incidentId}`,
      verify: async (issue) => ((await gh.getIssue(issue.number)) ? "verified" : "unknown"),
      reconcile: marker.reconcile,
      poll: { attempts: 3, delayMs: 50 },
      ...overrides,
    }
  );
}
