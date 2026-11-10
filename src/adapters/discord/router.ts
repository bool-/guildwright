/**
 * The gateway wiring: raw Discord events -> core `Registry` dispatches.
 *
 * FIVE THINGS THIS FILE IS BUILT AROUND, each of which is a production incident somewhere:
 *
 *  (1) THE 3-SECOND DEADLINE. Discord fails an interaction permanently if it is not
 *      acknowledged in 3 seconds. The router acknowledges from the DECLARED `ack` strategy
 *      BEFORE the handler runs - and then a WATCHDOG defers anyway at ~2.5s if a handler that
 *      declared `instant` has not answered, so a wrong declaration degrades to a slow reply
 *      instead of a dead interaction. The watchdog logs at error level, because a firing
 *      watchdog means the spec is lying.
 *
 *  (2) THE 15-MINUTE TOKEN. Everything the router does goes through
 *      `interactionScopedReply`, which consumes an `InteractionToken`. Everything a JOB does
 *      goes through `DiscordPort`, which takes a persisted `SurfaceRef`. A `handoff` is the
 *      hinge: the card is posted NOW, on the short path, its ids are injected into the job
 *      payload under `SURFACE_KEY`, and the long path never sees a token.
 *
 *  (3) NO COLLECTORS. `createMessageComponentCollector` lives in memory and dies with the
 *      process, which is why cards used to stop working after a deploy. Routing here is
 *      stateless: decode the `custom_id`, look the handler up in the registry, run it. A
 *      three-week-old button still works, and a button from an older codec version decodes to
 *      a clean "run the command again".
 *
 *  (4) 403 DISCOVERY. Every entry point declares `needs`, and the router checks it against the
 *      interaction's own `app_permissions` field - zero API calls, always fresh - then answers
 *      with a re-invite link carrying the exact permissions integer (SC-12). Provoked 403s
 *      count toward Discord's 10,000-invalid-requests-per-10-minutes ban threshold, so
 *      discovering them is not free.
 *
 *  (5) THE MISSING PRIVILEGED INTENT. Without `MessageContent`, `message.content` is the empty
 *      string, `$request` never fires, and the product silently does nothing. That is checked
 *      at boot AND detected on the first empty message, and both say which toggle to flip.
 */

import {
  Events,
  GatewayIntentBits,
  IntentsBitField,
  type AutocompleteInteraction,
  type ChatInputCommandInteraction,
  type Client,
  type Interaction,
  type Message,
  type ButtonInteraction,
  type ModalSubmitInteraction,
  type RepliableInteraction,
  type StringSelectMenuInteraction,
} from 'discord.js';
import { Err, Ok, type Result } from '#core/result';
import { errors, operatorMessage, SERVICE_NAME, userMessage, type AppError } from '#core/errors';
import type { Args, FormValues, SelectValues } from '#core/args';
import type {
  Actor,
  AckStrategy,
  AutocompleteRequest,
  ClickInvocation,
  FormSubmission,
  Invocation,
  MessageHookEvent,
  Outcome,
  ProgressHandle,
  Space,
} from '#core/command';
import { SURFACE_KEY } from '#core/command';
import type { JobRequest, EnqueueResult, ClockPort, DiscordPort, LoggerPort } from '#core/ports';
import type { AccessPort } from '#core/ports/access';
import type { AuditPort } from '#core/ports/audit';
import type { Registry } from '#core/registry';
import { isPublic, permissionKey, type PermissionRef } from '#core/policy';
import { missingPermissions, permissionInteger, type DiscordPermission } from '#core/permissions';
import type { RateLimit } from '#core/ratelimit';
import {
  decodeActionRef,
  newRequestId,
  toChannelId,
  toGuildId,
  toRoleId,
  toUserId,
  type ChannelId,
  type GuildId,
  type RequestId,
  type RoleId,
  type UserId,
} from '#core/ids';
import { parseHttpsUrl, sanitizeStored, toEnum, wrapUserText, type UserText } from '#core/text';
import type { SurfaceRef, View, ViewNode } from '#core/view';
import { interactionScopedReply, interactionToken, answerAutocomplete, type InteractionScopedReply } from '#adapters/discord/client';

// ---------------------------------------------------------------------------------------
// The 3-second contract
// ---------------------------------------------------------------------------------------

/** Discord's hard deadline for the first acknowledgement. */
export const ACK_DEADLINE_MS = 3_000;
/** How much of that we keep in hand for the round trip to Discord. */
export const WATCHDOG_MARGIN_MS = 500;

/**
 * When the watchdog should fire, measured from when DISCORD created the interaction rather
 * than from when we started work: the gateway hop, the event loop and any preflight have
 * already spent part of the budget, and a watchdog that starts its own 2.5 seconds after all
 * of that is a watchdog that fires at 3.4 seconds, i.e. never usefully.
 */
export function watchdogDelayMs(createdAtMs: number, nowMs: number): number {
  return Math.max(0, createdAtMs + ACK_DEADLINE_MS - WATCHDOG_MARGIN_MS - nowMs);
}

/** WHY a named predicate: the router acknowledges before the handler runs for exactly these,
 *  and the watchdog exists for exactly the others. */
export function ackDefersUpFront(ack: AckStrategy): boolean {
  return ack === 'defer' || ack === 'defer-ephemeral' || ack === 'defer-update';
}

/**
 * Why this handoff cannot be delivered, or `null` if it can.
 *
 * THE 15-MINUTE RULE, ENFORCED. A handoff's card is updated LATER, by a job, through a fresh
 * REST call keyed on a persisted `channelId`/`messageId`. An ephemeral message has no id any
 * later call can use - so an ephemeral handoff card is a card that says "building..." forever.
 * Both routes to one are refused here: the view asking for it, and the ACK making it ephemeral
 * whatever the view said. The second is the one that survives review.
 */
export function handoffRefusal(moduleId: string, view: View, ack: AckStrategy): AppError | null {
  const ephemeralAck = ack === 'defer-ephemeral';
  if (view.ephemeral !== true && !ephemeralAck) return null;
  return errors.config(
    `${moduleId}.handoff`,
    ephemeralAck
      ? "a handoff came from a handler declaring ack: 'defer-ephemeral'; that card is ephemeral and no job can edit it later"
      : 'a handoff view was marked ephemeral, and an ephemeral message cannot be edited by a job',
    "Use ack: 'defer' or 'defer-update' and return a non-ephemeral view from a handler that hands off durable work.",
  );
}

