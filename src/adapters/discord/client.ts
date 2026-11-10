/**
 * The Discord adapter: the gateway client, the real `DiscordPort`, and - the reason this file
 * is worth reading - THE TWO DELIVERY PATHS, side by side, so nobody can confuse them.
 *
 *   channelScopedDelivery(...)   a fresh REST call keyed on a PERSISTED channelId/messageId.
 *                               Valid forever. This is what a durable job uses at minute 22.
 *   interactionScopedReply(...)  the interaction webhook. Valid ~15 MINUTES from the click.
 *                               It CONSUMES an `InteractionToken`, whose payload sits behind a
 *                               module-private symbol.
 *
 * THE 15-MINUTE RULE, MADE STRUCTURAL. A Claude Code build takes 5-30 minutes; an interaction
 * token dies at ~15. So "the PR opened" must not go through the interaction webhook. Two
 * things make that unwritable rather than discouraged:
 *
 *   - `DiscordPort` (what a module or a job holds) has no reply method at all, and every write
 *     on it takes a `SurfaceRef`, which is plain JSON recovered from the job payload.
 *   - `interactionScopedReply` takes an `InteractionToken`. That type's only field is keyed by
 *     a `unique symbol` that is not exported, so it cannot be forged by an object literal, and
 *     it carries a live discord.js object, so it is not `JsonObject` and cannot be put in a
 *     `JobRequest` payload. A job context simply has no value of that type in scope.
 *
 * The failure this prevents passes every test with a fast build and fails silently in
 * production on a slow one, which is exactly why it is a type and not a code review comment.
 */

import { createHash } from 'node:crypto';
import {
  ApplicationCommandOptionType,
  ApplicationCommandType,
  ApplicationIntegrationType,
  Client,
  GatewayIntentBits,
  InteractionContextType,
  MessageFlags,
  Routes,
  type AutocompleteInteraction,
  type Message,
  type RepliableInteraction,
} from 'discord.js';
import { z } from 'zod';
import { Err, Ok, type Result } from '#core/result';
import { errors, type AppError } from '#core/errors';
import type { Secret } from '#core/config';
import { md, renderPlainName, type PlainName } from '#core/text';
import { toChannelId, toRoleId, type ChannelId, type GuildId, type RoleId, type UserId } from '#core/ids';
import { missingPermissions, type DiscordPermission } from '#core/permissions';
import type { ClockPort, DiscordPort, LoggerPort } from '#core/ports';
import type { AutocompleteChoice, CommandOption, CommandSpec, CommandSurface } from '#core/command';
import { MAX_AUTOCOMPLETE_CHOICES } from '#core/command';
import type { FormSpec, SurfaceRef, View } from '#core/view';
import {
  disableComponentsJson,
  renderForm,
  renderView,
  toEditBody,
  toReplyBody,
  toRestBody,
  type RenderedMessage,
} from '#adapters/discord/render';

// ---------------------------------------------------------------------------------------
// The client
// ---------------------------------------------------------------------------------------

/**
 * WHAT THE BOT ACTUALLY NEEDS, AND WHY IT IS SO LITTLE NOW.
 *
 * `Guilds` alone. The product's entry point is `/request`, a slash command, and application
 * commands and modal submissions arrive as INTERACTIONS - which are delivered regardless of
 * message intents. So the default install needs NO privileged intent at all.
 *
 * That was not a tidy-up. `MessageContent` is privileged, and it was the single most common
 * setup failure: without it the bot connects happily, `message.content` arrives EMPTY, and the
 * flagship command silently does nothing while every health indicator says fine. It also meant
 * the bot received the content of EVERY message in every channel it could see - a real privacy
 * and attack surface for a bot that forwards text into a GitHub issue and then into an AI.
 *
 * A module MAY still declare a `HookSpec` (a `$prefix` message hook). That needs the privileged
 * intents, so it is opt-in through `DISCORD_MESSAGE_CONTENT=true`, and main.ts REFUSES TO START
 * if a module declares a hook while the flag is off. Loud beats silently-dead - that is the
 * whole reason the default moved.
 */
export const BASE_INTENTS = [GatewayIntentBits.Guilds] as const;

/** Added only when a module declares a message hook and the operator opted in. */
export const MESSAGE_INTENTS = [GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] as const;

/** Interactions only. The integer is spelled out so a change to the list is a visible diff. */
export const BASE_INTENTS_BITFIELD = 1;
/** Guilds | GuildMessages | MessageContent, for the opt-in path. */
export const MESSAGE_INTENTS_BITFIELD = 33_281;

/**
 * WHY no `partials`: partials exist so events fire for objects that are not in cache -
 * uncached reactions, DM channels, uncached message updates. This bot routes interactions by
 * decoding `custom_id`, so every object it touches arrives complete. Enabling partials would
 * only mean handling `null` fields that never occur.
 */
