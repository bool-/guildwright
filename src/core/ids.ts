/**
 * Identifiers, and the button-`custom_id` codec.
 *
 * POSTMORTEMS THIS FILE CLOSES:
 *  (1) "`new ButtonBuilder().setCustomId(x)` threw at render time in production, because the
 *      module id plus the action name plus a ULID plus a nonce came to 104 characters."
 *      Discord's cap is 100. `encodeActionRef` returns `Result`, the view layer accepts only
 *      `CustomId` (which only this file mints), and `actionRefFits` lets the registry
 *      preflight every declared action at BOOT against a worst-case entity id.
 *  (2) "Two requests created in the same millisecond sorted the wrong way and the reconciler
 *      adopted the wrong workflow run." Ids are ULID-shaped and monotonic within a ms.
 *  (3) "The request id came from Math.random." Randomness is `node:crypto` only.
 *
 * BRANDING NOTE, and it is the opposite choice from `text.ts` on purpose: ids ARE strings -
 * they are compared, logged and bound as SQL parameters - so they are branded intersections
 * rather than opaque wrappers. The useful direction still holds: a bare `string` is not
 * assignable to `GuildId`. Every brand is minted by a type predicate, so this file has no
 * casts.
 */

import { randomFillSync, randomUUID } from 'node:crypto';
import { Err, Ok, type Result } from '#core/result';
import { errors, type AppError } from '#core/errors';

declare const ID_BRAND: unique symbol;

/** Phantom marker. Never exists at runtime; only the compiler sees it. */
interface Branded<Tag extends string> {
  readonly [ID_BRAND]: Tag;
}

/** WHY one type per snowflake kind: `send(userId, view)` is the classic swapped-argument bug
 *  and it is unfixable with a single `Snowflake` alias. */
export type UserId = string & Branded<'UserId'>;
/** A Discord guild snowflake. */
export type GuildId = string & Branded<'GuildId'>;
/** A Discord channel or thread snowflake. */
export type ChannelId = string & Branded<'ChannelId'>;
/** A Discord message snowflake. Persisted, so a card can be edited after token death. */
export type MessageId = string & Branded<'MessageId'>;
/** A Discord role snowflake. */
export type RoleId = string & Branded<'RoleId'>;
/** A 26-character Crockford base32 ULID naming one build request. */
export type RequestId = string & Branded<'RequestId'>;
/** A durable job id. Never interchangeable with a RequestId. */
export type JobId = string & Branded<'JobId'>;
/** A Discord component `custom_id`, proven to be 1..100 characters. */
export type CustomId = string & Branded<'CustomId'>;
/** A UUID binding one Discord approval to one workflow run (SC-2 anti-replay). */
export type ApprovalId = string & Branded<'ApprovalId'>;
/** 16 hex characters, unguessable per issue. The SC-3 layer-4 delimiter. */
export type FenceNonce = string & Branded<'FenceNonce'>;
/** 8 Crockford characters. The SC-10 card-staleness fence carried in a `custom_id`. */
export type CardNonce = string & Branded<'CardNonce'>;

const SNOWFLAKE_RE = /^\d{17,20}$/u;
const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/u;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const FENCE_RE = /^[0-9a-f]{16}$/u;
const CARD_NONCE_RE = /^[0-9A-HJKMNP-TV-Z]{8}$/u;

// A predicate is how a brand is created without a cast: the runtime check IS the evidence,
// so the invariant and the type cannot drift apart.
function isUserId(s: string): s is UserId {
  return SNOWFLAKE_RE.test(s);
}
function isGuildId(s: string): s is GuildId {
  return SNOWFLAKE_RE.test(s);
}
function isChannelId(s: string): s is ChannelId {
  return SNOWFLAKE_RE.test(s);
}
function isMessageId(s: string): s is MessageId {
  return SNOWFLAKE_RE.test(s);
}
function isRoleId(s: string): s is RoleId {
  return SNOWFLAKE_RE.test(s);
}
function isRequestIdShape(s: string): s is RequestId {
  return ULID_RE.test(s);
}
function isJobIdShape(s: string): s is JobId {
  return ULID_RE.test(s);
}
function isApprovalIdShape(s: string): s is ApprovalId {
  return UUID_RE.test(s);
}
function isFenceNonceShape(s: string): s is FenceNonce {
  return FENCE_RE.test(s);
}
function isCardNonceShape(s: string): s is CardNonce {
  return CARD_NONCE_RE.test(s);
}
function isCustomIdShape(s: string): s is CustomId {
  return s.length > 0 && s.length <= CUSTOM_ID_MAX;
}

