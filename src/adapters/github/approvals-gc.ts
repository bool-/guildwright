/**
 * GARBAGE-COLLECTING `refs/approvals/*` (RFC-001 5.3a, section 12 decision 7, section 13 risk 10).
 *
 * WHAT THE REFS ARE. Every build's consume step creates `refs/approvals/<approval_id>` before it
 * spends anything, so a second run carrying the same approval answers 422 and is refused. That
 * makes an approval single-use, and it also means one ref per build accumulates forever.
 *
 * WHY DELETING AN OLD ONE IS SAFE. A ref only matters while its approval token could still be
 * replayed, and `verify_approval.py` refuses any token older than `APPROVAL_MAX_AGE_SECONDS`
 * (default 900) measured against the replaying run's own creation time. A ref months old guards
 * nothing. The CLI still refuses any `--older-than` below one day, because the operator can raise
 * `APPROVAL_MAX_AGE_SECONDS` and this code cannot read it.
 *
 * HOW A REF'S AGE IS KNOWN. A git ref carries no timestamp, and the commit it points at is the
 * base commit of the run, which can be arbitrarily older than the ref. The honest clock is the
 * workflow RUN that created it: `run-name` carries `approval <id>` (the same field the consume
 * step's run-list scan reads), and its `created_at` is within one job's runtime of the ref's
 * creation. A ref no run names is reported and KEPT: an age this code cannot establish is not an
 * age it may act on.
 *
 * NEVER AUTOMATIC. Nothing in the bot calls this; only `<bin> gc-approvals` does, and only with
 * `--yes` does it delete. A dry run lists exactly what `--yes` would delete.
 *
 * THE CREDENTIAL. Deleting a ref is Contents WRITE, and the bot's GitHub App deliberately holds
 * Contents READ only (RFC-001 6.1: the bot must not be able to push). So in the documented setup
 * the listing works and the delete answers 403; the CLI then prints the `git push --delete`
 * command an operator with push rights runs from their clone. A PAT that holds Contents write
 * deletes directly.
 */

import { z } from 'zod';
import { Err, Ok, type Result } from '#core/result';
import { errors, type AppError } from '#core/errors';
import { toApprovalId } from '#core/ids';
import type { WorkflowFile } from '#core/ports';
import type { GithubRepo } from '#adapters/github/client';
import { readGithubFailure } from '#adapters/github/client';
import { credentialFailure, isTransientFailure, type GithubRequest } from '#adapters/github/gates';

/** Every consumed approval lives under this prefix; nothing outside it is ever listed or deleted. */
export const APPROVAL_REF_PREFIX = 'refs/approvals/';

/** One page of refs or runs. GitHub's maximum. */
const PAGE_SIZE = 100;

/** How many pages of workflow runs are read to date the refs: 5,000 runs, years at the daily cap. */
export const MAX_RUN_PAGES = 50;

/** A `refs/approvals/<id>` ref whose name is a real approval id. */
export interface ApprovalRef {
  /** `refs/approvals/<id>`. */
  readonly ref: string;
  readonly approvalId: string;
}

/** The same ref, with the creation time of the run that consumed it, when one names it. */
export interface DatedApprovalRef extends ApprovalRef {
  readonly createdAtMs: number | null;
  readonly runId: number | null;
}

/** What the listing found. `foreign` are refs under the prefix that no approval could have made. */
export interface ApprovalRefListing {
  readonly refs: readonly ApprovalRef[];
  readonly foreign: readonly string[];
}

const RefList = z.array(z.object({ ref: z.string() }));
const RunPage = z.object({
  workflow_runs: z.array(z.object({ id: z.number(), display_title: z.string().nullable().optional(), created_at: z.string() })),
});

/** `approval <uuid>` inside a run's display title (the workflow's `run-name`). */
const RUN_NAME_APPROVAL = /\bapproval ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/u;

