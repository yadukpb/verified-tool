// An on-call agent opens an incident ticket; the API times out after creating it.
import { describeOutcome } from "../src/index.js";
import { FakeGitHub, GitHubTimeoutError } from "./fake-github.js";
import { makeIssueTool, markerFor } from "./issue-tool.js";

const incident = { incidentId: "inc-42", title: "Checkout 500s", body: "Error rate above 5% since 14:02." };

console.log("\n1) Naive tool with retry-on-error");
{
  const gh = new FakeGitHub();
  gh.faults = ["lost_response"];
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      await gh.createIssue(incident);
      console.log(`   attempt ${attempt}: created`);
      break;
    } catch (e) {
      if (!(e instanceof GitHubTimeoutError)) throw e;
      console.log(`   attempt ${attempt}: ${e.message} -> retrying`);
    }
  }
  console.log(`   issues titled "Checkout 500s": ${gh.count(incident.title)}   <- duplicate ticket, two people paged`);
}

console.log("\n2) verified-tool: effect key written into the issue body, reconcile lists the repo");
{
  const gh = new FakeGitHub();
  gh.faults = ["lost_response"];
  const createIssue = makeIssueTool(gh, {
    trace: (e) => {
      if (e.type === "execute") console.log(`   execute #${e.execution}`);
      if (e.type === "error") console.log(`   error (${e.errorClass}): looking for ${markerFor("issue:inc-42")} instead of retrying`);
      if (e.type === "reconcile") console.log(`   reconcile poll ${e.poll}: ${e.outcome}`);
    },
  });
  const r = await createIssue(incident);
  console.log(`   result: ${r.outcome} (${r.reason}), issue #${r.result?.number}`);
  console.log(`   model sees: "${describeOutcome(r, "create_issue")}"`);
  console.log(`   issues titled "Checkout 500s": ${gh.count(incident.title)}`);

  const again = await createIssue({ ...incident, body: "Reworded by the model on its next turn." });
  console.log(`   agent asks again for inc-42: ${again.reason}, executions: ${again.executions}`);
}

console.log("\n3) Reconcile using the search API instead (its index lags a few seconds)");
const searchReconcile = (gh: FakeGitHub) => async ({ effectKey }: { effectKey?: string }) => {
  const hits = await gh.search(markerFor(effectKey!));
  return hits.length ? { outcome: "verified" as const, result: hits[0] } : { outcome: "failed" as const };
};
{
  const gh = new FakeGitHub(5_000);
  gh.faults = ["lost_response"];
  const r = await makeIssueTool(gh, { reconcile: searchReconcile(gh) })(incident);
  console.log(`   default: search finds nothing, but "not found" right after a timeout isn't proof`);
  console.log(`   result: ${r.outcome} (${r.reason}); issues: ${gh.count(incident.title)}   <- safe, a person confirms`);
}
{
  const gh = new FakeGitHub(5_000);
  gh.faults = ["lost_response"];
  await makeIssueTool(gh, { reconcile: searchReconcile(gh), maxInFlightMs: 0 })(incident);
  console.log(`   with maxInFlightMs: 0 ("nothing can still be in flight"): issues: ${gh.count(incident.title)}   <- duplicate`);
  console.log(`   declaring a bound means trusting "not found"; that's only true if reconcile reads its own writes\n`);
}
