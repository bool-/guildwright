/**
 * Command, action, hook, form and job definitions - every entry point a module can declare.
 *
 * POSTMORTEMS THIS FILE CLOSES:
 *  (1) THE THREE-SECOND DEADLINE. Discord fails an interaction permanently if it is not
 *      acknowledged within 3 seconds. `ack` is REQUIRED, so every handler author states which
 *      side of that line they are on, and the router acknowledges BEFORE the handler runs
 *      rather than discovering the answer from a timeout.
 *  (2) THE FIFTEEN-MINUTE TOKEN. A build takes 5-30 minutes; the token dies at 15. The long
 *      path is a STRUCTURALLY DIFFERENT return value: `{ kind: 'handoff' }` hands the router a
 *      durable `JobRequest` whose payload must be `JsonObject`, and the router injects the
 *      posted card's `SurfaceRef` into it inside the same transaction. A job has no reply
 *      function in scope at all, and no port takes a token, so "reply after the token expired"
 *      is unwritable rather than discouraged.
 *      AND - the part all three earlier designs got wrong - a handler cannot simply BLOCK for
 *      thirty minutes instead, because there is no `sleep` on `ClockPort`. Waiting is a
 *      `JobContext` capability. That, plus the `no-loop-await-in-handler` lint rule and the
 *      router's dev-mode handler deadline, is the honest version of the guarantee.
 *  (3) THE DOUBLE-CLICKED APPROVE. `ActionSpec.idempotency` is required, and each variant
 *      forces the author to write down HOW a duplicate is defeated.
 *  (4) 403 DISCOVERY. `needs` is required on every entry point INCLUDING jobs, so a poll job
 *      editing a card at minute 20 preflights instead of provoking a 403 from a background
 *      task with no card to report it on (SC-12).
 *  (5) THE DISCARDED MODAL. `FormSpec` could be opened and never read: neither earlier design
 *      had a modal-submit handler or a field accessor, so the flagship's `fields_json` column
 *      was unpopulatable. `FormHandlerSpec` + `FormValues` close it.
 *  (6) THE UNANSWERABLE AUTOCOMPLETE. `autocomplete: true` was declarable with nowhere to
 *      answer, so the mandated starter module was broken at runtime in both designs.
 */

import type { Result } from '#core/result';
import { Err, Ok } from '#core/result';
import type { AppError } from '#core/errors';
import { errors } from '#core/errors';
import type { JsonObject } from '#core/json';
import { isJsonObject } from '#core/json';
import type { Args, FormValues, SelectValues } from '#core/args';
import type { PermissionRef } from '#core/policy';
import type { RateLimit } from '#core/ratelimit';
import type { DiscordPermission } from '#core/permissions';
import type { ActionRef, ChannelId, GuildId, RequestId, RoleId, UserId } from '#core/ids';
import type { FormSpec, SurfaceRef, View } from '#core/view';
import type { Backoff, Capability, HealthReport, JobRequest, LoggerPort, PortsFor } from '#core/ports';
import type { AppEvents, EventName, EventSource } from '#core/events';
import type { UserText } from '#core/text';

// ---------------------------------------------------------------------------------------
// Acknowledgement strategy - the 3-second contract
// ---------------------------------------------------------------------------------------

/**
 * How the router acknowledges BEFORE the handler runs.
 *
 *  - `instant`         handler is pure/in-memory and provably < 3s; reply directly.
 *  - `defer`           public "thinking..." then edit. Anything touching SQLite or network.
 *  - `defer-ephemeral` same, but only the invoker sees it.
 *  - `defer-update`    a component click that edits the message it is attached to.
 *  - `form`            respond with a modal. Discord FORBIDS defer-then-modal, so such a
 *                      handler must not await before returning
 *                      (lint rule `no-await-in-form-handler`).
 */
export type AckStrategy = 'instant' | 'defer' | 'defer-ephemeral' | 'defer-update' | 'form';

/** Where a command may be used. */
export type CommandSurface = 'guild' | 'dm' | 'both';

/** Option types the framework knows how to marshal. */
export type OptionType = 'text' | 'integer' | 'number' | 'boolean' | 'user' | 'role' | 'channel';

