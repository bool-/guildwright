/**
 * ADAPTER, not core. It is here to prove two things at once: that `BuildsPort.dispatch` is
 * implementable against the real SDK, and that an `ActionsToken` becomes a wire string in
 * exactly ONE place in the whole repo.
 *
 * THE OCTOKIT DEFECT THIS IS DESIGNED AROUND: GitHub's API accepts `return_run_details: true`
 * on the workflow-dispatch endpoint and answers HTTP 200 with
 * `{ workflow_run_id, run_url, html_url }`. The installed `@octokit/openapi-types` does not
 * describe that parameter at all, so `octokit.rest.actions.createWorkflowDispatch()` types
 * `res.data` as `never` and every property access is TS2339. The fix is the raw `request()`
 * call plus the ONE documented `as never` on the parameter object, then zod on the response -
 * nothing coming back is trusted.
 *
 * This is the only `as` cast in the entire deliverable.
 */

import { Octokit } from 'octokit';
import { z } from 'zod';
import { errors, type AppError } from '#core/errors';
import { Ok, type Result } from '#core/result';
import { parseHttpsUrl, renderActionsToken, type ActionsToken } from '#core/text';
import type { ActionsInput, DispatchOutcome, GitRef, WorkflowFile } from '#core/ports';

const DispatchRunDetails = z.object({
  workflow_run_id: z.number().int().positive(),
  run_url: z.url(),
  html_url: z.url(),
});

/**
 * WHY this function is the ONLY place an `ActionsToken` becomes a string: it is the boundary
 * between "a value this codebase minted" and "text a workflow will see". Everything upstream
 * is structurally unable to carry free text, so this conversion is safe by construction rather
 * than by review.
 */
//
// EVERY wire value is a string: the dispatch endpoint answers 422 to a JSON number or boolean,
// whatever `type:` the workflow declares for that input. The workflow parses them back itself.
function toWireInputs(inputs: Readonly<Record<string, ActionsInput>>): Readonly<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(inputs)) {
    out[key] = typeof value === 'object' ? renderActionsToken(value) : String(value);
  }
  return out;
}

/** WHY it returns the union: a 204 is a routine answer, not an error. */
export async function dispatchWorkflow(
  octokit: Octokit,
  owner: string,
  repo: string,
  input: {
    readonly workflowFile: WorkflowFile;
    readonly ref: GitRef;
    readonly inputs: Readonly<Record<string, ActionsInput>>;
    readonly runName: ActionsToken;
  },
): Promise<Result<DispatchOutcome, AppError>> {
  const res = await octokit.request(
    'POST /repos/{owner}/{repo}/actions/workflows/{workflow_id}/dispatches',
    {
      owner,
      repo,
      workflow_id: input.workflowFile,
      ref: input.ref,
      inputs: toWireInputs(input.inputs),
      return_run_details: true,
      // THE ONE DOCUMENTED CAST IN THIS DELIVERABLE. @octokit/openapi-types has no
      // `return_run_details` in its parameter type, so the whole object is rejected; `as never`
      // is the narrowest way to say "the SDK's types are behind the API here". The response is
      // validated with zod below, so nothing is trusted on the way back.
    } as never,
  );

  // octokit types this as the literal 200; the API really does answer 204 when
  // `return_run_details` is not honoured, so widen before comparing.
  const status: number = res.status;
  if (status === 204) return Ok({ kind: 'blind', correlateBy: input.runName });

  const parsed = DispatchRunDetails.safeParse(res.data);
  if (!parsed.success) return Ok({ kind: 'blind', correlateBy: input.runName });

  const url = parseHttpsUrl(parsed.data.html_url);
  if (!url.ok) return Ok({ kind: 'blind', correlateBy: input.runName });

  return Ok({ kind: 'adopted', run: { runId: parsed.data.workflow_run_id, runUrl: url.value } });
}

/** WHY it exists: something has to turn a thrown SDK error into an `AppError` with a nextStep. */
export function githubUnavailable(cause: unknown): AppError {
  // `cause` is deliberately NOT interpolated: an octokit error carries the request headers,
  // and therefore the PAT (SC-6). Only its shape reaches the operator log.
  return errors.upstream(
    'github',
    0,
    'Try again in a minute; the build has not been lost.',
    cause instanceof Error ? cause.name : 'unknown',
  );
}
