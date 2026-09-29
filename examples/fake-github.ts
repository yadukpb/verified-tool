/**
 * A stand-in for GitHub's issues API. Unlike Stripe it has no idempotency
 * key, so retrying a create makes a second issue. It has two ways to look
 * issues up, and they behave differently on purpose:
 * - listRecent() reads the repo directly (sees its own writes), like
 *   GET /repos/{owner}/{repo}/issues?sort=created
 * - search() goes through an index that lags, like GET /search/issues
 */

export class GitHubTimeoutError extends Error {
  name = "GitHubTimeoutError";
}

export interface Issue {
  number: number;
  title: string;
  body: string;
  createdAt: number;
}

export class FakeGitHub {
  faults: "lost_response"[] = [];
  private issues: Issue[] = [];

  constructor(private readonly searchLagMs = 0) {}

  async createIssue(p: { title: string; body: string }): Promise<Issue> {
    const fault = this.faults.shift();
    const issue = { number: this.issues.length + 1, title: p.title, body: p.body, createdAt: Date.now() };
    this.issues.push(issue);
    if (fault === "lost_response") throw new GitHubTimeoutError("POST /issues timed out");
    return issue;
  }

  async getIssue(number: number): Promise<Issue | undefined> {
    return this.issues.find((i) => i.number === number);
  }

  async listRecent(sinceMs: number): Promise<Issue[]> {
    return this.issues.filter((i) => i.createdAt >= sinceMs);
  }

  async search(text: string): Promise<Issue[]> {
    const indexedBefore = Date.now() - this.searchLagMs;
    return this.issues.filter((i) => i.createdAt <= indexedBefore && i.body.includes(text));
  }

  count(title: string): number {
    return this.issues.filter((i) => i.title === title).length;
  }
}
