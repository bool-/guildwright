/**
 * The parts of the adapter that decide something before they touch the network: what Discord
 * is told a command looks like, whether that has changed since the last boot, what an upstream
 * failure is allowed to say - and THE SHORT PATH, `interactionScopedReply`, which is where the
 * 3-second contract and the 15-minute token are actually spent.
 *
 * The short-path tests drive a fake interaction that models discord.js's own semantics rather
 * than a convenient version of them, because the router's guarantees rest on those semantics:
 * `deferReply` sets `deferred` only after its REST call resolves, `reply` and `showModal`
 * refuse locally once `deferred || replied`, and an `editReply` body may not carry `flags`.
 */

import { deepStrictEqual, ok, strictEqual } from 'node:assert/strict';
import { test } from 'node:test';
import {
  ApplicationCommandOptionType,
  GatewayIntentBits,
  InteractionContextType,
  MessageFlags,
  type AutocompleteInteraction,
  type RepliableInteraction,
} from 'discord.js';
import { md } from '#core/text';
import { staticCustomId } from '#core/ids';
import { MAX_AUTOCOMPLETE_CHOICES } from '#core/command';
import type { View } from '#core/view';
import { fakeLogger, fakeRecordingLogger } from '#testing/fakes';
import {
  answerAutocomplete,
  buildCommandPayloads,
  commandDigest,
  deployCommands,
  deployScope,
  discordUpstream,
  interactionScopedReply,
  interactionToken,
  memoryCommandSyncStore,
  BASE_INTENTS,
  BASE_INTENTS_BITFIELD,
  createDiscordClient,
  INTERACTION_TOKEN_MS,
  MESSAGE_INTENTS,
  MESSAGE_INTENTS_BITFIELD,
  type CommandPayload,
  type DeployableCommand,
} from '#adapters/discord/client';

const ping: DeployableCommand = {
  name: 'ping',
  description: 'Check that the bot is alive',
  surface: 'both',
  options: [],
};

function recorder(): { put(route: `/${string}`, body: unknown): Promise<void>; readonly calls: { route: string; body: unknown }[] } {
  const calls: { route: string; body: unknown }[] = [];
  return {
    calls,
    async put(route, body) {
      calls.push({ route, body });
      await Promise.resolve();
    },
  };
}

// ---------------------------------------------------------------------------------------
// Intents
// ---------------------------------------------------------------------------------------

test('the DEFAULT install requests no privileged intent at all', () => {
  // This is the point of moving to `/request`: application commands and modal submissions are
  // INTERACTIONS, which arrive regardless of message intents. Anything more than `Guilds` here
  // means somebody reintroduced a privileged requirement — and with it the setup failure where
  // the bot connects fine and silently never sees the command.
  const bits = BASE_INTENTS.reduce<number>((acc, i) => acc | i, 0);
  strictEqual(bits, BASE_INTENTS_BITFIELD);
  strictEqual(bits, GatewayIntentBits.Guilds);

  const client = createDiscordClient();
  strictEqual(Number(client.options.intents.bitfield), GatewayIntentBits.Guilds);
  strictEqual(
    client.options.intents.has(GatewayIntentBits.MessageContent),
    false,
    'MessageContent is privileged and must never be requested by default',
  );
});

test('opting in adds exactly the two message intents, and nothing else', () => {
  const bits = [...BASE_INTENTS, ...MESSAGE_INTENTS].reduce<number>((acc, i) => acc | i, 0);
  strictEqual(bits, MESSAGE_INTENTS_BITFIELD);
  strictEqual(bits, GatewayIntentBits.Guilds | GatewayIntentBits.GuildMessages | GatewayIntentBits.MessageContent);

  const client = createDiscordClient({ messageContent: true });
  strictEqual(client.options.intents.has(GatewayIntentBits.MessageContent), true);
});

// ---------------------------------------------------------------------------------------
// Command payloads
// ---------------------------------------------------------------------------------------

test('a plain command becomes one chat-input payload with authorization left to us', () => {
  const built = buildCommandPayloads([ping]);
  ok(built.ok);
  const [payload] = built.value;
  ok(payload !== undefined);
  strictEqual(payload.name, 'ping');
  // Discord's own permission gate would be a SECOND authorization answer, silently able to
  // disagree with core_access. The one that lands in an audit row is ours.
  strictEqual(payload.default_member_permissions, null);
  deepStrictEqual(payload.contexts, [InteractionContextType.Guild, InteractionContextType.BotDM]);
});

