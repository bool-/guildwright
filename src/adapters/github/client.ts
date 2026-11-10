/**
 * The GitHub client, and the ONE place an octokit failure becomes an `AppError`.
 *
 * THREE THINGS THIS FILE IS RESPONSIBLE FOR, ALL OF THEM LOAD-BEARING:
 *
 *  1. PINNING THE API VERSION - and doing it with a request hook rather than a constructor
 *     option. `@octokit/core@7`'s constructor builds its `requestDefaults` from `baseUrl`,
 *     `userAgent`, `previews` and `timeZone` ONLY; a top-level `headers` option is silently
 *     dropped on the floor (read `node_modules/@octokit/core/dist-src/index.js`). Passing
 *     `headers: {...}` therefore LOOKS like a pin, typechecks (OctokitOptions carries an
 *     `[option: string]: any` index signature, so nothing complains) and pins nothing. The
 *     `hook.before('request')` below applies to every request the instance makes, including
 *     the one in `dispatch.ts`.
 *
 *  2. MAPPING a thrown octokit error to `AppError`, once, so no caller invents its own 404
 *     wording and no caller forgets that a 404 is usually a token-scope problem.
 *
 *  3. KEEPING THE TOKEN OUT OF EVERY STRING THAT COULD REACH DISCORD (SC-6). An octokit
 *     `RequestError` carries `request.headers.authorization`, and its `message` can echo a
 *     request body. NOTHING read off the error object is interpolated into `userDetail` or
 *     `nextStep`: those are developer-authored sentences selected by status code. The only
 *     value that crosses over is a hand-built `internal` line (status, error codes, error
 *     class name), and it goes through core's `redactSecrets` even though `userMessage()`
 *     structurally cannot read `internal` at all.
 */

import { Octokit } from 'octokit';
import { z } from 'zod';
import { describeWait, errors, type AppError } from '#core/errors';
import { redactSecrets } from '#core/text';
import type { Secret } from '#core/config';
import type { LoggerPort } from '#core/ports';

// ---------------------------------------------------------------------------------------
// The pinned API version
// ---------------------------------------------------------------------------------------

/**
 * GitHub currently offers two REST API versions: `2026-03-10` and `2022-11-28`. Verified:
 * a request on `2022-11-28` comes back carrying `Deprecation: true` with `Sunset: 2028-03-10`,
 * and `return_run_details` on the workflow-dispatch endpoint is honoured on BOTH
 * (docs/ARCHITECTURE.md section 3).
 *
 * So `2026-03-10` is pinned deliberately: it is the choice that is not already dated for
 * removal, and every response this adapter reads is zod-validated, so a shape change on a
 * version we chose fails loudly in one place rather than silently in several.
 *
 * WHY pin at all rather than omit the header: an unpinned request gets whatever GitHub's
 * current default is, so the bot's behaviour would change on GitHub's schedule instead of on
 * a commit of ours.
 */
export const GITHUB_API_VERSION = '2026-03-10';

/** Sent so GitHub can identify the client in abuse reports. Never contains a credential. */
export const GITHUB_USER_AGENT = 'discord-ai-feature-builder';

/**
 * Statuses the bundled retry plugin must never retry.
 *
 * WHY 401/403 are here rather than "not retried by convention": hammering an auth failure is
 * how a bad token becomes a Cloudflare block on the whole IP (SC-12), and core's `isRetryable`
 * already refuses to retry them - the transport has to agree or the rule is a comment.
 * 400/404/422 are deterministic: the same request yields the same answer forever.
 *
 * WHY 409 JOINED THEM. `POST /actions/runs/{id}/cancel` answers 409 for a run that has already
 * finished, and that is not a failure at all - it is the ROUTINE outcome of `/request cancel`
 * on a build that completed a second before the click, which `BuildsPort.cancelRun` maps to
 * `already-finished`. The retry plugin retries every `>= 400` it has not been told about, so
 * without this line the commonest successful path through that endpoint cost four requests and
 * roughly fourteen seconds of exponential backoff before the adapter ever saw the answer. Like
 * the rest of the list, it is deterministic: a finished run does not become cancellable.
 */
export const DO_NOT_RETRY: readonly number[] = [400, 401, 403, 404, 409, 422];

/** Transport-level retries for the statuses that ARE worth retrying (5xx and network). */
export const TRANSPORT_RETRIES = 3;

/** How many times the throttler waits out a primary rate limit before giving up. */
export const THROTTLE_RETRIES = 2;

/** Which repository a client is bound to. Config values, never user text. */
export interface GithubRepo {
  readonly owner: string;
  readonly repo: string;
}

// ---------------------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------------------

