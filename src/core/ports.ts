/**
 * The hexagonal ports, and the capability -> port mapping that makes `capabilities` a real
 * blast-radius declaration rather than a comment.
 *
 * ZERO imports from `discord.js`, `octokit` or `node:sqlite` - that is the whole point. The
 * domain is testable with plain object fakes, and the Discord front end is replaceable.
 *
 * POSTMORTEMS THIS FILE CLOSES:
 *  (1) "The module declared `capabilities: ['db']` and still reached the GitHub client."
 *      `PortsFor<C>` is a mapped type over the declared tuple, so `ctx.ports.builds` in that
 *      module is TS2339 - AND `portsFor` builds the runtime bag from the same list, so it is
 *      `undefined` too.
 *  (2) "Someone hoisted the capability list, annotated it `readonly Capability[]`, and the
 *      module silently received every port in the bot." That is the one hole all three
 *      earlier designs shared, and the compiler itself taught contributors into it by naming
 *      `Capability[]` in the error message. `LiteralCaps<C>` makes the widened form a named
 *      compile error at the manifest.
 *  (3) "We posted the PR link with `editReply` and it 404'd, because the build took 22 minutes
 *      and the token dies at 15." `DiscordPort` has no reply method at all. Every write is
 *      keyed on a persisted `SurfaceRef`, i.e. a fresh REST call - the correct thing is the
 *      only thing.
 *  (4) "Free text reached a workflow input." `BuildsPort.dispatch` takes `ActionsInput`,
 *      which excludes `string` (SC-1), and `workflowFile`/`ref` are branded, not free text.
 */

import type { Result } from '#core/result';
import { Err, Ok } from '#core/result';
import type { AppError } from '#core/errors';
import { errors } from '#core/errors';
import type { JsonObject } from '#core/json';
import type { ActionsToken, HttpsUrl, IssueBody, PlainName, SafeMarkdown } from '#core/text';
import type { ChannelId, GuildId, JobId, MessageId, RoleId, UserId } from '#core/ids';
import type { SurfaceRef, View } from '#core/view';
import type { DiscordPermission } from '#core/permissions';
import type { DbPort } from '#core/ports/db';
import type { AuditPort } from '#core/ports/audit';
import type { CatalogPort } from '#core/ports/catalog';
import type { AccessPort } from '#core/ports/access';
import type { SecretsPort } from '#core/ports/secrets';
import type { AdminPort } from '#core/ports/admin';
import type { VersionPort } from '#core/ports/version';

export type { Db, DbPort, DocRecord, DocStore, SqlQuery, SqlValue, WriteResult } from '#core/ports/db';
export { sql, sqlJoin, sqlValues } from '#core/ports/db';
export type { Audit, AuditEntry, AuditPort, AuditRecord } from '#core/ports/audit';
export type { Admin, AdminPort, JobStats, RunningJob } from '#core/ports/admin';
export { oldestRunningJob } from '#core/ports/admin';
export type { CatalogCommand, CatalogHealth, CatalogModule, CatalogPermission, CatalogPort } from '#core/ports/catalog';
export type { Version, VersionPort } from '#core/ports/version';
export type { BuildInfo, GithubAuthSummary, PackageIdentity, RepoIdentity } from '#core/version';
export { UNKNOWN_BUILD, UNKNOWN_GITHUB_AUTH, describeBuild, describeGithubAuth, shortSha } from '#core/version';
export type { AccessPort, AccessSubjectSnapshot, Grant, GrantSubject } from '#core/ports/access';
export type { EnvironmentListing, EnvironmentName, SecretName, Secrets, SecretsPort } from '#core/ports/secrets';
export {
  AI_AGENT_ENVIRONMENT,
  SECRET_NAMES,
  USER_ENVIRONMENT_PREFIX,
  agentEnvironment,
  classifyCredential,
  isUserEnvironment,
  toEnvironmentName,
  toSecretName,
  userEnvironmentName,
} from '#core/ports/secrets';
export type { DiscordPermission } from '#core/permissions';

// ---------------------------------------------------------------------------------------
// Clock
// ---------------------------------------------------------------------------------------

/**
 * All time comes from here.
 *
 * WHY: `Date.now()` in a module makes the state machine untestable, and `setTimeout` in a
 * module is an in-memory promise a restart silently drops - the exact reason builds
 * "disappeared" across a deploy. Lint rule `no-ambient-clock` enforces it.
 *
 * NOTE THE ABSENCE OF `sleep`. Waiting is a JOB capability, not a handler capability: a
 * 30-minute poll loop inside an `ack: 'defer'` handler answers an interaction that died at 15
 * minutes, and that is the one bug all three earlier designs claimed to prevent and did not.
 * `JobContext.sleep` exists; `ClockPort.sleep` deliberately does not.
 */
export interface ClockPort {
  /** Wall-clock milliseconds. The value that goes in `updated_at`. */
  now(): number;
  /** Monotonic nanoseconds, for durations that must not go backwards over an NTP step. */
  monotonicNs(): bigint;
}

/** Short alias. */
export type Clock = ClockPort;

// ---------------------------------------------------------------------------------------
// Logger
// ---------------------------------------------------------------------------------------

/** Structured logging levels, matching pino's. */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/**
 * Structured logger.
 *
 * WHY fields are `JsonObject` and not `unknown`: pino serialises with `JSON.stringify`, and an
 * `unknown` field is how an octokit error object - complete with the request headers and the
 * PAT - reached a log line in the incident that produced SC-6. A `Secret`, a `UserText` and a
 * `ProgressHandle` are all unassignable here.
 *
 * WHY logging is NOT a capability: everything logs, so declaring it would add a word to every
 * module's blast-radius line and remove information rather than add it. It arrives on
 * `ctx.logger`, pre-bound to the module id.
 */
