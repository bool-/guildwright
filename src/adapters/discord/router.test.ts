/**
 * The routing decisions AND the wiring that makes them happen.
 *
 * PART ONE is a function that answers one question the router has to get right before it
 * touches Discord at all: does this message fire a hook, does this button belong to a handler
 * that still exists, when must the watchdog fire, and what may an error card say.
 *
 * PART TWO drives the real `attachRouter` through a fake gateway. Everything in part one is a
 * DECISION; nothing in it proves those decisions are connected to the events that provoke
 * them. `attachRouter` is called exactly once in this repo, from `src/main.ts`, and it used to
 * be called from no test at all.
 */

import { deepStrictEqual, ok, strictEqual } from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { Events, GatewayIntentBits, MessageFlags, type Client } from 'discord.js';
import { errors, type AppError } from '#core/errors';
import { Err, Ok } from '#core/result';
import { md, sanitizeStored, toMarkdown } from '#core/text';
import type { View } from '#core/view';
import {
  assertActionRef,
  newCardNonce,
  newJobId,
  newRequestId,
  toChannelId,
  toUserId,
} from '#core/ids';
import { permissionInteger, type DiscordPermission } from '#core/permissions';
import { permissionRef, PUBLIC, type PermissionRef } from '#core/policy';
import { limit, NO_LIMIT, type RateLimit } from '#core/ratelimit';
import { SURFACE_KEY } from '#core/command';
import type {
  ActionSpec,
  AutocompleteChoice,
  AutocompleteRequest,
  ClickInvocation,
  CommandSpec,
  CommandSurface,
  FormHandlerSpec,
  FormSubmission,
  HookSpec,
  Invocation,
  MessageHookEvent,
  Outcome,
  SelectActionSpec,
  SelectInvocation,
} from '#core/command';
import type {
  ActionOwner,
  CommandOwner,
  FormOwner,
  HookOwner,
  Registry,
  SelectOwner,
} from '#core/registry';
import type { Capability, ClockPort, JobRequest } from '#core/ports';
import type { AccessPort } from '#core/ports/access';
import { fakeAccess, fakeAudit, fakeClock, fakeDiscord, fakeRecordingLogger } from '#testing/fakes';
import type { FakeAudit, FakeDiscord, FakeRecordingLogger } from '#testing/fakes';
import { renderView } from '#adapters/discord/render';
import type { InteractionToken } from '#adapters/discord/client';
import {
  ackDefersUpFront,
  ACK_DEADLINE_MS,
  ALLOW_ALL,
  attachRouter,
  commandKey,
  errorView,
  handoffRefusal,
  inviteUrl,
  looksLikeMissingContent,
  matchPrefix,
  MESSAGE_CONTENT_ADVICE,
  routeCustomId,
  watchdogDelayMs,
  WATCHDOG_MARGIN_MS,
  type RateGate,
  type RateGateRequest,
  type Router,
  type RouterIO,
} from '#adapters/discord/router';

// ---------------------------------------------------------------------------------------
// The prefix hook - the product's actual entry point
// ---------------------------------------------------------------------------------------

test('$request fires on its own prefix and on nothing that merely starts with it', () => {
  const prefixes = ['$request'];
  strictEqual(matchPrefix('$request add a /ping command', prefixes)?.body, 'add a /ping command');
  strictEqual(matchPrefix('$request', prefixes)?.body, '');
  strictEqual(matchPrefix('$request\nmultiline body', prefixes)?.body, 'multiline body');
  // The incident this prevents: "$requesting a day off" filing a GitHub issue and asking a
  // human to approve spending CI credits on it.
  strictEqual(matchPrefix('$requesting a day off', prefixes), null);
  strictEqual(matchPrefix('please $request something', prefixes), null);
  strictEqual(matchPrefix('$REQUEST loud', prefixes), null, 'prefixes are case-sensitive');
});

test('the longest matching prefix wins', () => {
  const match = matchPrefix('$request body', ['$req', '$request']);
  strictEqual(match?.prefix, '$request');
  strictEqual(match?.body, 'body');
});

test('an empty message with no attachments is what a missing MessageContent intent looks like', () => {
  strictEqual(looksLikeMissingContent({ content: '', attachments: 0, embeds: 0, stickers: 0 }), true);
  strictEqual(looksLikeMissingContent({ content: '', attachments: 1, embeds: 0, stickers: 0 }), false);
  strictEqual(looksLikeMissingContent({ content: 'hi', attachments: 0, embeds: 0, stickers: 0 }), false);
});

test('the missing-intent advice names the toggle, not the symptom', () => {
  ok(MESSAGE_CONTENT_ADVICE.includes('Privileged Gateway Intents'));
  ok(MESSAGE_CONTENT_ADVICE.includes('Message Content Intent'));
  ok(MESSAGE_CONTENT_ADVICE.includes('Developer Portal'));
});

// ---------------------------------------------------------------------------------------
// Stateless component routing - the reason cards survive a restart
// ---------------------------------------------------------------------------------------

test('a custom_id minted three weeks ago still routes to a registry key', () => {
  const id = assertActionRef({
    moduleId: 'builder',
    action: 'approve',
    entityId: newRequestId(0),
    nonce: newCardNonce(),
  });
  const routed = routeCustomId(id);
  ok(routed.ok);
  strictEqual(routed.value.key, 'builder:approve');
  strictEqual(routed.value.moduleId, 'builder');
  strictEqual(routed.value.action, 'approve');
  strictEqual(routed.value.nonce.length, 8, 'the card-staleness fence rides in the id');
});

test('a custom_id from an older codec decodes to a next step, not to a wrong handler', () => {
  const stale = routeCustomId('v0~builder~approve~01J~ABCD');
  ok(!stale.ok);
  strictEqual(stale.error.kind, 'conflict');
  ok(stale.error.nextStep.includes('Run the command again'));
  ok(!routeCustomId('not-a-custom-id').ok);
});

test('the registry command key is the spelling modules already use', () => {
  strictEqual(commandKey({ commandName: 'tag', group: null, subcommand: null }), 'tag');
  strictEqual(commandKey({ commandName: 'tag', group: null, subcommand: 'get' }), 'tag get');
  strictEqual(commandKey({ commandName: 'tag', group: 'admin', subcommand: 'reset' }), 'tag admin reset');
});

// ---------------------------------------------------------------------------------------
// The 3-second contract
// ---------------------------------------------------------------------------------------

test('the watchdog is measured from the interaction, not from when we got round to it', () => {
  const created = 1_000_000;
  // Fresh interaction: fire at 2.5s of ITS age.
  strictEqual(watchdogDelayMs(created, created), ACK_DEADLINE_MS - WATCHDOG_MARGIN_MS);
  // We spent 2 seconds in a preflight; only 0.5s of budget is left.
  strictEqual(watchdogDelayMs(created, created + 2_000), 500);
  // Already past the deadline: fire immediately rather than scheduling into the past.
  strictEqual(watchdogDelayMs(created, created + 9_000), 0);
});

test('only the deferring strategies acknowledge before the handler runs', () => {
  strictEqual(ackDefersUpFront('defer'), true);
  strictEqual(ackDefersUpFront('defer-ephemeral'), true);
  strictEqual(ackDefersUpFront('defer-update'), true);
  // These two are exactly the cases the watchdog exists for.
  strictEqual(ackDefersUpFront('instant'), false);
  strictEqual(ackDefersUpFront('form'), false);
});

// ---------------------------------------------------------------------------------------
// Error cards
// ---------------------------------------------------------------------------------------

test('a missing bot permission is answered with a re-invite link carrying the exact integer', () => {
  const bits = permissionInteger(['SendMessages', 'EmbedLinks']);
  const view = errorView(
    errors.missingBotPermission(['SendMessages', 'EmbedLinks'], bits, 'Ask an admin.'),
    '123456789012345678',
  );
  const rendered = renderView(view);
  ok(rendered.ok);
  const json = JSON.stringify(rendered.value);
  ok(json.includes(`permissions=${bits.toString()}`), 'the card offers the one-click repair');
  ok(json.includes('client_id=123456789012345678'));
});

test('an error card renders userMessage and cannot reach `internal`', () => {
  // `internal` is where upstream bodies - and once, a token - live.
  const e = errors.upstream('discord', 500, 'Try again in a minute.', 'PATCH failed with Authorization: Bearer sk-live-42');
  const rendered = renderView(errorView(e, '123456789012345678'));
  ok(rendered.ok);
  const json = JSON.stringify(rendered.value);
  ok(!json.includes('Bearer'), 'operator detail is structurally unreachable from a card');
  ok(json.includes('Try again in a minute.'), 'the next step is always shown');
});

test('every error card is ephemeral, so a refusal is not broadcast to the channel', () => {
  strictEqual(errorView(errors.notFound('tag', 'Create it first.'), '1').ephemeral, true);
});

test('the invite URL is https and carries both scopes', () => {
  const url = inviteUrl('123', '2048');
  ok(url.startsWith('https://discord.com/oauth2/authorize'));
  ok(url.includes('scope=bot+applications.commands'));
});

// ---------------------------------------------------------------------------------------
// The 15-minute rule, proved at compile time
// ---------------------------------------------------------------------------------------

test('a handoff card can never be ephemeral, by either route to one', () => {
  const durable: View = { accent: 'pending', nodes: [{ kind: 'text', md: md`Building...` }] };
  const ephemeral: View = { ...durable, ephemeral: true };

  strictEqual(handoffRefusal('builder', durable, 'defer'), null);
  strictEqual(handoffRefusal('builder', durable, 'defer-update'), null, 'the Approve-button path');

  // Route 1: the view asked for it.
  const byView = handoffRefusal('builder', ephemeral, 'defer');
  ok(byView !== null);
  ok(byView.internal?.includes('ephemeral'));

  // Route 2 - the one that survives review: the VIEW is fine and the ACK makes it ephemeral,
  // so the card is unaddressable 20 minutes later when the build finishes.
  const byAck = handoffRefusal('builder', durable, 'defer-ephemeral');
  ok(byAck !== null);
  ok(byAck.internal?.includes('defer-ephemeral'));
  ok(byAck.nextStep.includes("ack: 'defer'"));
});