test('a space in the name is a subcommand, which is the spelling the registry already uses', () => {
  const built = buildCommandPayloads([
    { name: 'tag get', description: 'Show a tag', surface: 'guild', options: [] },
    { name: 'tag set', description: 'Save a tag', surface: 'guild', options: [] },
    { name: 'tag admin reset', description: 'Wipe the tags', surface: 'guild', options: [] },
  ]);
  ok(built.ok);
  strictEqual(built.value.length, 1, 'one top-level command named "tag"');
  const [tag] = built.value;
  ok(tag !== undefined);
  strictEqual(tag.options.length, 3);
  strictEqual(tag.options[0]?.type, ApplicationCommandOptionType.Subcommand);
  const group = tag.options[2];
  strictEqual(group?.type, ApplicationCommandOptionType.SubcommandGroup);
  strictEqual(group.name, 'admin');
  strictEqual(group.options?.[0]?.name, 'reset');
});

test('a command that is both a leaf and a group is refused here, not by a 400 over the whole PUT', () => {
  const built = buildCommandPayloads([
    { name: 'tag', description: 'Tags', surface: 'guild', options: [] },
    { name: 'tag get', description: 'Show a tag', surface: 'guild', options: [] },
  ]);
  ok(!built.ok);
  strictEqual(built.error.kind, 'config');
  ok(built.error.internal?.includes('subcommand group'));
});

test('an option Discord would reject is named before deployment', () => {
  const badName = buildCommandPayloads([
    { name: 'ping', description: 'x', surface: 'guild', options: [{ name: 'Loud', description: 'y', type: 'boolean', required: false }] },
  ]);
  ok(!badName.ok);

  const both = buildCommandPayloads([
    {
      name: 'ping',
      description: 'x',
      surface: 'guild',
      options: [{ name: 'who', description: 'y', type: 'text', required: false, autocomplete: true, choices: ['a'] }],
    },
  ]);
  ok(!both.ok);
  ok(both.error.internal?.includes('choices and autocomplete'));
});

test('option constraints survive into the payload, because they are part of what Discord stores', () => {
  const built = buildCommandPayloads([
    {
      name: 'page',
      description: 'Show a page',
      surface: 'guild',
      options: [{ name: 'n', description: 'Which page', type: 'integer', required: true, minValue: 1, maxValue: 50 }],
    },
  ]);
  ok(built.ok);
  const option = built.value[0]?.options[0];
  strictEqual(option?.min_value, 1);
  strictEqual(option.max_value, 50);
  strictEqual(option.required, true);
});

// ---------------------------------------------------------------------------------------
// The digest that stops a restart loop from burning the deployment budget
// ---------------------------------------------------------------------------------------

test('the digest ignores key order and command order, and notices a real change', () => {
  const a: CommandPayload = {
    name: 'ping',
    description: 'Check',
    type: 1,
    contexts: [0],
    integration_types: [0],
    default_member_permissions: null,
    options: [],
  };
  const reordered: CommandPayload = {
    options: [],
    default_member_permissions: null,
    integration_types: [0],
    contexts: [0],
    type: 1,
    description: 'Check',
    name: 'ping',
  };
  const b: CommandPayload = { ...a, name: 'pong' };
  strictEqual(commandDigest([a]), commandDigest([reordered]));
  strictEqual(commandDigest([a, b]), commandDigest([b, a]));
  ok(commandDigest([a]) !== commandDigest([{ ...a, description: 'Check!' }]));
});

test('a restart does not re-deploy, and a real change does', async () => {
  const rest = recorder();
  const store = memoryCommandSyncStore();
  const io = { put: rest.put, clientId: '42', guildId: null, store, logger: fakeLogger() };

  const first = await deployCommands(io, [ping]);
  ok(first.ok);
  strictEqual(first.value.deployed, true);
  strictEqual(rest.calls.length, 1);
  strictEqual(rest.calls[0]?.route, '/applications/42/commands');

  // The restart.
  const second = await deployCommands(io, [ping]);
  ok(second.ok);
  strictEqual(second.value.deployed, false);
  strictEqual(rest.calls.length, 1, 'a global PUT is rate limited; a restart loop must not spend one');

  const third = await deployCommands(io, [{ ...ping, description: 'Check that the bot is awake' }]);
  ok(third.ok);
  strictEqual(third.value.deployed, true);
  strictEqual(rest.calls.length, 2);
});