export interface LoggerPort {
  debug(msg: string, fields?: JsonObject): void;
  info(msg: string, fields?: JsonObject): void;
  warn(msg: string, fields?: JsonObject): void;
  error(msg: string, fields?: JsonObject): void;
  /** Child logger with permanent bindings, e.g. `{ requestId }`. */
  child(bindings: JsonObject): LoggerPort;
}

/** Short alias. */
export type Logger = LoggerPort;

// ---------------------------------------------------------------------------------------
// Discord
// ---------------------------------------------------------------------------------------

/**
 * The Discord port.
 *
 * READ THE ABSENCE: there is no `reply`, no `editReply`, no `followUp`, no `webhook`, and
 * nothing anywhere that accepts an interaction or a token. Replying is the ROUTER's job,
 * inside the 3-second/15-minute window it owns. Everything a module or a job can do here is a
 * fresh REST call keyed on ids we persisted, which is the only thing that still works 30
 * minutes into a build.
 */
export interface DiscordPort {
  /** Post a new message and return the durable handle to it. */
  post(channelId: ChannelId, view: View): Promise<Result<SurfaceRef, AppError>>;

  /**
   * Edit a message we previously posted, by id.
   * Safe at any age: no interaction token is involved. Coalesced and 429-aware in the adapter
   * (SC-14), so a chatty poller cannot get the bot Cloudflare-banned.
   */
  edit(ref: SurfaceRef, view: View): Promise<Result<SurfaceRef, AppError>>;

  /** WHY separate from `edit`: resolving a card means removing its buttons, and doing that by
   *  rendering an empty button row is easy to forget. */
  disableComponents(ref: SurfaceRef): Promise<Result<void, AppError>>;

  /** Delete a message we posted. A message that is already gone counts as deleted. */
  delete(ref: SurfaceRef): Promise<Result<void, AppError>>;

  /** Open a thread on an existing message, e.g. for build logs. */
  openThread(ref: SurfaceRef, name: PlainName): Promise<Result<ChannelId, AppError>>;

  /**
   * Which of `needs` the bot lacks, from an interaction's `app_permissions`. Zero API calls.
   * WHY it takes the bitfield rather than reading a cache: channel overwrites change without a
   * gateway event we subscribe to, and a stale cache is how you provoke a 403 (SC-12).
   */
  missingFromAppPermissions(appPermissions: bigint, needs: readonly DiscordPermission[]): readonly DiscordPermission[];

  /**
   * The bot's permissions in a channel, resolved by an API call.
   * WHY a JOB needs this and an interaction does not: a poll job editing a card at minute 20
   * has no `app_permissions` field to read, and if the bot lost SendMessages meanwhile the
   * edit is a 403 from a background task, with no card to show the error on.
   */
  botPermissionsIn(channelId: ChannelId): Promise<Result<bigint, AppError>>;

  /** Roles a member holds, for allow-list resolution against the CLICKER (SC-10 check 2). */
  memberRoles(guildId: GuildId, userId: UserId): Promise<Result<readonly RoleId[], AppError>>;
}

/** Short alias. */
export type Chat = DiscordPort;

// ---------------------------------------------------------------------------------------
// GitHub
// ---------------------------------------------------------------------------------------

declare const GH_BRAND: unique symbol;
type GhBranded<B extends string> = string & { readonly [GH_BRAND]: B };

/** A workflow file name. WHY branded: it is a path segment in a REST URL, not free text. */
export type WorkflowFile = GhBranded<'WorkflowFile'>;
/** A git ref. WHY branded: `dispatch` sends it verbatim, and `..`/`;` have no business here. */
export type GitRef = GhBranded<'GitRef'>;

// Predicates, not casts: the regex IS the evidence for the brand.
function isWorkflowFile(v: string): v is WorkflowFile {
  return /^[A-Za-z0-9._-]{1,80}\.ya?ml$/u.test(v);
}
function isGitRef(v: string): v is GitRef {
  return /^[A-Za-z0-9][A-Za-z0-9._/-]{0,100}$/u.test(v) && !v.includes('..');
}

/** WHY validated once, at config load: an invalid workflow file is a boot failure, not a 404. */
export function toWorkflowFile(v: string): Result<WorkflowFile, AppError> {
  return isWorkflowFile(v)
    ? Ok(v)
    : Err(errors.config('GITHUB_WORKFLOW_FILE', `"${v}" is not a workflow file name`, 'Use a name like claude-build.yml.'));
}

/** WHY validated once, at config load: same reasoning as `toWorkflowFile`. */
export function toGitRef(v: string): Result<GitRef, AppError> {
  return isGitRef(v)
    ? Ok(v)
    : Err(errors.config('GITHUB_REF', `"${v}" is not a git ref`, 'Use a branch name like main.'));
}

/** A created issue. `bodySha256` is what SC-2's HMAC binds, so it is not optional. */
export interface IssueRef {
  readonly number: number;
  readonly url: HttpsUrl;
  readonly bodySha256: string;
}