test('an interaction token cannot be forged from data a job could hold', () => {
  // A job payload is `JsonObject`. This is what trying to reconstitute the short path from one
  // looks like, and the only reason this test file compiles is the @ts-expect-error: the
  // token's payload is keyed by a symbol `#adapters/discord/client` does not export.
  // @ts-expect-error - a plain object is not an InteractionToken
  const forged: InteractionToken = { expiresAtMs: Date.now() + 900_000 };
  void forged;
  ok(true);
});

test('the offline rate gate allows, so the router is constructible without a database', () => {
  const userId = toUserId('123456789012345678');
  const channelId = toChannelId('223456789012345678');
  ok(userId.ok && channelId.ok);
  const spent = ALLOW_ALL.spend({
    moduleId: 'builder',
    name: 'hook:$request',
    limits: [],
    userId: userId.value,
    guildId: null,
    channelId: channelId.value,
    at: 0,
  });
  ok(spent.ok);
});

// =======================================================================================
// PART TWO - `attachRouter`, driven
//
// WHAT IS BEING PROVED HERE, AND WHY IT IS DIFFERENT FROM EVERYTHING ABOVE.
//
// Every test above calls an exported pure function. That is the right shape for a decision -
// but a decision nothing invokes is a decision that does not happen. `attachRouter` is the
// join: it subscribes to `InteractionCreate` and `MessageCreate`, and inside those listeners
// it runs the guard order, the acknowledgement, the watchdog and the delivery. It is called
// once, from `src/main.ts:618`, on a client that has just logged in - which is why nothing
// tested it.
//
// So: a fake gateway. An `EventEmitter` shaped like a discord.js `Client`, and interaction
// objects shaped like the ones discord.js hands the listener. No network, no token, no login.
//
// THE FAKES MODEL discord.js's REAL SEMANTICS, and one detail is load-bearing. In
// `node_modules/discord.js/src/structures/interfaces/InteractionResponses.js`, `deferReply`
// sets `this.deferred = true` AFTER awaiting the REST POST, and `reply` guards only on
// `this.deferred || this.replied`. So there is a window in which the interaction has been
// acknowledged at Discord and still looks unacknowledged locally. That window is a real
// defect in this file, and the last test in this section documents it rather than hiding it.
// =======================================================================================

const BOT_ID = '900000000000000001';
const USER_ID = '100000000000000001';
const GUILD_ID = '200000000000000002';
const CHANNEL_ID = '300000000000000003';
const MESSAGE_ID = '400000000000000004';
const APPROVER_ROLE = '500000000000000005';
const CLIENT_ID = '600000000000000006';
const OWNER_ID = '700000000000000007';

/** Every permission any spec below asks for, so `needs` never refuses by accident. */
const GRANTED = permissionInteger(['ViewChannel', 'SendMessages', 'EmbedLinks', 'ReadMessageHistory']);

/** A wall-clock start far enough from zero that a negative age would be obvious. */
const START = 1_800_000_000_000;

// ---------------------------------------------------------------------------------------
// A trace: what happened, in order, stamped with the clock the ROUTER reads
// ---------------------------------------------------------------------------------------

interface Step {
  readonly what: string;
  readonly at: number;
}

/**
 * One ordered log shared by the fake interactions and the fake handlers.
 *
 * WHY one list and not two: the whole question in this section is ORDER - did the
 * acknowledgement leave before the handler ran - and two lists cannot answer it.
 */
interface Trace {
  readonly steps: readonly Step[];
  mark(what: string): void;
  names(): readonly string[];
  has(what: string): boolean;
  /** The clock reading at that step. Throws rather than returning undefined, so a typo is loud. */
  at(what: string): number;
}

function tracer(clock: ClockPort): Trace {
  const steps: Step[] = [];
  return {
    steps,
    mark(what) {
      steps.push({ what, at: clock.now() });
    },
    names: () => steps.map((s) => s.what),
    has: (what) => steps.some((s) => s.what === what),
    at(what) {
      const found = steps.find((s) => s.what === what);
      if (found === undefined) throw new Error(`no step "${what}" in [${steps.map((s) => s.what).join(', ')}]`);
      return found.at;
    },
  };
}

/**
 * Let the event loop run until `done()` holds.
 *
 * WHY a poll and not an await: the router's listener is `void dispatchInteraction(i).catch(...)`
 * - deliberately fire-and-forget, so one bad interaction cannot reject into the emitter - which
 * means there is no promise for a test to await. A bounded poll that FAILS with the trace is
 * the honest way to wait, and `setTimeout` (rather than a microtask) is what lets the router's
 * own watchdog timer fire.
 */