// ---------------------------------------------------------------------------------------
// Rate limiting, as a seam
// ---------------------------------------------------------------------------------------

/** What the router needs from whatever implements SC-9's token buckets. */
export interface RateGateRequest {
  readonly moduleId: string;
  /** The entry point, e.g. `command:tag get` or `action:approve`. Names the bucket. */
  readonly name: string;
  readonly limits: readonly RateLimit[];
  readonly userId: UserId;
  readonly guildId: GuildId | null;
  readonly channelId: ChannelId;
  readonly at: number;
}

/**
 * Spend every declared bucket atomically, or say which one was empty.
 * WHY it is a port-shaped seam rather than an import: the real implementation is a SQLite
 * table owned by another adapter, and the router must be constructible without it.
 */
export interface RateGate {
  spend(req: RateGateRequest): Result<void, AppError>;
}

/** The offline default. WHY it exists: `npm run dev:offline` and the tests must not need a
 *  database in order to route an interaction. */
export const ALLOW_ALL: RateGate = { spend: () => Ok(undefined) };

// ---------------------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------------------

/** Everything the router is given. All seams, no globals. */
export interface RouterIO {
  readonly registry: Registry;
  readonly logger: LoggerPort;
  readonly clock: ClockPort;
  readonly access: AccessPort;
  readonly audit: AuditPort;
  /** The CHANNEL-scoped path. Used for hook replies and for repairing a failed handoff. */
  readonly discord: DiscordPort;
  readonly limits: RateGate;
  /** The application id, for the re-invite link on a missing-permission card. */
  readonly clientId: string;
  /** The configured application owner - authorization layer L0. */
  readonly ownerId: string;
  /**
   * Enqueue a handoff's durable work.
   *
   * WHY it is injected rather than `JobsPort` directly: the job runner owns how a module's job
   * type is namespaced and which transaction the insert joins, and the router must not encode
   * a second opinion about either. `null` means no runner is wired, and a `handoff` then fails
   * loudly instead of posting a card nothing will ever update.
   */
  readonly enqueueJob: ((moduleId: string, job: JobRequest) => Result<EnqueueResult, AppError>) | null;
}

/** What `handoff` reports: the failure (if any), and whether the card already shows it. */
interface HandoffResult {
  readonly error: AppError | null;
  readonly reported: boolean;
}

/** What `attach` gives back. */
export interface Router {
  /** Remove every listener. Idempotent. */
  detach(): void;
}

// ---------------------------------------------------------------------------------------
// Errors, rendered
// ---------------------------------------------------------------------------------------

/**
 * Card titles: 2-4 words naming what happened. The body never repeats the title.
 * `conflict` is the catch-all for "the state moved", so its default title is deliberately
 * generic rather than claiming the thing was already handled.
 */
function headingFor(e: AppError): string {
  switch (e.kind) {
    case 'validation':
      return 'Check your input';
    case 'not-found':
      return 'Not found';
    case 'conflict':
      return "Can't do that now";
    case 'forbidden':
      return 'Not allowed';
    case 'missing-bot-permission':
      return 'Missing permissions';
    case 'rate-limited':
      return 'Slow down';
    case 'timeout':
      return 'Timed out';
    case 'upstream':
      return `${e.service === 'sqlite' ? 'Database' : SERVICE_NAME[e.service]} error`;
    case 'unavailable':
      return 'Unavailable right now';
    case 'cancelled':
      return 'Cancelled';
    case 'config':
      return 'The bot is misconfigured';
    case 'internal':
      return 'Something broke';
    default: {
      const exhaustive: never = e;
      void exhaustive;
      return 'Something broke';
    }
  }
}

/** Warning for things the user can fix, info for a stop they asked for, error for real failures. */
function iconFor(e: AppError): 'warn' | 'info' | 'error' {
  switch (e.kind) {
    case 'validation':
    case 'not-found':
    case 'conflict':
    case 'forbidden':
    case 'missing-bot-permission':
    case 'rate-limited':
      return 'warn';
    case 'cancelled':
      return 'info';
    case 'timeout':
    case 'upstream':
    case 'unavailable':
    case 'config':
    case 'internal':
      return 'error';
    default: {
      const exhaustive: never = e;
      void exhaustive;
      return 'error';
    }
  }
}

/** The operator view of a refusal: the internal detail PLUS the developer hint a config error
 *  carries, which is exactly what a user must not be shown. */
function logDetail(e: AppError): string {
  return e.kind === 'config' ? `${operatorMessage(e)} | hint: ${e.nextStep}` : operatorMessage(e);
}

/** The one-click repair for SC-12: the exact permissions integer, in a re-invite URL. */
export function inviteUrl(clientId: string, permissionBits: string): string {
  return `https://discord.com/oauth2/authorize?client_id=${clientId}&scope=bot+applications.commands&permissions=${permissionBits}`;
}

/**
 * The ONLY way an `AppError` becomes a card.
 *
 * It renders `userMessage(e)` and nothing else, so `internal` - which carries paths, upstream
 * bodies and once carried a token - is structurally unreachable from here.
 */
export function errorView(e: AppError, clientId: string): View {
  const nodes: ViewNode[] = [
    { kind: 'heading', text: headingFor(e), icon: iconFor(e) },
    { kind: 'text', md: sanitizeStored(userMessage(e)) },
  ];
  if (e.kind === 'missing-bot-permission') {
    const url = parseHttpsUrl(inviteUrl(clientId, e.inviteBits));
    if (url.ok) {
      nodes.push({ kind: 'buttons', buttons: [], links: [{ label: 'Re-invite with these permissions', url: url.value }] });
    }
  }
  return { accent: iconFor(e), ephemeral: true, nodes };
}

// ---------------------------------------------------------------------------------------
// custom_id -> handler
// ---------------------------------------------------------------------------------------

/** The registry key a `custom_id` resolves to, plus the decoded ref the handler receives. */
export interface RoutedComponent {
  readonly key: string;
  readonly moduleId: string;
  readonly action: string;
  readonly entityId: string;
  readonly nonce: string;
}

/**
 * Decode a `custom_id` into a registry key.
 *
 * WHY this is the whole routing story: discord.js emits `InteractionCreate` unconditionally,
 * so a card minted before the last deploy - or before the last restart - still routes, with
 * zero registration and no collector.
 */