/** Issues sub-port. */
export interface IssuesPort {
  /**
   * Create an issue.
   *
   * WHY `body: IssueBody` and not `SafeMarkdown`: `IssueBody` is minted only by
   * `buildIssueBody`, from `FencedField`s minted only by `fence`. So "every piece of user text
   * in an issue body sits inside a per-issue nonce fence" (SC-3 layer 4) is a TYPE, not a
   * convention a reviewer has to check. All three earlier designs left this as a convention,
   * and all three were shown to be bypassable in one line.
   */
  create(input: {
    readonly title: PlainName;
    readonly body: IssueBody;
    /** Developer-authored labels from a closed set in the module. Never user input. */
    readonly labels: readonly string[];
  }): Promise<Result<IssueRef, AppError>>;

  /** Comment - e.g. the signed approval marker the workflow re-verifies (SC-2 check 4). */
  comment(issueNumber: number, body: SafeMarkdown): Promise<Result<void, AppError>>;

  /** Add the `bot:approved` label. */
  addLabel(issueNumber: number, label: string): Promise<Result<void, AppError>>;

  /** Re-read the body hash, to detect an edit made after approval (SC-2 check 4). */
  bodySha256(issueNumber: number): Promise<Result<string, AppError>>;

  /**
   * Close an issue.
   *
   * WHY IT IS HERE AND NOT ONLY ON THE ADAPTER: a rejected or expired request must not leave
   * an open issue behind forever. This lived on the GitHub adapter's own widened interface,
   * which meant a MODULE - which only ever sees `IssuesPort` through `ctx.ports` - could not
   * call it, and the builder's Reject path silently abandoned the issue.
   *
   * `reason` maps to GitHub's `state_reason`: a rejected request is `not_planned`, not
   * `completed`, so it does not read as shipped in the issue list.
   */
  close(issueNumber: number, reason: 'not_planned' | 'completed'): Promise<Result<void, AppError>>;

  /**
   * Reopen a closed issue.
   *
   * WHY IT IS HERE, next to `close` and for the same reason `close` is: `/request retry` files
   * a FRESH approval card against the ORIGINAL issue, and that issue was closed `not_planned`
   * when the request expired. Without this the bot asks an approver to approve work against a
   * closed, "we decided against it" issue - and if they approve, an agent is dispatched at an
   * issue GitHub shows as declined. The card says the request is live and the issue says it is
   * dead; one of those two is lying, and only this method can stop it being the issue.
   *
   * IT IS DELIBERATELY NOT `close(n, 'reopened')`. Reopening is not a closing reason, and a
   * state change hiding inside a word that means the opposite is not a thing a reader of a
   * retry path should have to work out.
   *
   * SAFE ON AN ALREADY-OPEN ISSUE: GitHub answers 200 and changes nothing, so a retry of a
   * retry does not have to look first. It returns `void` rather than "was it closed?" - the
   * caller wants the issue OPEN, and which of the two ways it got there is not a fact any card
   * should be rendering.
   */
  reopen(issueNumber: number): Promise<Result<void, AppError>>;
}

/**
 * What may be passed as a `workflow_dispatch` input.
 *
 * A plain `string` is deliberately absent (SC-1). `ActionsToken` has six fixed-shape
 * constructors in `#core/text` and no caller-supplied-regex escape hatch, so free text has no
 * path to a `${{ }}` context at all.
 */
export type ActionsInput = number | boolean | ActionsToken;

/** An adopted workflow run. */
export interface RunRef {
  readonly runId: number;
  readonly runUrl: HttpsUrl;
}

/**
 * The dispatch outcome.
 *
 * WHY a union and not `RunRef | null`: GitHub returns 200 with run details only when
 * `return_run_details: true` is honoured, and 204 with an empty body otherwise. Both really
 * happen. Forcing the caller to name the `blind` case is what makes the `run-name` fallback
 * get written instead of forgotten.
 */
export type DispatchOutcome =
  | { readonly kind: 'adopted'; readonly run: RunRef }
  | { readonly kind: 'blind'; readonly correlateBy: ActionsToken };

/**
 * Terminal and non-terminal states of a workflow run.
 *
 * WHY EVERY ARM CARRIES `runUrl`, INCLUDING THE HAPPY ONES. The adapter has always read
 * `html_url` off the run payload and thrown it away, so the only place a run link ever existed
 * was `RunRef` - available at dispatch, and gone by the first poll. That left the poller with
 * no link to render, and "your build failed" with nothing to open is the least actionable
 * message this product can produce: the run log is the ONLY artefact that says why.
 *
 * It is on the non-terminal arms too, deliberately. A card that says "building..." for twenty
 * minutes with nothing to watch is indistinguishable from a bot that hung, and the link is
 * exactly as available at minute one as it is at minute thirty.
 *
 * WHY `HttpsUrl | null` AND NOT AN OPTIONAL FIELD: `exactOptionalPropertyTypes` is on, so an
 * absent property and an explicitly-undefined one are different types and a renderer would
 * have to handle both. `null` is ONE state with one meaning - "GitHub did not give us a URL
 * this process could parse" - and making the field REQUIRED on every arm is what stops a
 * future arm quietly forgetting it.
 *
 * It is never free text: `parseHttpsUrl` is the only door to an `HttpsUrl`, so a card cannot
 * turn a string off the network into a link button by accident.
 */
export type RunStatus =
  | { readonly kind: 'queued'; readonly runUrl: HttpsUrl | null }
  | { readonly kind: 'in-progress'; readonly runUrl: HttpsUrl | null }
  | { readonly kind: 'success'; readonly runUrl: HttpsUrl | null }
  | { readonly kind: 'cancelled'; readonly runUrl: HttpsUrl | null }
  | { readonly kind: 'failure'; readonly runUrl: HttpsUrl | null; readonly detail: string };