/** A failed read or delete, as a sentence for the operator. */
function readFailure(cause: unknown, nowMs: number, fullName: string, what: string, permission: string): AppError {
  const credential = credentialFailure(cause, nowMs, `approvals_gc.${what}`);
  if (credential !== null) return credential;
  const { transient, status } = isTransientFailure(cause, nowMs);
  if (transient) {
    return {
      ...errors.unavailable('GitHub', 'Try again in a few minutes; nothing was deleted.'),
      internal: `could not ${what} on ${fullName} (${status === 0 ? 'GitHub could not be reached' : `GitHub answered ${status}`}).`,
    };
  }
  return errors.config(
    'github.approvals',
    `could not ${what} on ${fullName} (HTTP ${readGithubFailure(cause, nowMs).status}).`,
    `Check GITHUB_OWNER/GITHUB_REPO and that the credential holds ${permission} on the repository.`,
  );
}

/** Every `refs/approvals/*` ref, paginated. Refs whose name is not an approval id are set aside. */
export async function listApprovalRefs(
  request: GithubRequest,
  repo: GithubRepo,
  nowMs: () => number,
): Promise<Result<ApprovalRefListing, AppError>> {
  const fullName = `${repo.owner}/${repo.repo}`;
  const refs: ApprovalRef[] = [];
  const foreign: string[] = [];
  for (let page = 1; ; page += 1) {
    let data: unknown;
    try {
      const res = await request('GET /repos/{owner}/{repo}/git/matching-refs/{ref}', {
        owner: repo.owner,
        repo: repo.repo,
        ref: APPROVAL_REF_PREFIX.slice('refs/'.length),
        per_page: PAGE_SIZE,
        page,
      });
      data = res.data;
    } catch (cause: unknown) {
      return Err(readFailure(cause, nowMs(), fullName, 'list refs/approvals/*', 'Contents: read'));
    }
    const parsed = RefList.safeParse(data);
    if (!parsed.success) {
      return Err(errors.config('github.approvals', `GitHub answered the refs listing for ${fullName} with a shape this CLI cannot read.`, 'Try again; if it persists, report it.'));
    }
    for (const { ref } of parsed.data) {
      if (!ref.startsWith(APPROVAL_REF_PREFIX)) continue;
      const id = ref.slice(APPROVAL_REF_PREFIX.length);
      if (toApprovalId(id).ok) refs.push({ ref, approvalId: id });
      else foreign.push(ref);
    }
    if (parsed.data.length < PAGE_SIZE) break;
  }
  return Ok({ refs, foreign });
}

/**
 * Date each ref by the earliest run of `workflowFile` read whose title names its approval id: that
 * is the run whose consume step created the ref (a refused replay carries the same name, later).
 * Stops as soon as every ref is dated, at the last page, or after `MAX_RUN_PAGES`.
 */
export async function dateApprovalRefs(
  request: GithubRequest,
  repo: GithubRepo,
  workflowFile: WorkflowFile,
  refs: readonly ApprovalRef[],
  nowMs: () => number,
): Promise<Result<readonly DatedApprovalRef[], AppError>> {
  const fullName = `${repo.owner}/${repo.repo}`;
  const wanted = new Set(refs.map((r) => r.approvalId));
  const earliest = new Map<string, { readonly createdAtMs: number; readonly runId: number }>();
  for (let page = 1; page <= MAX_RUN_PAGES && wanted.size > 0; page += 1) {
    let data: unknown;
    try {
      const res = await request('GET /repos/{owner}/{repo}/actions/workflows/{workflow_id}/runs', {
        owner: repo.owner,
        repo: repo.repo,
        workflow_id: workflowFile,
        per_page: PAGE_SIZE,
        page,
      });
      data = res.data;
    } catch (cause: unknown) {
      return Err(readFailure(cause, nowMs(), fullName, `list the runs of ${workflowFile}`, 'Actions: read'));
    }
    const parsed = RunPage.safeParse(data);
    if (!parsed.success) {
      return Err(errors.config('github.approvals', `GitHub answered the run listing for ${fullName} with a shape this CLI cannot read.`, 'Try again; if it persists, report it.'));
    }
    for (const run of parsed.data.workflow_runs) {
      const id = RUN_NAME_APPROVAL.exec(run.display_title ?? '')?.[1];
      const createdAtMs = Date.parse(run.created_at);
      if (id === undefined || !Number.isFinite(createdAtMs)) continue;
      const prior = earliest.get(id);
      if (prior === undefined ? wanted.has(id) : createdAtMs < prior.createdAtMs) earliest.set(id, { createdAtMs, runId: run.id });
    }
    // Runs come newest first, so an id first seen on this page may still have an EARLIER run
    // further back (a refused replay is later than the run that created the ref). Stopping once
    // every ref is dated can only date a ref by a later run, which makes it look YOUNGER: the
    // error is always toward keeping a ref, never toward deleting one early.
    for (const id of earliest.keys()) wanted.delete(id);
    if (parsed.data.workflow_runs.length < PAGE_SIZE) break;
  }
  return Ok(
    refs.map((r) => {
      const hit = earliest.get(r.approvalId);
      return { ...r, createdAtMs: hit?.createdAtMs ?? null, runId: hit?.runId ?? null };
    }),
  );
}