export function routeCustomId(raw: string): Result<RoutedComponent, AppError> {
  const ref = decodeActionRef(raw);
  if (!ref.ok) return ref;
  return Ok({
    key: `${ref.value.moduleId}:${ref.value.action}`,
    moduleId: ref.value.moduleId,
    action: ref.value.action,
    entityId: ref.value.entityId,
    nonce: ref.value.nonce,
  });
}

/** The registry's command key: `tag`, `tag get`, `tag admin reset`. */
export function commandKey(parts: {
  readonly commandName: string;
  readonly group: string | null;
  readonly subcommand: string | null;
}): string {
  return [parts.commandName, parts.group, parts.subcommand].filter((p): p is string => p !== null).join(' ');
}

// ---------------------------------------------------------------------------------------
// Message prefix hooks
// ---------------------------------------------------------------------------------------

/** What `$request Add a /ping command` decodes to. */
export interface PrefixMatch {
  readonly prefix: string;
  readonly body: string;
}

/**
 * Match a literal message prefix.
 *
 * WHY the prefix must be followed by whitespace or end-of-message: without that, `$requesting
 * a day off` fires the build pipeline, which files a GitHub issue and asks a human to approve
 * spending CI credits on it. WHY the longest match wins: the registry refuses two prefixes
 * where one shadows the other, but a bot with both `$req` and `$request` would still have to
 * pick, and picking the longer one is the only choice that can be right.
 */
export function matchPrefix(content: string, prefixes: readonly string[]): PrefixMatch | null {
  let best: PrefixMatch | null = null;
  for (const prefix of prefixes) {
    if (prefix.length === 0 || !content.startsWith(prefix)) continue;
    const after = content.slice(prefix.length);
    if (after.length > 0 && !/^\s/u.test(after)) continue;
    if (best === null || prefix.length > best.prefix.length) best = { prefix, body: after.trim() };
  }
  return best;
}

/**
 * The sentence an operator needs when `$request` does nothing.
 * WHY it names the toggle: "content was empty" is a symptom, and every hour spent on it is an
 * hour spent not reading the Developer Portal page that fixes it in ten seconds.
 */
export const MESSAGE_CONTENT_ADVICE =
  'MESSAGE CONTENT INTENT IS MISSING: message.content arrives empty, so no $ prefix will ever match. ' +
  'Enable it at Discord Developer Portal -> your application -> Bot -> Privileged Gateway Intents -> Message Content Intent, then restart.';

/** Whether a message looks like the intent is missing rather than the user typing nothing. */
export function looksLikeMissingContent(m: {
  readonly content: string;
  readonly attachments: number;
  readonly embeds: number;
  readonly stickers: number;
}): boolean {
  return m.content.length === 0 && m.attachments === 0 && m.embeds === 0 && m.stickers === 0;
}

/**
 * In a DM there are no channel overwrites and the bot always has these.
 * WHY it is spelled out: `needs` is preflighted for every entry point, and a message hook in a
 * DM has no `app_permissions` field to read, so without this a DM hook would be refused for a
 * permission Discord does not even model there.
 */
const DM_PERMISSIONS: readonly DiscordPermission[] = [
  'ViewChannel',
  'SendMessages',
  'EmbedLinks',
  'AttachFiles',
  'ReadMessageHistory',
  'AddReactions',
  'UseExternalEmojis',
  'UseApplicationCommands',
];

// ---------------------------------------------------------------------------------------
// Argument marshalling. Every textual accessor yields `UserText`; there is no string door.
// ---------------------------------------------------------------------------------------

function argsFor(interaction: ChatInputCommandInteraction): Args {
  const wrap = (raw: string | null): UserText | undefined =>
    raw === null ? undefined : wrapUserText(raw, 'command-option');

  return {
    get names(): readonly string[] {
      return interaction.options.data.flatMap((o) => (o.options ?? []).map((c) => c.name).concat(o.name));
    },
    text: (name) => wrap(interaction.options.getString(name)),
    textRequired(name) {
      const raw = interaction.options.getString(name);
      if (raw === null) {
        // Discord enforces `required`, so absence means the registered payload and the spec
        // have drifted - a deploy bug, and it should be loud.
        throw new Error(`args.textRequired("${name}"): the deployed command payload has drifted from the spec`);
      }
      return wrapUserText(raw, 'command-option');
    },
    integer(name, opts) {
      const raw = interaction.options.getInteger(name);
      if (raw === null) {
        return Err(errors.validation(name, 'That number is missing.', `Provide ${name}.`));
      }
      if (raw < opts.min || raw > opts.max) {
        return Err(errors.validation(name, `That number must be between ${opts.min} and ${opts.max}.`, 'Pick a number in range.'));
      }
      return Ok(raw);
    },
    bool: (name) => interaction.options.getBoolean(name) ?? undefined,
    user(name) {
      const user = interaction.options.getUser(name);
      if (user === null) return undefined;
      const id = toUserId(user.id);
      return id.ok ? id.value : undefined;
    },
    role(name) {
      const role = interaction.options.getRole(name);
      if (role === null) return undefined;
      const id = toRoleId(role.id);
      return id.ok ? id.value : undefined;
    },
    channel(name) {
      const channel = interaction.options.getChannel(name);
      if (channel === null) return undefined;
      const id = toChannelId(channel.id);
      return id.ok ? id.value : undefined;
    },
    choice(name, allowed) {
      const raw = interaction.options.getString(name);
      if (raw === null) return Err(errors.validation(name, 'That choice is missing.', `Provide ${name}.`));
      // SC-11: Discord permits a client to submit a value that was never offered, so the
      // allow-list the HANDLER will accept is the only thing worth checking.
      return toEnum(wrapUserText(raw, 'command-option'), allowed);
    },
  };
}

function formValuesFor(interaction: ModalSubmitInteraction): FormValues {
  const read = (name: string): string | null => {
    try {
      return interaction.fields.getTextInputValue(name);
    } catch {
      // discord.js throws when the field is absent; an optional field left blank is normal.
      return null;
    }
  };
  return {
    get names(): readonly string[] {
      return [...interaction.fields.fields.keys()];
    },
    text(name) {
      const raw = read(name);
      return raw === null ? undefined : wrapUserText(raw, 'modal-field');
    },
    textRequired(name) {
      const raw = read(name);
      if (raw === null) {
        throw new Error(`fields.textRequired("${name}"): the modal that was opened does not match this handler`);
      }
      return wrapUserText(raw, 'modal-field');
    },
    choice(name, allowed) {
      let picked: readonly string[];
      try {
        picked = interaction.fields.getStringSelectValues(name);
      } catch {
        // Absent: an optional dropdown left empty, exactly like a blank optional text field.
        return Ok(undefined);
      }
      const first = picked[0];
      // The client echoes the value back, so it is re-validated, never trusted.
      return first === undefined ? Ok(undefined) : toEnum(wrapUserText(first, 'modal-field'), allowed);
    },
  };
}