/**
 * What asking GitHub to cancel a run actually achieved.
 *
 * WHY A UNION AND NOT `void`, AND NOT A BOOLEAN. The endpoint answers **202 Accepted** when it
 * has accepted the request to stop, and **409 Conflict** when the run had already finished -
 * and 409 is NOT a failure. "There was nothing left to cancel" is a successful outcome of
 * `/request cancel`; mapping it to an `AppError` would put "GitHub refused that" in front of
 * somebody whose build finished a second before they clicked, which is both alarming and false.
 *
 * The two are still DIFFERENT, which is why they do not collapse into `Ok(void)`:
 *   `requested`        - money stops being spent from about now. A card may say "cancelling".
 *   `already-finished` - the run is over; its cost is already paid, and its result exists. A
 *                        card that says "cancelled, nothing was spent" would be wrong, and a
 *                        caller that wants to look for the pull request anyway needs to know.
 *
 * Note what 202 does NOT mean: the run is not stopped yet. GitHub tears down jobs
 * asynchronously, so a poll immediately after this can still read `in_progress`. Only
 * `RunStatus` says whether it is over.
 */
export type CancelOutcome =
  /** 202: GitHub accepted the cancellation. The run is stopping, not yet stopped. */
  | { readonly kind: 'requested' }
  /** 409: the run had already reached a terminal state. Nothing was cancelled; nothing failed. */
  | { readonly kind: 'already-finished' };

/**
 * One repository Actions variable, as an answer rather than as a string.
 *
 * WHY THE RAW VALUE IS NOT HERE. Nothing else on any port hands a module an arbitrary string
 * off the network - `RunStatus.failure.detail` is selected from a closed vocabulary,
 * `EnvironmentCredentials.credentials` is an allow-list, `IssueRef.bodySha256` is a digest -
 * because a network string that reaches a renderer is the shape of every leak this repo is
 * built to prevent. The one variable this exists for holds a NUMBER, so the port answers with
 * a number and the invariant survives. A caller that genuinely needs a textual variable is a
 * new arm here, reviewed, rather than a `string` field that quietly becomes a door.
 *
 * WHY THREE ARMS AND NOT `number | null`, in the same spirit as `DispatchOutcome`: all three
 * really happen, they mean completely different things to an operator, and the two unhappy
 * ones are the ones a `null` would hide.
 *
 * `unset` IS NOT ZERO AND IS NOT AN ERROR. GitHub answers 404 for a variable that was never
 * created, and the workflow then falls back to its own literal default - so the honest reading
 * is "the default applies", and a caller that treated it as 0 would report a cap of zero on a
 * perfectly healthy repository.
 */
export type RepositoryVariable =
  /** GitHub has no such variable. Whatever default the workflow spells out is what applies. */
  | { readonly kind: 'unset'; readonly name: string }
  /** Set to a plain non-negative integer, which is the only shape a cap can usefully have. */
  | { readonly kind: 'number'; readonly name: string; readonly value: number }
  /**
   * Set to something that is not a plain non-negative integer.
   *
   * NOT A COSMETIC COMPLAINT: the workflow's own guard is
   * `case "$DAILY_CAP" in ''|*[!0-9]*) ... exit 1`, so ` 4 `, `4.0`, `-1` and `four` all mean
   * every future build dies in its first seconds with an error only the Actions log carries.
   * That is worth saying out loud, and it is unsayable if this arm collapses into `unset`.
   */
  | { readonly kind: 'not-a-number'; readonly name: string };

/**
 * GitHub's own rule for an Actions variable name: letters, digits and underscores, never
 * starting with a digit, at most 200 characters.
 *
 * WHY IT IS IN CORE RATHER THAN IN THE ADAPTER THAT NEEDS IT: the name becomes a REST path
 * segment, and the fake has to refuse exactly what the real adapter refuses or a module can
 * pass a name that works offline and 404s in production. Same reasoning, and the same shape, as
 * `isBuildEnvironmentName`.
 */
const VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,199}$/u;

export function isRepositoryVariableName(value: string): boolean {
  return VARIABLE_NAME.test(value);
}

/**
 * What a `${vars.X}` cap looks like TO THE WORKFLOW, which is the only reading that matters.
 *
 * `^\d{1,15}$` is deliberately the strictest possible reading, because it mirrors the
 * workflow's own guard - `case "$DAILY_CAP" in ''|*[!0-9]*) ... exit 1` - on everything an
 * operator can plausibly type. ` 4 `, `4.0`, `+4`, `-1` and `four` are all rejected THERE, so a
 * checker that quietly accepted them here would report agreement about a value that kills every
 * build. Leniency is the one thing this function must not have.
 *
 * The 15-digit ceiling is about `Number`: past `Number.MAX_SAFE_INTEGER` an integer stops being
 * exactly representable, and an inexact cap comparison is worse than none. Nobody sets a daily
 * build cap of a quadrillion.
 */
const NON_NEGATIVE_INTEGER = /^\d{1,15}$/u;

/**
 * Read one variable's raw value into the answer `BuildsPort.repositoryVariable` promises.
 *
 * Pure and total, so "is `AGENT_DAILY_RUN_CAP` a number the workflow will accept?" is a unit
 * test rather than a discovery during somebody's build. Shared by the adapter and the fake for
 * the reason every shared definition here is shared: two copies disagree eventually, and the
 * disagreement shows up as a green test suite over a broken bot.
 */