/** What a run of `gc-approvals` would do. Pure, so the dry run and `--yes` cannot disagree. */
export interface ApprovalGcPlan {
  readonly remove: readonly DatedApprovalRef[];
  readonly keepYoung: readonly DatedApprovalRef[];
  readonly keepUndated: readonly DatedApprovalRef[];
}

export function planApprovalGc(refs: readonly DatedApprovalRef[], nowMs: number, olderThanMs: number): ApprovalGcPlan {
  const remove: DatedApprovalRef[] = [];
  const keepYoung: DatedApprovalRef[] = [];
  const keepUndated: DatedApprovalRef[] = [];
  for (const r of refs) {
    if (r.createdAtMs === null) keepUndated.push(r);
    else if (nowMs - r.createdAtMs > olderThanMs) remove.push(r);
    else keepYoung.push(r);
  }
  const byAge = (a: DatedApprovalRef, b: DatedApprovalRef): number => (a.createdAtMs ?? 0) - (b.createdAtMs ?? 0);
  return { remove: remove.sort(byAge), keepYoung: keepYoung.sort(byAge), keepUndated };
}

/** The outcome of deleting: every ref removed, and the first failure (deletion stops there). */
export interface ApprovalGcResult {
  readonly deleted: readonly string[];
  readonly failure: { readonly ref: string; readonly error: AppError; readonly forbidden: boolean } | null;
}

/**
 * Delete each ref in order, stopping at the first failure: a 403 on one is a 403 on all, and a
 * partial run reports exactly what it removed. A 404 means somebody deleted it already, which is
 * the outcome asked for, so it counts as deleted.
 */
export async function deleteApprovalRefs(
  request: GithubRequest,
  repo: GithubRepo,
  refs: readonly ApprovalRef[],
  nowMs: () => number,
): Promise<ApprovalGcResult> {
  const fullName = `${repo.owner}/${repo.repo}`;
  const deleted: string[] = [];
  for (const r of refs) {
    // The refused shapes never reach here (`listApprovalRefs` sets them aside); this is the
    // last line that keeps a delete inside refs/approvals/<uuid>.
    if (!r.ref.startsWith(APPROVAL_REF_PREFIX) || !toApprovalId(r.approvalId).ok) continue;
    try {
      await request('DELETE /repos/{owner}/{repo}/git/refs/{ref}', {
        owner: repo.owner,
        repo: repo.repo,
        ref: r.ref.slice('refs/'.length),
      });
      deleted.push(r.ref);
    } catch (cause: unknown) {
      const status = readGithubFailure(cause, nowMs()).status;
      if (status === 404) {
        deleted.push(r.ref);
        continue;
      }
      const forbidden = status === 403 && !isTransientFailure(cause, nowMs()).transient;
      const error = forbidden
        ? errors.config(
            'github.approvals',
            `the credential cannot delete refs on ${fullName} (HTTP 403): deleting a ref needs Contents: write, and the bot's GitHub App holds Contents: read only, by design.`,
            'Delete them from a clone with push rights using the git command printed below, or re-run with a PAT that holds Contents: write.',
          )
        : readFailure(cause, nowMs(), fullName, `delete ${r.ref}`, 'Contents: write');
      return { deleted, failure: { ref: r.ref, error, forbidden } };
    }
  }
  return { deleted, failure: null };
}

/** The command an operator with push rights runs instead. */
export function gitDeleteCommand(refs: readonly ApprovalRef[]): string {
  return `git push origin --delete ${refs.map((r) => r.ref).join(' ')}`;
}
