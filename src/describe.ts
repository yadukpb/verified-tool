import type { ToolCallResult } from "./types.js";

/**
 * Turns a result into the text the model should see as the tool output.
 *
 * This matters as much as the verification itself: a model shown a bare
 * error tends to re-issue the same call, and a model shown nothing about
 * uncertainty tends to tell the user it worked. These messages say what
 * happened and what the model should and shouldn't do next.
 */
export function describeOutcome(r: ToolCallResult<unknown>, toolName = "The action"): string {
  const detail = r.result === undefined ? "" : ` Details: ${JSON.stringify(r.result)}`;
  switch (r.reason) {
    case "verified":
      return `${toolName} succeeded and the result was confirmed.${detail}`;
    case "trusted":
      return `${toolName} completed.${detail}`;
    case "cached":
      return `${toolName} had already been completed earlier, so it was not repeated.${detail}`;
    case "reconciled":
      return `${toolName} succeeded. The first response was lost, but the result was confirmed by checking the system directly. Do not repeat it.${detail}`;
    case "failed":
      return `${toolName} did not happen (confirmed). You may tell the user it failed.${detail}`;
    case "exhausted":
      return `${toolName} could not be completed after ${r.executions} attempt(s). Nothing was changed.`;
    case "denied":
      return `${toolName} was not performed because it is not currently authorized. Nothing was changed.`;
    case "in_flight":
      return `${toolName} for this item is already in progress. Do not call it again. Tell the user it is being processed.`;
    case "ambiguous":
      return (
        `It is not known whether ${toolName} took effect. Do not retry it, and do not tell the user it succeeded or failed. ` +
        (r.escalated
          ? "A person has been asked to confirm; tell the user it is pending confirmation."
          : "Check another way if you can (for example with a tool that reads or lists what exists), or report the outcome as uncertain.")
      );
  }
}