export function toRepositoryVariable(name: string, value: string): RepositoryVariable {
  return NON_NEGATIVE_INTEGER.test(value)
    ? { kind: 'number', name, value: Number.parseInt(value, 10) }
    : { kind: 'not-a-number', name };
}

/**
 * An opened pull request.
 *
 * WHY `isDraft` IS HERE. The composed agent prompt gives the agent three legitimate endings:
 * finish and open a pull request, refuse and open none, or run out of room and "still commit,
 * push, and open the PR with --draft" describing what remains. Without this field the builder
 * could distinguish only the first and the third, so an UNFINISHED build was reported to the
 * requester as "Pull request opened" - the one wrong answer of the three, because it invites
 * somebody to merge work the agent itself said was incomplete.
 *
 * It is REQUIRED rather than optional: GitHub sends `draft` on every pull request payload, and
 * an optional field would let a future adapter forget it and silently resume mis-reporting the
 * ending that matters most.
 */
/**
 * What the build workflow's last step reports about a run, read back from the issue comment it
 * posts. `failedStep`, `stop` and `turns` are computed by the workflow; only `agent` is written
 * by the model, so it is untrusted text and every string in it goes through `sanitizeStored`.
 */
export type RunFailedStep =
  | 'approval'
  /** The token verified, but it was older than APPROVAL_MAX_AGE_SECONDS at the run's creation. */
  | 'approval_expired'
  /** The token verified, but its approval id had already been used by an earlier run. */
  | 'approval_replayed'
  | 'credentials'
  | 'daily_cap'
  | 'setup'
  | 'agent'
  | 'forbidden_path';

export interface RunReport {
  /** The first guard that failed, or null when every step the run reached passed. */
  readonly failedStep: RunFailedStep | null;
  /** Claude Code's result subtype (`success`, `error_max_turns`, ...), or null if it never ran. */
  readonly stop: string | null;
  readonly turns: number | null;
  /** The agent's own closing report, or null when it ended without one (turn limit, crash). */
  readonly agent: {
    readonly status: 'done' | 'partial' | 'refused';
    readonly summary: string;
    readonly remaining: string;
  } | null;
}

export interface PrRef {
  readonly number: number;
  readonly url: HttpsUrl;
  readonly branch: string;
  /** True when the agent opened the PR with `--draft`, i.e. it did not finish the work. */
  readonly isDraft: boolean;
}

/**
 * The two secret names the build workflow can pay with. A user supplies ONE of them.
 *
 *   ANTHROPIC_API_KEY        metered console billing         `sk-ant-api<n>-...`
 *   CLAUDE_CODE_OAUTH_TOKEN  a Pro/Max subscription          `sk-ant-oat<n>-...`
 *
 * The workflow passes both to the action and lets whichever exists resolve, so the bot never
 * has to know which one a given user chose - only that at least one is there.
 */
export type BuildCredentialName = 'ANTHROPIC_API_KEY' | 'CLAUDE_CODE_OAUTH_TOKEN';

/**
 * What a GitHub environment holds, BY NAME ONLY.
 *
 * READ THE ABSENCE: there is no field carrying a secret value, and there is no method anywhere
 * on this port that returns one. GitHub environment secrets are write-only by design, and this
 * whole feature exists so the bot stores no credential - so the port is shaped to make
 * "the bot read the user's key" not a thing that can be expressed, rather than a thing we
 * remember not to do.
 *
 * `exists: false` and an empty `credentials` are DIFFERENT states and the difference decides
 * who pays:
 *   - no environment  -> this user never brought credentials; the shared one funds the build.
 *   - an environment holding nothing -> they DID bring credentials and the credential is gone
 *     (revoked, rotated, deleted). Falling back to the shared environment here would silently
 *     bill the operator for a build the user chose to fund themselves, so it is an error.
 */
export interface EnvironmentCredentials {
  /** Echoed back so a caller that asked about two environments cannot confuse the answers. */
  readonly environmentName: string;
  /** False when GitHub has no such environment. */
  readonly exists: boolean;
  /** Which of the two paying secrets are set. Names only - never values. */
  readonly credentials: readonly BuildCredentialName[];
}

/** Actions sub-port. WHY split from `issues`: filing an issue is cheap and reversible;
 *  dispatching a workflow spends money and writes to the repo. One reviewable line in the
 *  manifest has to be able to tell them apart. */
export interface BuildsPort {
  dispatch(input: {
    readonly workflowFile: WorkflowFile;
    readonly ref: GitRef;
    readonly inputs: Readonly<Record<string, ActionsInput>>;
    /** Value of the workflow's `run-name`, used to correlate a blind dispatch. */
    readonly runName: ActionsToken;
  }): Promise<Result<DispatchOutcome, AppError>>;

  /**
   * Correlate a blind dispatch by `run-name`, bounded by a start time.
   *
   * `excludeRunId` leaves one run out of the search. The replay path needs it: the run that
   * reported `approval_replayed` carries the same approval id in its name as the earlier run
   * it was refused in favour of, and it is the newer of the two, so without the exclusion the
   * search would hand back the refused run itself.
   */
  findRunByName(runName: ActionsToken, sinceMs: number, excludeRunId?: number): Promise<Result<RunRef | null, AppError>>;