async function until(done: () => boolean, why: string): Promise<void> {
  for (let i = 0; i < 200; i += 1) {
    if (done()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error(`timed out waiting for ${why}`);
}

// ---------------------------------------------------------------------------------------
// The interaction response surface, modelled on discord.js
// ---------------------------------------------------------------------------------------

/** One call Discord received, with the body it was given. */
interface Answer {
  readonly method: string;
  readonly body: unknown;
}

interface Respondable {
  deferred: boolean;
  replied: boolean;
  readonly answers: readonly Answer[];
  deferReply(opts: unknown): Promise<unknown>;
  deferUpdate(opts: unknown): Promise<unknown>;
  reply(body: unknown): Promise<unknown>;
  editReply(body: unknown): Promise<unknown>;
  deleteReply(): Promise<void>;
  showModal(data: unknown): Promise<void>;
}

/** HTTP 400 / JSON 40060 - what Discord answers a second acknowledgement with. */
function alreadyAcknowledged(): Error {
  return Object.assign(new Error('40060: Interaction has already been acknowledged.'), { status: 400 });
}

function respondable(
  trace: Trace,
  opts: {
    readonly deferGate?: Promise<void>;
    /** Hold the REPLY's round trip open, the way `deferGate` holds the defer's. */
    readonly replyGate?: Promise<void>;
    readonly replyFails?: boolean;
  } = {},
): Respondable {
  const message = { id: MESSAGE_ID, channelId: CHANNEL_ID, guildId: GUILD_ID };
  const answers: Answer[] = [];
  /** True between issuing the acknowledgement and Discord confirming it. See the header. */
  let inFlight = false;

  const self: Respondable = {
    deferred: false,
    replied: false,
    answers,

    async deferReply(o) {
      if (self.deferred || self.replied) throw alreadyAcknowledged();
      answers.push({ method: 'deferReply', body: o });
      trace.mark('discord:deferReply');
      inFlight = true;
      // discord.js awaits the REST POST here and only THEN sets `deferred`.
      await (opts.deferGate ?? Promise.resolve());
      inFlight = false;
      self.deferred = true;
      return { resource: { message } };
    },

    async deferUpdate(o) {
      if (self.deferred || self.replied) throw alreadyAcknowledged();
      answers.push({ method: 'deferUpdate', body: o });
      trace.mark('discord:deferUpdate');
      await Promise.resolve();
      self.deferred = true;
      return { resource: { message } };
    },

    async reply(body) {
      // discord.js's own local guard...
      if (self.deferred || self.replied) throw new Error('InteractionAlreadyReplied');
      // ...and Discord's, which is the only one left while an acknowledgement is in flight.
      if (inFlight) throw alreadyAcknowledged();
      answers.push({ method: 'reply', body });
      trace.mark('discord:reply');
      // A REPLY HAS A ROUND TRIP TOO, and `replied` is set only when it comes back - exactly
      // like `deferReply`. Modelling that is what makes the REVERSE race reachable: the window
      // in which the handler's own answer is on the wire and the interaction still reads as
      // unacknowledged, which is when the watchdog used to defer on top of it.
      inFlight = true;
      await (opts.replyGate ?? Promise.resolve());
      inFlight = false;
      // A reply CAN fail - a 500, or a channel deleted between the click and the answer - and
      // when it does the interaction stays unacknowledged.
      if (opts.replyFails === true) throw Object.assign(new Error('500: Internal Server Error'), { status: 500 });
      self.replied = true;
      return { resource: { message } };
    },

    async editReply(body) {
      answers.push({ method: 'editReply', body });
      trace.mark('discord:editReply');
      await Promise.resolve();
      return message;
    },

    async deleteReply() {
      answers.push({ method: 'deleteReply', body: null });
      trace.mark('discord:deleteReply');
      await Promise.resolve();
    },

    async showModal(data) {
      if (self.deferred || self.replied) throw new Error('InteractionAlreadyReplied');
      answers.push({ method: 'showModal', body: data });
      trace.mark('discord:showModal');
      await Promise.resolve();
      self.replied = true;
    },
  };
  return self;
}

/** The five discriminators `dispatchInteraction` switches on, all false by default. */
interface Guards {
  isChatInputCommand(): boolean;
  isAutocomplete(): boolean;
  isModalSubmit(): boolean;
  isStringSelectMenu(): boolean;
  isButton(): boolean;
  isMessageComponent(): boolean;
}

function guards(kind: 'command' | 'autocomplete' | 'modal' | 'select' | 'button' | 'other'): Guards {
  return {
    isChatInputCommand: () => kind === 'command',
    isAutocomplete: () => kind === 'autocomplete',
    isModalSubmit: () => kind === 'modal',
    isStringSelectMenu: () => kind === 'select',
    isButton: () => kind === 'button',
    isMessageComponent: () => kind === 'select' || kind === 'button',
  };
}

/** Who and where, shared by every interaction kind. */
interface WhoWhere {
  readonly userId?: string;
  readonly roleIds?: readonly string[];
  readonly guildId?: string | null;
  readonly appPermissions?: bigint;
  readonly memberPermissions?: bigint;
}

function actorFields(o: WhoWhere): Record<string, unknown> {
  return {
    user: { id: o.userId ?? USER_ID },
    // The RAW api member shape, whose `roles` is a plain array - one of the two shapes
    // `memberRoleIds` has to cope with.
    member: { roles: [...(o.roleIds ?? [])] },
    memberPermissions: { bitfield: o.memberPermissions ?? 0n },
    appPermissions: { bitfield: o.appPermissions ?? GRANTED },
    guildId: o.guildId === undefined ? GUILD_ID : o.guildId,
    channelId: CHANNEL_ID,
  };
}

interface CommandOpts extends WhoWhere {
  /** The full registry key, e.g. `demo ping` or `demo admin reset`. */
  readonly name: string;
  readonly createdTimestamp: number;
  readonly strings?: Readonly<Record<string, string>>;
  readonly deferGate?: Promise<void>;
  /** Hold the reply's round trip open, so the reverse ack race is reachable. */
  readonly replyGate?: Promise<void>;
  /** Model Discord refusing the answer, which leaves the interaction unacknowledged. */
  readonly replyFails?: boolean;
}

function commandInteraction(trace: Trace, o: CommandOpts): Respondable & Record<string, unknown> {
  const parts = o.name.split(' ');
  const commandName = parts[0] ?? '';
  const second = parts[1];
  const third = parts[2];
  const group = third === undefined ? null : (second ?? null);
  const subcommand = third ?? second ?? null;
  const strings = o.strings ?? {};

  const wire: { deferGate?: Promise<void>; replyGate?: Promise<void>; replyFails?: boolean } = {};
  if (o.deferGate !== undefined) wire.deferGate = o.deferGate;
  if (o.replyGate !== undefined) wire.replyGate = o.replyGate;
  if (o.replyFails === true) wire.replyFails = true;

  return Object.assign(
    respondable(trace, wire),
    actorFields(o),
    guards('command'),
    {
      createdTimestamp: o.createdTimestamp,
      commandName,
      options: {
        data: [],
        getSubcommandGroup: () => group,
        getSubcommand: () => subcommand,
        getString: (n: string) => strings[n] ?? null,
        getInteger: () => null,
        getBoolean: () => null,
        getUser: () => null,
        getRole: () => null,
        getChannel: () => null,
      },
    },
  );
}

interface ComponentOpts extends WhoWhere {
  readonly customId: string;
  readonly createdTimestamp: number;
  readonly values?: readonly string[];
  readonly deferGate?: Promise<void>;
}

function componentInteraction(
  trace: Trace,
  kind: 'button' | 'select',
  o: ComponentOpts,
): Respondable & Record<string, unknown> {
  return Object.assign(
    respondable(trace, o.deferGate === undefined ? {} : { deferGate: o.deferGate }),
    actorFields(o),
    guards(kind),
    {
      createdTimestamp: o.createdTimestamp,
      customId: o.customId,
      values: [...(o.values ?? [])],
      message: { id: MESSAGE_ID },
    },
  );
}

interface ModalOpts extends WhoWhere {
  readonly customId: string;
  readonly createdTimestamp: number;
  readonly values?: Readonly<Record<string, string>>;
  readonly selects?: Readonly<Record<string, readonly string[]>>;
}

function modalInteraction(trace: Trace, o: ModalOpts): Respondable & Record<string, unknown> {
  const values = o.values ?? {};
  return Object.assign(respondable(trace), actorFields(o), guards('modal'), {
    createdTimestamp: o.createdTimestamp,
    customId: o.customId,
    fields: {
      fields: new Map(Object.keys(values).map((k) => [k, values[k]])),
      getTextInputValue(name: string): string {
        const found = values[name];
        // discord.js throws for an absent field, which is what `formValuesFor` catches.
        if (found === undefined) throw new Error(`no field ${name}`);
        return found;
      },
      getStringSelectValues(name: string): readonly string[] {
        const found = o.selects?.[name];
        // Same as discord.js: an absent dropdown throws, and `choice` reads that as "left empty".
        if (found === undefined) throw new Error(`no select ${name}`);
        return found;
      },
    },
  });
}

interface AutocompleteOpts extends WhoWhere {
  readonly name: string;
  readonly option: string;
  readonly partial: string;
}

function autocompleteInteraction(o: AutocompleteOpts): Record<string, unknown> & { readonly sent: unknown[] } {
  const parts = o.name.split(' ');
  const second = parts[1];
  const third = parts[2];
  const sent: unknown[] = [];
  return Object.assign(actorFields(o), guards('autocomplete'), {
    sent,
    commandName: parts[0] ?? '',
    options: {
      getSubcommandGroup: () => (third === undefined ? null : (second ?? null)),
      getSubcommand: () => third ?? second ?? null,
      getFocused: () => ({ name: o.option, value: o.partial }),
    },
    async respond(choices: unknown): Promise<void> {
      sent.push(choices);
      await Promise.resolve();
    },
  });
}

interface MessageOpts {
  readonly content: string;
  readonly authorId?: string;
  readonly bot?: boolean;
  readonly attachments?: number;
}

function gatewayMessage(o: MessageOpts): Record<string, unknown> {
  return {
    id: MESSAGE_ID,
    content: o.content,
    system: false,
    author: { id: o.authorId ?? USER_ID, bot: o.bot ?? false },
    attachments: { size: o.attachments ?? 0 },
    embeds: [],
    stickers: { size: 0 },
    guildId: GUILD_ID,
    channelId: CHANNEL_ID,
    inGuild: () => true,
    channel: { permissionsFor: () => ({ bitfield: GRANTED }) },
    member: { roles: { cache: new Map([[APPROVER_ROLE, {}]]) }, permissions: { bitfield: 0n } },
  };
}

// ---------------------------------------------------------------------------------------
// Specs and a registry, hand-built
// ---------------------------------------------------------------------------------------

/** A permission this fake module declares, so the guard has something real to check. */
const DEMO_APPROVE: PermissionRef = permissionRef('demo', 'approve');

function viewOutcome(text: string): Outcome {
  return { kind: 'view', view: { accent: 'ok', nodes: [{ kind: 'text', md: sanitizeStored(text) }] } };
}

function demoCommand(parts: {
  readonly name: string;
  readonly ack: CommandSpec['ack'];
  readonly handle: (inv: Invocation) => Promise<Outcome>;
  readonly permission?: PermissionRef;
  readonly limit?: readonly RateLimit[];
  readonly needs?: readonly DiscordPermission[];
  readonly surface?: CommandSurface;
  readonly autocomplete?: (req: AutocompleteRequest) => Promise<readonly AutocompleteChoice[]>;
}): CommandSpec {
  const spec: CommandSpec = {
    name: parts.name,
    description: 'A stand-in command',
    surface: parts.surface ?? 'both',
    options: [],
    permission: parts.permission ?? PUBLIC,
    limit: parts.limit ?? NO_LIMIT,
    needs: parts.needs ?? [],
    ack: parts.ack,
    handle: parts.handle,
  };
  return parts.autocomplete === undefined ? spec : { ...spec, autocomplete: parts.autocomplete };
}

function demoAction(parts: {
  readonly name: string;
  readonly ack: ActionSpec['ack'];
  readonly handle: (click: ClickInvocation) => Promise<Outcome>;
  readonly permission?: PermissionRef;
  readonly limit?: readonly RateLimit[];
  readonly needs?: readonly DiscordPermission[];
}): ActionSpec {
  return {
    name: parts.name,
    permission: parts.permission ?? PUBLIC,
    limit: parts.limit ?? NO_LIMIT,
    needs: parts.needs ?? [],
    ack: parts.ack,
    idempotency: { kind: 'naturally-idempotent', why: 'a test double with no side effect' },
    handle: parts.handle,
  };
}

function demoSelect(parts: {
  readonly name: string;
  readonly handle: (sel: SelectInvocation) => Promise<Outcome>;
}): SelectActionSpec {
  return {
    name: parts.name,
    permission: PUBLIC,
    limit: NO_LIMIT,
    needs: [],
    ack: 'defer',
    idempotency: { kind: 'naturally-idempotent', why: 'a test double with no side effect' },
    handle: parts.handle,
  };
}

function demoForm(parts: {
  readonly name: string;
  readonly fields: readonly string[];
  readonly handle: (sub: FormSubmission) => Promise<Outcome>;
}): FormHandlerSpec {
  return {
    name: parts.name,
    permission: PUBLIC,
    limit: NO_LIMIT,
    needs: [],
    ack: 'defer',
    idempotency: { kind: 'naturally-idempotent', why: 'a test double with no side effect' },
    fields: parts.fields,
    handle: parts.handle,
  };
}

function demoHook(parts: {
  readonly prefix: string;
  readonly handle: (ev: MessageHookEvent) => Promise<Outcome>;
}): HookSpec {
  return {
    source: 'message',
    prefix: parts.prefix,
    permission: PUBLIC,
    limit: NO_LIMIT,
    needs: ['SendMessages'],
    handle: parts.handle,
  };
}

/**
 * A registry, built by hand rather than by `buildRegistry`.
 *
 * WHY: this section is about the ROUTER's use of the maps, and the registry's own indexing,
 * collision refusal and permission cross-check are already exhaustively tested next door in
 * `src/core/registry.test.ts`. Building the maps directly keeps each test's fixture to the
 * two or three entries it is actually about.
 */
function registryOf(parts: {
  readonly commands?: readonly (readonly [string, CommandOwner])[];
  readonly actions?: readonly (readonly [string, ActionOwner])[];
  readonly selects?: readonly (readonly [string, SelectOwner])[];
  readonly forms?: readonly (readonly [string, FormOwner])[];
  readonly hooks?: readonly (readonly [string, HookOwner])[];
}): Registry {
  return {
    modules: new Map(),
    commands: new Map(parts.commands ?? []),
    actions: new Map(parts.actions ?? []),
    selects: new Map(parts.selects ?? []),
    forms: new Map(parts.forms ?? []),
    jobs: new Map(),
    hooks: new Map(parts.hooks ?? []),
    permissions: new Map(),
    installed: new Map(),
    capabilitiesUsed: new Set<Capability>(),
  };
}

// ---------------------------------------------------------------------------------------
// The two seams the router is given
// ---------------------------------------------------------------------------------------

interface RecordingGate extends RateGate {
  /** Every bucket the router actually tried to spend, in order. */
  readonly spent: readonly RateGateRequest[];
  /** Refuse the next spend, the way an exhausted bucket does. */
  refuseNext(): void;
}

function recordingGate(): RecordingGate {
  const spent: RateGateRequest[] = [];
  let refusals = 0;
  return {
    spent,
    refuseNext() {
      refusals += 1;
    },
    spend(req) {
      spent.push(req);
      if (refusals === 0) return Ok(undefined);
      refusals -= 1;
      return {
        ok: false,
        error: errors.rateLimited(`${req.moduleId}:${req.name}`, 30_000, 'Wait 30 seconds and try again.'),
      };
    },
  };
}

interface RoleGatedAccess extends AccessPort {
  /** The subject snapshot the router handed the check, once per invocation. */
  readonly checks: readonly { readonly userId: string; readonly roleIds: readonly string[] }[];
}

/**
 * Allows only an actor who holds `role` AT THE MOMENT OF THE CHECK.
 *
 * `fakeAccess()` says yes to everything, which cannot distinguish "checked and allowed" from
 * "never checked" - and that distinction is the entire subject of the re-check test below.
 */
function roleGatedAccess(role: string): RoleGatedAccess {
  const checks: { userId: string; roleIds: readonly string[] }[] = [];
  const base = fakeAccess();
  return {
    ...base,
    checks,
    check(_guildId, _ref, subject) {
      checks.push({ userId: subject.userId, roleIds: [...subject.roleIds] });
      return subject.roleIds.some((r) => r === role)
        ? { allowed: true, layer: 'L1-allowlist' }
        : { allowed: false, layer: 'L3-deny', grantableBy: 'a server admin' };
    },
  };
}

// ---------------------------------------------------------------------------------------
// The harness
// ---------------------------------------------------------------------------------------

interface Harness {
  readonly router: Router;
  /** The same object the router was handed, so listeners can be counted. */
  readonly emitter: EventEmitter;
  readonly logger: FakeRecordingLogger;
  readonly audit: FakeAudit;
  readonly discord: FakeDiscord;
  readonly gate: RecordingGate;
  readonly enqueued: readonly { readonly moduleId: string; readonly job: JobRequest }[];
  /** Exactly what discord.js does: emit the event with the interaction. */
  deliver(interaction: unknown): void;
  message(m: unknown): void;
}

function harness(parts: {
  readonly registry: Registry;
  readonly clock: ClockPort;
  readonly access?: AccessPort;
  readonly gate?: RecordingGate;
  readonly intents?: number;
  /** Make the job runner refuse every enqueue, the way a full queue or a bad payload does. */
  readonly enqueueError?: AppError;
}): Harness {
  const emitter = new EventEmitter();
  const client = Object.assign(emitter, {
    options: { intents: parts.intents ?? GatewayIntentBits.Guilds },
    user: { id: BOT_ID },
  }) as unknown as Client;

  const logger = fakeRecordingLogger();
  const audit = fakeAudit();
  const discord = fakeDiscord();
  const gate = parts.gate ?? recordingGate();
  const enqueued: { moduleId: string; job: JobRequest }[] = [];

  const io: RouterIO = {
    registry: parts.registry,
    logger,
    clock: parts.clock,
    access: parts.access ?? fakeAccess(),
    audit,
    discord,
    limits: gate,
    clientId: CLIENT_ID,
    ownerId: OWNER_ID,
    enqueueJob: (moduleId, job) => {
      if (parts.enqueueError !== undefined) return Err(parts.enqueueError);
      enqueued.push({ moduleId, job });
      return Ok({ id: newJobId(parts.clock.now()), created: true });
    },
  };

  return {
    router: attachRouter(client, io),
    emitter,
    logger,
    audit,
    discord,
    gate,
    enqueued,
    deliver: (interaction) => void emitter.emit(Events.InteractionCreate, interaction),
    message: (m) => void emitter.emit(Events.MessageCreate, m),
  };
}

/** A `custom_id` of the shape a live card carries. */
function cardId(action: string): string {
  return assertActionRef({ moduleId: 'demo', action, entityId: newRequestId(START), nonce: newCardNonce() });
}

// ---------------------------------------------------------------------------------------
// The subscription itself
// ---------------------------------------------------------------------------------------

test('attachRouter subscribes to the two gateway events, and detach removes both', () => {
  const clock = fakeClock(START);
  const h = harness({ registry: registryOf({}), clock });

  strictEqual(h.emitter.listenerCount(Events.InteractionCreate), 1, 'slash commands, buttons, modals and autocomplete all arrive here');
  strictEqual(h.emitter.listenerCount(Events.MessageCreate), 1, 'and `$request` arrives here');

  h.router.detach();
  strictEqual(h.emitter.listenerCount(Events.InteractionCreate), 0);
  strictEqual(h.emitter.listenerCount(Events.MessageCreate), 0);

  // `Router.detach` documents itself as idempotent, and main.ts calls it on a failed login
  // and again on shutdown.
  h.router.detach();
  strictEqual(h.emitter.listenerCount(Events.InteractionCreate), 0);
});

test('every interaction kind in the contract reaches its own registry map', async () => {
  const clock = fakeClock(START);
  const trace = tracer(clock);
  const reached: string[] = [];

  const registry = registryOf({
    commands: [
      ['demo ping', { moduleId: 'demo', spec: demoCommand({ name: 'demo ping', ack: 'instant', handle: async () => { reached.push('command:ping'); return viewOutcome('pong'); } }) }],
      // A sibling under the same top-level name. Routing that ignored the subcommand would
      // land here, which is exactly the "whichever loaded last won" failure.
      ['demo pong', { moduleId: 'demo', spec: demoCommand({ name: 'demo pong', ack: 'instant', handle: async () => { reached.push('command:pong'); return viewOutcome('ping'); } }) }],
    ],
    actions: [
      ['demo:approve', { moduleId: 'demo', spec: demoAction({ name: 'approve', ack: 'defer', handle: async () => { reached.push('button:approve'); return viewOutcome('approved'); } }) }],
    ],
    // A SELECT and a BUTTON with the same name, in the same module: they live in different
    // maps and `runComponent` is given a different lookup for each.
    selects: [
      ['demo:approve', { moduleId: 'demo', spec: demoSelect({ name: 'approve', handle: async (sel) => { reached.push(`select:${sel.values.chosen.length}`); return viewOutcome('chosen'); } }) }],
    ],
    forms: [
      ['demo:brief', { moduleId: 'demo', spec: demoForm({ name: 'brief', fields: ['title'], handle: async (sub) => { reached.push(`form:${sub.fields.names.join(',')}`); return viewOutcome('filed'); } }) }],
    ],
  });
  const h = harness({ registry, clock });

  const command = commandInteraction(trace, { name: 'demo ping', createdTimestamp: clock.now() });
  h.deliver(command);
  await until(() => trace.has('discord:reply'), 'the command reply');

  const button = componentInteraction(trace, 'button', { customId: cardId('approve'), createdTimestamp: clock.now() });
  h.deliver(button);
  await until(() => button.answers.length >= 2, 'the button answer');

  const select = componentInteraction(trace, 'select', { customId: cardId('approve'), createdTimestamp: clock.now(), values: ['a', 'b'] });
  h.deliver(select);
  await until(() => select.answers.length >= 2, 'the select answer');

  const modal = modalInteraction(trace, { customId: cardId('brief'), createdTimestamp: clock.now(), values: { title: 'a title' } });
  h.deliver(modal);
  await until(() => modal.answers.length >= 2, 'the modal answer');

  deepStrictEqual(reached, ['command:ping', 'button:approve', 'select:2', 'form:title']);
});

test('a modal dropdown is read through choice(), re-validated against the allow-list', async () => {
  // The client echoes the chosen value back, so a forged value must come back as an Err, and
  // a dropdown that was never filled in reads as "left empty", exactly like a blank text field.
  const clock = fakeClock(START);
  const trace = tracer(clock);
  const seen: string[] = [];
  const KINDS = ['new-command', 'change', 'fix'] as const;
  const registry = registryOf({
    forms: [
      ['demo:brief', {
        moduleId: 'demo',
        spec: demoForm({
          name: 'brief',
          fields: ['title', 'kind'],
          handle: async (sub) => {
            const c = sub.fields.choice('kind', KINDS);
            seen.push(c.ok ? `ok:${String(c.value)}` : `err:${c.error.kind}`);
            return viewOutcome('filed');
          },
        }),
      }],
    ],
  });
  const h = harness({ registry, clock });

  for (const selects of [{ kind: ['fix'] }, { kind: ['drop-tables'] }, undefined]) {
    const modal = modalInteraction(trace, {
      customId: cardId('brief'),
      createdTimestamp: clock.now(),
      values: { title: 'a title' },
      ...(selects === undefined ? {} : { selects }),
    });
    h.deliver(modal);
    await until(() => modal.answers.length >= 2, 'the modal answer');
  }

  deepStrictEqual(seen, ['ok:fix', 'err:validation', 'ok:undefined']);
});

test('an interaction kind outside the module contract is ignored, not thrown', async () => {
  const clock = fakeClock(START);
  const trace = tracer(clock);
  const registry = registryOf({
    commands: [['demo ping', { moduleId: 'demo', spec: demoCommand({ name: 'demo ping', ack: 'instant', handle: async () => viewOutcome('pong') }) }]],
  });
  const h = harness({ registry, clock });

  // A context menu, a user select, a ping - none are in the contract yet.
  const other = Object.assign(respondable(trace), actorFields({}), guards('other'), { createdTimestamp: clock.now() });
  h.deliver(other);
  await new Promise((resolve) => setTimeout(resolve, 5));
  deepStrictEqual(other.answers, [], 'nothing was said to an interaction nothing handles');

  // And the listener survived it, which is the part that matters.
  const command = commandInteraction(trace, { name: 'demo ping', createdTimestamp: clock.now() });
  h.deliver(command);
  await until(() => trace.has('discord:reply'), 'the next command');
});

// ---------------------------------------------------------------------------------------
// THE 3-SECOND DEADLINE, at the wiring
// ---------------------------------------------------------------------------------------

test('a deferring handler is acknowledged BEFORE it runs, and a 30-second handler does not delay that', async () => {
  const clock = fakeClock(START);
  const trace = tracer(clock);
  let release = (): void => undefined;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });

  const registry = registryOf({
    commands: [
      ['demo build', {
        moduleId: 'demo',
        spec: demoCommand({
          name: 'demo build',
          ack: 'defer',
          async handle() {
            trace.mark('handler:start');
            await blocked;
            // The handler took half a minute. The token lives 15 ; the ACK had 3.
            clock.set(clock.now() + 30_000);
            trace.mark('handler:end');
            return viewOutcome('built');
          },
        }),
      }],
    ],
  });
  const h = harness({ registry, clock });

  const i = commandInteraction(trace, { name: 'demo build', createdTimestamp: START });
  h.deliver(i);
  await until(() => trace.has('handler:start'), 'the handler to start');

  // THE ASSERTION THIS WHOLE SECTION EXISTS FOR: Discord has already been acknowledged while
  // the handler is still running, and it was acknowledged at the interaction's own age zero.
  deepStrictEqual(trace.names(), ['discord:deferReply', 'handler:start']);
  strictEqual(i.deferred, true);
  ok(trace.at('discord:deferReply') - START < ACK_DEADLINE_MS);

  release();
  await until(() => trace.has('discord:editReply'), 'the answer');

  deepStrictEqual(trace.names(), ['discord:deferReply', 'handler:start', 'handler:end', 'discord:editReply']);
  strictEqual(trace.at('discord:editReply'), START + 30_000, 'the answer landed 30s in, on a token that is still alive');
  // A deferred reply is edited, never re-replied: a second `reply` is Discord's 40060.
  deepStrictEqual(i.answers.map((a) => a.method), ['deferReply', 'editReply']);
});