export function createDiscordClient(opts: { readonly messageContent: boolean } = { messageContent: false }): Client {
  const intents = opts.messageContent ? [...BASE_INTENTS, ...MESSAGE_INTENTS] : [...BASE_INTENTS];
  return new Client({ intents });
}

/** WHY it returns `Result`: a bad token is a config failure `main` exits on, not an exception
 *  thrown out of an async boot step that leaves half a bot running. */
export async function login(client: Client, token: Secret): Promise<Result<void, AppError>> {
  try {
    // The single greppable unwrap of a credential (SC-6). One grep audits every use.
    await client.login(token.reveal());
    return Ok(undefined);
  } catch (cause: unknown) {
    return Err(
      errors.config(
        'DISCORD_TOKEN',
        `login failed: ${cause instanceof Error ? cause.name : 'unknown'}`,
        'Check DISCORD_TOKEN, and that the bot has not been regenerated in the Developer Portal.',
      ),
    );
  }
}

/** Bounded, idempotent shutdown. WHY it exists: `client.destroy()` closes the websocket and
 *  clears the REST queue; without it a SIGTERM leaves the gateway session hanging until it
 *  times out server side, and the next boot races the old session's presence. */
export async function shutdownClient(client: Client, logger: LoggerPort): Promise<void> {
  try {
    await client.destroy();
    logger.info('discord client destroyed');
  } catch (cause: unknown) {
    logger.warn('discord client did not shut down cleanly', { cause: cause instanceof Error ? cause.name : 'unknown' });
  }
}

// ---------------------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------------------

const STATUS_HINT: Readonly<Record<number, string>> = {
  403: 'Ask an admin to allow the bot to post in that channel.',
  404: 'The message or channel is gone. Nothing more to do.',
};

/** WHY `Reflect.get` and not a cast: reading one property off an unknown thrown value should
 *  not require asserting a shape the value may not have. */
function readProp(value: unknown, key: string): unknown {
  if (typeof value !== 'object' || value === null) return undefined;
  const read: unknown = Reflect.get(value, key);
  return read;
}

function statusOf(cause: unknown): number {
  const status = readProp(cause, 'status');
  return typeof status === 'number' ? status : 0;
}

/**
 * Turn a thrown discord.js error into an `AppError`.
 * WHY `cause` is never interpolated: a REST error carries the request options, and therefore
 * the bot token (SC-6). Only its shape - name and status - reaches the operator log.
 */
export function discordUpstream(cause: unknown, action: string): AppError {
  const status = statusOf(cause);
  if (status === 429) {
    return errors.rateLimited('discord', 60_000, 'Try again in a minute.', 'Discord is rate-limiting the bot.');
  }
  return errors.upstream(
    'discord',
    status,
    STATUS_HINT[status] ?? 'Try again in a moment.',
    `${action}: ${cause instanceof Error ? cause.name : 'unknown'} (status ${status})`,
  );
}

// ---------------------------------------------------------------------------------------
// PATH 1 - CHANNEL-SCOPED. Keyed on persisted ids, valid at any age. Jobs use ONLY this.
// ---------------------------------------------------------------------------------------

const MessageRefShape = z.object({
  id: z.string(),
  channel_id: z.string(),
  guild_id: z.string().nullish(),
});

const ThreadShape = z.object({ id: z.string() });
const MemberShape = z.object({ roles: z.array(z.string()) });

/** WHY a floor between edits of ONE message: a 15-second poller that also reacts to gateway
 *  events can produce a burst, and provoked 429s count toward Discord's
 *  10,000-invalid-requests-per-10-minutes Cloudflare ban threshold (SC-14). */
export const MIN_EDIT_INTERVAL_MS = 1_000;

/** Threads opened on a build card archive after a day of silence. */
const THREAD_AUTO_ARCHIVE_MINUTES = 1_440;