  /**
   * How many runs of one workflow GitHub has recorded since `sinceMs`. THE DAILY CAP'S ONLY
   * HONEST SOURCE.
   *
   * WHY IT ASKS GITHUB RATHER THAN COUNTING ROWS: the thing being capped is Actions minutes and
   * Anthropic spend, and both are consumed by every run of that workflow - including runs this
   * process never filed, runs filed by a previous deploy whose database was replaced, and runs
   * a human started from the Actions tab. A counter in `m_builder_*` counts what THIS bot
   * remembers doing, which is a strictly smaller number than what was actually spent, and it
   * resets to zero whenever somebody restores a backup or points `DATABASE_PATH` somewhere new.
   * A cap that can be reset by losing a file is not a cap.
   *
   * WHY IT IS SEPARATE FROM `findRunByName` even though it is the same listing endpoint family:
   * that one answers "which run is MINE", and it must stay filtered to `workflow_dispatch` and
   * matched on a token. This one answers "how much of today is gone", and must count runs from
   * every trigger, including a manual one - so it is the same call with a different filter, and
   * merging them would mean one of the two questions gets the wrong answer.
   *
   * `workflowFile` is branded, so it is a validated path segment and never free text.
   * `sinceMs` is absolute epoch milliseconds; pass `clock.now() - windowMs`.
   */
  runsSince(workflowFile: WorkflowFile, sinceMs: number): Promise<Result<number, AppError>>;

  /** Poll. Called from a durable job, never from an interaction handler. */
  runStatus(runId: number): Promise<Result<RunStatus, AppError>>;

  /**
   * Ask GitHub to stop a run.
   *
   * THE PRODUCT FAILURE THIS CLOSES: `/request cancel` stopped the BOT and freed the slot while
   * the Actions run carried on to the end - burning the REQUESTER'S OWN Anthropic credits, and
   * a daily-cap slot, on a build whose result nobody would ever look at. The bot said
   * "cancelled" and the only thing it had actually cancelled was its own interest.
   *
   * IT IS NOT `JobsPort.cancel`, AND BOTH ARE NEEDED. `jobs.cancel` stops the POLLER - work
   * inside this process. This stops the RUN - work inside GitHub, which is where the money is.
   * Cancelling the poller alone is precisely the bug above; cancelling the run alone leaves a
   * poller watching a run it asked to die.
   *
   * `runId` is a number GitHub gave us, carried on `RunRef`/`DispatchOutcome`, so there is
   * nothing here for a caller to invent.
   */
  cancelRun(runId: number): Promise<Result<CancelOutcome, AppError>>;

  /**
   * Read one repository Actions VARIABLE - the operator-set half of a setting the bot also
   * holds a copy of.
   *
   * THE ONE THIS EXISTS FOR: `AGENT_DAILY_RUN_CAP`. The workflow reads
   * `vars.AGENT_DAILY_RUN_CAP || '4'` and exits 1 over it; the bot refuses at
   * `modules.builder.dailyRunCap` before dispatching. The two are equal only because an
   * operator keeps them so, and when they drift the bot cheerfully dispatches builds the
   * workflow then refuses - the requester's card says "building", the run dies in its first
   * seconds, and the only place the reason exists is a log line in Actions. Being able to READ
   * the variable is what turns that from a paragraph in the docs into something the bot can
   * notice and say.
   *
   * NOT A SECRET, and that is a property of the endpoint rather than a promise made here:
   * GitHub's Actions VARIABLES are plaintext by design and are printed in run logs. The secrets
   * endpoints return names only, and nothing on this port returns a secret value at all.
   */
  repositoryVariable(name: string): Promise<Result<RepositoryVariable, AppError>>;

  /** The PR the build opened, if any. */
  findPrForBranch(branch: string): Promise<Result<PrRef | null, AppError>>;

  /** The workflow's report for one request, from its comment on the issue; null if it posted none. */
  findRunReport(issueNumber: number, runId: number): Promise<Result<RunReport | null, AppError>>;

  /**
   * Which paying secrets an environment holds. Names only; see `EnvironmentCredentials`.
   *
   * WHY THE BOT ASKS AT ALL, instead of dispatching and finding out: an environment that holds
   * no credential does not fail the dispatch. GitHub happily starts the run, and the missing
   * key surfaces as an auth error INSIDE the agent step, up to thirty minutes later, having
   * consumed a concurrency slot, a daily-cap slot and Actions minutes - and the user sees
   * "build failed" with no hint that the cause is their own expired key. One read before
   * spending turns that into an immediate, specific message.
   *
   * WHY IT ALSO ANSWERS FOR THE SHARED ENVIRONMENT: exactly the same failure exists there, and
   * on a fresh install it is the LIKELY one - `ai-agent` ships holding only APPROVAL_HMAC_KEY.
   *
   * `environmentName` is a REST path segment. The adapter re-validates it with
   * `isBuildEnvironmentName` and refuses anything else, so this is not a door into the API for
   * an arbitrary string that reached a caller from somewhere unexpected.
   */
  environmentCredentials(environmentName: string): Promise<Result<EnvironmentCredentials, AppError>>;