function snowflakeErr(what: string): AppError {
  return errors.validation(what, `That is not a valid Discord ${what} id.`, 'Right-click in Discord and use Copy ID.');
}

/** Validate a user snowflake at the adapter edge. */
export function toUserId(s: string): Result<UserId, AppError> {
  return isUserId(s) ? Ok(s) : Err(snowflakeErr('user'));
}
/** Validate a guild snowflake at the adapter edge. */
export function toGuildId(s: string): Result<GuildId, AppError> {
  return isGuildId(s) ? Ok(s) : Err(snowflakeErr('guild'));
}
/** Validate a channel snowflake at the adapter edge. */
export function toChannelId(s: string): Result<ChannelId, AppError> {
  return isChannelId(s) ? Ok(s) : Err(snowflakeErr('channel'));
}
/** WHY it is re-proven: a `SurfaceRef` rehydrated from a job payload is untrusted bytes. */
export function toMessageId(s: string): Result<MessageId, AppError> {
  return isMessageId(s) ? Ok(s) : Err(snowflakeErr('message'));
}
/** Validate a role snowflake, e.g. from `/access grant`. */
export function toRoleId(s: string): Result<RoleId, AppError> {
  return isRoleId(s) ? Ok(s) : Err(snowflakeErr('role'));
}
/** Re-brand a RequestId read back out of SQLite or out of a decoded `custom_id`. */
export function toRequestId(s: string): Result<RequestId, AppError> {
  return isRequestIdShape(s)
    ? Ok(s)
    : Err(errors.validation('requestId', 'That is not a request id.', 'Copy the id from the build card.'));
}
/** Re-brand a JobId read back out of SQLite. */
export function toJobId(s: string): Result<JobId, AppError> {
  return isJobIdShape(s) ? Ok(s) : Err(errors.validation('jobId', 'That is not a job id.', 'Use the id printed by /status.'));
}
/** Re-brand an ApprovalId before it is dispatched into a workflow input. */
export function toApprovalId(s: string): Result<ApprovalId, AppError> {
  return isApprovalIdShape(s)
    ? Ok(s)
    : Err(errors.validation('approvalId', 'That approval id is malformed.', 'Approve the request again to get a fresh one.'));
}
/** Re-brand a fence nonce read back off a persisted request row. */
export function toFenceNonce(s: string): Result<FenceNonce, AppError> {
  return isFenceNonceShape(s)
    ? Ok(s)
    : Err(errors.validation('nonce', 'That issue is missing its fence nonce.', 'Open a new request.'));
}
/** Re-brand a card nonce read back off a persisted request row. */
export function toCardNonce(s: string): Result<CardNonce, AppError> {
  return isCardNonceShape(s)
    ? Ok(s)
    : Err(errors.conflict('card_nonce', 'That card is from an older version.', 'Run the command again to get a fresh card.'));
}

/** WHY it exists: `text.ts` composes the fence markers and must not re-derive the brand. */
export function renderFenceNonce(n: FenceNonce): string {
  return n;
}

// ---------------------------------------------------------------------------------------
// ULID generation - crypto randomness, monotonic within a millisecond
// ---------------------------------------------------------------------------------------

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const RANDOM_BYTES = 10;
const MAX_ULID_MS = 281_474_976_710_655;

let lastMs = -1;
const lastRandom = new Uint8Array(RANDOM_BYTES);

function encodeTime(ms: number): string {
  let out = '';
  let n = ms;
  for (let i = 0; i < 10; i += 1) {
    out = `${CROCKFORD.charAt(n % 32)}${out}`;
    n = Math.floor(n / 32);
  }
  return out;
}

function encodeRandom(bytes: Uint8Array): string {
  // 10 bytes -> 80 bits -> 16 base32 characters, most significant first.
  let acc = 0n;
  for (const b of bytes) acc = (acc << 8n) | BigInt(b);
  let out = '';
  for (let i = 0; i < 16; i += 1) {
    out = `${CROCKFORD.charAt(Number(acc & 31n))}${out}`;
    acc >>= 5n;
  }
  return out;
}

function incrementRandom(): void {
  for (let i = RANDOM_BYTES - 1; i >= 0; i -= 1) {
    const cur = lastRandom[i];
    if (cur === undefined) return;
    if (cur < 255) {
      lastRandom[i] = cur + 1;
      return;
    }
    lastRandom[i] = 0;
  }
}