/** The subset of the throttler's callback options this adapter actually reads. */
interface ThrottleRequestOptions {
  readonly method?: string;
  readonly url?: string;
}

/** What `new Octokit(...)` accepts. Derived, so no transitive `@octokit/*` type is imported. */
type OctokitOptions = NonNullable<ConstructorParameters<typeof Octokit>[0]>;

/**
 * THE PIN, as a plugin. See the header: a constructor `headers` option would be dropped silently.
 *
 * WHY A PLUGIN rather than one `hook.before` on one instance: in App mode the bundled
 * `@octokit/app` constructs the instances itself (the JWT-authenticated `app.octokit`, and one
 * per installation from `getInstallationOctokit`). A plugin on the CLASS is applied to every
 * instance that class ever makes, so no instance the App builds can be the one that forgot.
 */
const pinApiVersion: Parameters<typeof Octokit.plugin>[0] = (octokit) => {
  octokit.hook.before('request', (options) => {
    options.headers['x-github-api-version'] = GITHUB_API_VERSION;
  });
};

/** The class every GitHub client in the bot is an instance of. */
export type GithubOctokitClass = typeof Octokit;

/**
 * The Octokit CLASS the bot uses, with every policy baked in: user agent, transport, retry,
 * throttle, structured redacted logging, and the API-version pin.
 *
 * `octokit@5.0.5` already bundles `@octokit/plugin-retry` and `@octokit/plugin-throttling`
 * (see `node_modules/octokit/dist-src/octokit.js`), so this CONFIGURES them rather than adding
 * a dependency. The package's own defaults retry a rate limit exactly once and log to
 * `console`; both are replaced here so the policy is ours and the logging is structured.
 *
 * WHY A CLASS AND NOT AN INSTANCE: a PAT needs one instance, but a GitHub App hands its class to
 * `@octokit/app`, which builds the instances (RFC-001 6.4 step 3). Both modes therefore get
 * byte-for-byte the same options from this one function instead of two copies that drift.
 *
 * WHY THE DEFAULTS ARE A FUNCTION: `@octokit/app` builds each installation client from the
 * App client's own constructor options, and `Octokit.defaults({...})` with an object CONCATENATES
 * `userAgent` on every such hop. A function overwrites it, so the header stays one product name.
 */
export function githubOctokitClass(input: {
  readonly logger: LoggerPort;
  /**
   * Transport override.
   *
   * WHY it is on the production factory rather than hidden in a test file: the API-version
   * pin, the retry policy and the throttle policy are properties of the CLIENT, so a test
   * that builds its own bare `Octokit` proves nothing about the one the bot runs. Injecting
   * the transport is how those get exercised offline. It doubles as the seam an operator
   * behind a corporate proxy needs.
   */
  readonly fetch?: typeof globalThis.fetch;
}): GithubOctokitClass {
  const log = input.logger.child({ component: 'github' });
  const fetchImpl = input.fetch;

  const policy = (options: OctokitOptions): OctokitOptions => ({
    ...options,
    userAgent: GITHUB_USER_AGENT,
    request: fetchImpl === undefined ? { ...options.request } : { ...options.request, fetch: fetchImpl },
    retry: { doNotRetry: [...DO_NOT_RETRY], retries: TRANSPORT_RETRIES },
    throttle: {
      onRateLimit(
        retryAfterSeconds: number,
        options: ThrottleRequestOptions,
        _octokit: unknown,
        retryCount: number,
      ): boolean {
        log.warn('github primary rate limit', {
          method: options.method ?? 'unknown',
          url: options.url ?? 'unknown',
          retryAfterSeconds,
          retryCount,
        });
        return retryCount < THROTTLE_RETRIES;
      },
      onSecondaryRateLimit(
        retryAfterSeconds: number,
        options: ThrottleRequestOptions,
        _octokit: unknown,
        retryCount: number,
      ): boolean {
        // A secondary limit is the abuse detector talking. Backing off once is correct;
        // looping on it is precisely the behaviour that escalates to a block.
        log.warn('github secondary rate limit', {
          method: options.method ?? 'unknown',
          url: options.url ?? 'unknown',
          retryAfterSeconds,
          retryCount,
        });
        return retryCount < 1;
      },
    },
    // octokit logs request URLs, which carry no credential - redaction is cheap insurance.
    log: {
      debug: (message: string) => log.debug(redactSecrets(message)),
      info: (message: string) => log.info(redactSecrets(message)),
      warn: (message: string) => log.warn(redactSecrets(message)),
      error: (message: string) => log.error(redactSecrets(message)),
    },
  });

  return Octokit.plugin(pinApiVersion).defaults(policy);
}