test('guild-scoped and global deployments are different routes and different digest keys', async () => {
  const rest = recorder();
  const store = memoryCommandSyncStore();
  const guild = await deployCommands(
    { put: rest.put, clientId: '42', guildId: '99', store, logger: fakeLogger() },
    [ping],
  );
  ok(guild.ok);
  strictEqual(rest.calls[0]?.route, '/applications/42/guilds/99/commands');

  // Switching to global must still deploy: the scopes are remembered separately.
  const global = await deployCommands({ put: rest.put, clientId: '42', guildId: null, store, logger: fakeLogger() }, [ping]);
  ok(global.ok);
  strictEqual(global.value.deployed, true);
  ok(deployScope('42', '99') !== deployScope('42', null));
});

// ---------------------------------------------------------------------------------------
// Upstream failures
// ---------------------------------------------------------------------------------------

test('a discord failure never carries the thrown object into the error', () => {
  // A REST error carries the request options, and therefore the bot token (SC-6).
  const thrown = Object.assign(new Error('401: Unauthorized, token MTIz.abcdef.ghijkl'), { status: 401 });
  const e = discordUpstream(thrown, 'post a message');
  strictEqual(e.kind, 'upstream');
  ok(!JSON.stringify(e).includes('MTIz'));
  strictEqual(e.retryable, false, '401 and 403 are never retried - hammering them risks a ban');

  const rateLimited = discordUpstream(Object.assign(new Error('429'), { status: 429 }), 'edit a message');
  strictEqual(rateLimited.retryable, true);
  ok(rateLimited.nextStep.length > 0);
});

// ---------------------------------------------------------------------------------------
// PATH 2 - the interaction-scoped reply
//
// This is the object the router acknowledges through, and every guarantee in
// `src/adapters/discord/router.ts` about the 3-second deadline is really a guarantee about
// what these five methods do. None of it was driven.
// ---------------------------------------------------------------------------------------

const CHANNEL = '300000000000000003';
const GUILD = '200000000000000002';
const MESSAGE = '400000000000000004';
const CREATED_AT = 1_800_000_000_000;

/** One call Discord received. */
interface Call {
  readonly method: string;
  readonly body: unknown;
}

interface FakeInteraction {
  deferred: boolean;
  replied: boolean;
  readonly calls: readonly Call[];
  readonly createdTimestamp: number;
}

/**
 * A discord.js interaction, modelled from
 * `node_modules/discord.js/src/structures/interfaces/InteractionResponses.js`.
 *
 * The two details that matter and are easy to get wrong in a convenient fake: `deferReply`
 * sets `deferred` only AFTER awaiting the REST POST, and `reply`/`showModal` throw locally the
 * moment `deferred || replied` is true.
 */
function fakeInteraction(kind: 'command' | 'component' | 'modal' = 'command'): FakeInteraction {
  const message = { id: MESSAGE, channelId: CHANNEL, guildId: GUILD };
  const calls: Call[] = [];
  const already = (): Error => new Error('InteractionAlreadyReplied');

  const self = {
    deferred: false,
    replied: false,
    calls,
    createdTimestamp: CREATED_AT,
    isMessageComponent: () => kind === 'component',
    isModalSubmit: () => kind === 'modal',
    message,

    async deferReply(opts: unknown) {
      if (self.deferred || self.replied) throw already();
      calls.push({ method: 'deferReply', body: opts });
      await Promise.resolve();
      self.deferred = true;
      return { resource: { message } };
    },
    async deferUpdate(opts: unknown) {
      if (self.deferred || self.replied) throw already();
      calls.push({ method: 'deferUpdate', body: opts });
      await Promise.resolve();
      self.deferred = true;
      return { resource: { message } };
    },
    async reply(body: unknown) {
      if (self.deferred || self.replied) throw already();
      calls.push({ method: 'reply', body });
      await Promise.resolve();
      self.replied = true;
      return { resource: { message } };
    },
    async editReply(body: unknown) {
      calls.push({ method: 'editReply', body });
      await Promise.resolve();
      return message;
    },
    async deleteReply() {
      calls.push({ method: 'deleteReply', body: null });
      await Promise.resolve();
    },
    async showModal(data: unknown) {
      if (self.deferred || self.replied) throw already();
      calls.push({ method: 'showModal', body: data });
      await Promise.resolve();
      self.replied = true;
    },
  };
  return self;
}

