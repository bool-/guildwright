/**
 * `IssuesPort` on octokit.
 *
 * THE INTERESTING PART IS THE IDEMPOTENCY, AND WHERE THE KEY COMES FROM.
 *
 * `create` must be safe to retry: a crash between "GitHub created the issue" and "we persisted
 * the issue number" must not file the same request twice. That needs a marker in the issue
 * body that we can search for, keyed on something stable per request.
 *
 * The marker already exists, and core put it there. `buildIssueBody` ends every body with
 *
 *     <!-- build-request v1 nonce=<16 hex> requestId=<ULID> -->
 *
 * and exposes that nonce as `IssueBody.nonce`. The same `FenceNonce` is minted once per
 * request and persisted on the row, so a retry rebuilds a body carrying the same nonce.
 * `issueMarker()` below is the prefix of that comment.
 *
 * WHY THAT MARKER CANNOT BE FORGED, which is the property that makes searching for it safe:
 * every path from `UserText` into a body runs through `toMarkdown`, whose `neutralise` step
 * rewrites `<!--` as `&lt;!--`. So no user-supplied byte in any issue body can contain the
 * opening `<!--` at all, let alone this exact comment. `fence()` additionally scrubs the
 * nonce out of the user's own text. Layer 4 of SC-3 buys the idempotency key for free.
 *
 * WHY THE SEARCH API IS NOT USED: `GET /search/issues` is served from an index that lags
 * writes by seconds to minutes. The window this idempotency defends is *exactly* those first
 * seconds after a create, so the one tool that looks purpose-built for the job is the one tool
 * guaranteed to answer "no" when the answer matters. A plain `GET /repos/.../issues` read is
 * strongly consistent, so that is what runs.
 */

import { createHash } from 'node:crypto';
import type { Octokit } from 'octokit';
import { z } from 'zod';
import { Err, Ok, type Result } from '#core/result';
import type { AppError } from '#core/errors';
import { errors } from '#core/errors';
import { parseHttpsUrl, renderIssueBody, renderPlainName, renderSafeMarkdown, type IssueBody, type SafeMarkdown } from '#core/text';
import type { ClockPort, IssueRef, IssuesPort, LoggerPort } from '#core/ports';
import { isAlreadyExists, mapGithubError, readGithubFailure, type GithubRepo } from '#adapters/github/client';

// ---------------------------------------------------------------------------------------
// Pure parts: the marker, and the scan over what a list call returned
// ---------------------------------------------------------------------------------------

/** How many recent issues the pre-create scan reads. See `findExistingIssue` for the bound. */
export const MARKER_SCAN_PAGE_SIZE = 50;

/** Colour and description for labels this adapter creates. Developer-authored, never input. */
const LABEL_COLOR = 'bfd4f2';
const LABEL_DESCRIPTION = 'Created by the Discord build bot.';

/**
 * The idempotency marker for one issue body.
 *
 * It is a PREFIX of core's trailing metadata comment rather than the whole comment, because
 * the `meta` half is sorted and varies per caller; the `<!-- build-request v1 nonce=` opening
 * plus 16 hex characters is already both unique and unforgeable (see the file header).
 */
export function issueMarker(body: IssueBody): string {
  return `<!-- build-request v1 nonce=${body.nonce}`;
}

/** The three fields the scan needs, lifted out of whatever GitHub returned. */
export interface IssueSummary {
  readonly number: number;
  readonly htmlUrl: string;
  readonly body: string;
  /** `GET /repos/{o}/{r}/issues` returns pull requests too; they carry `pull_request`. */
  readonly isPullRequest: boolean;
}

/**
 * Find a previously created issue for this body, by marker.
 *
 * WHY the LOWEST number wins rather than the newest: if a bug ever did file two issues for one
 * request, the first one is the one whose number may already be persisted somewhere, and
 * picking deterministically means two racing retries converge on the same answer instead of
 * disagreeing.
 */
export function findExistingIssue(issues: readonly IssueSummary[], marker: string): IssueSummary | null {
  let best: IssueSummary | null = null;
  for (const issue of issues) {
    if (issue.isPullRequest) continue;
    if (!issue.body.includes(marker)) continue;
    if (best === null || issue.number < best.number) best = issue;
  }
  return best;
}

/**
 * The hash SC-2 check 4 re-verifies.
 *
 * WHY it hashes the body GitHub RETURNED rather than the body we sent: an independent verifier
 * (`verify-approval.sh` on the runner) can only see the API's copy, and GitHub normalises line
 * endings on the way in. Hashing what we sent would produce a digest nothing else can
 * reproduce, i.e. a check that fails exactly when it is finally exercised.
 */
export function bodyDigest(body: string): string {
  return createHash('sha256').update(body, 'utf8').digest('hex');
}

// ---------------------------------------------------------------------------------------
// Wire schemas. Nothing off the network is trusted (same posture as dispatch.ts).
// ---------------------------------------------------------------------------------------