/** Build the octokit instance for a personal access token (PAT mode). */
export function createGithubClient(input: {
  readonly token: Secret;
  readonly logger: LoggerPort;
  /** See `githubOctokitClass`. */
  readonly fetch?: typeof globalThis.fetch;
}): Octokit {
  const GithubOctokit = githubOctokitClass(
    input.fetch === undefined ? { logger: input.logger } : { logger: input.logger, fetch: input.fetch },
  );
  // `reveal()` is the single greppable unwrap of a credential in the repo (SC-6).
  return new GithubOctokit({ auth: input.token.reveal() });
}

// ---------------------------------------------------------------------------------------
// An auth failure that has already been translated
// ---------------------------------------------------------------------------------------

/**
 * Thrown by the GitHub App auth layer (`app-auth.ts`) out of the transport, carrying the
 * `AppError` it has ALREADY chosen; `mapGithubError` and the boot preflight hand that error back
 * unchanged instead of re-deriving one from a status code.
 *
 * WHY IT EXISTS: the one case today is an uninstalled App. Minting an installation token then
 * answers 404, and a bare 404 is the worst possible status to let escape into the ports: the
 * variable read turns 404 into `unset` and the environment probe turns it into "this user has no
 * environment", so an uninstall would read as a quiet default rather than as the bot having lost
 * its access. This carries NO `status` on purpose, so no `=== 404` branch anywhere can match it.
 *
 * Nothing read off the network is in it: `appError` is built from developer-authored sentences
 * and config values (the App slug, the repository name).
 */
export class GithubAuthFailure extends Error {
  readonly appError: AppError;

  constructor(appError: AppError) {
    super(appError.code);
    this.name = 'GithubAuthFailure';
    this.appError = appError;
  }
}

// ---------------------------------------------------------------------------------------
// Reading a thrown octokit error WITHOUT touching anything that could carry a credential
// ---------------------------------------------------------------------------------------

/** The only facts we are willing to read off a thrown error. */
export interface GithubFailure {
  /** HTTP status, or 0 when the request never got a response (DNS, socket, abort). */
  readonly status: number;
  /** The error class name. Never the message: a message can echo a request body. */
  readonly name: string;
  /** `response.data.errors[].code`, e.g. `already_exists`. A closed vocabulary from GitHub. */
  readonly codes: readonly string[];
  /** From `retry-after` / `x-ratelimit-reset`, when GitHub said how long to wait. */
  readonly retryAfterMs: number | null;
  /** `x-ratelimit-remaining`. Zero on a 403 is what distinguishes a limit from a denial. */
  readonly rateLimitRemaining: number | null;
}

/** WHY zod: `response.data` is bytes off the network, and this runs on the failure path. */
const ErrorBody = z.object({
  errors: z.array(z.object({ code: z.string().optional(), field: z.string().optional() })).optional(),
});

/** Read one property off an unknown value without a cast and without throwing. */
function prop(target: unknown, key: string): unknown {
  if (typeof target !== 'object' || target === null) return undefined;
  return Reflect.get(target, key);
}

function asFiniteNumber(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && /^-?\d{1,15}$/u.test(v)) return Number.parseInt(v, 10);
  return null;
}

/**
 * Normalise a thrown value into the five facts above.
 *
 * WHY it is total and never throws: it runs inside a `catch`, so a second throw here would
 * replace a mapped `AppError` with an unhandled rejection - the exact failure mode
 * `Result<T, E>` exists to remove.
 *
 * WHY it takes `nowMs`: `x-ratelimit-reset` is an absolute epoch, and turning it into a
 * duration needs a clock. Reading `Date.now()` here would make the mapping untestable and
 * would break the no-ambient-clock rule the rest of the repo lives by.
 */
export function readGithubFailure(cause: unknown, nowMs: number): GithubFailure {
  const name = cause instanceof Error ? cause.name : 'unknown';
  const status = asFiniteNumber(prop(cause, 'status')) ?? 0;

  const response = prop(cause, 'response');
  const parsed = ErrorBody.safeParse(prop(response, 'data'));
  const codes = parsed.success
    ? (parsed.data.errors ?? []).map((e) => e.code).filter((c): c is string => c !== undefined)
    : [];

  const headers = prop(response, 'headers');
  const retryAfterSeconds = asFiniteNumber(prop(headers, 'retry-after'));
  const resetEpochSeconds = asFiniteNumber(prop(headers, 'x-ratelimit-reset'));
  const retryAfterMs =
    retryAfterSeconds !== null
      ? retryAfterSeconds * 1000
      : resetEpochSeconds !== null
        ? Math.max(0, resetEpochSeconds * 1000 - nowMs)
        : null;

  return {
    status,
    name,
    codes,
    retryAfterMs,
    rateLimitRemaining: asFiniteNumber(prop(headers, 'x-ratelimit-remaining')),
  };
}