function selectValuesFor(interaction: StringSelectMenuInteraction): SelectValues {
  const chosen = interaction.values.map((v) => wrapUserText(v, 'command-option'));
  return {
    chosen,
    all(allowed) {
      const out: string[] = [];
      for (const value of chosen) {
        const checked = toEnum(value, allowed);
        if (!checked.ok) return checked;
        out.push(checked.value);
      }
      return Ok(out);
    },
  };
}

// ---------------------------------------------------------------------------------------
// The progress handle
// ---------------------------------------------------------------------------------------

interface ProgressParts {
  readonly tokenExpiresAtMs: number;
  update(view: View): void;
  detach(): SurfaceRef;
}

/**
 * CORE-CHANGE-NEEDED (see `core_change_requests`): `ProgressHandle` in `#core/command` is
 * keyed by a `unique symbol` that the module does not export, and it ships no constructor, so
 * NO adapter can produce one structurally. This assertion is the whole of the workaround; it
 * is confined to one three-line function so that adding
 * `export function createProgressHandle(...)` to core deletes it in one edit.
 *
 * The runtime object is complete and correct - the symbol is a compile-time brand that nothing
 * ever reads.
 */
function asProgressHandle(parts: ProgressParts): ProgressHandle {
  return parts as unknown as ProgressHandle;
}

// ---------------------------------------------------------------------------------------
// The router
// ---------------------------------------------------------------------------------------

/** Where an invocation is happening, plus who is asking. */
interface Context {
  readonly requestId: RequestId;
  readonly actor: Actor;
  readonly space: Space;
  readonly at: number;
}

/** WHY the guard returns data: the same three checks run for commands, clicks, selects, modals
 *  and hooks, and duplicating them is how one of the five ends up unguarded. */
interface GuardInput {
  readonly moduleId: string;
  readonly name: string;
  readonly permission: PermissionRef;
  readonly limit: readonly RateLimit[];
  readonly needs: readonly DiscordPermission[];
}