/**
 * Mint a request id.
 *
 * WHY it takes `nowMs` instead of reading `Date.now()`: modules may not touch the ambient
 * clock (lint rule `no-ambient-clock`), and a generator that reads the clock itself cannot be
 * tested on the same-millisecond monotonic path - which is exactly the path that mis-ordered
 * two requests in the incident this design answers.
 *
 * WHY it may throw: the only failure is a non-finite or out-of-range time, i.e. a bug.
 */
export function newRequestId(nowMs: number): RequestId {
  if (!Number.isFinite(nowMs) || nowMs < 0 || nowMs > MAX_ULID_MS) {
    throw new RangeError('newRequestId: nowMs is outside the ULID range');
  }
  const ms = Math.floor(nowMs);
  if (ms === lastMs) {
    incrementRandom();
  } else {
    lastMs = ms;
    randomFillSync(lastRandom);
  }
  const s = `${encodeTime(ms)}${encodeRandom(lastRandom)}`;
  if (!isRequestIdShape(s)) throw new Error('newRequestId: generator produced a non-ULID; this is a bug');
  return s;
}

/** Same generator, different brand, so a job id can never be used as a request id. */
export function newJobId(nowMs: number): JobId {
  const s: string = newRequestId(nowMs);
  if (!isJobIdShape(s)) throw new Error('newJobId: generator produced a non-ULID; this is a bug');
  return s;
}

/**
 * WHY a UUID and not a ULID: the workflow's validate step re-matches this exact shape in shell
 * before the id is signed into anything (SC-2 check 1), and two independent checks of the same
 * shape is the point. The id is persisted on the request row, signed into the approval token,
 * sent as the `approval_id` dispatch input, and consumed ONCE by the workflow - a second run
 * carrying it is refused, which is what turns the token from a bearer credential into a
 * single-use one.
 */
export function newApprovalId(): ApprovalId {
  const u = randomUUID();
  if (!isApprovalIdShape(u)) throw new Error('newApprovalId: randomUUID produced an unexpected shape');
  return u;
}

/** WHY unguessable per issue: a predictable fence lets a user close it early (SC-3 layer 4). */
export function newFenceNonce(): FenceNonce {
  const bytes = new Uint8Array(8);
  randomFillSync(bytes);
  const s = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  if (!isFenceNonceShape(s)) throw new Error('newFenceNonce: encoder produced an invalid nonce');
  return s;
}

/** WHY only 8 characters: it must be cheap in the 100-character `custom_id` budget. */
export function newCardNonce(): CardNonce {
  const bytes = new Uint8Array(5);
  randomFillSync(bytes);
  let acc = 0n;
  for (const b of bytes) acc = (acc << 8n) | BigInt(b);
  let out = '';
  for (let i = 0; i < 8; i += 1) {
    out = `${CROCKFORD.charAt(Number(acc & 31n))}${out}`;
    acc >>= 5n;
  }
  if (!isCardNonceShape(out)) throw new Error('newCardNonce: encoder produced an invalid nonce');
  return out;
}

// ---------------------------------------------------------------------------------------
// custom_id codec
// ---------------------------------------------------------------------------------------

/** Discord's hard limit. `setCustomId` throws above it - at render time, in production. */
export const CUSTOM_ID_MAX = 100;

/**
 * WHY a version segment: "buttons survive a restart" is a headline feature, so cards minted
 * by an older codec are guaranteed to exist. An unknown version decodes to a clean
 * "run the command again" instead of a structurally valid ref with wrong-meaning fields.
 */
export const CUSTOM_ID_VERSION = 'a1';
const SEP = '~';

/** The longest entity id the codec will ever carry, used by the boot preflight. */
export const WORST_CASE_ENTITY_ID = 26;
/** Length of a `CardNonce`, used by the boot preflight. */
export const CARD_NONCE_LENGTH = 8;

/**
 * Everything a button click must carry when there is no server-side session.
 *
 * WHY `nonce`: discord.js emits `InteractionCreate` unconditionally, so a spec-registered
 * action survives a restart with zero re-registration - that is the feature. The flip side is
 * that a button on a three-week-old message still fires, so the handler must be able to tell
 * that the card has been superseded. The nonce is that fence (SC-10 check 3).
 */
export interface ActionRef {
  /** Owning module. The router uses it to find the handler and to scope authorization. */
  readonly moduleId: string;
  /** Action name within the module. Stable across deploys - it is persisted inside Discord. */
  readonly action: string;
  /** The entity the click acts on: a RequestId, a settings key, a page number. */
  readonly entityId: string;
  /** Card-generation fence, compared against the stored nonce before any state change. */
  readonly nonce: CardNonce;
}