function replyFor(interaction: FakeInteraction, logger = fakeLogger()): ReturnType<typeof interactionScopedReply> {
  return interactionScopedReply(interactionToken(interaction as unknown as RepliableInteraction), logger);
}

const DONE: View = { accent: 'ok', nodes: [{ kind: 'text', md: md`Done.` }] };
const PRIVATE: View = { accent: 'ok', ephemeral: true, nodes: [{ kind: 'text', md: md`Only you.` }] };

test('the short path expires 15 minutes from the CLICK, not from when a handler got round to reading it', () => {
  const reply = replyFor(fakeInteraction());
  // This is the number a module reads off `progress.tokenExpiresAtMs` to decide whether it can
  // still answer. Anchoring it to `createdTimestamp` is what makes it honest after a slow boot.
  strictEqual(reply.expiresAtMs, CREATED_AT + INTERACTION_TOKEN_MS);
  strictEqual(INTERACTION_TOKEN_MS, 15 * 60_000);
});

test('deferring captures the durable card ids a handoff needs, and flips acknowledged()', async () => {
  const interaction = fakeInteraction();
  const reply = replyFor(interaction);

  strictEqual(reply.acknowledged(), false);
  strictEqual(reply.surface(), null, 'there is no message to hand a job until something created one');

  const deferred = await reply.deferReply({ ephemeral: false });
  ok(deferred.ok);
  strictEqual(reply.acknowledged(), true);
  // `withResponse: true` is the whole reason the ids are available now rather than after a
  // second round trip inside the 3-second window.
  deepStrictEqual(interaction.calls[0], { method: 'deferReply', body: { withResponse: true } });
  deepStrictEqual(reply.surface(), { guildId: GUILD, channelId: CHANNEL, messageId: MESSAGE });
  deepStrictEqual(deferred.value, reply.surface());

  const ephemeral = fakeInteraction();
  const quiet = await replyFor(ephemeral).deferReply({ ephemeral: true });
  ok(quiet.ok);
  deepStrictEqual(ephemeral.calls[0]?.body, { withResponse: true, flags: MessageFlags.Ephemeral });
});

test('send replies before the acknowledgement and edits after it, so one call site can never post twice', async () => {
  const fresh = fakeInteraction();
  const first = await replyFor(fresh).send(PRIVATE);
  ok(first.ok);
  strictEqual(fresh.calls[0]?.method, 'reply');
  ok(JSON.stringify(fresh.calls[0]?.body).includes(String(MessageFlags.Ephemeral)), 'ephemeral is decidable only when a reply is CREATED');

  const deferredInteraction = fakeInteraction();
  const reply = replyFor(deferredInteraction);
  await reply.deferReply({ ephemeral: true });
  const second = await reply.send(PRIVATE);
  ok(second.ok);
  strictEqual(deferredInteraction.calls[1]?.method, 'editReply', 'a deferred reply is edited; a second reply is Discord 40060');
  const editBody = JSON.stringify(deferredInteraction.calls[1]?.body);
  ok(!editBody.includes('"flags"'), 'flags may not change on an existing message, so the edit body carries none');

  // And a public view carries no flags at all - `ephemeral` is a property of the VIEW, not a
  // default of the transport.
  const plain = fakeInteraction();
  ok((await replyFor(plain).send(DONE)).ok);
  ok(!JSON.stringify(plain.calls[0]?.body).includes('"flags"'));
});