  /**
   * Sign an approval so GitHub can verify it WITHOUT trusting this process.
   *
   * WHY IT LIVES ON THE PORT AND NOT IN THE MODULE: the MAC key is a secret. If a module
   * computed the token it would need that key in `ctx.config`, which drags a signing secret
   * into every module's blast radius and into `MODULES_JSON`. The adapter is built once in the
   * composition root holding the key, and hands modules a finished token they cannot forge.
   *
   * The token covers
   * `v2.<requestId>.<approvalId>.<issueNumber>.<bodySha256>.<environmentName>.<issuedAtSec>.<repository>`
   * and is re-checked by `.github/scripts/verify_approval.py` before the workflow spends
   * anything. Binding the body digest is what stops "get something harmless approved, then
   * rewrite the issue".
   *
   * WHY `approvalId` AND `issuedAtSec` ARE IN THE TUPLE: dispatch inputs print in plaintext in
   * the run log, so the token was a non-expiring bearer token anyone with repository read
   * could replay. The approval id is persisted on the row and consumed once by the workflow
   * (a replay is refused), and the issue time lets the workflow refuse a token older than
   * APPROVAL_MAX_AGE_SECONDS at the run's creation. `issuedAtSec` is Unix SECONDS, not ms,
   * because the shell on the other side compares it to `date +%s`-shaped numbers.
   *
   * `repository` is NOT a parameter: the adapter supplies `owner/name` as GitHub spells it,
   * so a module cannot sign for a repository other than the one the adapter is bound to.
   *
   * WHY `environmentName` IS IN THE TUPLE, and why it is not optional: `environment_name` is a
   * NON-SECRET dispatch input, and a live probe confirmed dispatch inputs are printed verbatim
   * in the run title, the REST API and the job log. So anyone who can dispatch this workflow
   * can also read and choose that value. Without binding it, repo write access would be enough
   * to re-dispatch an already-approved request against SOMEBODY ELSE'S environment and spend
   * their Anthropic credits - the approval MAC would still verify, because it would not have
   * covered the field that decides who pays. The MAC key lives only in the bot and in the
   * `ai-agent` environment, so binding the name makes the choice of payer unforgeable.
   *
   * `bodySha256` MUST be the digest of the body AS GITHUB RETURNS IT — use
   * `IssuesPort.bodySha256`, never a hash of the string this process sent, or the two sides
   * disagree the first time GitHub normalises anything and every build is rejected.
   */
  signApproval(input: {
    readonly requestId: string;
    /** The row's persisted approval id, exactly the string sent as the `approval_id` input. */
    readonly approvalId: string;
    readonly issueNumber: number;
    readonly bodySha256: string;
    /** Exactly the string sent as the `environment_name` input. Built by `buildEnvironmentName`. */
    readonly environmentName: string;
    /** Unix seconds, exactly the number sent as the `approval_issued_at` input. */
    readonly issuedAtSec: number;
  }): ActionsToken;
}

/** Short alias. */
export type Builds = BuildsPort;

// ---------------------------------------------------------------------------------------
// Durable jobs
// ---------------------------------------------------------------------------------------

/** Retry shape. Bounded by construction; there is no "retry forever". */
export interface Backoff {
  readonly initialMs: number;
  readonly factor: number;
  readonly maxMs: number;
  /** Random fraction added to each delay, so N restarted pollers do not thunder. */
  readonly jitter: number;
}

/** WHY a constant and not a magic number in the adapter: `onShutdown` and the reclaimer both
 *  have to agree on how long a lease is held, and disagreement means a stalled queue. */
export const JOB_LEASE_MS = 60_000;

/**
 * A unit of durable work.
 *
 * `payload` is `JsonObject`. That IS the restart contract: anything a job needs must survive
 * `JSON.stringify` and a process death. A `ProgressHandle`, an interaction, a discord.js
 * object, a `Date`, a `bigint` and a closure are all structurally rejected - which is how "the
 * bot restarted and forgot about the build" is prevented rather than documented.
 */
export interface JobRequest {
  /** Matches a `JobSpec.type` declared by the same module. */
  readonly type: string;
  readonly payload: JsonObject;
  /** Earliest run time, absolute ms. Use `clock.now() + delay`. */
  readonly runAfterMs: number;
  /** Absolute give-up time. Bounds any poller (SC-14). */
  readonly deadlineAtMs: number;
  /** One live job per (module, dedupeKey). The double-click fence for async work. */
  readonly dedupeKey: string | null;
}

/** WHY `created` is on the success arm: "a job for this key already exists" is a routine,
 *  branchable outcome - it is exactly what a second Approve click must see - and the previous
 *  designs left it either thrown or silently indistinguishable from a fresh enqueue. */
export interface EnqueueResult {
  readonly id: JobId;
  readonly created: boolean;
}

/**
 * Enqueue port. SYNCHRONOUS on purpose: the enqueue must happen inside the same SQLite
 * transaction as the state change that justified it, so a crash between the two is impossible
 * rather than unlikely.
 */
export interface JobsPort {
  enqueue(req: JobRequest): Result<EnqueueResult, AppError>;
  /** Cancel a live job. `false` when it had already finished. */
  cancel(id: JobId): Result<boolean, AppError>;
  /** WHY a lookup and not just dedupe-on-insert: a handler wants to say "already building". */
  findByDedupeKey(dedupeKey: string): JobId | undefined;
}

/** Short alias. */
export type Jobs = JobsPort;

// ---------------------------------------------------------------------------------------
// Guild settings
// ---------------------------------------------------------------------------------------

/**
 * Per-guild overrides (`core_settings`).
 * WHY separate from module `config`: config is per-process and comes from env; settings are
 * per-guild and edited at runtime by an admin command. Conflating them is how "why is this
 * different in the other server?" happens.
 */
export interface SettingsPort {
  get(guildId: GuildId, key: string): JsonObject | undefined;
  set(guildId: GuildId, key: string, value: JsonObject): void;
  all(guildId: GuildId): Readonly<Record<string, JsonObject>>;
}

// ---------------------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------------------

