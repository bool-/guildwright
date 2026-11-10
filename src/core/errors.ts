/**
 * `AppError` - a CLOSED discriminated union plus the only sanctioned constructors.
 *
 * TWO POSTMORTEMS, ONE TYPE:
 *  (1) "The bot replied with a stack trace containing the repo path and the PAT prefix."
 *      Operator detail lives in `internal`, which `userMessage()` structurally never reads.
 *      Leaking it again requires writing new code, not forgetting to strip something.
 *  (2) "The bot said 'error' and the user retried forty times." Every variant REQUIRES a
 *      `nextStep` imperative, so a dead-end message is TS2741 at construction.
 *
 * The union is closed: `userMessage` ends in a `never` binding, so adding a variant without
 * teaching the renderer is a compile error rather than a blank Discord card.
 */

/** Every kind of expected failure. Adding one breaks every exhaustive switch, deliberately. */
export type AppErrorKind =
  | 'validation'
  | 'not-found'
  | 'conflict'
  | 'forbidden'
  | 'missing-bot-permission'
  | 'rate-limited'
  | 'timeout'
  | 'upstream'
  | 'unavailable'
  | 'cancelled'
  | 'config'
  | 'internal';

/** Fields every variant carries. `internal` is the quarantine for anything a user must not read. */
interface ErrorBase {
  /** Stable machine code, safe to log and to switch on. Never interpolated user text. */
  readonly code: string;
  /** Short, user-safe statement of what went wrong. */
  readonly userDetail: string;
  /** REQUIRED imperative telling the user what to do next. A dead end is a bug. */
  readonly nextStep: string;
  /** Operator-only context: paths, ids, upstream bodies. Never rendered to Discord. */
  readonly internal: string | null;
  /** Whether a retry could plausibly succeed. 401/403 are always false (SC-12). */
  readonly retryable: boolean;
}

/** The user's input does not fit the shape the command needs. */
export interface ValidationError extends ErrorBase {
  readonly kind: 'validation';
  /** The OPTION NAME, never the value - the value may be a secret the user pasted. */
  readonly field: string;
}

/** The named entity does not exist, or is not visible to this actor. */
export interface NotFoundError extends ErrorBase {
  readonly kind: 'not-found';
  readonly what: string;
}

/** State moved under us: a stale card, a double-click, an exhausted quota, a lost CAS. */
export interface ConflictError extends ErrorBase {
  readonly kind: 'conflict';
  readonly state: string;
}

/** Authorization denied. Names who CAN grant it, so the user is never stuck (SC-7 L3). */
export interface ForbiddenError extends ErrorBase {
  readonly kind: 'forbidden';
  readonly permission: string;
  readonly grantableBy: string;
}

/**
 * The BOT lacks a Discord permission here. Distinct from `forbidden` because the remedy is a
 * re-invite link with an exact integer, not an allow-list grant (SC-12).
 */
export interface MissingBotPermissionError extends ErrorBase {
  readonly kind: 'missing-bot-permission';
  readonly missing: readonly string[];
  /** Permissions integer for the one-click re-invite URL. Stringified: it exceeds 2^53. */
  readonly inviteBits: string;
}

/** Token bucket empty. Carries the wait so the reply is exact rather than vague. */
export interface RateLimitedError extends ErrorBase {
  readonly kind: 'rate-limited';
  readonly retryAfterMs: number;
  /** Which declared bucket ran out, so SC-9's two-bucket rule is debuggable. */
  readonly bucket: string;
}

/** We stopped waiting. Distinct from `upstream` so pollers tune separately. */
export interface TimeoutError extends ErrorBase {
  readonly kind: 'timeout';
  readonly afterMs: number;
}

/** A third party answered badly. `status` drives the never-retry-401/403 rule. */
export interface UpstreamError extends ErrorBase {
  readonly kind: 'upstream';
  readonly service: 'discord' | 'github' | 'sqlite';
  readonly status: number;
}

/** A module is quarantined by the circuit breaker (SC-14), or a dependency is down. */
export interface UnavailableError extends ErrorBase {
  readonly kind: 'unavailable';
  readonly component: string;
}

/** A human or a deadline stopped the work. Not a failure to apologise for. */
export interface CancelledError extends ErrorBase {
  readonly kind: 'cancelled';
  readonly by: string;
}