test('each deferring strategy uses the acknowledgement its own surface requires', async () => {
  const clock = fakeClock(START);
  const trace = tracer(clock);
  const registry = registryOf({
    commands: [
      ['demo quiet', { moduleId: 'demo', spec: demoCommand({ name: 'demo quiet', ack: 'defer-ephemeral', handle: async () => viewOutcome('only you') }) }],
    ],
    actions: [
      ['demo:approve', { moduleId: 'demo', spec: demoAction({ name: 'approve', ack: 'defer-update', handle: async () => viewOutcome('approved') }) }],
    ],
  });
  const h = harness({ registry, clock });

  const command = commandInteraction(trace, { name: 'demo quiet', createdTimestamp: clock.now() });
  h.deliver(command);
  await until(() => command.answers.length >= 2, 'the ephemeral defer');
  strictEqual(command.answers[0]?.method, 'deferReply');
  deepStrictEqual(command.answers[0]?.body, { withResponse: true, flags: MessageFlags.Ephemeral });

  const button = componentInteraction(trace, 'button', { customId: cardId('approve'), createdTimestamp: clock.now() });
  h.deliver(button);
  await until(() => button.answers.length >= 2, 'the update defer');
  // `defer-update` edits the card the button lives on; deferReply would post a new message.
  strictEqual(button.answers[0]?.method, 'deferUpdate');
});