/** What `/status` and `/readyz` render per module. `detail` is required so "ok" says why. */
export interface HealthReport {
  readonly status: 'ok' | 'degraded' | 'down';
  /** One short line for a human. No secrets, no stack traces. */
  readonly detail: string;
}

// ---------------------------------------------------------------------------------------
// The capability map - the single most load-bearing type in the repo
// ---------------------------------------------------------------------------------------

/**
 * Every port that exists, keyed by the word a module writes in `capabilities`.
 * Adding a key here is a core change and therefore a CODEOWNERS-reviewed PR, which is the
 * intended friction: a new capability is a new piece of blast radius.
 */
export interface PortRegistry {
  readonly db: DbPort;
  readonly audit: AuditPort;
  readonly clock: ClockPort;
  readonly jobs: JobsPort;
  readonly discord: DiscordPort;
  readonly issues: IssuesPort;
  readonly builds: BuildsPort;
  readonly settings: SettingsPort;
  readonly catalog: CatalogPort;
  readonly access: AccessPort;
  readonly secrets: SecretsPort;
  readonly admin: AdminPort;
  readonly version: VersionPort;
}

/** WHY derived from the registry rather than written twice: adding a port makes it a legal
 *  capability automatically, and a typo in `capabilities` is TS2322. */
export type Capability = keyof PortRegistry & string;

/**
 * Every capability, for the runtime narrowing and for `/status`.
 * The `satisfies` clause below fails to compile if a port is added and not listed here, so the
 * duplication cannot drift.
 */
export const ALL_CAPABILITIES = [
  'db',
  'audit',
  'clock',
  'jobs',
  'discord',
  'issues',
  'builds',
  'settings',
  'catalog',
  'access',
  'secrets',
  'admin',
  'version',
] as const satisfies readonly Capability[];

/** Compile-time completeness check for `ALL_CAPABILITIES`. Never read at runtime. */
export const CAPABILITY_LIST_IS_COMPLETE: Capability extends (typeof ALL_CAPABILITIES)[number] ? true : never = true;

/**
 * THE type that makes `capabilities` load-bearing.
 *
 * `PortsFor<['db','audit','clock']>` is `{ db; audit; clock }` and nothing else, so
 * `ctx.ports.builds` in that module is TS2339 naming the property - and it is `undefined` at
 * runtime too, because `portsFor` builds the object from the same list.
 */
export type PortsFor<C extends readonly Capability[]> = {
  readonly [K in C[number]]: PortRegistry[K];
};

/**
 * THE WIDENING SENTINEL - the hole every earlier design shared.
 *
 * `const CAPS: readonly Capability[] = ['db']` makes `C[number]` equal `Capability`, at which
 * point `PortsFor<C>` expands to the ENTIRE registry and the blast-radius declaration silently
 * means nothing. Worse, the compiler taught contributors into it: hoisting the array without an
 * annotation produces an error whose text NAMES `readonly Capability[]` as the expected type,
 * so the obvious repair IS the hole. A `[...preset]` spread does the same thing.
 *
 * Intersecting the manifest field with this turns all three widened forms into a compile error
 * that PRINTS the fix - and, because the sentinel's payload is a message rather than a type,
 * the commoner mistake (`capabilities: ['gihub']`) prints the same sentence while naming the
 * offending member. A literal tuple resolves to `unknown` and constrains nothing.
 */
export type CapabilityTupleMessage =
  'ERROR: `capabilities` must be an inline tuple of port names, e.g. ["db","audit"] - a widened `Capability[]` would silently grant every port in the bot';

export type LiteralCaps<C extends readonly Capability[]> = [Capability] extends [C[number]]
  ? readonly [CapabilityTupleMessage]
  : unknown;

/**
 * Runtime proof that the loader supplied every declared capability.
 * WHY a type predicate rather than a cast: narrowing through a predicate is how a mapped type
 * is produced without `as`, and it forces the runtime check to exist.
 */
function hasEvery<C extends readonly Capability[]>(
  bag: Readonly<Partial<PortRegistry>>,
  caps: C,
): bag is Readonly<Partial<PortRegistry>> & PortsFor<C> {
  for (const c of caps) if (bag[c] === undefined) return false;
  return true;
}

/**
 * Narrow the wired port bag to EXACTLY what a module declared.
 *
 * WHY it deletes rather than returning the caller's object: the previous design returned the
 * full bag with a narrower type, so the widening hole above became a genuine runtime
 * capability escape instead of a `TypeError`. Deleting makes the runtime object agree with the
 * type, so even if a widened tuple slips past review, an undeclared port is `undefined`.
 *
 * WHY `Reflect.deleteProperty` and not `delete`: `delete` on a non-optional property is TS2790.
 */
export function portsFor<C extends readonly Capability[]>(
  provided: Readonly<Partial<PortRegistry>>,
  caps: C,
  moduleId: string,
): Result<PortsFor<C>, AppError> {
  const bag: Partial<PortRegistry> = { ...provided };
  for (const cap of ALL_CAPABILITIES) {
    if (!caps.includes(cap)) Reflect.deleteProperty(bag, cap);
  }
  if (hasEvery(bag, caps)) return Ok(bag);
  const missing = caps.filter((c) => bag[c] === undefined);
  return Err(
    errors.config(
      moduleId,
      `module "${moduleId}" declares capabilities [${missing.join(', ')}] that the composition root did not wire`,
      'Wire the port in src/composition.ts, or remove the capability from the module manifest.',
    ),
  );
}

/** Re-exported so a module needs one import for message ids. */
export type { MessageId };