const IssuePayload = z.object({
  number: z.number().int().positive(),
  html_url: z.url(),
  body: z.string().nullable().optional(),
});

const IssueListPayload = z.array(
  IssuePayload.extend({
    pull_request: z.looseObject({}).optional(),
  }),
);

function toSummaries(data: unknown): readonly IssueSummary[] {
  const parsed = IssueListPayload.safeParse(data);
  if (!parsed.success) return [];
  return parsed.data.map((i) => ({
    number: i.number,
    htmlUrl: i.html_url,
    body: i.body ?? '',
    isPullRequest: i.pull_request !== undefined,
  }));
}

/** WHY a shared builder: `create` and the idempotent re-adopt must produce the same ref. */
function toIssueRef(number: number, htmlUrl: string, body: string): Result<IssueRef, AppError> {
  const url = parseHttpsUrl(htmlUrl);
  if (!url.ok) {
    return Err(
      errors.upstream('github', 200, 'Ask an admin to check the GitHub base URL.', `issue ${number} html_url is not https`),
    );
  }
  return Ok({ number, url: url.value, bodySha256: bodyDigest(body) });
}

// ---------------------------------------------------------------------------------------
// The port
// ---------------------------------------------------------------------------------------

/**
 * `IssuesPort` plus the one operation the port deliberately does not declare.
 *
 * ONLY `ensureLabel` IS EXTRA NOW. `close` and `reopen` were both on this widened interface
 * first - the adapter could do them and a MODULE, which only ever sees `IssuesPort` through
 * `ctx.ports`, could not call them - and both have since moved onto the port itself, which is
 * why they are gone from here rather than restated. A method declared in two places is a method
 * that will eventually be declared two different ways.
 *
 * `ensureLabel` stays out of core on purpose: a module names labels from a closed set it
 * authored, and `create`/`addLabel` already ensure them. A module that could mint labels
 * directly would be a module that could fill the repository's label list from a command.
 */
export interface GithubIssuesPort extends IssuesPort {
  /** Create a label if it is missing. Idempotent; see `isAlreadyExists`. */
  ensureLabel(label: string): Promise<Result<void, AppError>>;
}