test("the watchdog is wired to a real timer: an `instant` handler that overruns is deferred for it", async () => {
  const clock = fakeClock(START);
  const trace = tracer(clock);
  let release = (): void => undefined;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });

  const registry = registryOf({
    commands: [
      ['demo slow', {
        moduleId: 'demo',
        spec: demoCommand({
          name: 'demo slow',
          // The lie. This handler awaits SQLite, GitHub and a DNS lookup.
          ack: 'instant',
          async handle() {
            trace.mark('handler:start');
            await blocked;
            trace.mark('handler:end');
            return viewOutcome('eventually');
          },
        }),
      }],
    ],
  });
  const h = harness({ registry, clock });

  // Created 5 seconds ago: already past the 2.5s margin, so `watchdogDelayMs` is 0 and the
  // timer fires on the next tick instead of making the test wait two and a half seconds.
  const i = commandInteraction(trace, { name: 'demo slow', createdTimestamp: START - 5_000 });
  h.deliver(i);
  await until(() => trace.has('discord:deferReply'), 'the watchdog to defer');

  const shout = h.logger.lines.find((l) => l.msg.includes('ACK WATCHDOG'));
  strictEqual(shout?.level, 'error', 'a firing watchdog means a spec is lying, so it is not a warning');
  strictEqual(shout?.fields['handler'], 'demo slow', 'and it names the handler whose declaration is wrong');

  release();
  await until(() => trace.has('discord:editReply'), 'the rescued answer');

  // The interaction was saved: acknowledged by the watchdog, answered by the handler.
  deepStrictEqual(trace.names(), ['handler:start', 'discord:deferReply', 'handler:end', 'discord:editReply']);
});

test('the watchdog rescues PRIVATELY, so a slow refusal is not published to the channel', async () => {
  // WHAT THIS GUARDS. The watchdog fires for a handler that declared `ack: 'instant'` and then
  // did not answer, which means it fires BEFORE anyone knows what that handler was going to say.
  // A defer fixes the visibility of the reply that follows it, so the guess is unavoidable - and
  // the two ways of being wrong are not equally bad. Guess public and an ephemeral answer (a
  // permission denial, a credential error, an audit listing) is published to the channel, which
  // the user never asked for and cannot undo. Guess private and a public answer reaches only the
  // person who ran the command, on a path that is already degraded because the handler broke its
  // own `instant` contract. So: private.
  //
  // It was `{ ephemeral: false }` and no test looked at the flag, only that a defer happened.
  const clock = fakeClock(START);
  const trace = tracer(clock);
  let release = (): void => undefined;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });

  const registry = registryOf({
    commands: [
      ['demo secret', {
        moduleId: 'demo',
        spec: demoCommand({
          name: 'demo secret',
          ack: 'instant',
          async handle() {
            await blocked;
            // The shape that made this matter: a refusal meant for one person only.
            return viewOutcome('you are not allowed to do that');
          },
        }),
      }],
    ],
  });
  const h = harness({ registry, clock });

  const i = commandInteraction(trace, { name: 'demo secret', createdTimestamp: START - 5_000 });
  h.deliver(i);
  await until(() => trace.has('discord:deferReply'), 'the watchdog to defer');

  // The wire form, not the convenience form: discord.js 14.27 deprecated `ephemeral: true` in
  // favour of `flags: MessageFlags.Ephemeral` (64), and `interactionScopedReply` translates.
  // Asserting the 64 is what makes this test about what Discord is actually told.
  const defer = i.answers.find((a) => a.method === 'deferReply');
  const body = defer?.body as { flags?: number } | undefined;
  strictEqual(
    (body?.flags ?? 0) & 64,
    64,
    'the watchdog cannot know what the handler will say, so it must not make it public',
  );

  release();
  await until(() => trace.has('discord:editReply'), 'the rescued answer');
});

test("an `instant` handler answers directly, and nothing defers behind its reply", async () => {
  const clock = fakeClock(START);
  const trace = tracer(clock);
  const registry = registryOf({
    commands: [
      ['demo fast', {
        moduleId: 'demo',
        spec: demoCommand({
          name: 'demo fast',
          ack: 'instant',
          async handle() {
            trace.mark('handler:start');
            return viewOutcome('pong');
          },
        }),
      }],
    ],
  });
  const h = harness({ registry, clock });

  // The interaction is ALREADY past the watchdog margin, so the timer is scheduled for 0ms and
  // gets a real chance to run. It must not: the handler's own answer is the acknowledgement.
  const i = commandInteraction(trace, { name: 'demo fast', createdTimestamp: START - 5_000 });
  h.deliver(i);
  await until(() => trace.has('discord:reply'), 'the reply');
  await new Promise((resolve) => setTimeout(resolve, 5));

  deepStrictEqual(trace.names(), ['handler:start', 'discord:reply']);
  deepStrictEqual(h.logger.lines.filter((l) => l.msg.includes('WATCHDOG')), []);
});

test('the watchdog is a deadline on the HANDLER, not on the delivery: a failed answer does not wake it', async () => {
  const clock = fakeClock(START);
  const trace = tracer(clock);
  const registry = registryOf({
    commands: [
      ['demo fast', {
        moduleId: 'demo',
        spec: demoCommand({
          name: 'demo fast',
          ack: 'instant',
          async handle() {
            trace.mark('handler:start');
            return viewOutcome('pong');
          },
        }),
      }],
    ],
  });
  const h = harness({ registry, clock });

  // The handler is quick and Discord then REFUSES the reply, so the interaction is still
  // unacknowledged when the timer would fire - the one state in which the watchdog would act.
  // `stop()` in the handler's `finally` block is what keeps it from acting, and without that
  // line the user gets a spurious "thinking..." and an ERROR log blaming a handler that was
  // never slow.
  const i = commandInteraction(trace, { name: 'demo fast', createdTimestamp: START - 5_000, replyFails: true });
  h.deliver(i);
  await until(() => h.logger.lines.some((l) => l.msg === 'could not answer an interaction'), 'the failed answer');
  await new Promise((resolve) => setTimeout(resolve, 5));

  strictEqual(i.replied, false, 'the interaction really is unacknowledged, so the guard inside the timer would not save us');
  ok(!trace.has('discord:deferReply'), 'the watchdog was cancelled when the handler returned, not when the answer landed');
  deepStrictEqual(h.logger.lines.filter((l) => l.msg.includes('WATCHDOG')), []);
});

test("an ack:'form' handler is not acknowledged up front, so the modal is still legal", async () => {
  const clock = fakeClock(START);
  const trace = tracer(clock);
  const registry = registryOf({
    commands: [
      ['demo request', {
        moduleId: 'demo',
        spec: demoCommand({
          name: 'demo request',
          ack: 'form',
          async handle() {
            trace.mark('handler:start');
            return {
              kind: 'form',
              form: {
                customId: assertActionRef({ moduleId: 'demo', action: 'brief', entityId: newRequestId(START), nonce: newCardNonce() }),
                title: 'Describe it',
                intro: null,
                fields: [{ kind: 'text', name: 'title', label: 'Title', description: null, style: 'short', required: true, maxLength: 100, placeholder: '' }],
              },
            };
          },
        }),
      }],
    ],
  });
  const h = harness({ registry, clock });

  const i = commandInteraction(trace, { name: 'demo request', createdTimestamp: clock.now() });
  h.deliver(i);
  await until(() => trace.has('discord:showModal'), 'the modal');

  // Discord forbids defer-then-modal. Nothing acknowledged before the handler ran, which is
  // the only reason `showModal` was reachable at all.
  deepStrictEqual(trace.names(), ['handler:start', 'discord:showModal']);
  deepStrictEqual(i.answers.map((a) => a.method), ['showModal']);
});

// ---------------------------------------------------------------------------------------
// The guard, at INVOCATION time
// ---------------------------------------------------------------------------------------