/** Boot-time misconfiguration. Its own kind so `main` exits non-zero instead of limping. */
export interface ConfigError extends ErrorBase {
  readonly kind: 'config';
  readonly location: string;
}

/** A bug. The ONLY variant whose user-facing text is generic by construction. */
export interface InternalError extends ErrorBase {
  readonly kind: 'internal';
  readonly correlationId: string;
}

/** The closed union. `switch (e.kind)` is exhaustive and stays exhaustive. */
export type AppError =
  | ValidationError
  | NotFoundError
  | ConflictError
  | ForbiddenError
  | MissingBotPermissionError
  | RateLimitedError
  | TimeoutError
  | UpstreamError
  | UnavailableError
  | CancelledError
  | ConfigError
  | InternalError;

/** Service display names, shared by the error factory and the card heading. */
export const SERVICE_NAME: Readonly<Record<UpstreamError['service'], string>> = {
  discord: 'Discord',
  github: 'GitHub',
  sqlite: 'The database',
};

/** What a user sees for ANY config-kind error. The developer hint is logged, never shown. */
export const CONFIG_USER_TEXT = 'This command is broken on our side. Tell an admin.';

/** `SendMessages` -> `Send Messages`. */
export function humanizePermission(flag: string): string {
  return flag.replace(/([a-z0-9])([A-Z])/gu, '$1 $2');
}

/**
 * The factory.
 *
 * WHY a plain object and not free functions or a `namespace`: `erasableSyntaxOnly` bans
 * `namespace` (TS1294), and one greppable call shape (`errors.*`) lets a reviewer enumerate
 * every failure a module can produce with a single grep. `nextStep` is positional in every
 * signature, so it cannot be postponed.
 */
export const errors = {
  /** `field` is the option name; the value never appears in an error. */
  validation(field: string, userDetail: string, nextStep: string): ValidationError {
    return { kind: 'validation', code: `validation.${field}`, field, userDetail, nextStep, internal: null, retryable: false };
  },

  /** `what` is a noun (tag, request), never an id. */
  notFound(what: string, nextStep: string): NotFoundError {
    return { kind: 'not-found', code: `not_found.${what}`, what, userDetail: `That ${what} does not exist.`, nextStep, internal: null, retryable: false };
  },

  /** Illegal transition, stale card, or quota. `code` is the machine reason. */
  conflict(code: string, userDetail: string, nextStep: string, state = 'unknown'): ConflictError {
    return { kind: 'conflict', code: `conflict.${code}`, state, userDetail, nextStep, internal: null, retryable: false };
  },

  /** `grantableBy` closes the "who do I even ask" dead end. */
  forbidden(permission: string, grantableBy: string, nextStep: string): ForbiddenError {
    return { kind: 'forbidden', code: `forbidden.${permission}`, permission, grantableBy, userDetail: `You need \`${permission}\`.`, nextStep, internal: null, retryable: false };
  },

  /**
   * Separation of duty: the actor holds the permission but is the requester. Its own text,
   * because "ask someone to grant you the permission" is the wrong remedy.
   */
  forbiddenSelfApproval(permission: string): ForbiddenError {
    return {
      kind: 'forbidden',
      code: `forbidden.${permission}.self_approval`,
      permission,
      grantableBy: 'another approver',
      userDetail: "You can't approve your own request.",
      nextStep: 'Ask another approver.',
      internal: null,
      retryable: false,
    };
  },

  /** WHY `inviteBits` is a string: the permissions integer exceeds `Number.MAX_SAFE_INTEGER`. */
  missingBotPermission(missing: readonly string[], inviteBits: bigint, nextStep: string): MissingBotPermissionError {
    return { kind: 'missing-bot-permission', code: 'missing_bot_permission', missing, inviteBits: inviteBits.toString(), userDetail: `I can't post here: missing ${missing.map(humanizePermission).join(', ')}.`, nextStep, internal: null, retryable: false };
  },

  /** `bucket` names WHICH declared limit was exhausted (SC-9 declares two on `$request`). */
  rateLimited(bucket: string, retryAfterMs: number, nextStep: string, userDetail = 'You are sending requests too fast.'): RateLimitedError {
    return { kind: 'rate-limited', code: 'rate_limited', bucket, retryAfterMs, userDetail, nextStep, internal: null, retryable: true };
  },

  /** We stopped waiting. Bounded by the job `deadlineAtMs`. */
  timeout(component: string, afterMs: number, nextStep: string): TimeoutError {
    return { kind: 'timeout', code: `timeout.${component}`, afterMs, userDetail: 'That took too long and was stopped.', nextStep, internal: null, retryable: true };
  },

  /** NOTE the retry rule: 401/403 are never retried - hammering them risks a Cloudflare ban. */
  upstream(service: 'discord' | 'github' | 'sqlite', status: number, nextStep: string, internal: string | null = null): UpstreamError {
    return { kind: 'upstream', code: `upstream.${service}.${status}`, service, status, userDetail: `${SERVICE_NAME[service]} rejected that request.`, nextStep, internal, retryable: status !== 401 && status !== 403 };
  },

  /** Quarantined module or dead dependency. */
  unavailable(component: string, nextStep: string): UnavailableError {
    return { kind: 'unavailable', code: `unavailable.${component}`, component, userDetail: `${component} is temporarily unavailable.`, nextStep, internal: null, retryable: true };
  },

  /** WHY its own kind: "we stopped" must read differently from "it broke" in the audit log. */
  cancelled(by: string, nextStep: string): CancelledError {
    return { kind: 'cancelled', code: 'cancelled', by, userDetail: 'That was cancelled.', nextStep, internal: null, retryable: false };
  },

  /** `location` is an env var name or a module id. */
  config(location: string, internal: string, nextStep: string): ConfigError {
    return { kind: 'config', code: `config.${location}`, location, userDetail: CONFIG_USER_TEXT, nextStep, internal, retryable: false };
  },

  /** A bug. Everything interesting goes in `internal`; the user sees the correlation id only. */
  internal(correlationId: string, internal: string): InternalError {
    return { kind: 'internal', code: 'internal', correlationId, userDetail: 'Something broke on our side.', nextStep: `Report this id to an admin: \`${correlationId}\``, internal, retryable: false };
  },
};