/**
 * One declared slash-command option.
 *
 * WHY the numeric/length/channel constraints are here and not only in the handler: they are
 * part of the application-command payload Discord stores, so they belong in the hash that
 * decides whether to re-`PUT`. Leaving them out made `core_command_sync` compute a digest over
 * a payload the contract could not fully describe.
 */
export interface CommandOption {
  readonly name: string;
  readonly description: string;
  readonly type: OptionType;
  readonly required: boolean;
  /** WHY still re-validated with `args.choice`: Discord permits an unoffered value (SC-11). */
  readonly autocomplete?: boolean;
  /** Static choice list, when the set is small and fixed. */
  readonly choices?: readonly string[];
  readonly minValue?: number;
  readonly maxValue?: number;
  readonly minLength?: number;
  readonly maxLength?: number;
  /** Discord channel-type ids, for `type: 'channel'`. */
  readonly channelTypes?: readonly number[];
}

/** Discord's hard cap on autocomplete responses. */
export const MAX_AUTOCOMPLETE_CHOICES = 25;

/** One suggestion. `value` is what the client may submit - and is re-validated on arrival. */
export interface AutocompleteChoice {
  readonly name: string;
  readonly value: string;
}

// ---------------------------------------------------------------------------------------
// Invocation
// ---------------------------------------------------------------------------------------

/** Who is asking. `appPermissions` comes off the interaction, so it is always fresh. */
export interface Actor {
  readonly userId: UserId;
  readonly roleIds: readonly RoleId[];
  /** True only for the configured application owner (SC-7 layer L0). */
  readonly isAppOwner: boolean;
  /** The ACTOR's guild permissions, for the `guild-admin` fallback. No admin expansion. */
  readonly memberPermissions: bigint;
  /** The BOT's permissions here, from `app_permissions`. Zero API calls (SC-12). */
  readonly appPermissions: bigint;
}

/** Where it is happening. */
export interface Space {
  /** `null` in a DM. A command declaring `surface: 'guild'` is never routed with null. */
  readonly guildId: GuildId | null;
  readonly channelId: ChannelId;
}

const PROGRESS = Symbol('core.command.progress');

/**
 * The live, token-bound reply channel.
 *
 * DELIBERATELY NOT SERIALISABLE: it carries a module-private symbol and methods, so it is not
 * assignable to `JsonObject` and cannot be smuggled into a `JobRequest` payload, a doc-store
 * value, an audit `detail` or a log field. That single fact is what makes "the job tried to
 * editReply 22 minutes later" unwritable rather than merely discouraged.
 */
export interface ProgressHandle {
  readonly [PROGRESS]: true;
  /** Absolute ms at which the interaction token dies. Read it; do not race it. */
  readonly tokenExpiresAtMs: number;
  /** Update the deferred reply. Coalesced, and a no-op before the ack and after `detach`. */
  update(view: View): void;
  /**
   * Abandon the token and return a durable handle to the same message.
   * WHY it exists alongside `handoff`: a handler that already posted a card (a click on an
   * existing message) needs the ref without enqueueing anything. `handoff` is the preferred
   * path and the scaffolder writes it; this is the escape hatch for the other shape.
   */
  detach(): SurfaceRef;
}

/** Everything a command handler is given. */
export interface Invocation {
  /** Correlation id, written to every audit row and log line for this invocation. */
  readonly id: RequestId;
  readonly actor: Actor;
  readonly space: Space;
  readonly args: Args;
  readonly progress: ProgressHandle;
  /** `clock.now()` captured once by the router, so a handler never reads the ambient clock. */
  readonly at: number;
}

/** Everything a button handler is given. */
export interface ClickInvocation {
  readonly id: RequestId;
  readonly actor: Actor;
  readonly space: Space;
  /** Decoded `custom_id`. `ref.nonce` is the card-staleness fence (SC-10 check 3). */
  readonly ref: ActionRef;
  /** The message the button lives on - always present for a click, unlike for a command. */
  readonly surface: SurfaceRef;
  readonly progress: ProgressHandle;
  readonly at: number;
}

/** Everything a select-menu handler is given. */
export interface SelectInvocation extends ClickInvocation {
  /** Echoed values, as `UserText`, so `values.all(allowed)` is the only way to read them. */
  readonly values: SelectValues;
}