test('the permission is re-checked on every click, so a role removed after the card was posted is refused', async () => {
  const clock = fakeClock(START);
  const trace = tracer(clock);
  const access = roleGatedAccess(APPROVER_ROLE);
  const clicks: ClickInvocation[] = [];

  const registry = registryOf({
    actions: [
      ['demo:approve', {
        moduleId: 'demo',
        spec: demoAction({
          name: 'approve',
          ack: 'defer-update',
          permission: DEMO_APPROVE,
          handle: async (click) => {
            clicks.push(click);
            return viewOutcome('approved');
          },
        }),
      }],
    ],
  });
  const h = harness({ registry, clock, access });

  // ONE card, clicked twice. The `custom_id` is identical - it was minted when the approver
  // still had the role, and nothing about it can express that they no longer do.
  const custom = cardId('approve');

  const first = componentInteraction(trace, 'button', { customId: custom, createdTimestamp: clock.now(), roleIds: [APPROVER_ROLE] });
  h.deliver(first);
  await until(() => clicks.length === 1, 'the allowed click');

  const second = componentInteraction(trace, 'button', { customId: custom, createdTimestamp: clock.now(), roleIds: [] });
  h.deliver(second);
  await until(() => second.answers.length > 0, 'the refusal');

  strictEqual(clicks.length, 1, 'the handler did not run the second time');
  deepStrictEqual(access.checks.map((c) => c.roleIds), [[APPROVER_ROLE], []], 'each check read the roles on THAT interaction');

  const refusal = JSON.stringify(second.answers);
  ok(refusal.includes('Not allowed'));
  ok(refusal.includes('You need `demo.approve`.'), 'a denial names the key');
  ok(refusal.includes('Ask a server admin to run `/access grant demo.approve`.'), 'and who can grant it, with the command in code');
  ok(!refusal.includes('server admin to run /access'), 'the command is never printed bare');

  // The guard runs before the acknowledgement, so a refusal never spends one.
  strictEqual(second.answers[0]?.method, 'reply');

  const denied = h.audit.entries.at(-1);
  strictEqual(denied?.action, 'demo.action:approve');
  strictEqual(denied?.decisionLayer, 'L3-deny');
  strictEqual(denied?.detail['denied'], 'demo.approve');
});

test('a missing bot permission is caught from the interaction, before the handler and with no API call', async () => {
  const clock = fakeClock(START);
  const trace = tracer(clock);
  let ran = 0;
  const registry = registryOf({
    commands: [
      ['demo post', {
        moduleId: 'demo',
        spec: demoCommand({
          name: 'demo post',
          ack: 'defer',
          needs: ['SendMessages', 'EmbedLinks'],
          handle: async () => {
            ran += 1;
            return viewOutcome('posted');
          },
        }),
      }],
    ],
  });
  const h = harness({ registry, clock });

  // The bot can see the channel and nothing else - which is what `app_permissions` says in a
  // channel with an overwrite. Zero REST calls are made to discover this.
  const i = commandInteraction(trace, {
    name: 'demo post',
    createdTimestamp: clock.now(),
    appPermissions: permissionInteger(['ViewChannel']),
  });
  h.deliver(i);
  await until(() => i.answers.length > 0, 'the refusal');

  strictEqual(ran, 0);
  strictEqual(i.answers[0]?.method, 'reply', 'refused before any acknowledgement was spent');
  const card = JSON.stringify(i.answers);
  ok(card.includes('Missing permissions'));
  ok(card.includes("I can't post here: missing Send Messages, Embed Links."), 'flag names are humanised');
  ok(card.includes('Ask an admin to allow them here, or use the re-invite button.'));
  ok(card.includes(`permissions=${permissionInteger(['SendMessages', 'EmbedLinks']).toString()}`), 'the re-invite link carries the exact integer');
});

// ---------------------------------------------------------------------------------------
// Rate limits, on the path an interaction actually takes
// ---------------------------------------------------------------------------------------

test('the declared bucket is spent on the path an interaction takes, naming the entry point and the actor', async () => {
  const clock = fakeClock(START);
  const trace = tracer(clock);
  const perUser = [limit.perUser(3, 3_600_000), limit.perGuild(20, 86_400_000)];

  const registry = registryOf({
    commands: [
      ['demo build', { moduleId: 'demo', spec: demoCommand({ name: 'demo build', ack: 'defer', limit: perUser, handle: async () => viewOutcome('built') }) }],
    ],
    actions: [
      ['demo:approve', { moduleId: 'demo', spec: demoAction({ name: 'approve', ack: 'defer', limit: perUser, handle: async () => viewOutcome('approved') }) }],
    ],
  });
  const h = harness({ registry, clock });

  const command = commandInteraction(trace, { name: 'demo build', createdTimestamp: clock.now() });
  h.deliver(command);
  await until(() => command.answers.length >= 2, 'the command answer');

  const button = componentInteraction(trace, 'button', { customId: cardId('approve'), createdTimestamp: clock.now() });
  h.deliver(button);
  await until(() => button.answers.length >= 2, 'the click answer');

  deepStrictEqual(h.gate.spent.map((s) => s.name), ['command:demo build', 'action:approve'], 'both surfaces spend, and the bucket is named for the entry point');
  const spend = h.gate.spent[0];
  strictEqual(spend?.moduleId, 'demo');
  deepStrictEqual(spend.limits, perUser, 'every declared bucket goes to the gate, not just the first');
  strictEqual(spend.userId, USER_ID, 'keyed on the CLICKER, never on the card author');
  strictEqual(spend.guildId, GUILD_ID);
  strictEqual(spend.channelId, CHANNEL_ID);
  strictEqual(spend.at, START, 'stamped from ctx.clock, so a window is testable');
});

test('an empty bucket refuses before the handler runs and before an acknowledgement is spent', async () => {
  const clock = fakeClock(START);
  const trace = tracer(clock);
  let ran = 0;
  const gate = recordingGate();
  const registry = registryOf({
    actions: [
      ['demo:approve', {
        moduleId: 'demo',
        spec: demoAction({
          name: 'approve',
          ack: 'defer',
          limit: [limit.perUser(3, 3_600_000)],
          handle: async () => {
            ran += 1;
            return viewOutcome('approved');
          },
        }),
      }],
    ],
  });
  const h = harness({ registry, clock, gate });
  gate.refuseNext();

  const i = componentInteraction(trace, 'button', { customId: cardId('approve'), createdTimestamp: clock.now() });
  h.deliver(i);
  await until(() => i.answers.length > 0, 'the refusal');

  strictEqual(ran, 0, 'a spent bucket does not reach the handler');
  strictEqual(i.answers[0]?.method, 'reply');
  const card = JSON.stringify(i.answers);
  ok(card.includes('Slow down'));
  ok(!card.includes('Too fast'), 'the old triple-statement is gone');
});

// ---------------------------------------------------------------------------------------
// Failed handoffs, and refusals on a message hook, say it once
// ---------------------------------------------------------------------------------------

function handoffCommand(): Registry {
  return registryOf({
    commands: [
      ['demo build', {
        moduleId: 'demo',
        spec: demoCommand({
          name: 'demo build',
          ack: 'defer',
          async handle() {
            return {
              kind: 'handoff',
              view: { accent: 'pending', nodes: [{ kind: 'text', md: md`Building...` }] },
              job: { type: 'poll', payload: {}, runAfterMs: START, deadlineAtMs: START + 1_800_000, dedupeKey: 'r-1' },
            };
          },
        }),
      }],
    ],
  });
}

test('a failed handoff on the interaction path answers ONCE, through the reply, and never edits the card behind it', async () => {
  const clock = fakeClock(START);
  const trace = tracer(clock);
  const h = harness({
    registry: handoffCommand(),
    clock,
    enqueueError: errors.unavailable('the job runner', 'Ask an admin to restart the bot.'),
  });

  const i = commandInteraction(trace, { name: 'demo build', createdTimestamp: clock.now() });
  h.deliver(i);
  await until(() => i.answers.length >= 3, 'the card and then the failure');

  // deferReply, the card, the error: three writes, one of them the error. Before the fix the
  // channel path edited the card to the error AND the reply edited it again.
  deepStrictEqual(i.answers.map((a) => a.method), ['deferReply', 'editReply', 'editReply']);
  strictEqual(h.discord.edited.length, 0, 'the channel-scoped edit is not used on the interaction path');
  ok(JSON.stringify(i.answers.at(-1)).includes('Unavailable right now'));
});

test('a failed handoff on the message-hook path edits the card to the error and posts nothing else', async () => {
  const clock = fakeClock(START);
  const registry = registryOf({
    hooks: [
      ['$request', {
        moduleId: 'demo',
        spec: demoHook({
          prefix: '$request',
          handle: async () => ({
            kind: 'handoff',
            view: { accent: 'pending', nodes: [{ kind: 'text', md: md`Filing...` }] },
            job: { type: 'poll', payload: {}, runAfterMs: START, deadlineAtMs: START + 1_800_000, dedupeKey: 'r-2' },
          }),
        }),
      }],
    ],
  });
  const h = harness({
    registry,
    clock,
    intents: GatewayIntentBits.Guilds | GatewayIntentBits.GuildMessages | GatewayIntentBits.MessageContent,
    enqueueError: errors.unavailable('the job runner', 'Ask an admin to restart the bot.'),
  });

  h.message(gatewayMessage({ content: '$request add a thing' }));
  await until(() => h.discord.edited.length === 1, 'the card repair');
  await new Promise((resolve) => setTimeout(resolve, 5));

  strictEqual(h.discord.posted.length, 1, 'only the card itself was posted; there is no second public error');
  strictEqual(h.discord.edited.length, 1);
});

test('a rate limit or permission refusal on a message hook is logged, not posted to the channel', async () => {
  const clock = fakeClock(START);
  let ran = 0;
  const registry = registryOf({
    hooks: [
      ['$request', {
        moduleId: 'demo',
        spec: demoHook({
          prefix: '$request',
          handle: async () => {
            ran += 1;
            return viewOutcome('filed');
          },
        }),
      }],
    ],
  });
  const gate = recordingGate();
  const h = harness({
    registry,
    clock,
    gate,
    intents: GatewayIntentBits.Guilds | GatewayIntentBits.GuildMessages | GatewayIntentBits.MessageContent,
  });

  gate.refuseNext();
  h.message(gatewayMessage({ content: '$request too often' }));
  await until(() => h.logger.lines.some((l) => l.msg === 'hook refused by the guard'), 'the logged refusal');
  await new Promise((resolve) => setTimeout(resolve, 5));

  strictEqual(ran, 0, 'the handler did not run');
  strictEqual(h.discord.posted.length, 0, 'nothing was posted to the channel');
});