export function createGithubIssues(input: {
  readonly octokit: Octokit;
  readonly repo: GithubRepo;
  readonly clock: ClockPort;
  readonly logger: LoggerPort;
}): GithubIssuesPort {
  const { octokit, clock } = input;
  const { owner, repo } = input.repo;
  const log = input.logger.child({ component: 'github.issues' });

  /** One place turns a thrown value into an `AppError`, so no call site invents wording. */
  const fail = (cause: unknown, operation: string): AppError => mapGithubError(cause, operation, clock.now());

  async function ensureLabel(label: string): Promise<Result<void, AppError>> {
    try {
      await octokit.request('POST /repos/{owner}/{repo}/labels', {
        owner,
        repo,
        name: label,
        color: LABEL_COLOR,
        description: LABEL_DESCRIPTION,
      });
      return Ok(undefined);
    } catch (cause: unknown) {
      // THE VERIFIED DUPLICATE SHAPE: 422 + errors[].code === 'already_exists'. There is no
      // 409 branch on purpose - GitHub does not answer 409 here, and a branch for a status
      // that never arrives reads to the next maintainer like a case that was handled.
      if (isAlreadyExists(readGithubFailure(cause, clock.now()))) return Ok(undefined);
      return Err(fail(cause, 'issues.ensureLabel'));
    }
  }

  async function ensureLabels(labels: readonly string[]): Promise<Result<void, AppError>> {
    for (const label of labels) {
      const r = await ensureLabel(label);
      if (!r.ok) return r;
    }
    return Ok(undefined);
  }

  /** The strongly-consistent pre-create scan. See the file header for why not `/search`. */
  async function findExisting(marker: string, labels: readonly string[]): Promise<Result<IssueSummary | null, AppError>> {
    try {
      const res = await octokit.request('GET /repos/{owner}/{repo}/issues', {
        owner,
        repo,
        state: 'all',
        sort: 'created',
        direction: 'desc',
        per_page: MARKER_SCAN_PAGE_SIZE,
        // Narrowing by our own label keeps the scan to bot-created issues. A retry rebuilds
        // the same labels, so an issue we created is always inside this filter.
        ...(labels.length > 0 ? { labels: labels.join(',') } : {}),
      });
      return Ok(findExistingIssue(toSummaries(res.data), marker));
    } catch (cause: unknown) {
      return Err(fail(cause, 'issues.findExisting'));
    }
  }

  return {
    async create(request): Promise<Result<IssueRef, AppError>> {
      const marker = issueMarker(request.body);

      // 1. Labels first. Creating the issue with a label that does not exist works, but
      //    creating them explicitly is what makes `bot:request` carry a colour and a
      //    description instead of GitHub's default grey.
      const labelled = await ensureLabels(request.labels);
      if (!labelled.ok) return labelled;

      // 2. THE IDEMPOTENCY CHECK. A crash after GitHub created the issue but before we
      //    persisted its number lands here on the retry and re-adopts the existing issue.
      const existing = await findExisting(marker, request.labels);
      if (!existing.ok) return existing;
      if (existing.value !== null) {
        log.warn('re-adopted an existing issue for this request', { issueNumber: existing.value.number });
        return toIssueRef(existing.value.number, existing.value.htmlUrl, existing.value.body);
      }

      // 3. Create. `renderIssueBody` is one of the five adapter-only unwrappers in core, and
      //    `IssueBody` is minted only by `buildIssueBody`, so there is no path by which raw
      //    user text reaches this call - no cast could produce one either.
      try {
        const res = await octokit.request('POST /repos/{owner}/{repo}/issues', {
          owner,
          repo,
          title: renderPlainName(request.title),
          body: renderIssueBody(request.body),
          labels: [...request.labels],
        });
        const parsed = IssuePayload.safeParse(res.data);
        if (!parsed.success) {
          return Err(
            errors.upstream('github', res.status, 'Ask an admin to check the GitHub API version pin.', 'issues.create: unrecognised response shape'),
          );
        }
        return toIssueRef(parsed.data.number, parsed.data.html_url, parsed.data.body ?? '');
      } catch (cause: unknown) {
        return Err(fail(cause, 'issues.create'));
      }
    },

    async comment(issueNumber, body: SafeMarkdown): Promise<Result<void, AppError>> {
      try {
        await octokit.request('POST /repos/{owner}/{repo}/issues/{issue_number}/comments', {
          owner,
          repo,
          issue_number: issueNumber,
          body: renderSafeMarkdown(body),
        });
        return Ok(undefined);
      } catch (cause: unknown) {
        return Err(fail(cause, 'issues.comment'));
      }
    },

    async addLabel(issueNumber, label): Promise<Result<void, AppError>> {
      const ensured = await ensureLabel(label);
      if (!ensured.ok) return ensured;
      try {
        await octokit.request('POST /repos/{owner}/{repo}/issues/{issue_number}/labels', {
          owner,
          repo,
          issue_number: issueNumber,
          labels: [label],
        });
        return Ok(undefined);
      } catch (cause: unknown) {
        return Err(fail(cause, 'issues.addLabel'));
      }
    },

    async bodySha256(issueNumber): Promise<Result<string, AppError>> {
      try {
        const res = await octokit.request('GET /repos/{owner}/{repo}/issues/{issue_number}', {
          owner,
          repo,
          issue_number: issueNumber,
        });
        const parsed = IssuePayload.safeParse(res.data);
        if (!parsed.success) {
          return Err(
            errors.upstream('github', res.status, 'Ask an admin to check the GitHub API version pin.', 'issues.get: unrecognised response shape'),
          );
        }
        return Ok(bodyDigest(parsed.data.body ?? ''));
      } catch (cause: unknown) {
        return Err(fail(cause, 'issues.bodySha256'));
      }
    },

    ensureLabel,

    async close(issueNumber, reason): Promise<Result<void, AppError>> {
      try {
        await octokit.request('PATCH /repos/{owner}/{repo}/issues/{issue_number}', {
          owner,
          repo,
          issue_number: issueNumber,
          state: 'closed',
          state_reason: reason,
        });
        return Ok(undefined);
      } catch (cause: unknown) {
        return Err(fail(cause, 'issues.close'));
      }
    },

    /**
     * Reopen an issue an expiry closed, so `/request retry` stops asking for approval on a
     * closed one.
     *
     * `state_reason: 'reopened'` IS SENT EXPLICITLY, and it is the whole point of the call. The
     * issue arrives here closed as `not_planned` - stamped that way when the request expired -
     * and `not_planned` is what GitHub renders as the greyed, "we decided against this" style.
     * Sending `state: 'open'` alone leaves that reason on the row, so the retry would be
     * discussed under an issue still labelled declined. `reopened` is the documented third
     * value of `state_reason` and it is the only one that clears it.
     *
     * IDEMPOTENT: GitHub answers 200 for an issue that is already open and changes nothing, so
     * a second retry does not need to read the state first - which is one fewer API call and,
     * more usefully, one fewer race between the read and the write.
     */
    async reopen(issueNumber): Promise<Result<void, AppError>> {
      try {
        await octokit.request('PATCH /repos/{owner}/{repo}/issues/{issue_number}', {
          owner,
          repo,
          issue_number: issueNumber,
          state: 'open',
          state_reason: 'reopened',
        });
        return Ok(undefined);
      } catch (cause: unknown) {
        return Err(fail(cause, 'issues.reopen'));
      }
    },
  };
}