/** Everything a modal-submit handler is given. */
export interface FormSubmission {
  readonly id: RequestId;
  readonly actor: Actor;
  readonly space: Space;
  /** Decoded `custom_id` of the modal, so a submission routes to the right entity. */
  readonly ref: ActionRef;
  readonly fields: FormValues;
  readonly progress: ProgressHandle;
  readonly at: number;
}

/** Everything a message-prefix hook is given, e.g. `$request <free text>`. */
export interface MessageHookEvent {
  readonly id: RequestId;
  readonly actor: Actor;
  readonly space: Space;
  /** The message minus the prefix, already wrapped as untrusted. */
  readonly body: UserText;
  /** The user's message, so a card can be posted as a reply to it. */
  readonly surface: SurfaceRef;
  readonly at: number;
}

/** What an autocomplete handler is given. Answered within 3 seconds or not at all. */
export interface AutocompleteRequest {
  readonly actor: Actor;
  readonly space: Space;
  /** The option being completed. */
  readonly option: string;
  /** What the user has typed so far. Untrusted, like every other string from Discord. */
  readonly partial: UserText;
  readonly at: number;
}

// ---------------------------------------------------------------------------------------
// Outcome
// ---------------------------------------------------------------------------------------

/**
 * The key under which the router injects the posted card's `SurfaceRef` into a handoff job's
 * payload. Fixed rather than configurable so `readSurface` is total.
 */
export const SURFACE_KEY = 'surface';

/**
 * What a handler returns.
 *
 * `handoff` is the whole 15-minute answer: the handler posts a card NOW, inside the token
 * window, and DESCRIBES the durable work that will update it later. The router persists the
 * card's ids into the job payload under `SURFACE_KEY` and commits the enqueue in the same
 * transaction, so a crash between "card posted" and "job queued" leaves no orphan - and the
 * module never has to remember to carry the handle.
 */
export type Outcome =
  | { readonly kind: 'view'; readonly view: View }
  | { readonly kind: 'fail'; readonly error: AppError }
  | { readonly kind: 'form'; readonly form: FormSpec }
  /** Acknowledged, nothing to say. Used by hooks that decline to act. */
  | { readonly kind: 'silent' }
  | { readonly kind: 'handoff'; readonly view: View; readonly job: JobRequest };

/**
 * Read the injected card handle inside a job.
 * WHY `Result`: a payload written by an older version of the bot may predate the key, and a
 * job that cannot find its card must dead-letter cleanly rather than throw.
 */
export function readSurface(payload: JsonObject): Result<SurfaceRef, AppError> {
  const raw = payload[SURFACE_KEY];
  const stale = errors.conflict('surface_missing', 'That build card is no longer tracked.', 'Run the command again.');
  if (!isJsonObject(raw)) return Err(stale);
  const { channelId, messageId, guildId } = raw;
  if (typeof channelId !== 'string' || typeof messageId !== 'string') return Err(stale);
  return Ok({ channelId, messageId, guildId: typeof guildId === 'string' ? guildId : null });
}

// ---------------------------------------------------------------------------------------
// Specs
// ---------------------------------------------------------------------------------------

/**
 * A slash command. EVERY field is required - there are no defaults anywhere in this repo.
 * Omitting `permission` is TS2741, which is the intended experience: an unguarded command
 * should be impossible to write by accident, and `PUBLIC` makes the decision visible.
 */
export interface CommandSpec {
  /** Space-separated for subcommands: `tag get`. Uniqueness is enforced at boot. */
  readonly name: string;
  readonly description: string;
  readonly surface: CommandSurface;
  readonly options: readonly CommandOption[];
  /** From `ctx.perms.<key>` or the explicit `PUBLIC` sentinel. */
  readonly permission: PermissionRef;
  /**
   * Every bucket that must be spent. WHY a LIST: SC-9 specifies `$request` as
   * "3/user/hour + 20/guild/day", which one bucket cannot express. `NO_LIMIT` opts out.
   */
  readonly limit: readonly RateLimit[];
  /** Bot permissions this command needs. `[]` if none. Preflighted, never discovered. */
  readonly needs: readonly DiscordPermission[];
  readonly ack: AckStrategy;
  handle(inv: Invocation): Promise<Outcome>;
  /**
   * REQUIRED whenever any option sets `autocomplete: true`; the registry refuses to boot
   * otherwise, naming the command and the option. At most `MAX_AUTOCOMPLETE_CHOICES` are sent.
   */
  autocomplete?(req: AutocompleteRequest): Promise<readonly AutocompleteChoice[]>;
}

