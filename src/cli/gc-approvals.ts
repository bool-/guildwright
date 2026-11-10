/**
 * `<bin> gc-approvals [--older-than <duration>] [--yes]` (RFC-001 section 12 decision 7).
 *
 * Lists every `refs/approvals/*` ref in the module repository, dates each by the workflow run
 * that consumed it, and prints what is older than `--older-than` (default 90 days). It deletes
 * ONLY with `--yes`; without it, nothing is changed and the same list is printed as a dry run.
 * Nothing calls this automatically. The mechanics and the safety argument are in
 * `src/adapters/github/approvals-gc.ts`.
 */

import { loadConfig } from '#core/config';
import { systemClock } from '#adapters/system/clock';
import {
  createGithubRequester,
  dateApprovalRefs,
  deleteApprovalRefs,
  gitDeleteCommand,
  listApprovalRefs,
  planApprovalGc,
  resolveGithubAuth,
  type DatedApprovalRef,
  type GithubRequest,
} from '#adapters/github/index';

import { formatConfigFailure } from '../main.ts';

import { EXIT_OK, EXIT_PROBLEM, EXIT_USAGE, describeAppError, silentLogger, type CliIo } from './io.ts';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const UNIT_MS: Readonly<Record<string, number>> = { h: HOUR_MS, d: DAY_MS, w: 7 * DAY_MS };

/** RFC-001 decision 7. */
export const DEFAULT_OLDER_THAN = '90d';

/**
 * The floor. A ref only guards a token younger than `APPROVAL_MAX_AGE_SECONDS` (default 900), but
 * that is a repository variable this CLI cannot read and an operator may raise; a day is far
 * above any sane value and still lets an operator collect aggressively.
 */
export const MIN_OLDER_THAN_MS = DAY_MS;

/** `90d`, `12w`, `36h` -> milliseconds, or the sentence explaining the refusal. */
export function parseOlderThan(raw: string): { readonly ms: number } | { readonly error: string } {
  const m = /^(\d{1,5})([hdw])$/u.exec(raw.trim());
  const unit = m?.[2] === undefined ? undefined : UNIT_MS[m[2]];
  if (m === null || unit === undefined) return { error: `--older-than "${raw}" is not a duration; write it as a number and a unit: 36h, 90d or 12w.` };
  const ms = Number.parseInt(m[1] ?? '0', 10) * unit;
  if (ms < MIN_OLDER_THAN_MS) {
    return { error: `--older-than ${raw} is shorter than one day; a younger ref may still guard a live approval token, so gc-approvals refuses it.` };
  }
  return { ms };
}

export interface GcDeps {
  /** Request seam, for tests. Production builds one on the bot's own credential. */
  readonly request?: GithubRequest;
}

function isoDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function line(r: DatedApprovalRef): string {
  return r.createdAtMs === null ? `    ${r.ref}` : `    ${r.ref}  consumed ${isoDay(r.createdAtMs)} by run ${String(r.runId)}`;
}

export async function gcApprovals(io: CliIo, deps: GcDeps, opts: { readonly olderThan: string; readonly yes: boolean }): Promise<number> {
  const age = parseOlderThan(opts.olderThan);
  if ('error' in age) {
    io.err(`gc-approvals: ${age.error}\n`);
    return EXIT_USAGE;
  }
  const parsed = loadConfig(io.env);
  if (!parsed.ok) {
    io.err(formatConfigFailure(parsed.error));
    return EXIT_PROBLEM;
  }
  const cfg = parsed.value;
  const repo = { owner: cfg.github.owner, repo: cfg.github.repo };
  const fullName = `${repo.owner}/${repo.repo}`;

  let request: GithubRequest;
  if (deps.request !== undefined) {
    request = deps.request;
  } else {
    const auth = resolveGithubAuth(cfg.github.auth);
    if (!auth.ok) {
      io.err(formatConfigFailure(auth.error));
      return EXIT_PROBLEM;
    }
    const made = await createGithubRequester({ auth: auth.value, repo, clock: systemClock(), logger: silentLogger() });
    if (!made.ok) {
      io.err(formatConfigFailure(made.error));
      return EXIT_PROBLEM;
    }
    request = made.value;
  }

  const listed = await listApprovalRefs(request, repo, io.nowMs);
  if (!listed.ok) {
    io.err(`gc-approvals: ${describeAppError(listed.error)}\n`);
    return EXIT_PROBLEM;
  }
  const dated = await dateApprovalRefs(request, repo, cfg.github.workflowFile, listed.value.refs, io.nowMs);
  if (!dated.ok) {
    io.err(`gc-approvals: ${describeAppError(dated.error)}\n`);
    return EXIT_PROBLEM;
  }
  const plan = planApprovalGc(dated.value, io.nowMs(), age.ms);

  io.out(`gc-approvals: ${String(listed.value.refs.length)} refs/approvals/* ref(s) on ${fullName}\n`);
  io.out(`  older than ${opts.olderThan}${opts.yes ? ', deleting' : ', would delete'}: ${String(plan.remove.length)}\n`);
  for (const r of plan.remove) io.out(`${line(r)}\n`);
  io.out(`  kept, younger than ${opts.olderThan}: ${String(plan.keepYoung.length)}\n`);
  if (plan.keepUndated.length > 0) {
    io.out(`  kept, age unknown (no run of ${cfg.github.workflowFile} names the approval): ${String(plan.keepUndated.length)}\n`);
    for (const r of plan.keepUndated) io.out(`${line(r)}\n`);
  }
  if (listed.value.foreign.length > 0) {
    io.out(`  left alone, not an approval id: ${listed.value.foreign.join(', ')}\n`);
  }

  if (plan.remove.length === 0) {
    io.out('Nothing to delete.\n');
    return EXIT_OK;
  }
  if (!opts.yes) {
    io.out(`\nDry run: nothing was deleted. Re-run with --yes to delete the ${String(plan.remove.length)} ref(s) listed above.\n`);
    return EXIT_OK;
  }

  const result = await deleteApprovalRefs(request, repo, plan.remove, io.nowMs);
  io.out(`\nDeleted ${String(result.deleted.length)} of ${String(plan.remove.length)} ref(s).\n`);
  if (result.failure === null) return EXIT_OK;
  const remaining = plan.remove.filter((r) => !result.deleted.includes(r.ref));
  io.err(`gc-approvals: stopped at ${result.failure.ref}: ${describeAppError(result.failure.error)}\n`);
  if (result.failure.forbidden) io.err(`  From a clone with push rights:\n    ${gitDeleteCommand(remaining)}\n`);
  return EXIT_PROBLEM;
}