// ---------------------------------------------------------------------------------------
// Nothing a handler does may take the process down
// ---------------------------------------------------------------------------------------

test('a handler that throws becomes an error card, and the router keeps routing', async () => {
  const clock = fakeClock(START);
  const trace = tracer(clock);
  let correlationId = '';
  let healthyRan = 0;

  const registry = registryOf({
    commands: [
      ['demo boom', {
        moduleId: 'demo',
        spec: demoCommand({
          name: 'demo boom',
          ack: 'defer',
          // A SYNCHRONOUS throw, which is the one that escapes if `handle` is called outside
          // the try block rather than inside it.
          handle(inv) {
            correlationId = inv.id;
            throw new Error('the database was on fire');
          },
        }),
      }],
      ['demo fine', { moduleId: 'demo', spec: demoCommand({ name: 'demo fine', ack: 'instant', handle: async () => { healthyRan += 1; return viewOutcome('still here'); } }) }],
    ],
  });
  const h = harness({ registry, clock });

  const boom = commandInteraction(trace, { name: 'demo boom', createdTimestamp: clock.now() });
  h.deliver(boom);
  await until(() => boom.answers.length >= 2, 'the error card');

  const card = JSON.stringify(boom.answers);
  ok(card.includes('Something broke'));
  ok(card.includes(correlationId), 'the user is given the id that ties their screenshot to the log line');
  ok(!card.includes('the database was on fire'), 'and never the thrown message');

  // The listener is still attached and the next interaction is routed normally. This is the
  // whole point of the `.catch` on the dispatch: one bad handler must not deafen the bot.
  const fine = commandInteraction(trace, { name: 'demo fine', createdTimestamp: clock.now() });
  h.deliver(fine);
  await until(() => healthyRan === 1, 'the next command');
});

test('an unknown command name and an undecodable custom_id are answered, not thrown', async () => {
  const clock = fakeClock(START);
  const trace = tracer(clock);
  let ran = 0;
  const registry = registryOf({
    actions: [['demo:approve', { moduleId: 'demo', spec: demoAction({ name: 'approve', ack: 'defer', handle: async () => { ran += 1; return viewOutcome('x'); } }) }]],
  });
  const h = harness({ registry, clock });

  // A command Discord still has registered that this build no longer declares.
  const ghost = commandInteraction(trace, { name: 'ghost', createdTimestamp: clock.now() });
  h.deliver(ghost);
  await until(() => ghost.answers.length > 0, 'the not-found card');
  ok(JSON.stringify(ghost.answers).includes('The command list is out of date'));

  // A `custom_id` from before the codec version changed.
  const stale = componentInteraction(trace, 'button', { customId: 'v0~demo~approve~01J~ABCD', createdTimestamp: clock.now() });
  h.deliver(stale);
  await until(() => stale.answers.length > 0, 'the stale-card answer');
  ok(JSON.stringify(stale.answers).includes('older version of the bot'));

  // Not a custom_id at all.
  const junk = componentInteraction(trace, 'button', { customId: 'not-a-custom-id', createdTimestamp: clock.now() });
  h.deliver(junk);
  await until(() => junk.answers.length > 0, 'the junk answer');

  // A well-formed id for an action this build no longer loads.
  const vanished = componentInteraction(trace, 'button', { customId: cardId('vanished'), createdTimestamp: clock.now() });
  h.deliver(vanished);
  await until(() => vanished.answers.length > 0, 'the unknown-action answer');
  ok(JSON.stringify(vanished.answers).includes('no longer loaded'));

  strictEqual(ran, 0, 'none of the four reached a handler');
});

// ---------------------------------------------------------------------------------------
// The other two entry points
// ---------------------------------------------------------------------------------------

test('a $request message reaches the hook and its card is posted to the CHANNEL, never to an interaction', async () => {
  const clock = fakeClock(START);
  const bodies: string[] = [];
  const registry = registryOf({
    hooks: [
      ['$request', {
        moduleId: 'demo',
        spec: demoHook({
          prefix: '$request',
          handle: async (ev) => {
            // `body` is UserText - an object, never a string. This is the only door out of it.
            bodies.push(toMarkdown(ev.body, { maxLength: 200 }).text);
            return viewOutcome('filed');
          },
        }),
      }],
    ],
  });
  // Message intents, so the boot-time advice below stays out of this test's log.
  const h = harness({ registry, clock, intents: GatewayIntentBits.Guilds | GatewayIntentBits.GuildMessages | GatewayIntentBits.MessageContent });

  h.message(gatewayMessage({ content: '$request add a /ping command' }));
  await until(() => h.discord.posted.length === 1, 'the hook card');

  strictEqual(bodies.length, 1);
  strictEqual(bodies[0], 'add a /ping command', 'the prefix is stripped and the rest arrives as UserText');
  strictEqual(h.discord.posted[0]?.channelId, CHANNEL_ID, 'a hook has no interaction token, so the card goes to the channel');

  // The bot must not answer itself, and a message with no prefix is not a hook.
  h.message(gatewayMessage({ content: '$request loop', authorId: BOT_ID, bot: true }));
  h.message(gatewayMessage({ content: 'just talking' }));
  await new Promise((resolve) => setTimeout(resolve, 5));
  strictEqual(h.discord.posted.length, 1);
});

test('attaching with a hook declared and no MessageContent intent says which toggle to flip - once at boot, once on the first empty message', async () => {
  const clock = fakeClock(START);
  const registry = registryOf({
    hooks: [['$request', { moduleId: 'demo', spec: demoHook({ prefix: '$request', handle: async () => ({ kind: 'silent' }) }) }]],
  });
  const h = harness({ registry, clock, intents: GatewayIntentBits.Guilds });

  const boot = h.logger.lines.find((l) => l.msg === MESSAGE_CONTENT_ADVICE);
  strictEqual(boot?.level, 'error');
  strictEqual(boot?.fields['hooks'], '$request');

  // What the missing intent actually looks like at runtime: content arrives empty.
  h.message(gatewayMessage({ content: '', attachments: 0 }));
  h.message(gatewayMessage({ content: '', attachments: 0 }));
  await new Promise((resolve) => setTimeout(resolve, 5));

  strictEqual(
    h.logger.lines.filter((l) => l.msg === MESSAGE_CONTENT_ADVICE).length,
    2,
    'boot says it once and the first empty message says it once; the log is not flooded thereafter',
  );
  strictEqual(h.discord.posted.length, 0);
});

test('an autocomplete reaches its handler and is answered - with no permission check and no rate-limit spend', async () => {
  const clock = fakeClock(START);
  const access = roleGatedAccess(APPROVER_ROLE);
  const asked: string[] = [];

  const registry = registryOf({
    commands: [
      ['demo retry', {
        moduleId: 'demo',
        spec: demoCommand({
          name: 'demo retry',
          ack: 'defer',
          permission: DEMO_APPROVE,
          limit: [limit.perUser(3, 3_600_000)],
          handle: async () => viewOutcome('retried'),
          autocomplete: async (req) => {
            asked.push(`${req.option}:${req.actor.userId}`);
            return [{ name: 'the first one', value: 'r-1' }];
          },
        }),
      }],
    ],
  });
  const h = harness({ registry, clock, access });

  const i = autocompleteInteraction({ name: 'demo retry', option: 'request', partial: 'the', roleIds: [] });
  h.deliver(i);
  await until(() => i.sent.length === 1, 'the suggestions');

  deepStrictEqual(asked, [`request:${USER_ID}`]);
  deepStrictEqual(i.sent[0], [{ name: 'the first one', value: 'r-1' }]);

  // THE CONTRACT THIS PINS, because a module depends on it. `runAutocomplete` never calls
  // `guard`: it does not spend a bucket (Discord fires one of these per keystroke) and it does
  // not run the allow-list read (a 3-second budget cannot afford one). The consequence is that
  // a suggestion list is NOT permission-scoped by the router, which is exactly why
  // `src/modules/builder/history.ts` scopes `suggest()` to the caller's own rows by hand.
  deepStrictEqual(h.gate.spent, []);
  deepStrictEqual(access.checks, []);
});

test('an autocomplete handler that throws is answered with an empty list rather than left to time out', async () => {
  const clock = fakeClock(START);
  const registry = registryOf({
    commands: [
      ['demo retry', {
        moduleId: 'demo',
        spec: demoCommand({
          name: 'demo retry',
          ack: 'defer',
          handle: async () => viewOutcome('retried'),
          autocomplete: () => {
            throw new Error('the index is gone');
          },
        }),
      }],
    ],
  });
  const h = harness({ registry, clock });

  const i = autocompleteInteraction({ name: 'demo retry', option: 'request', partial: '' });
  h.deliver(i);
  await until(() => i.sent.length === 1, 'the empty answer');

  deepStrictEqual(i.sent[0], [], 'there is no defer for an autocomplete: answer within 3s or not at all');
  ok(h.logger.lines.some((l) => l.level === 'error' && l.msg === 'autocomplete threw'));
});

test('a handoff posts its card now and injects the card ids into the job payload', async () => {
  const clock = fakeClock(START);
  const trace = tracer(clock);
  const registry = registryOf({
    commands: [
      ['demo build', {
        moduleId: 'demo',
        spec: demoCommand({
          name: 'demo build',
          ack: 'defer',
          async handle() {
            return {
              kind: 'handoff',
              view: { accent: 'pending', nodes: [{ kind: 'text', md: md`Building...` }] },
              job: { type: 'poll', payload: { requestId: 'r-1' }, runAfterMs: START, deadlineAtMs: START + 1_800_000, dedupeKey: 'r-1' },
            };
          },
        }),
      }],
    ],
  });
  const h = harness({ registry, clock });

  const i = commandInteraction(trace, { name: 'demo build', createdTimestamp: clock.now() });
  h.deliver(i);
  await until(() => h.enqueued.length === 1, 'the enqueue');

  // The card went out on the SHORT path, while the token was alive...
  deepStrictEqual(i.answers.map((a) => a.method), ['deferReply', 'editReply']);
  // ...and the long path was handed its durable ids instead of a token.
  const handed = h.enqueued[0];
  strictEqual(handed?.moduleId, 'demo');
  deepStrictEqual(handed.job.payload[SURFACE_KEY], { guildId: GUILD_ID, channelId: CHANNEL_ID, messageId: MESSAGE_ID });
  strictEqual(handed.job.payload['requestId'], 'r-1', 'the payload the module wrote survives the injection');
});