/**
 * How a repeated click is defeated. REQUIRED, because "the Approve button was double-clicked
 * and we dispatched twice" is the single most likely production incident in this system, and
 * a required field puts the answer in front of a reviewer.
 */
export type IdempotencyPolicy =
  /**
   * The handler compares `ref.nonce` to the stored nonce, then does a compare-and-set write
   * whose `changes === 0` means someone else won. `staleMessage` is what the loser is told.
   */
  | { readonly kind: 'nonce-and-cas'; readonly staleMessage: string }
  /** The action has no side effect at all (a refresh, a page turn). `why` is reviewed. */
  | { readonly kind: 'naturally-idempotent'; readonly why: string };

/**
 * A component handler.
 *
 * Keyed by NAME, not by a collector: discord.js emits `InteractionCreate` unconditionally, so
 * a spec-registered action survives a restart with zero re-registration. Collectors do not,
 * which is why `createMessageComponentCollector` is banned outright.
 */
export interface ActionSpec {
  /** Stable across deploys - it is baked into `custom_id`s already sitting in Discord. */
  readonly name: string;
  readonly permission: PermissionRef;
  readonly limit: readonly RateLimit[];
  readonly needs: readonly DiscordPermission[];
  /** A click has no `defer-ephemeral`; use `defer-update` to edit the card in place. */
  readonly ack: 'instant' | 'defer' | 'defer-update' | 'form';
  readonly idempotency: IdempotencyPolicy;
  handle(click: ClickInvocation): Promise<Outcome>;
}

/** A select-menu handler. Same contract as `ActionSpec`, plus re-validated values. */
export interface SelectActionSpec {
  readonly name: string;
  readonly permission: PermissionRef;
  readonly limit: readonly RateLimit[];
  readonly needs: readonly DiscordPermission[];
  readonly ack: 'instant' | 'defer' | 'defer-update' | 'form';
  readonly idempotency: IdempotencyPolicy;
  handle(sel: SelectInvocation): Promise<Outcome>;
}

/**
 * A modal-submit handler.
 *
 * WHY it is its own spec and not a branch of `ActionSpec`: a submission carries FIELDS and no
 * `nonce`-bearing button, and conflating them is how both earlier designs ended up able to
 * open a modal they could never read.
 */
export interface FormHandlerSpec {
  /** Matches the `name` used to build the modal's `custom_id`. */
  readonly name: string;
  readonly permission: PermissionRef;
  readonly limit: readonly RateLimit[];
  readonly needs: readonly DiscordPermission[];
  readonly ack: 'defer' | 'defer-ephemeral' | 'defer-update';
  readonly idempotency: IdempotencyPolicy;
  /** The fields this handler will read. Boot checks them against the `FormSpec` that opens it. */
  readonly fields: readonly string[];
  handle(sub: FormSubmission): Promise<Outcome>;
}

/**
 * A gateway message hook - the product's actual entry point (`$request <free text>`).
 *
 * WHY it is in core at all: without it, step one of the flagship flow is unbuildable and a
 * design quietly substitutes a slash command, which is a different product with a different
 * deadline and no free-text-after-prefix shape. Intents required: Guilds | GuildMessages |
 * MessageContent, the last of which is privileged.
 */
export interface HookSpec {
  readonly source: 'message';
  /** Literal prefix, e.g. `$request`. Exact and case-sensitive; unique across the bot. */
  readonly prefix: string;
  readonly permission: PermissionRef;
  readonly limit: readonly RateLimit[];
  readonly needs: readonly DiscordPermission[];
  handle(ev: MessageHookEvent): Promise<Outcome>;
}

// ---------------------------------------------------------------------------------------
// Durable work
// ---------------------------------------------------------------------------------------

/**
 * What a durable job handler is given.
 *
 * READ THE ABSENCE AGAIN: no interaction, no `ProgressHandle`, no reply function. A job runs
 * long after the interaction token died, so the only way it can talk to the user is
 * `ports.discord.edit(surface, view)` with a `SurfaceRef` recovered from its own payload.
 *
 * WHY `ports` is `PortsFor<C>` and not the full registry: this is the surface that dispatches
 * workflow runs and spends money, and one earlier design typed it as the whole `PortRegistry`
 * - so a module declaring `['db','clock']` reached `builds.dispatch` from inside a job,
 * cast-free, compiling clean. The capability line must bind the long path or it binds nothing.
 */