const SEGMENT_RE = /^[A-Za-z0-9._-]{1,40}$/u;

/**
 * The boot-time budget check.
 *
 * WHY the registry runs this over every DECLARED action with a worst-case entity id, rather
 * than waiting for a live card: an over-long `custom_id` makes discord.js throw while
 * rendering a card a user is already looking at. Failing on the deploy, naming the module and
 * the action, is the only humane place to discover it.
 */
export function actionRefFits(moduleId: string, action: string, entityIdLength = WORST_CASE_ENTITY_ID): boolean {
  const len = CUSTOM_ID_VERSION.length + moduleId.length + action.length + entityIdLength + CARD_NONCE_LENGTH + 4;
  return len <= CUSTOM_ID_MAX;
}

/**
 * Encode a click target.
 *
 * WHY `Result` and not a throw: the failure must land where the card is BUILT - boot time for
 * previews, request time for live cards - not inside a discord.js builder three frames deeper.
 */
export function encodeActionRef(ref: ActionRef): Result<CustomId, AppError> {
  const parts: readonly string[] = [CUSTOM_ID_VERSION, ref.moduleId, ref.action, ref.entityId, ref.nonce];
  for (const p of parts) {
    if (!SEGMENT_RE.test(p)) {
      return Err(
        errors.config(
          'custom_id',
          `custom_id segment ${JSON.stringify(p)} must match ${String(SEGMENT_RE)}`,
          'Shorten the module id, the action name or the entity id.',
        ),
      );
    }
  }
  const encoded = parts.join(SEP);
  if (!isCustomIdShape(encoded)) {
    return Err(
      errors.config(
        'custom_id',
        `custom_id is ${encoded.length} chars, Discord allows ${CUSTOM_ID_MAX}: ${encoded}`,
        'Shorten the module id or the action name; entity ids are fixed width.',
      ),
    );
  }
  return Ok(encoded);
}

/**
 * Boot-time variant that THROWS.
 *
 * WHY both exist: every module ships `previews`, and the loader renders them through the real
 * component compiler at boot, so a module whose buttons cannot be encoded fails to boot rather
 * than failing on the first click at 2am. Compile-time length checking is not expressible for
 * a runtime-composed id, so this is the assertion, promoted from test time to boot time.
 */
export function assertActionRef(ref: ActionRef): CustomId {
  const r = encodeActionRef(ref);
  if (!r.ok) throw new Error(r.error.internal ?? r.error.code);
  return r.value;
}

/**
 * A fixed, stateless component id (a `/help` pager, a settings toggle).
 * WHY it exists: those do not need the ref codec, and forcing them through it would mean
 * minting a meaningless nonce on every render.
 */
export function staticCustomId(moduleId: string, name: string): Result<CustomId, AppError> {
  const encoded = [CUSTOM_ID_VERSION, moduleId, name, '-', '-'].join(SEP);
  return isCustomIdShape(encoded)
    ? Ok(encoded)
    : Err(errors.config('custom_id', `static custom_id is ${encoded.length} chars`, 'Shorten the module id or the name.'));
}

/** Parse a `custom_id` Discord echoed back. Total: any malformed id is a clean `Err`. */
export function decodeActionRef(raw: string): Result<ActionRef, AppError> {
  const stale = errors.conflict(
    'custom_id',
    'That button is from an older version of the bot.',
    'Run the command again to get a fresh card.',
  );
  const parts = raw.split(SEP);
  if (parts.length !== 5) return Err(stale);
  const [version, moduleId, action, entityId, nonce] = parts;
  if (version !== CUSTOM_ID_VERSION) return Err(stale);
  if (moduleId === undefined || action === undefined || entityId === undefined || nonce === undefined) return Err(stale);
  // The nonce is re-proven rather than trusted: it gates a state change.
  if (nonce !== '-' && !isCardNonceShape(nonce)) return Err(stale);
  const cardNonce = isCardNonceShape(nonce) ? nonce : newCardNonceSentinel();
  return Ok({ moduleId, action, entityId, nonce: cardNonce });
}

/**
 * WHY a sentinel: a stateless `staticCustomId` has no card generation to fence, but
 * `ActionRef.nonce` must stay non-nullable so no handler can skip the comparison by accident.
 * The sentinel never equals a minted nonce, so a state-changing handler comparing against a
 * stored nonce always rejects it.
 */
function newCardNonceSentinel(): CardNonce {
  const s = '00000000';
  if (!isCardNonceShape(s)) throw new Error('card nonce sentinel is invalid');
  return s;
}