// ---------------------------------------------------------------------------------------
// THE DEFECT THAT WAS DOCUMENTED HERE, AND IS NOW FIXED
//
// This section used to hold a test named "DOCUMENTED DEFECT", which PASSED by asserting the
// broken behaviour, and was written to fail loudly the day somebody closed the race. Somebody
// has, so it has been inverted rather than deleted: the setup is the valuable part and it is
// unchanged, because it is the only place that reproduces the window deterministically.
//
// WHAT WAS WRONG. `startWatchdog` fires `void reply.deferReply(...)` and does not await it, and
// discord.js sets `interaction.deferred` only AFTER its REST POST resolves. For one round trip
// the interaction was acknowledged at Discord and read as unacknowledged locally, so a handler
// finishing inside that window reached `reply.send`, took the `interaction.reply()` branch, and
// was refused with 40060. The failure was logged and swallowed; the user was left looking at
// "Bot is thinking..." forever. A handler taking about 2.6 seconds is not an exotic case - it
// is exactly the mis-declared `ack: 'instant'` the watchdog exists to rescue.
//
// WHERE IT WAS FIXED, and why not here: `interactionScopedReply` in `#adapters/discord/client`
// now tracks an in-flight acknowledgement, reports it from `acknowledged()`, and makes `send`,
// `showForm` and `close` wait for it to settle before reading discord.js's flags. Fixing it in
// the watchdog would have closed this one caller's window; fixing it in the reply object closes
// it for every caller, including the reverse race where the HANDLER's own reply is in flight at
// 2.5s and the watchdog would have deferred on top of it.
// ---------------------------------------------------------------------------------------

test('AN ANSWER THAT ARRIVES WHILE THE WATCHDOG IS STILL ACKNOWLEDGING LANDS ON THE CARD', async () => {
  const clock = fakeClock(START);
  const trace = tracer(clock);
  let releaseHandler = (): void => undefined;
  let confirmDefer = (): void => undefined;
  const handlerBlocked = new Promise<void>((resolve) => {
    releaseHandler = resolve;
  });
  // Discord has received the acknowledgement; the response has not come back yet. discord.js
  // sets `interaction.deferred` only after it does.
  const deferInFlight = new Promise<void>((resolve) => {
    confirmDefer = resolve;
  });

  const registry = registryOf({
    commands: [
      ['demo slow', {
        moduleId: 'demo',
        spec: demoCommand({
          name: 'demo slow',
          ack: 'instant',
          async handle() {
            await handlerBlocked;
            return viewOutcome('the answer the user is waiting for');
          },
        }),
      }],
    ],
  });
  const h = harness({ registry, clock });

  const i = commandInteraction(trace, { name: 'demo slow', createdTimestamp: START - 5_000, deferGate: deferInFlight });
  h.deliver(i);
  await until(() => trace.has('discord:deferReply'), 'the watchdog to defer');

  // THE WINDOW. The handler finishes DURING the acknowledgement's round trip, and discord.js
  // still reports the interaction as unacknowledged - which is the fact that used to be acted
  // on and is now waited out.
  strictEqual(i.deferred, false, 'the acknowledgement is in flight, so discord.js still reads unacknowledged');
  releaseHandler();

  // Nothing can complete until the acknowledgement is confirmed, because `send` now waits for
  // it rather than racing it. Let it land.
  await new Promise((resolve) => setTimeout(resolve, 5));
  deepStrictEqual(i.answers.map((a) => a.method), ['deferReply'], 'the answer is waiting, not lost');

  confirmDefer();
  await until(() => trace.has('discord:editReply'), 'the answer, once the defer is confirmed');

  // THE POINT: the answer EDITS the deferred reply instead of attempting a second one. A second
  // `reply` here is Discord 40060, and its cost is a "Bot is thinking..." nobody ever replaces.
  deepStrictEqual(i.answers.map((a) => a.method), ['deferReply', 'editReply']);
  deepStrictEqual(h.logger.lines.filter((l) => l.msg === 'could not answer an interaction'), []);
});

test('THE REVERSE RACE: a reply already on the wire is an acknowledgement, so the watchdog stands down', async () => {
  // THE SAME WINDOW, ENTERED FROM THE OTHER SIDE, and the half a naive fix misses. With the
  // HANDLER's own `reply()` in flight when the watchdog fires, `acknowledged()` used to read
  // false - because discord.js sets `replied` only when the round trip returns - so the watchdog
  // deferred on top of an answer that was already going. Same 40060, opposite culprit.
  //
  // `replyGate` holds the reply open so the timer genuinely lands inside the window. Without it
  // the reply resolves on a microtask and the macrotask timer never sees the race at all.
  //
  // READ THIS BEFORE TRUSTING IT: THIS TEST IS DEFENCE IN DEPTH AND DOES NOT BITE ALONE.
  // Two independent things stop this race, and today the FIRST one gets there every time - the
  // `stop()` in the handler's `finally` clears the timer before `deliver` runs, so the watchdog
  // is already dead by the time any reply is issued. Verified by mutation: removing the
  // `ackInFlight` term from `acknowledged()` leaves this test green, and so does removing the
  // `clearTimeout` from `stop()`. Removing BOTH turns it red.
  //
  // It is kept for exactly that reason. It is the only test that says the second layer holds
  // when the first is gone, and the first is one line of ordering that a refactor could move -
  // `deliver` inside the `try`, say - without anything else noticing. The test that pins the
  // `acknowledged()` term on its own is the progress-update one below.
  const clock = fakeClock(START);
  const trace = tracer(clock);
  let confirmReply = (): void => undefined;
  const replyInFlight = new Promise<void>((resolve) => {
    confirmReply = resolve;
  });

  const registry = registryOf({
    commands: [
      ['demo fast', {
        moduleId: 'demo',
        spec: demoCommand({ name: 'demo fast', ack: 'instant', handle: async () => viewOutcome('pong') }),
      }],
    ],
  });
  const h = harness({ registry, clock });

  // Created 5s ago, so `watchdogDelayMs` is 0 and the timer is due on the next timers phase -
  // which is while the reply below is still on the wire.
  const i = commandInteraction(trace, { name: 'demo fast', createdTimestamp: START - 5_000, replyGate: replyInFlight });
  h.deliver(i);
  await until(() => trace.has('discord:reply'), 'the handler answer to be issued');

  strictEqual(i.replied, false, 'the answer is on the wire and discord.js still reads unacknowledged');
  // Give the watchdog's timer every chance to fire into that window.
  await new Promise((resolve) => setTimeout(resolve, 10));

  ok(
    !trace.has('discord:deferReply'),
    'the watchdog must not acknowledge over an answer already in flight - that is Discord 40060',
  );
  deepStrictEqual(h.logger.lines.filter((l) => l.msg.includes('WATCHDOG')), []);

  confirmReply();
  await until(() => i.replied, 'the reply to land');
  deepStrictEqual(i.answers.map((a) => a.method), ['reply'], 'one acknowledgement, and it is the answer itself');
});

test('A PROGRESS UPDATE ISSUED WHILE THE WATCHDOG IS ACKNOWLEDGING IS NOT SILENTLY DROPPED', async () => {
  // THE OTHER HALF OF THE SAME FIX, and the half that is reachable through the router.
  //
  // `progress.update()` is a no-op before the acknowledgement, because there is nothing to edit
  // until one exists - and it decides that by asking `reply.acknowledged()`. The watchdog's
  // defer takes a round trip to be confirmed, so a handler that overran to 2.5s and then reported
  // progress asked that question in exactly the window where discord.js still said "no". The
  // update was dropped on the floor, silently, with no log line: the handler did everything
  // right and the user saw nothing.
  //
  // The `stop()` in the handler's `finally` means the watchdog can never race the handler's own
  // FINAL answer - that path is closed by construction. This one is not, because a progress
  // update happens WHILE the handler is still running, which is precisely when the watchdog
  // fires.
  const clock = fakeClock(START);
  const trace = tracer(clock);
  let confirmDefer = (): void => undefined;
  let watchdogFired = (): void => undefined;
  let finishHandler = (): void => undefined;
  const deferInFlight = new Promise<void>((resolve) => {
    confirmDefer = resolve;
  });
  const deferHappened = new Promise<void>((resolve) => {
    watchdogFired = resolve;
  });
  const handlerMayFinish = new Promise<void>((resolve) => {
    finishHandler = resolve;
  });

  const registry = registryOf({
    commands: [
      ['demo slow', {
        moduleId: 'demo',
        spec: demoCommand({
          name: 'demo slow',
          ack: 'instant',
          async handle(inv) {
            // Wait until the watchdog's acknowledgement is ON THE WIRE but not yet confirmed.
            await deferHappened;
            inv.progress.update({ accent: 'pending', nodes: [{ kind: 'text', md: sanitizeStored('still working on it') }] });
            await handlerMayFinish;
            return viewOutcome('the finished answer');
          },
        }),
      }],
    ],
  });
  const h = harness({ registry, clock });

  const i = commandInteraction(trace, { name: 'demo slow', createdTimestamp: START - 5_000, deferGate: deferInFlight });
  h.deliver(i);
  await until(() => trace.has('discord:deferReply'), 'the watchdog to defer');
  strictEqual(i.deferred, false, 'the acknowledgement is on the wire and not yet confirmed');

  watchdogFired();
  await new Promise((resolve) => setTimeout(resolve, 5));

  // Nothing can have been written yet - the edit is queued behind the acknowledgement it needs.
  deepStrictEqual(i.answers.map((a) => a.method), ['deferReply']);

  confirmDefer();
  await until(
    () => i.answers.some((a) => a.method === 'editReply' && JSON.stringify(a.body).includes('still working on it')),
    'the progress update to reach the card',
  );

  finishHandler();
  await until(
    () => i.answers.some((a) => a.method === 'editReply' && JSON.stringify(a.body).includes('the finished answer')),
    'the final answer',
  );
  deepStrictEqual(h.logger.lines.filter((l) => l.msg === 'progress update dropped'), []);
});