/** What the channel-scoped path needs. Deliberately tiny: a client and a clock. */
export interface ChannelDeliveryIO {
  readonly client: Client;
  readonly clock: ClockPort;
  readonly logger: LoggerPort;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * The real `DiscordPort`.
 *
 * READ THE ABSENCE, again: no `reply`, no `followUp`, no method that accepts an interaction or
 * a token. Everything here is a fresh REST call against ids we persisted, which is the only
 * thing that still works 30 minutes into a build.
 */
export function channelScopedDelivery(io: ChannelDeliveryIO): DiscordPort {
  const { client, clock, logger } = io;
  /** Serialises edits per message, so two pollers cannot interleave PATCHes on one card. */
  const chain = new Map<string, Promise<unknown>>();
  /** The newest edit wins; superseded ones are dropped rather than sent (SC-14 coalescing). */
  const latest = new Map<string, number>();
  const lastEditAt = new Map<string, number>();
  let seq = 0;

  function guildOf(channelId: string, fromApi: string | null | undefined): string | null {
    if (typeof fromApi === 'string') return fromApi;
    // REST message objects omit `guild_id`; the channel cache (Guilds intent) has it, and a
    // `SurfaceRef` without a guild leaves a poll job unable to write a guild-scoped audit row.
    const cached = client.channels.cache.get(channelId);
    return cached !== undefined && 'guildId' in cached && typeof cached.guildId === 'string' ? cached.guildId : null;
  }

  async function patch(ref: SurfaceRef, rendered: RenderedMessage): Promise<Result<SurfaceRef, AppError>> {
    try {
      await client.rest.patch(Routes.channelMessage(ref.channelId, ref.messageId), { body: toRestBody(rendered) });
      lastEditAt.set(`${ref.channelId}/${ref.messageId}`, clock.now());
      return Ok(ref);
    } catch (cause: unknown) {
      return Err(discordUpstream(cause, 'edit a message'));
    }
  }

  return {
    async post(channelId, view) {
      const rendered = renderView(view);
      if (!rendered.ok) return rendered;
      try {
        const data: unknown = await client.rest.post(Routes.channelMessages(channelId), {
          body: toRestBody(rendered.value),
        });
        const parsed = MessageRefShape.safeParse(data);
        if (!parsed.success) {
          return Err(errors.upstream('discord', 0, 'Try again.', 'message create returned an unexpected shape'));
        }
        return Ok({
          guildId: guildOf(parsed.data.channel_id, parsed.data.guild_id),
          channelId: parsed.data.channel_id,
          messageId: parsed.data.id,
        });
      } catch (cause: unknown) {
        return Err(discordUpstream(cause, 'post a message'));
      }
    },

    async edit(ref, view) {
      const rendered = renderView(view);
      if (!rendered.ok) return rendered;

      const key = `${ref.channelId}/${ref.messageId}`;
      seq += 1;
      const mine = seq;
      latest.set(key, mine);
      const previous = chain.get(key);

      const run = (async (): Promise<Result<SurfaceRef, AppError>> => {
        if (previous !== undefined) await previous.catch(() => undefined);
        const since = clock.now() - (lastEditAt.get(key) ?? 0);
        if (since < MIN_EDIT_INTERVAL_MS) await sleep(MIN_EDIT_INTERVAL_MS - since);
        // Coalesce: if a newer edit for this card arrived while we waited, it will write the
        // final state, so sending this one would only spend a request to be overwritten.
        if (latest.get(key) !== mine) return Ok(ref);
        return patch(ref, rendered.value);
      })();

      chain.set(key, run);
      const out = await run;
      if (chain.get(key) === run) {
        chain.delete(key);
        latest.delete(key);
      }
      return out;
    },

    async disableComponents(ref) {
      try {
        const current: unknown = await client.rest.get(Routes.channelMessage(ref.channelId, ref.messageId));
        await client.rest.patch(Routes.channelMessage(ref.channelId, ref.messageId), {
          body: { components: disableComponentsJson(readProp(current, 'components')) },
        });
        return Ok(undefined);
      } catch (cause: unknown) {
        return Err(discordUpstream(cause, 'disable components'));
      }
    },

    async delete(ref) {
      try {
        await client.rest.delete(Routes.channelMessage(ref.channelId, ref.messageId));
        return Ok(undefined);
      } catch (cause: unknown) {
        // 10008 Unknown Message: it is already gone, which is the outcome we wanted.
        if (readProp(cause, 'code') === 10008) return Ok(undefined);
        return Err(discordUpstream(cause, 'delete a message'));
      }
    },

    async openThread(ref, name: PlainName) {
      try {
        const data: unknown = await client.rest.post(Routes.threads(ref.channelId, ref.messageId), {
          body: { name: renderPlainName(name), auto_archive_duration: THREAD_AUTO_ARCHIVE_MINUTES },
        });
        const parsed = ThreadShape.safeParse(data);
        if (!parsed.success) {
          return Err(errors.upstream('discord', 0, 'Try again.', 'thread create returned an unexpected shape'));
        }
        return toChannelId(parsed.data.id);
      } catch (cause: unknown) {
        return Err(discordUpstream(cause, 'open a thread'));
      }
    },

    missingFromAppPermissions(appPermissions: bigint, needs: readonly DiscordPermission[]) {
      // Zero API calls, always fresh, and NO Administrator expansion - `PermissionsBitField
      // #missing()` is banned in this repo for exactly that reason (SC-7).
      return missingPermissions(appPermissions, needs);
    },

    async botPermissionsIn(channelId: ChannelId) {
      try {
        const channel = await client.channels.fetch(channelId);
        if (channel === null || channel.isDMBased() || !('guild' in channel)) {
          return Err(errors.notFound('channel', 'Post the card in a normal server channel.'));
        }
        const me = channel.guild.members.me ?? (await channel.guild.members.fetchMe());
        const perms = channel.permissionsFor(me);
        if (perms === null) {
          return Err(errors.notFound('channel', 'Check that the bot can still see that channel.'));
        }
        return Ok(perms.bitfield);
      } catch (cause: unknown) {
        return Err(discordUpstream(cause, 'resolve bot permissions'));
      }
    },

    async memberRoles(guildId: GuildId, userId: UserId) {
      try {
        const data: unknown = await client.rest.get(Routes.guildMember(guildId, userId));
        const parsed = MemberShape.safeParse(data);
        if (!parsed.success) {
          return Err(errors.upstream('discord', 0, 'Try again.', 'guild member returned an unexpected shape'));
        }
        const roles: RoleId[] = [];
        for (const raw of parsed.data.roles) {
          const role = toRoleId(raw);
          if (role.ok) roles.push(role.value);
          else logger.warn('guild member carried a role id that is not a snowflake');
        }
        return Ok(roles);
      } catch (cause: unknown) {
        return Err(discordUpstream(cause, 'read member roles'));
      }
    },
  };
}

// ---------------------------------------------------------------------------------------
// PATH 2 - INTERACTION-SCOPED. Valid ~15 minutes. The router owns it; a job cannot hold one.
// ---------------------------------------------------------------------------------------

/**
 * THE WALL. Not exported, so no file outside this one can write this key, and therefore no
 * file outside this one can produce an `InteractionToken`. `interactionScopedReply` takes one,
 * so the short path is reachable only from code that was handed a live interaction.
 */
const TOKEN = Symbol('adapters.discord.interactionToken');

/** Discord's documented interaction token lifetime. */
export const INTERACTION_TOKEN_MS = 15 * 60_000;

/**
 * A live, token-bound reply channel.
 *
 * It carries a discord.js object behind a private symbol, so it is not assignable to
 * `JsonObject` and cannot be smuggled into a `JobRequest` payload, a doc-store value, an audit
 * `detail` or a log field - the same trick `ProgressHandle` uses in core, for the same reason.
 */
export interface InteractionToken {
  readonly [TOKEN]: RepliableInteraction;
  /** Absolute ms at which this token dies. Read it; do not race it. */
  readonly expiresAtMs: number;
}

/** Mint a token. Router-only by construction: it takes a live interaction. */
export function interactionToken(interaction: RepliableInteraction): InteractionToken {
  return { [TOKEN]: interaction, expiresAtMs: interaction.createdTimestamp + INTERACTION_TOKEN_MS };
}

/** What the interaction-scoped path can do. Every method dies with the token. */
export interface InteractionScopedReply {
  /** Absolute ms at which this path stops working. */
  readonly expiresAtMs: number;
  /** Whether Discord has been acknowledged yet - the 3-second contract. */
  acknowledged(): boolean;
  /** The message the acknowledgement created, once we know it. Null until then. */
  surface(): SurfaceRef | null;
  /** "Thinking..." - public or ephemeral. Captures the message id, so a handoff has a card. */
  deferReply(opts: { readonly ephemeral: boolean }): Promise<Result<SurfaceRef | null, AppError>>;
  /** Acknowledge a component click that will edit the message it lives on. */
  deferUpdate(): Promise<Result<SurfaceRef | null, AppError>>;
  /** Reply, or edit the deferred reply - whichever is legal at this point. */
  send(view: View): Promise<Result<SurfaceRef | null, AppError>>;
  /** Open a modal. Illegal after any acknowledgement: Discord forbids defer-then-modal. */
  showForm(form: FormSpec): Promise<Result<void, AppError>>;
  /**
   * Acknowledged, nothing to say - `Outcome.kind === 'silent'`.
   * WHY it is not a no-op: a deferred reply that is never edited leaves "Bot is thinking..."
   * on screen forever, which reads exactly like the bot hanging.
   */
  close(): Promise<Result<void, AppError>>;
}

/** What a `silent` outcome shows when there is no deferred reply to delete. */
const NOTHING_TO_DO: View = { accent: 'info', ephemeral: true, nodes: [{ kind: 'text', md: md`Nothing to do.` }] };

/**
 * The short path. CONSUMES an `InteractionToken` - that parameter is the whole design.
 *
 * WHY it captures a `SurfaceRef` at acknowledgement time: `deferReply({ withResponse: true })`
 * answers with the message it created, which is the durable handle a handoff needs. Getting it
 * later would mean `fetchReply` (deprecated) or a second round trip during the 3-second
 * window.
 */
export function interactionScopedReply(token: InteractionToken, logger: LoggerPort): InteractionScopedReply {
  const interaction = token[TOKEN];
  let captured: SurfaceRef | null = null;
  /** How this interaction was acknowledged, which decides what `close` may do. */
  let ackedWith: 'none' | 'reply' | 'update' = 'none';

  /**
   * AN ACKNOWLEDGEMENT THIS OBJECT HAS ISSUED BUT DISCORD HAS NOT YET CONFIRMED.
   *
   * THE BUG THIS FIELD EXISTS TO CLOSE, which was live and user-visible. discord.js sets
   * `interaction.deferred` only AFTER its REST POST resolves (see `async deferReply` in
   * `node_modules/discord.js/src/structures/interfaces/InteractionResponses.js`). So for one
   * round trip - fifty to a few hundred milliseconds - the interaction IS acknowledged at
   * Discord and still reads as unacknowledged locally.
   *
   * That window is not hypothetical, because there is a caller that lives inside it. The
   * router's ACK WATCHDOG fires at 2.5s for a handler that declared `ack: 'instant'` and is
   * overrunning, and it does not await its own defer. A handler finishing during that round
   * trip - i.e. one taking roughly 2.5 to 2.8 seconds, which is precisely the mis-declaration
   * the watchdog exists to rescue - then reached `send`, saw `deferred === false`, and called
   * `interaction.reply()`. Discord refuses that with 40060 "already acknowledged"; the failure
   * was logged and swallowed; and THE USER WAS LEFT LOOKING AT "Bot is thinking..." with
   * nothing that would ever edit it. The same race runs the other way: with the handler's own
   * `reply()` in flight at 2.5s, `acknowledged()` was false and the watchdog deferred on top.
   *
   * FIXING IT HERE RATHER THAN IN THE WATCHDOG closes the window for every caller at once, and
   * puts the knowledge in the object that actually holds it: only this file can see that an
   * acknowledgement has been sent and not yet confirmed. `acknowledged()` now reports it, and
   * every method that must not double-acknowledge waits for it to settle first.
   */
  let ackInFlight: Promise<unknown> | null = null;

  /**
   * Wait for an acknowledgement this object already issued, if any.
   *
   * IT SWALLOWS THE REJECTION ON PURPOSE. Whoever issued the acknowledgement is already
   * returning an `Err` for it; re-throwing here would turn one reported failure into an
   * unhandled rejection inside an unrelated method. What this guarantees is only that
   * `interaction.deferred` / `.replied` have stopped moving before they are read.
   */
  const settleAck = async (): Promise<void> => {
    const pending = ackInFlight;
    if (pending === null) return;
    try {
      await pending;
    } catch {
      // Reported by the issuer. See above.
    }
  };

  /** Run `attempt` as THE acknowledgement, so a concurrent caller can see it in flight. */
  const asAck = async <T,>(attempt: Promise<T>): Promise<T> => {
    ackInFlight = attempt;
    try {
      return await attempt;
    } finally {
      ackInFlight = null;
    }
  };

  const capture = (message: Message | null | undefined): SurfaceRef | null => {
    if (message === null || message === undefined) return captured;
    captured = { guildId: message.guildId, channelId: message.channelId, messageId: message.id };
    return captured;
  };

  return {
    expiresAtMs: token.expiresAtMs,

    acknowledged(): boolean {
      // `ackInFlight` FIRST, and it is the whole point: an acknowledgement that has been sent
      // and not yet confirmed is an acknowledgement. Reading only discord.js's flags is what
      // let the router's watchdog defer on top of a reply already on its way.
      return ackInFlight !== null || interaction.deferred || interaction.replied;
    },

    surface(): SurfaceRef | null {
      return captured;
    },

    async deferReply(opts) {
      await settleAck();
      // Idempotent rather than an error: the watchdog and the handler can both decide to defer,
      // and the second to arrive should find the job done rather than raise 40060.
      if (interaction.deferred || interaction.replied) return Ok(captured);
      try {
        const response = await asAck(
          interaction.deferReply(
            opts.ephemeral ? { withResponse: true, flags: MessageFlags.Ephemeral } : { withResponse: true },
          ),
        );
        ackedWith = 'reply';
        return Ok(capture(response.resource?.message));
      } catch (cause: unknown) {
        return Err(discordUpstream(cause, 'defer a reply'));
      }
    },

    async deferUpdate() {
      if (!interaction.isMessageComponent()) {
        return Err(
          errors.config(
            'ack',
            'defer-update was used on an interaction that is not a component click',
            "Declare ack: 'defer' on that handler.",
          ),
        );
      }
      await settleAck();
      if (interaction.deferred || interaction.replied) return Ok(captured);
      try {
        const response = await asAck(interaction.deferUpdate({ withResponse: true }));
        ackedWith = 'update';
        // The card being updated is the message the component lives on.
        return Ok(capture(response.resource?.message ?? interaction.message));
      } catch (cause: unknown) {
        return Err(discordUpstream(cause, 'defer an update'));
      }
    },

    async send(view) {
      const rendered = renderView(view);
      if (!rendered.ok) return rendered;
      // THE READ BELOW HAS TO BE STABLE. Deciding "reply or edit" against a flag that is still
      // moving is how an answer became a 40060 and a user was left with a permanent
      // "Bot is thinking...".
      await settleAck();
      try {
        if (interaction.deferred || interaction.replied) {
          // `flags` may not change on an existing message, so the edit body carries none.
          const message = await interaction.editReply(toEditBody(rendered.value));
          return Ok(capture(message));
        }
        // Issued AS the acknowledgement, so a watchdog reading `acknowledged()` while this is
        // in flight sees it and does not defer on top of it.
        const response = await asAck(
          interaction.reply({
            ...toReplyBody(rendered.value),
            withResponse: true,
          }),
        );
        ackedWith = 'reply';
        return Ok(capture(response.resource?.message));
      } catch (cause: unknown) {
        return Err(discordUpstream(cause, 'send an interaction reply'));
      }
    },

    async close() {
      await settleAck();
      try {
        // A `defer-update` acknowledgement changed nothing on screen and left nothing behind.
        if (ackedWith === 'update') return Ok(undefined);
        if (ackedWith === 'reply') {
          // Remove the "thinking..." message rather than leaving it up forever.
          await interaction.deleteReply();
          return Ok(undefined);
        }
        if (interaction.isMessageComponent()) {
          await interaction.deferUpdate();
          ackedWith = 'update';
          return Ok(undefined);
        }
        const rendered = renderView(NOTHING_TO_DO);
        if (!rendered.ok) return rendered;
        await interaction.reply(toReplyBody(rendered.value));
        ackedWith = 'reply';
        return Ok(undefined);
      } catch (cause: unknown) {
        return Err(discordUpstream(cause, 'close an interaction'));
      }
    },

    async showForm(form) {
      // Settle first, or a modal can be attempted against a defer still on the wire - which
      // Discord refuses, and which is the one ack mistake with no recovery.
      await settleAck();
      if (interaction.deferred || interaction.replied) {
        // Discord rejects a modal on an acknowledged interaction. This is the one ack mistake
        // that is 100% reproducible in production and invisible to every unit test.
        logger.error('a form handler acknowledged before returning its modal', { customId: form.customId });
        return Err(
          errors.conflict(
            'defer_then_modal',
            'That form could not be opened.',
            'Run the command again.',
            'acknowledged',
          ),
        );
      }
      if (interaction.isModalSubmit()) {
        // Discord has no "modal from a modal": the submit is the end of that conversation.
        return Err(
          errors.config(
            'ack',
            'a modal submit handler tried to open another modal',
            "Declare ack: 'defer' on that form handler and reply with a view instead.",
          ),
        );
      }
      const modal = renderForm(form);
      if (!modal.ok) return modal;
      try {
        await interaction.showModal(modal.value);
        return Ok(undefined);
      } catch (cause: unknown) {
        return Err(discordUpstream(cause, 'show a modal'));
      }
    },
  };
}

/**
 * Answer an autocomplete.
 * WHY it is not on `InteractionScopedReply`: an autocomplete interaction is not repliable at
 * all - there is no defer, no edit, no follow-up, and exactly one 3-second shot.
 */
export async function answerAutocomplete(
  interaction: AutocompleteInteraction,
  choices: readonly AutocompleteChoice[],
): Promise<Result<void, AppError>> {
  try {
    await interaction.respond(
      choices.slice(0, MAX_AUTOCOMPLETE_CHOICES).map((c) => ({ name: c.name.slice(0, 100), value: c.value.slice(0, 100) })),
    );
    return Ok(undefined);
  } catch (cause: unknown) {
    return Err(discordUpstream(cause, 'answer an autocomplete'));
  }
}

// ---------------------------------------------------------------------------------------
// Slash command deployment
// ---------------------------------------------------------------------------------------

/** One option, as Discord stores it. Snake case: this is the wire, and it is what we hash. */
export interface CommandOptionPayload {
  readonly type: number;
  readonly name: string;
  readonly description: string;
  readonly required?: boolean;
  readonly autocomplete?: boolean;
  readonly choices?: readonly { readonly name: string; readonly value: string }[];
  readonly min_value?: number;
  readonly max_value?: number;
  readonly min_length?: number;
  readonly max_length?: number;
  readonly channel_types?: readonly number[];
  readonly options?: readonly CommandOptionPayload[];
}

/** One application command, as Discord stores it. */
export interface CommandPayload {
  readonly name: string;
  readonly description: string;
  readonly type: number;
  readonly contexts: readonly number[];
  readonly integration_types: readonly number[];
  /**
   * WHY always `null`: Discord's own gate is a SECOND authorization answer that can silently
   * disagree with `core_access`, and the one that shows up in an audit row is ours (SC-7).
   */
  readonly default_member_permissions: null;
  readonly options: readonly CommandOptionPayload[];
}

const NAME_RE = /^[a-z0-9_-]{1,32}$/u;
const DESCRIPTION_MAX = 100;

const OPTION_TYPE: Readonly<Record<CommandOption['type'], number>> = {
  text: ApplicationCommandOptionType.String,
  integer: ApplicationCommandOptionType.Integer,
  number: ApplicationCommandOptionType.Number,
  boolean: ApplicationCommandOptionType.Boolean,
  user: ApplicationCommandOptionType.User,
  role: ApplicationCommandOptionType.Role,
  channel: ApplicationCommandOptionType.Channel,
};

function contextsFor(surface: CommandSurface): readonly number[] {
  switch (surface) {
    case 'guild':
      return [InteractionContextType.Guild];
    case 'dm':
      return [InteractionContextType.BotDM];
    case 'both':
      return [InteractionContextType.Guild, InteractionContextType.BotDM];
    default: {
      const exhaustive: never = surface;
      void exhaustive;
      return [InteractionContextType.Guild];
    }
  }
}

function deployError(name: string, detail: string): AppError {
  return errors.config(
    `command.${name}`,
    detail,
    'Fix the CommandSpec in the module that declares it; Discord refuses the whole PUT otherwise.',
  );
}

function optionPayload(commandName: string, o: CommandOption): Result<CommandOptionPayload, AppError> {
  if (!NAME_RE.test(o.name)) {
    return Err(deployError(commandName, `option "${o.name}" must match ${String(NAME_RE)}`));
  }
  if (o.description.length === 0 || o.description.length > DESCRIPTION_MAX) {
    return Err(deployError(commandName, `option "${o.name}" needs a description of 1..${DESCRIPTION_MAX} characters`));
  }
  if (o.autocomplete === true && o.choices !== undefined) {
    // Discord rejects the pair, and the failure is a 400 over the whole deployment.
    return Err(deployError(commandName, `option "${o.name}" declares both choices and autocomplete`));
  }
  return Ok({
    type: OPTION_TYPE[o.type],
    name: o.name,
    description: o.description,
    required: o.required,
    ...(o.autocomplete === undefined ? {} : { autocomplete: o.autocomplete }),
    ...(o.choices === undefined ? {} : { choices: o.choices.map((c) => ({ name: c, value: c })) }),
    ...(o.minValue === undefined ? {} : { min_value: o.minValue }),
    ...(o.maxValue === undefined ? {} : { max_value: o.maxValue }),
    ...(o.minLength === undefined ? {} : { min_length: o.minLength }),
    ...(o.maxLength === undefined ? {} : { max_length: o.maxLength }),
    ...(o.channelTypes === undefined ? {} : { channel_types: o.channelTypes }),
  });
}

/** The subset of a `CommandSpec` that Discord actually stores. Structural, so tests need no
 *  handler and the registry can hand its specs straight in. */
export type DeployableCommand = Pick<CommandSpec, 'name' | 'description' | 'surface' | 'options'>;

/**
 * Compile every declared command into the payload Discord stores.
 *
 * WHY subcommands are derived from a SPACE in the name (`tag get`): that is what
 * `CommandSpec.name` means everywhere else in the repo - the registry keys on it and `/help`
 * prints it - so deriving the nesting here keeps one spelling of a command name in the system.
 */
export function buildCommandPayloads(commands: readonly DeployableCommand[]): Result<readonly CommandPayload[], AppError> {
  const byParent = new Map<string, { payload: CommandPayload; children: CommandOptionPayload[]; leaf: boolean }>();
  const order: string[] = [];

  for (const spec of commands) {
    const parts = spec.name.split(' ').filter((p) => p.length > 0);
    const [parent, second, third] = parts;
    if (parent === undefined || parts.length > 3) {
      return Err(deployError(spec.name, 'a command name is 1..3 space-separated words'));
    }
    for (const part of parts) {
      if (!NAME_RE.test(part)) return Err(deployError(spec.name, `"${part}" must match ${String(NAME_RE)}`));
    }
    if (spec.description.length === 0 || spec.description.length > DESCRIPTION_MAX) {
      return Err(deployError(spec.name, `description must be 1..${DESCRIPTION_MAX} characters`));
    }

    const options: CommandOptionPayload[] = [];
    for (const o of spec.options) {
      const built = optionPayload(spec.name, o);
      if (!built.ok) return built;
      options.push(built.value);
    }

    let entry = byParent.get(parent);
    if (entry === undefined) {
      entry = {
        payload: {
          name: parent,
          description: parts.length === 1 ? spec.description : parent,
          type: ApplicationCommandType.ChatInput,
          contexts: contextsFor(spec.surface),
          integration_types: [ApplicationIntegrationType.GuildInstall],
          default_member_permissions: null,
          options: [],
        },
        children: [],
        leaf: parts.length === 1,
      };
      byParent.set(parent, entry);
      order.push(parent);
    } else if (parts.length === 1 || entry.leaf) {
      // Discord forbids a command that is both a leaf and a subcommand container.
      return Err(deployError(spec.name, `"${parent}" is declared both as a command and as a subcommand group`));
    }

    if (parts.length === 1) {
      entry.children.push(...options);
      continue;
    }
    if (second === undefined) return Err(deployError(spec.name, 'a subcommand needs a name'));

    const sub: CommandOptionPayload = {
      type: ApplicationCommandOptionType.Subcommand,
      name: third ?? second,
      description: spec.description,
      options,
    };
    if (third === undefined) {
      entry.children.push(sub);
      continue;
    }
    const at = entry.children.findIndex(
      (c) => c.name === second && c.type === ApplicationCommandOptionType.SubcommandGroup,
    );
    const group = at === -1 ? undefined : entry.children[at];
    if (group === undefined) {
      entry.children.push({
        type: ApplicationCommandOptionType.SubcommandGroup,
        name: second,
        description: second,
        options: [sub],
      });
    } else {
      entry.children[at] = { ...group, options: [...(group.options ?? []), sub] };
    }
  }

  return Ok(
    order.map((name) => {
      const entry = byParent.get(name);
      /* c8 ignore next */
      if (entry === undefined) throw new Error('buildCommandPayloads: lost a parent; this is a bug');
      return { ...entry.payload, options: entry.children };
    }),
  );
}

/** WHY a canonical form: `JSON.stringify` preserves insertion order, so two payloads that
 *  differ only in key order would hash differently and re-`PUT` on every restart. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (typeof value === 'object' && value !== null) {
    const entries: [string, unknown][] = Object.entries(value);
    const kept = entries.filter(([, v]) => v !== undefined).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return Object.fromEntries(kept.map(([k, v]) => [k, canonical(v)]));
  }
  return value;
}

/**
 * The digest that decides whether to deploy.
 *
 * WHY at all: a global `PUT` is rate limited to a handful per day, and a restart loop that
 * re-registers every boot burns that budget and can leave the command list empty for minutes.
 */
export function commandDigest(payloads: readonly CommandPayload[]): string {
  const sorted = [...payloads].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return createHash('sha256').update(JSON.stringify(canonical(sorted))).digest('hex');
}

/** Where the last deployed digest is remembered across restarts (`core_command_sync`). */
export interface CommandSyncStore {
  read(scope: string): string | undefined;
  write(scope: string, digest: string): void;
}

/** WHY it exists: `npm run dev:offline` and the tests must not need a database to deploy. */
export function memoryCommandSyncStore(): CommandSyncStore {
  const map = new Map<string, string>();
  return { read: (scope) => map.get(scope), write: (scope, digest) => void map.set(scope, digest) };
}

/** What a deployment did, so the boot log can say "unchanged" instead of nothing. */
export interface DeployReport {
  readonly scope: string;
  readonly commands: number;
  readonly digest: string;
  readonly deployed: boolean;
}

/** The store key. Includes the application id, so two bots sharing a database do not collide. */
export function deployScope(clientId: string, guildId: string | null): string {
  return guildId === null ? `global:${clientId}` : `guild:${clientId}:${guildId}`;
}

/**
 * What a deployment needs.
 * WHY `put` is a function and not the `Client`: the deployment decision - build, hash, compare,
 * maybe PUT - is the part that can be wrong, and it should be testable without a gateway
 * connection. `restPut(client)` is the one-liner that supplies the real one.
 */
export interface CommandDeployIO {
  put(route: `/${string}`, body: unknown): Promise<void>;
  readonly clientId: string;
  /** A development guild deploys instantly; `null` deploys globally. */
  readonly guildId: string | null;
  readonly store: CommandSyncStore;
  readonly logger: LoggerPort;
}

/** The real transport. */
export function restPut(client: Client): (route: `/${string}`, body: unknown) => Promise<void> {
  return async (route, body) => {
    await client.rest.put(route, { body });
  };
}

/**
 * Deploy the command list, and only when it changed.
 *
 * GUILD-SCOPED vs GLOBAL: a guild deployment is visible immediately, which is what a
 * development guild is for; a global deployment propagates over up to an hour. So dev passes a
 * guild id and production does not, and the digest is stored per scope so switching between
 * them does not skip a needed deployment.
 */
export async function deployCommands(
  io: CommandDeployIO,
  commands: readonly DeployableCommand[],
): Promise<Result<DeployReport, AppError>> {
  const payloads = buildCommandPayloads(commands);
  if (!payloads.ok) return payloads;

  const scope = deployScope(io.clientId, io.guildId);
  const digest = commandDigest(payloads.value);
  if (io.store.read(scope) === digest) {
    io.logger.info('slash commands unchanged; not re-deploying', { scope, commands: payloads.value.length });
    return Ok({ scope, commands: payloads.value.length, digest, deployed: false });
  }

  const route =
    io.guildId === null
      ? Routes.applicationCommands(io.clientId)
      : Routes.applicationGuildCommands(io.clientId, io.guildId);

  try {
    await io.put(route, payloads.value);
    io.store.write(scope, digest);
    io.logger.info('slash commands deployed', { scope, commands: payloads.value.length });
    return Ok({ scope, commands: payloads.value.length, digest, deployed: true });
  } catch (cause: unknown) {
    return Err(discordUpstream(cause, 'deploy slash commands'));
  }
}