/**
 * The duplicate-label answer.
 *
 * VERIFIED SHAPE: `POST /repos/{owner}/{repo}/labels` for a label that already exists answers
 * **422** with `errors: [{ resource: 'Label', code: 'already_exists', field: 'name' }]`.
 * It does NOT answer 409, so there is deliberately no 409 branch here or in `issues.ts`;
 * such a branch would be dead code that reads to a future maintainer like a handled case.
 */
export function isAlreadyExists(failure: GithubFailure): boolean {
  return failure.status === 422 && failure.codes.includes('already_exists');
}

/** WHY a ceiling: an unchecked `retry-after` becomes a job that sleeps for a day. */
const MAX_RETRY_AFTER_MS = 15 * 60_000;
/** What we tell a caller to wait when GitHub limited us without saying for how long. */
const DEFAULT_RETRY_AFTER_MS = 60_000;

function boundedRetryAfter(ms: number | null): number {
  if (ms === null || ms <= 0) return DEFAULT_RETRY_AFTER_MS;
  return Math.min(ms, MAX_RETRY_AFTER_MS);
}

/**
 * The single failure translator.
 *
 * `operation` is a DEVELOPER-AUTHORED tag (`issues.create`, `runs.status`) - never user text,
 * never anything read off the error. Every user-facing sentence below is a literal in this
 * file selected by status code, so no upstream body has a path to Discord.
 */
export function mapGithubError(cause: unknown, operation: string, nowMs: number): AppError {
  // Already translated by the App auth layer (an uninstalled App): see `GithubAuthFailure`.
  if (cause instanceof GithubAuthFailure) return cause.appError;
  const f = readGithubFailure(cause, nowMs);
  const internal = redactSecrets(
    `${operation}: ${f.name} status=${f.status}${f.codes.length > 0 ? ` codes=${f.codes.join(',')}` : ''}`,
  );

  // USER TEXT IS SHORT AND NAMES NO VARIABLES; the operator's hint rides in `internal`, which
  // is what the log line carries. "Ask an admin" is the whole instruction a user can act on.
  const forAdmin = (hint: string): string => `${internal} - ${hint}`;
  if (f.status === 0) {
    return errors.upstream('github', 0, "Couldn't reach GitHub. Try again in a minute - nothing was lost.", internal);
  }
  if (f.status === 401) {
    return errors.upstream(
      'github',
      401,
      "GitHub rejected the bot's login. Ask an admin to check it.",
      forAdmin('the token was rejected; renew GITHUB_TOKEN and restart'),
    );
  }
  if (f.status === 429 || (f.status === 403 && (f.rateLimitRemaining === 0 || f.retryAfterMs !== null))) {
    const wait = boundedRetryAfter(f.retryAfterMs);
    // The bot is being limited, not the user: say so, and say what to do about it.
    return errors.rateLimited(
      'github',
      wait,
      `Nothing was lost. Try again in ${describeWait(wait)}.`,
      'GitHub is rate-limiting the bot.',
    );
  }
  if (f.status === 403) {
    return errors.upstream(
      'github',
      403,
      "The bot isn't allowed to do that on GitHub. Ask an admin to check its access.",
      forAdmin('GITHUB_TOKEN lacks a repository permission (contents, issues, actions or environments)'),
    );
  }
  if (f.status === 404) {
    // THE ONE PIECE OF WORDING THAT IS NOT OBVIOUS. A token that cannot see a private
    // repository gets 404, not 403 - GitHub hides existence on purpose. Reporting "not found"
    // sends the operator hunting for a deleted issue instead of looking at the token.
    return errors.upstream(
      'github',
      404,
      "GitHub couldn't find that. Ask an admin to check the bot's access to the repository.",
      forAdmin('on a private repository a 404 usually means GITHUB_TOKEN cannot see it, not that the item is missing'),
    );
  }
  if (f.status === 422) {
    return errors.upstream(
      'github',
      422,
      'GitHub refused that request as invalid. Ask an admin to check the bot log.',
      forAdmin('check the workflow file name, the dispatch ref, the inputs, and that Issues are enabled'),
    );
  }
  if (f.status >= 500) {
    return errors.upstream('github', f.status, 'GitHub is having trouble. Try again in a minute.', internal);
  }
  return errors.upstream('github', f.status, 'Try again in a minute; nothing has been lost.', internal);
}