/**
 * The ONLY function permitted to turn an `AppError` into text a user sees.
 *
 * It reads `userDetail` and `nextStep` and nothing else. `internal`, `status` and any
 * upstream body are structurally unreachable from here, so "the error message leaked the
 * token" cannot be reintroduced by an agent that only edits a factory.
 */
export function userMessage(e: AppError): string {
  switch (e.kind) {
    case 'validation':
    case 'not-found':
    case 'conflict':
    case 'forbidden':
    case 'missing-bot-permission':
    case 'rate-limited':
    case 'timeout':
    case 'unavailable':
    case 'cancelled':
      return `${e.userDetail} ${e.nextStep}`;
    case 'upstream':
      // Deliberately drops `status` and `internal`: upstream bodies have carried tokens.
      return `${e.userDetail} ${e.nextStep}`;
    case 'config':
      // The developer hint in `nextStep` is for the logger, not for a Discord user.
      return CONFIG_USER_TEXT;
    case 'internal':
      // The title says "Something broke"; the body is only the id to report.
      return e.nextStep;
    default: {
      // Exhaustiveness proof. A new variant fails HERE, at compile time.
      const exhaustive: never = e;
      void exhaustive;
      return 'Something broke on our side. Report this to an admin.';
    }
  }
}

/** Human-facing duration, rounded up so "0 seconds" is never shown. */
export function describeWait(ms: number): string {
  const seconds = Math.max(1, Math.ceil(ms / 1000));
  if (seconds < 60) return `${seconds} second${seconds === 1 ? '' : 's'}`;
  const minutes = Math.ceil(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'}`;
  const hours = Math.ceil(minutes / 60);
  return `${hours} hour${hours === 1 ? '' : 's'}`;
}

/** WHY separate: this is the only function that reads `internal`, so one grep audits egress. */
export function operatorMessage(e: AppError): string {
  return e.internal === null ? `${e.kind}/${e.code}` : `${e.kind}/${e.code}: ${e.internal}`;
}

/** WHY one predicate: the 401/403 rule must not be re-derived per retry loop and get it wrong. */
export function isRetryable(e: AppError): boolean {
  if (e.kind === 'upstream') return e.status !== 401 && e.status !== 403;
  return e.retryable;
}