export interface JobContext<C extends readonly Capability[], PK extends string = never> {
  readonly ports: PortsFor<C>;
  readonly logger: LoggerPort;
  /** Subscribe only. Publishing goes through `emit`, narrowed to this module's own events. */
  readonly bus: EventSource;
  /** Publish one of this module's OWN declared events. */
  emit<K extends Extract<PK, EventName>>(name: K, payload: AppEvents[K]): void;
  /** Attempt number, 1-based. Present so a job can log rather than guess. */
  readonly attempt: number;
  /** Absolute give-up time from the enqueue, so a poller can stop itself early. */
  readonly deadlineAtMs: number;
  /**
   * Aborted on shutdown and at the deadline.
   * WHY it exists: `core_jobs` carries `lease_until`/`lease_owner`, and without a signal a
   * SIGTERM during a six-hour poll leaves a live lease nothing releases.
   */
  readonly signal: AbortSignal;
  /** Extend the lease during a long step, so the reclaimer does not steal the job. */
  heartbeat(): void;
  /**
   * Cancellable wait. WHY it is HERE and not on `ClockPort`: waiting inside an interaction
   * handler is the 15-minute bug. Waiting inside a job is correct, so the capability exists on
   * exactly one of the two.
   */
  sleep(ms: number): Promise<void>;
}

/**
 * What one attempt produced.
 *
 * WHY three arms and not `Result<void, AppError>`: both earlier designs expressed "the build
 * is still running" as `Err(errors.timeout(...))`, which abuses the failure channel, burns one
 * of `maxAttempts` per poll, pollutes `last_error` on every tick, and hands the cadence to the
 * runner's unspecified backoff. A twenty-minute build then hits `onDead` and tells the user it
 * failed while the PR is open. `retry` does not consume an attempt.
 */
export type JobOutcome =
  | { readonly kind: 'done' }
  | { readonly kind: 'retry'; readonly afterMs: number; readonly why: string }
  | { readonly kind: 'failed'; readonly error: AppError };

/**
 * A durable job.
 *
 * `onDead` is REQUIRED. It is where the user is told the build failed, and it is the single
 * most commonly omitted piece of an async pipeline: a job that exhausts its attempts in
 * silence looks, from Discord, exactly like a bot that hung.
 *
 * `onUnparseable` is REQUIRED too. A payload written by an older deploy is a real event on any
 * system that ships more than once, and the alternative is a job that throws on every attempt
 * until it dead-letters with a stack trace nobody reads.
 */
export interface JobSpec<C extends readonly Capability[], PK extends string = never> {
  /** Matches `JobRequest.type`. Unique within a module; namespaced by module at boot. */
  readonly type: string;
  readonly maxAttempts: number;
  /** Hard ceiling from enqueue. Bounds any poller (SC-14). */
  readonly deadlineMs: number;
  readonly backoff: Backoff;
  /** Bot permissions the job needs before it edits a card. Preflighted by the runner (SC-12). */
  readonly needs: readonly DiscordPermission[];
  /**
   * Run this job on a fixed interval with no enqueue, e.g. the reconciler sweeper.
   * WHY it is here: without a recurring job, "adopt runs whose poller was lost" has nowhere to
   * live, and a crash between `dispatch()` returning and the enqueue committing orphans a paid
   * workflow run forever.
   */
  readonly schedule?: { readonly everyMs: number };
  /** Never throws: an unhandled rejection here would kill the process. */
  run(ctx: JobContext<C, PK>, payload: JsonObject): Promise<JobOutcome>;
  /** Dead-letter path. Tell the human. Runs at most once, after the last attempt or deadline. */
  onDead(ctx: JobContext<C, PK>, payload: JsonObject, last: AppError): Promise<void>;
  /** The payload no longer matches what this version expects. Report, do not retry. */
  onUnparseable(ctx: JobContext<C, PK>, payload: JsonObject): Promise<void>;
}

/** WHY a named type: `/status` and `/readyz` aggregate these and the shape must be uniform. */
export type HealthCheck = () => Promise<HealthReport>;