export function attachRouter(client: Client, io: RouterIO): Router {
  const log = io.logger.child({ component: 'discord-router' });
  let warnedAboutContent = false;

  // --- boot-time intent check -----------------------------------------------------------
  const intents = new IntentsBitField(client.options.intents);
  if (!intents.has(GatewayIntentBits.MessageContent) && io.registry.hooks.size > 0) {
    log.error(MESSAGE_CONTENT_ADVICE, { hooks: [...io.registry.hooks.keys()].join(',') });
  }

  // --- shared pipeline ------------------------------------------------------------------

  function contextFrom(
    actorParts: {
      readonly userId: string;
      readonly roleIds: readonly string[];
      readonly memberPermissions: bigint;
      readonly appPermissions: bigint;
    },
    spaceParts: { readonly guildId: string | null; readonly channelId: string },
  ): Result<Context, AppError> {
    const userId = toUserId(actorParts.userId);
    if (!userId.ok) return userId;
    const channelId = toChannelId(spaceParts.channelId);
    if (!channelId.ok) return channelId;

    let guildId: GuildId | null = null;
    if (spaceParts.guildId !== null) {
      const parsed = toGuildId(spaceParts.guildId);
      if (!parsed.ok) return parsed;
      guildId = parsed.value;
    }

    const roleIds: RoleId[] = [];
    for (const raw of actorParts.roleIds) {
      const role = toRoleId(raw);
      if (role.ok) roleIds.push(role.value);
    }

    const at = io.clock.now();
    return Ok({
      requestId: newRequestId(at),
      actor: {
        userId: userId.value,
        roleIds,
        isAppOwner: userId.value === io.ownerId,
        memberPermissions: actorParts.memberPermissions,
        appPermissions: actorParts.appPermissions,
      },
      space: { guildId, channelId: channelId.value },
      at,
    });
  }

  /** Bot permissions, then authorization, then rate limits - in that order, always. */
  function guard(ctx: Context, spec: GuardInput): Result<void, AppError> {
    // (1) SC-12: preflight from the interaction's own app_permissions. Zero API calls.
    const missing = missingPermissions(ctx.actor.appPermissions, spec.needs);
    if (missing.length > 0) {
      return Err(
        errors.missingBotPermission(
          missing,
          permissionInteger(spec.needs),
          'Ask an admin to allow them here, or use the re-invite button.',
        ),
      );
    }

    // (2) SC-7: authorization against the CLICKER, never the card's author.
    if (!isPublic(spec.permission)) {
      const decision = io.access.check(ctx.space.guildId, spec.permission, {
        userId: ctx.actor.userId,
        roleIds: ctx.actor.roleIds,
        memberPermissions: ctx.actor.memberPermissions,
        isAppOwner: ctx.actor.isAppOwner,
      });
      if (!decision.allowed) {
        io.audit.record({
          action: `${spec.moduleId}.${spec.name}`,
          actorId: ctx.actor.userId,
          guildId: ctx.space.guildId,
          detail: { requestId: ctx.requestId, denied: permissionKey(spec.permission) },
          decisionLayer: decision.layer,
        });
        return Err(
          errors.forbidden(
            permissionKey(spec.permission),
            decision.grantableBy,
            `Ask ${decision.grantableBy} to run \`/access grant ${permissionKey(spec.permission)}\`.`,
          ),
        );
      }
    }

    // (3) SC-9: spend every declared bucket, and say which one was empty.
    return io.limits.spend({
      moduleId: spec.moduleId,
      name: spec.name,
      limits: spec.limit,
      userId: ctx.actor.userId,
      guildId: ctx.space.guildId,
      channelId: ctx.space.channelId,
      at: ctx.at,
    });
  }

  // --- acknowledgement, and the watchdog ------------------------------------------------

  async function acknowledge(reply: InteractionScopedReply, ack: AckStrategy): Promise<Result<void, AppError>> {
    switch (ack) {
      case 'defer':
        return mapVoid(await reply.deferReply({ ephemeral: false }));
      case 'defer-ephemeral':
        return mapVoid(await reply.deferReply({ ephemeral: true }));
      case 'defer-update':
        return mapVoid(await reply.deferUpdate());
      case 'instant':
      case 'form':
        // Nothing to do: the handler's own answer IS the acknowledgement, within 3 seconds.
        return Ok(undefined);
      default: {
        const exhaustive: never = ack;
        void exhaustive;
        return Ok(undefined);
      }
    }
  }

  /**
   * The watchdog.
   *
   * A handler that declared `instant` and then awaited SQLite, GitHub and a DNS lookup is the
   * single easiest way to kill an interaction, and the failure is invisible in tests because
   * a fake is fast. So: if `instant` has not answered by ~2.5s of the interaction's own age,
   * defer for it and log at ERROR - the reply still lands, and the log names the handler whose
   * declaration is wrong.
   *
   * `form` is deliberately NOT rescued: Discord forbids defer-then-modal, so deferring would
   * turn a slow modal into a permanently broken one.
   */
  function startWatchdog(
    reply: InteractionScopedReply,
    ack: AckStrategy,
    createdAtMs: number,
    label: string,
  ): () => void {
    if (ackDefersUpFront(ack)) return () => undefined;
    const delay = watchdogDelayMs(createdAtMs, io.clock.now());
    const timer = setTimeout(() => {
      if (reply.acknowledged()) return;
      if (ack === 'form') {
        log.error('a form handler has not returned its modal within the 3-second deadline', { handler: label });
        return;
      }
      log.error("ACK WATCHDOG: handler declared ack:'instant' but had not answered at 2.5s; deferring for it", {
        handler: label,
      });
      // EPHEMERAL, and this is a FAIL-CLOSED choice rather than a cosmetic one.
      //
      // The watchdog cannot know what the handler was about to return - it fires precisely
      // because the handler has not answered yet. A defer decides the visibility of the reply
      // that follows it, so guessing wrong goes one of two ways, and they are not symmetrical:
      //
      //   guessed public,  answer was ephemeral -> a permission denial, a credential error or
      //                                            an audit listing is published to the channel.
      //   guessed private, answer was public    -> the person who ran the command sees it and
      //                                            the channel does not.
      //
      // The first is a disclosure the user never asked for and cannot undo; the second is an
      // inconvenience on a path that is ALREADY degraded, because a handler that declared
      // `ack: 'instant'` and then took 2.5 seconds has broken its own contract either way.
      //
      // No shipped command uses `ack: 'instant'` today, so nothing currently leaks. It is fixed
      // now because this repo is extended by agents on purpose, and the first module that both
      // declares `instant` and answers ephemerally would have inherited a channel-visible
      // refusal with nothing in the type system to warn it.
      void reply.deferReply({ ephemeral: true }).then((r) => {
        if (!r.ok) log.error('watchdog defer failed', { handler: label, cause: operatorMessage(r.error) });
      });
    }, delay);
    return () => clearTimeout(timer);
  }

  // --- outcome delivery -----------------------------------------------------------------

  /**
   * A handoff, on the interaction path.
   *
   * The card goes out NOW, while the token is alive, and its durable ids are injected into the
   * job payload under `SURFACE_KEY`. From here on the work belongs to the job runner, which
   * has no token and no way to acquire one.
   */
  async function handoff(
    moduleId: string,
    view: View,
    job: JobRequest,
    post: (view: View) => Promise<Result<SurfaceRef | null, AppError>>,
    ack: AckStrategy,
    repairCard: boolean,
  ): Promise<HandoffResult> {
    const fail = (error: AppError, reported = false): HandoffResult => ({ error, reported });
    const refused = handoffRefusal(moduleId, view, ack);
    if (refused !== null) return fail(refused);
    const posted = await post(view);
    if (!posted.ok) return fail(posted.error);
    if (posted.value === null) {
      return fail(errors.upstream('discord', 0, 'Run the command again.', 'handoff card produced no message id'));
    }
    if (io.enqueueJob === null) {
      return fail(errors.unavailable('the job runner', 'Ask an admin to restart the bot with the job runner enabled.'));
    }

    const surface: SurfaceRef = posted.value;
    const enqueued = io.enqueueJob(moduleId, { ...job, payload: { ...job.payload, [SURFACE_KEY]: surface } });
    if (!enqueued.ok) {
      // Where there is no interaction to answer on (a message hook), the failure has to land ON
      // the card by the CHANNEL-scoped path. On the interaction path the caller answers once
      // through the reply object instead: editing here AND replying there is two writes to one
      // message, and the second one turns an ephemeral view into a public card.
      if (!repairCard) return fail(enqueued.error);
      const repaired = await io.discord.edit(surface, errorView(enqueued.error, io.clientId));
      if (!repaired.ok) {
        log.error('could not report a failed handoff on its own card', { cause: operatorMessage(repaired.error) });
        return fail(enqueued.error);
      }
      return fail(enqueued.error, true);
    }
    return { error: null, reported: false };
  }

  async function deliver(
    moduleId: string,
    outcome: Outcome,
    reply: InteractionScopedReply,
    label: string,
    ack: AckStrategy,
  ): Promise<void> {
    switch (outcome.kind) {
      case 'view':
        report(await reply.send(outcome.view), label);
        return;
      case 'fail':
        log.info('handler refused', { handler: label, cause: logDetail(outcome.error) });
        report(await reply.send(errorView(outcome.error, io.clientId)), label);
        return;
      case 'form':
        report(await reply.showForm(outcome.form), label);
        return;
      case 'silent':
        report(await reply.close(), label);
        return;
      case 'handoff': {
        const done = await handoff(
          moduleId,
          outcome.view,
          outcome.job,
          (v) => reply.send(v),
          ack,
          false,
        );
        if (done.error !== null) {
          log.error('handoff failed', { handler: label, cause: logDetail(done.error) });
          // Exactly one answer, through the reply object, so the error keeps its visibility.
          report(await reply.send(errorView(done.error, io.clientId)), label);
        }
        return;
      }
      default: {
        const exhaustive: never = outcome;
        void exhaustive;
        return;
      }
    }
  }

  /** WHY every send goes through here: a failed reply must be a log line, never a rejected
   *  promise escaping into the event emitter. */
  function report<T>(r: Result<T, AppError>, label: string): void {
    if (!r.ok) log.error('could not answer an interaction', { handler: label, cause: operatorMessage(r.error) });
  }

  /**
   * `ProgressHandle`, with the three behaviours core documents on it.
   *
   *  - COALESCED: rapid `update` calls are serialised and only the newest is sent, so a
   *    handler in a loop cannot turn one card into a burst of PATCHes and a 429.
   *  - A NO-OP BEFORE THE ACK: `update` edits a deferred reply, and there is nothing to edit
   *    until the acknowledgement has happened.
   *  - A NO-OP AFTER `detach`: the handler has taken the durable handle and is done with the
   *    token, so anything sent afterwards would race the job that now owns the card.
   */
  function progressFor(reply: InteractionScopedReply, ctx: Context, label: string): ProgressHandle {
    let detached = false;
    let chain: Promise<void> = Promise.resolve();
    let latest = 0;

    return asProgressHandle({
      tokenExpiresAtMs: reply.expiresAtMs,
      update(view: View): void {
        if (detached || !reply.acknowledged()) return;
        latest += 1;
        const mine = latest;
        chain = chain.then(async () => {
          // Superseded while the previous edit was in flight: sending this one would only
          // spend a request to be overwritten.
          if (detached || latest !== mine) return;
          const sent = await reply.send(view);
          if (!sent.ok) log.warn('progress update dropped', { handler: label, cause: operatorMessage(sent.error) });
        });
      },
      detach(): SurfaceRef {
        detached = true;
        const surface = reply.surface();
        if (surface !== null) return surface;
        // Only reachable from an `instant` or `form` handler that has not answered yet, i.e.
        // before any message exists to hand back. The empty message id is inert - every port
        // method that takes a `SurfaceRef` re-proves it with `toMessageId` - and this logs
        // loudly because the handler wanted a durable handle and there is none.
        log.error("progress.detach() was called before the reply existed; declare ack:'defer' to get a card to hand back", {
          handler: label,
        });
        return { guildId: ctx.space.guildId, channelId: ctx.space.channelId, messageId: '' };
      },
    });
  }

  // --- entry point: slash commands ------------------------------------------------------

  async function runCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    const key = commandKey({
      commandName: interaction.commandName,
      group: interaction.options.getSubcommandGroup(false),
      subcommand: interaction.options.getSubcommand(false),
    });
    const owner = io.registry.commands.get(key);
    const reply = interactionScopedReply(interactionToken(interaction), log);
    if (owner === undefined) {
      // A command Discord still has registered but this build no longer declares.
      report(
        await reply.send(
          errorView(errors.notFound('command', 'The command list is out of date; try again in a minute.'), io.clientId),
        ),
        key,
      );
      return;
    }

    const ctx = contextFrom(
      {
        userId: interaction.user.id,
        roleIds: memberRoleIds(interaction),
        memberPermissions: interaction.memberPermissions?.bitfield ?? 0n,
        appPermissions: interaction.appPermissions.bitfield,
      },
      { guildId: interaction.guildId, channelId: interaction.channelId },
    );
    if (!ctx.ok) {
      report(await reply.send(errorView(ctx.error, io.clientId)), key);
      return;
    }

    if (owner.spec.surface === 'guild' && ctx.value.space.guildId === null) {
      report(
        await reply.send(errorView(errors.validation('surface', 'That command only works in a server.', 'Run it in a server channel.'), io.clientId)),
        key,
      );
      return;
    }

    const guarded = guard(ctx.value, {
      moduleId: owner.moduleId,
      name: `command:${key}`,
      permission: owner.spec.permission,
      limit: owner.spec.limit,
      needs: owner.spec.needs,
    });
    if (!guarded.ok) {
      report(await reply.send(errorView(guarded.error, io.clientId)), key);
      return;
    }

    const acked = await acknowledge(reply, owner.spec.ack);
    if (!acked.ok) {
      log.error('acknowledgement failed', { handler: key, cause: operatorMessage(acked.error) });
      return;
    }

    const invocation: Invocation = {
      id: ctx.value.requestId,
      actor: ctx.value.actor,
      space: ctx.value.space,
      args: argsFor(interaction),
      progress: progressFor(reply, ctx.value, key),
      at: ctx.value.at,
    };

    const stop = startWatchdog(reply, owner.spec.ack, interaction.createdTimestamp, key);
    let outcome: Outcome;
    try {
      outcome = await owner.spec.handle(invocation);
    } catch (cause: unknown) {
      outcome = { kind: 'fail', error: crashed(ctx.value.requestId, key, cause) };
    } finally {
      stop();
    }
    await deliver(owner.moduleId, outcome, reply, key, owner.spec.ack);
  }

  // --- entry point: buttons and select menus --------------------------------------------

  /**
   * Buttons and select menus, in one function.
   *
   * WHY generic over the spec: `ActionSpec.handle` takes a `ClickInvocation` and
   * `SelectActionSpec.handle` takes a `SelectInvocation`, so a union of the two owners has no
   * callable `handle`. The lookup and the invocation are the only two lines that differ, so
   * they are the two parameters; everything else - the guard order, the ack, the watchdog, the
   * delivery - is written once and therefore cannot drift between the two surfaces.
   */
  async function runComponent<S extends ComponentSpecLike>(
    interaction: ButtonInteraction | StringSelectMenuInteraction,
    lookup: (key: string) => { readonly moduleId: string; readonly spec: S } | undefined,
    invoke: (spec: S, click: ClickInvocation) => Promise<Outcome>,
  ): Promise<void> {
    const routed = routeCustomId(interaction.customId);
    const reply = interactionScopedReply(interactionToken(interaction), log);
    if (!routed.ok) {
      report(await reply.send(errorView(routed.error, io.clientId)), 'component');
      return;
    }

    const owner = lookup(routed.value.key);
    if (owner === undefined) {
      report(
        await reply.send(
          errorView(
            errors.conflict('unknown_action', 'That button belongs to a part of the bot that is no longer loaded.', 'Run the command again.'),
            io.clientId,
          ),
        ),
        routed.value.key,
      );
      return;
    }

    const ctx = contextFrom(
      {
        userId: interaction.user.id,
        roleIds: memberRoleIds(interaction),
        memberPermissions: interaction.memberPermissions?.bitfield ?? 0n,
        appPermissions: interaction.appPermissions.bitfield,
      },
      { guildId: interaction.guildId, channelId: interaction.channelId },
    );
    if (!ctx.ok) {
      report(await reply.send(errorView(ctx.error, io.clientId)), routed.value.key);
      return;
    }

    const guarded = guard(ctx.value, {
      moduleId: owner.moduleId,
      name: `action:${routed.value.action}`,
      permission: owner.spec.permission,
      limit: owner.spec.limit,
      needs: owner.spec.needs,
    });
    if (!guarded.ok) {
      report(await reply.send(errorView(guarded.error, io.clientId)), routed.value.key);
      return;
    }

    const acked = await acknowledge(reply, owner.spec.ack);
    if (!acked.ok) {
      log.error('acknowledgement failed', { handler: routed.value.key, cause: operatorMessage(acked.error) });
      return;
    }

    const ref = decodeActionRef(interaction.customId);
    if (!ref.ok) {
      report(await reply.send(errorView(ref.error, io.clientId)), routed.value.key);
      return;
    }

    const click: ClickInvocation = {
      id: ctx.value.requestId,
      actor: ctx.value.actor,
      space: ctx.value.space,
      ref: ref.value,
      // The card the button lives on. Durable, and the thing a `defer-update` edits.
      surface: { guildId: interaction.guildId, channelId: interaction.channelId, messageId: interaction.message.id },
      progress: progressFor(reply, ctx.value, routed.value.key),
      at: ctx.value.at,
    };

    const stop = startWatchdog(reply, owner.spec.ack, interaction.createdTimestamp, routed.value.key);
    let outcome: Outcome;
    try {
      outcome = await invoke(owner.spec, click);
    } catch (cause: unknown) {
      outcome = { kind: 'fail', error: crashed(ctx.value.requestId, routed.value.key, cause) };
    } finally {
      stop();
    }
    await deliver(owner.moduleId, outcome, reply, routed.value.key, owner.spec.ack);
  }

  // --- entry point: modal submits -------------------------------------------------------

  async function runModal(interaction: ModalSubmitInteraction): Promise<void> {
    const routed = routeCustomId(interaction.customId);
    const reply = interactionScopedReply(interactionToken(interaction), log);
    if (!routed.ok) {
      report(await reply.send(errorView(routed.error, io.clientId)), 'form');
      return;
    }
    const owner = io.registry.forms.get(routed.value.key);
    if (owner === undefined) {
      report(
        await reply.send(
          errorView(errors.conflict('unknown_form', 'That form is no longer handled.', 'Run the command again.'), io.clientId),
        ),
        routed.value.key,
      );
      return;
    }

    const ctx = contextFrom(
      {
        userId: interaction.user.id,
        roleIds: memberRoleIds(interaction),
        memberPermissions: interaction.memberPermissions?.bitfield ?? 0n,
        appPermissions: interaction.appPermissions.bitfield,
      },
      { guildId: interaction.guildId, channelId: interaction.channelId ?? '' },
    );
    if (!ctx.ok) {
      report(await reply.send(errorView(ctx.error, io.clientId)), routed.value.key);
      return;
    }

    const guarded = guard(ctx.value, {
      moduleId: owner.moduleId,
      name: `form:${routed.value.action}`,
      permission: owner.spec.permission,
      limit: owner.spec.limit,
      needs: owner.spec.needs,
    });
    if (!guarded.ok) {
      report(await reply.send(errorView(guarded.error, io.clientId)), routed.value.key);
      return;
    }

    const acked = await acknowledge(reply, owner.spec.ack);
    if (!acked.ok) {
      log.error('acknowledgement failed', { handler: routed.value.key, cause: operatorMessage(acked.error) });
      return;
    }

    const ref = decodeActionRef(interaction.customId);
    if (!ref.ok) {
      report(await reply.send(errorView(ref.error, io.clientId)), routed.value.key);
      return;
    }

    const submission: FormSubmission = {
      id: ctx.value.requestId,
      actor: ctx.value.actor,
      space: ctx.value.space,
      ref: ref.value,
      fields: formValuesFor(interaction),
      progress: progressFor(reply, ctx.value, routed.value.key),
      at: ctx.value.at,
    };

    let outcome: Outcome;
    try {
      outcome = await owner.spec.handle(submission);
    } catch (cause: unknown) {
      outcome = { kind: 'fail', error: crashed(ctx.value.requestId, routed.value.key, cause) };
    }
    await deliver(owner.moduleId, outcome, reply, routed.value.key, owner.spec.ack);
  }

  // --- entry point: autocomplete --------------------------------------------------------

  async function runAutocomplete(interaction: AutocompleteInteraction): Promise<void> {
    const key = commandKey({
      commandName: interaction.commandName,
      group: interaction.options.getSubcommandGroup(false),
      subcommand: interaction.options.getSubcommand(false),
    });
    const owner = io.registry.commands.get(key);
    const answer = owner?.spec.autocomplete;
    if (owner === undefined || answer === undefined) {
      // The registry refuses to boot a command that declares `autocomplete: true` without a
      // handler, so this is only reachable for a stale registration.
      report(await answerAutocomplete(interaction, []), key);
      return;
    }

    const focused = interaction.options.getFocused(true);
    const ctx = contextFrom(
      {
        userId: interaction.user.id,
        roleIds: memberRoleIds(interaction),
        memberPermissions: interaction.memberPermissions?.bitfield ?? 0n,
        appPermissions: interaction.appPermissions.bitfield,
      },
      { guildId: interaction.guildId, channelId: interaction.channelId },
    );
    if (!ctx.ok) {
      report(await answerAutocomplete(interaction, []), key);
      return;
    }

    const request: AutocompleteRequest = {
      actor: ctx.value.actor,
      space: ctx.value.space,
      option: focused.name,
      partial: wrapUserText(focused.value, 'autocomplete'),
      at: ctx.value.at,
    };
    try {
      // No defer exists for autocomplete: it is answered inside 3 seconds or not at all.
      report(await answerAutocomplete(interaction, await answer.call(owner.spec, request)), key);
    } catch (cause: unknown) {
      log.error('autocomplete threw', { handler: key, cause: cause instanceof Error ? cause.name : 'unknown' });
      report(await answerAutocomplete(interaction, []), key);
    }
  }

  // --- entry point: `$request ...` ------------------------------------------------------

  async function runMessage(message: Message): Promise<void> {
    if (message.author.bot || message.author.id === client.user?.id || message.system) return;
    if (io.registry.hooks.size === 0) return;

    if (looksLikeMissingContent({
      content: message.content,
      attachments: message.attachments.size,
      embeds: message.embeds.length,
      stickers: message.stickers.size,
    })) {
      if (!warnedAboutContent && !intents.has(GatewayIntentBits.MessageContent)) {
        warnedAboutContent = true;
        log.error(MESSAGE_CONTENT_ADVICE, { channelId: message.channelId });
      }
      return;
    }

    const match = matchPrefix(message.content, [...io.registry.hooks.keys()]);
    if (match === null) return;
    const owner = io.registry.hooks.get(match.prefix);
    if (owner === undefined) return;

    const inGuild = message.inGuild();
    const appPermissions = inGuild
      ? (message.channel.permissionsFor(client.user ?? message.author)?.bitfield ?? 0n)
      : permissionInteger(DM_PERMISSIONS);

    const ctx = contextFrom(
      {
        userId: message.author.id,
        roleIds: inGuild ? [...(message.member?.roles.cache.keys() ?? [])] : [],
        memberPermissions: inGuild ? (message.member?.permissions.bitfield ?? 0n) : 0n,
        appPermissions,
      },
      { guildId: message.guildId, channelId: message.channelId },
    );
    if (!ctx.ok) {
      log.warn('a message hook could not be routed', { cause: operatorMessage(ctx.error) });
      return;
    }

    const label = `hook:${match.prefix}`;
    const guarded = guard(ctx.value, {
      moduleId: owner.moduleId,
      name: label,
      permission: owner.spec.permission,
      limit: owner.spec.limit,
      needs: owner.spec.needs,
    });
    if (!guarded.ok) {
      // A hook has no interaction, so there is no private place to refuse. Posting a rate limit
      // or a permission denial to the channel would answer a stranger's message in public (and
      // let anyone spam the bot into spamming the channel), so it is logged instead.
      log.info('hook refused by the guard', { handler: label, cause: logDetail(guarded.error) });
      return;
    }

    const event: MessageHookEvent = {
      id: ctx.value.requestId,
      actor: ctx.value.actor,
      space: ctx.value.space,
      // Untrusted from here to the issue body: `UserText` is an object, not a string.
      body: wrapUserText(match.body, 'message-body'),
      surface: { guildId: message.guildId, channelId: message.channelId, messageId: message.id },
      at: ctx.value.at,
    };

    let outcome: Outcome;
    try {
      outcome = await owner.spec.handle(event);
    } catch (cause: unknown) {
      outcome = { kind: 'fail', error: crashed(ctx.value.requestId, label, cause) };
    }

    // THE CHANNEL-SCOPED PATH, and the only one available here: a message hook has no
    // interaction token at all, so there is nothing that could expire.
    switch (outcome.kind) {
      case 'silent':
        return;
      case 'view':
        report(await io.discord.post(ctx.value.space.channelId, outcome.view), label);
        return;
      case 'fail':
        log.info('hook refused', { handler: label, cause: logDetail(outcome.error) });
        report(await io.discord.post(ctx.value.space.channelId, errorView(outcome.error, io.clientId)), label);
        return;
      case 'form':
        log.error('a message hook returned a modal; there is no interaction to show it on', { handler: label });
        return;
      case 'handoff': {
        const done = await handoff(
          owner.moduleId,
          outcome.view,
          outcome.job,
          async (view) => {
            const posted = await io.discord.post(ctx.value.space.channelId, view);
            return posted.ok ? Ok(posted.value) : posted;
          },
          // A message hook has no interaction and therefore no ephemeral anything.
          'defer',
          true,
        );
        if (done.error !== null) {
          log.error('handoff failed', { handler: label, cause: logDetail(done.error) });
          // The card was already edited to the error when `reported`; a second public post
          // would say it twice.
          if (!done.reported) {
            report(await io.discord.post(ctx.value.space.channelId, errorView(done.error, io.clientId)), label);
          }
        }
        return;
      }
      default: {
        const exhaustive: never = outcome;
        void exhaustive;
        return;
      }
    }
  }

  // --- listeners ------------------------------------------------------------------------

  const onInteraction = (interaction: Interaction): void => {
    void dispatchInteraction(interaction).catch((cause: unknown) => {
      // The last line of defence: an unhandled rejection here would kill the process, and one
      // bad interaction must not take every other module down with it.
      log.error('interaction routing threw', { cause: cause instanceof Error ? cause.name : 'unknown' });
    });
  };

  async function dispatchInteraction(interaction: Interaction): Promise<void> {
    if (interaction.isChatInputCommand()) return runCommand(interaction);
    if (interaction.isAutocomplete()) return runAutocomplete(interaction);
    if (interaction.isModalSubmit()) return runModal(interaction);
    if (interaction.isStringSelectMenu()) {
      const values = selectValuesFor(interaction);
      return runComponent(
        interaction,
        (key) => io.registry.selects.get(key),
        (spec, click) => spec.handle({ ...click, values }),
      );
    }
    if (interaction.isButton()) {
      return runComponent(interaction, (key) => io.registry.actions.get(key), (spec, click) => spec.handle(click));
    }
    // Context menus, user/role/channel selects and the rest are not in the module contract yet.
    return undefined;
  }

  const onMessage = (message: Message): void => {
    void runMessage(message).catch((cause: unknown) => {
      log.error('message routing threw', { cause: cause instanceof Error ? cause.name : 'unknown' });
    });
  };

  client.on(Events.InteractionCreate, onInteraction);
  client.on(Events.MessageCreate, onMessage);

  return {
    detach(): void {
      client.off(Events.InteractionCreate, onInteraction);
      client.off(Events.MessageCreate, onMessage);
    },
  };
}

// ---------------------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------------------

function mapVoid<T>(r: Result<T, AppError>): Result<void, AppError> {
  return r.ok ? Ok(undefined) : r;
}

/** WHY the correlation id: `errors.internal` shows the user an id and nothing else, and that
 *  id is the only thing that ties their screenshot to the log line with the stack. */
function crashed(requestId: RequestId, label: string, cause: unknown): AppError {
  return errors.internal(requestId, `${label} threw: ${cause instanceof Error ? cause.name : 'unknown'}`);
}

/** Roles the actor holds. A guild interaction may carry either a cached `GuildMember` or the
 *  raw API member, and only one of those has a role cache. */
function memberRoleIds(interaction: RepliableInteraction | AutocompleteInteraction): readonly string[] {
  const member = interaction.member;
  if (member === null) return [];
  if (Array.isArray(member.roles)) return member.roles;
  return [...member.roles.cache.keys()];
}

/** What `runComponent` needs of a spec, regardless of which surface it came from. */
interface ComponentSpecLike {
  readonly permission: PermissionRef;
  readonly limit: readonly RateLimit[];
  readonly needs: readonly DiscordPermission[];
  readonly ack: 'instant' | 'defer' | 'defer-update' | 'form';
}