test('a modal after an acknowledgement is refused with a next step, and the mistake is logged', async () => {
  const customId = staticCustomId('demo', 'brief');
  ok(customId.ok);
  const form = {
    customId: customId.value,
    title: 'Describe it',
    intro: null,
    fields: [{ kind: 'text' as const, name: 'title', label: 'Title', description: null, style: 'short' as const, required: true, maxLength: 100, placeholder: '' }],
  };

  // Discord forbids defer-then-modal. This is the one ack mistake that is 100% reproducible in
  // production and invisible to a unit test that never acknowledges first.
  const logger = fakeRecordingLogger();
  const interaction = fakeInteraction();
  const reply = replyFor(interaction, logger);
  await reply.deferReply({ ephemeral: true });

  const refused = await reply.showForm(form);
  ok(!refused.ok);
  strictEqual(refused.error.kind, 'conflict');
  strictEqual(refused.error.code, 'conflict.defer_then_modal');
  ok(refused.error.nextStep.includes('Run the command again'));
  ok(logger.lines.some((l) => l.level === 'error' && l.fields['customId'] === customId.value));
  deepStrictEqual(interaction.calls.map((c) => c.method), ['deferReply'], 'and no modal was ever attempted');

  // Discord has no "modal from a modal" either, and that refusal names the fix.
  const fromModal = await replyFor(fakeInteraction('modal')).showForm(form);
  ok(!fromModal.ok);
  strictEqual(fromModal.error.kind, 'config');
  ok(fromModal.error.nextStep.includes("ack: 'defer'"));

  // The legal case, for contrast.
  const clean = fakeInteraction();
  const shown = await replyFor(clean).showForm(form);
  ok(shown.ok);
  strictEqual(clean.calls[0]?.method, 'showModal');
});

test('close() removes the "thinking..." message after a defer, and leaves a defer-update alone', async () => {
  // A deferred reply that is never edited reads exactly like the bot hanging, so `silent` has
  // to clean up after itself.
  const deferredInteraction = fakeInteraction();
  const deferredReply = replyFor(deferredInteraction);
  await deferredReply.deferReply({ ephemeral: false });
  ok((await deferredReply.close()).ok);
  deepStrictEqual(deferredInteraction.calls.map((c) => c.method), ['deferReply', 'deleteReply']);

  // A `defer-update` changed nothing on screen and left nothing behind to delete.
  const component = fakeInteraction('component');
  const componentReply = replyFor(component);
  await componentReply.deferUpdate();
  ok((await componentReply.close()).ok);
  deepStrictEqual(component.calls.map((c) => c.method), ['deferUpdate']);

  // Nothing acknowledged at all: something must be said, or the interaction dies at 3 seconds.
  const fresh = fakeInteraction();
  ok((await replyFor(fresh).close()).ok);
  strictEqual(fresh.calls[0]?.method, 'reply');
  ok(JSON.stringify(fresh.calls[0]?.body).includes('Nothing to do'));
});

test('defer-update on something that is not a component click is refused as a misdeclared ack', async () => {
  const refused = await replyFor(fakeInteraction('command')).deferUpdate();
  ok(!refused.ok);
  strictEqual(refused.error.kind, 'config');
  // There is no message for it to update, so the fix is the declaration, not a retry.
  ok(refused.error.nextStep.includes("ack: 'defer'"));
});

test('an autocomplete answer is capped and clipped to what Discord will accept', async () => {
  const sent: unknown[] = [];
  const interaction = {
    async respond(choices: unknown): Promise<void> {
      sent.push(choices);
      await Promise.resolve();
    },
  };
  const choices = Array.from({ length: 40 }, (_, i) => ({ name: `${String(i)} ${'x'.repeat(200)}`, value: 'v'.repeat(200) }));

  const answered = await answerAutocomplete(interaction as unknown as AutocompleteInteraction, choices);
  ok(answered.ok);

  const out = sent[0] as readonly { readonly name: string; readonly value: string }[];
  // Discord rejects the WHOLE response if one choice is over length or there are too many, so
  // a module that suggests generously must not be able to break its own autocomplete.
  strictEqual(out.length, MAX_AUTOCOMPLETE_CHOICES);
  ok(out.every((c) => c.name.length <= 100 && c.value.length <= 100));
});

test('an autocomplete that Discord refuses is a Result, not a throw', async () => {
  const interaction = {
    async respond(): Promise<void> {
      await Promise.resolve();
      throw Object.assign(new Error('Unknown interaction'), { status: 404 });
    },
  };
  // It arrives 3.1 seconds late and the interaction is gone. The router logs it and moves on;
  // an escaping rejection here would take the process down.
  const answered = await answerAutocomplete(interaction as unknown as AutocompleteInteraction, []);
  ok(!answered.ok);
  strictEqual(answered.error.kind, 'upstream');
});
