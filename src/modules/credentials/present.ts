/**
 * Bring-your-own-credentials, part 2: the entry points and what the user sees.
 *
 * EVERY VIEW HERE IS EPHEMERAL, and that is not politeness. A reply that says "your
 * subscription token is stored" is a statement about somebody's billing arrangement, in a
 * channel other people read. There is nothing secret in these views - they carry secret NAMES,
 * never values - but the fact of which credential you use is yours.
 *
 * WHAT IS NOT HERE: any path from a credential to a `View`. A text node takes `SafeMarkdown`,
 * which `#core/text` mints only from source literals or from a scrubber, and there is no
 * scrubber that accepts a `Secret`. So "the credential was rendered into a card" is not a bug
 * that had to be avoided in this file - it is unwritable.
 */

import type { CommandSpec, FormHandlerSpec, Outcome } from '#core/module';
import { md, mdInlineCode } from '#core/text';
import { staticCustomId, type CustomId } from '#core/ids';
import { limit } from '#core/ratelimit';
import type { PermissionRef } from '#core/policy';
import type { FormSpec, View } from '#core/view';
import type { SecretName } from '#core/ports/secrets';
import type { CredentialService, CredentialStatus } from '#modules/credentials/domain';

/** MUST equal the folder name; it is half of every `custom_id` this module mints. */
export const MODULE_ID = 'credentials';

/** The modal-submit handler's name, and the `custom_id` action segment that routes to it. */
export const SET_FORM = 'set';

/** The one field in the modal. `FormHandlerSpec.fields` and the `FormSpec` must agree. */
export const CREDENTIAL_FIELD = 'credential';

/** This module's permission bag, keyed so `perms.mange` is TS2551 with a suggestion. */
export type CredentialPerms = Readonly<Record<'manage', PermissionRef>>;

// ---------------------------------------------------------------------------------------
// The modal
// ---------------------------------------------------------------------------------------

/**
 * The modal's `custom_id`.
 *
 * `staticCustomId` rather than `assertActionRef`: an action ref carries an entity id and a
 * card-generation nonce, and this submission has NEITHER, on purpose. The scope of a
 * submission is the AUTHENTICATED SUBMITTER, read from `sub.actor.userId` - so there is
 * nothing to carry, and carrying a user id here would only tempt a future editor into trusting
 * a value that round-tripped through the client.
 *
 * WHY the throw is acceptable: the encoded id is 22 characters against a 100-character budget,
 * so the `Err` arm is unreachable for these two literals - and a throw during `setup()` is
 * caught by `defineModule`, which quarantines this module and lets the rest of the bot boot.
 */
function setFormCustomId(): CustomId {
  const id = staticCustomId(MODULE_ID, SET_FORM);
  if (!id.ok) throw new Error(id.error.internal ?? id.error.code);
  return id.value;
}

/**
 * THE MODAL, AND WHY IT IS THE WHOLE POINT OF THIS COMMAND.
 *
 * A modal submission arrives as an INTERACTION, not as a message. The credential is therefore
 * never posted to a channel, never appears in anyone's scrollback, is not in the guild's
 * message history, cannot be quoted or pinned, and is not sitting in Discord's copy of the
 * channel waiting for the next person with read-history to scroll past it. A slash-command
 * string option would fail every one of those: the invocation is rendered above the reply, and
 * `/credentials set token:sk-ant-...` would be visible to the channel and preserved by Discord.
 * That difference is the reason this command exists as `ack: 'form'` rather than as an option.
 *
 * `maxLength` is Discord's full paragraph cap ON PURPOSE. A tight cap does not protect anything
 * here - it TRUNCATES, client-side and silently - and a truncated credential still starts with
 * `sk-ant-api…`, so it classifies happily, stores successfully, and fails as a 401 half an hour
 * into a build. Being generous costs nothing; being tight costs the exact failure this feature
 * removes.
 */
export function credentialForm(): FormSpec {
  return {
    customId: setFormCustomId(),
    title: 'Use your own Claude credentials',
    intro: 'Stored encrypted as a GitHub environment secret and used only for builds you request. Nobody can read it back, including you.',
    fields: [
      {
        kind: 'text',
        name: CREDENTIAL_FIELD,
        description: 'An API key from console.anthropic.com, or run claude setup-token for a subscription.',
        // Discord caps a modal label at 45 characters; this is 43.
        label: 'API key or Claude Code OAuth token',
        // `paragraph`, not `short`: these values are ~100 characters and a single-line box
        // shows about a third of one, so a mis-paste is invisible in a `short` field.
        style: 'paragraph',
        required: true,
        maxLength: 4000,
        placeholder: 'sk-ant-api03-… or sk-ant-oat01-…',
      },
    ],
  };
}

// ---------------------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------------------

/** What each secret name MEANS for the person who set it. This is the useful half of a reply. */
function billing(name: SecretName): View['nodes'][number] {
  return name === 'ANTHROPIC_API_KEY'
    ? {
        kind: 'field',
        name: 'Billing',
        md: md`Metered against your Anthropic Console account. Separate from your personal Claude usage.`,
      }
    : {
        kind: 'field',
        name: 'Billing',
        md: md`Drawn from your Claude Pro/Max subscription limits - the same allowance as your own Claude Code usage, so a long build can use up what you have left that day.`,
      };
}

export const present = {
  /**
   * Confirmation after a successful write.
   *
   * It names the SECRET NAME and nothing else, because that is the only fact about the value
   * this process still knows - the credential went straight into a sealed box and is not
   * readable back by anything, including the bot.
   */
  stored: (name: SecretName): View => ({
    accent: 'ok',
    ephemeral: true,
    nodes: [
      { kind: 'heading', text: 'Credential stored', icon: 'ok' },
      { kind: 'field', name: 'Stored as', md: mdInlineCode(name) },
      billing(name),
      {
        kind: 'text',
        md: md`Run ${mdInlineCode('/credentials set')} to replace it or ${mdInlineCode('/credentials clear')} to remove it.`,
      },
    ],
  }),

  /** Which names exist. Never values; there is no way to read one anyway. */
  status: (status: CredentialStatus): View =>
    status.names.length === 0
      ? {
          accent: 'info',
          ephemeral: true,
          nodes: [
            { kind: 'heading', text: 'No credential of your own', icon: 'info' },
            {
              kind: 'text',
              // THE DEFAULT IS THAT THIS BLOCKS YOU, so it is said first and said plainly. With
              // `modules.builder.requireOwnCredentials` on - which is how the bot ships -
              // `/request new` refuses a submission from someone with nothing stored. An operator
              // can switch it off and fund the server themselves, and then this is merely a way
              // to move the bill; but telling every user the optimistic version of a setting
              // they cannot see is how somebody ends up staring at a refusal that the status
              // command said would not happen.
              md: md`Run ${mdInlineCode('/credentials set')} first. On most servers ${mdInlineCode('/request new')} is refused until you do.`,
            },
          ],
        }
      : {
          accent: 'ok',
          ephemeral: true,
          nodes: [
            { kind: 'heading', text: 'Your build credentials', icon: 'ok' },
            // Each credential's name sits next to its billing. When both are set the build uses
            // the OAuth token, so the API key is marked unused and gets no billing line.
            ...status.names.flatMap((name): View['nodes'] => {
              const unused = status.names.length > 1 && name === 'ANTHROPIC_API_KEY';
              return unused
                ? [{ kind: 'field', name: 'Stored as', md: md`${mdInlineCode(name)} (unused)` }]
                : [{ kind: 'field', name: 'Stored as', md: mdInlineCode(name) }, billing(name)];
            }),
            {
              kind: 'text',
              md:
                status.names.length > 1
                  ? md`Both are set. The build uses the OAuth token, so the API key is unused. ${mdInlineCode('/credentials clear')} removes both.`
                  : md`Values are never shown: the bot stores them write-only and cannot read them back.`,
            },
          ],
        },

  /** After `/credentials clear`. The two arms read differently on purpose. */
  cleared: (existed: boolean): View => ({
    accent: existed ? 'ok' : 'info',
    ephemeral: true,
    nodes: [
      existed
        ? {
            kind: 'text',
            // A WARNING, not a receipt. Clearing is the one action here that can take the
            // flagship command away from the person who ran it, and they will not find that out
            // until the next time they try to use it. Saying so costs one sentence.
            md: md`Removed. ${mdInlineCode('/request new')} and any approved-but-unstarted request will fail until you run ${mdInlineCode('/credentials set')} again.`,
          }
        : { kind: 'text', md: md`You had no credential stored, so there was nothing to remove.` },
    ],
  }),
};

// ---------------------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------------------

/**
 * WHY `needs: []` ON ALL THREE, when the flagship writes `needs: ['SendMessages']`: every reply
 * here is an EPHEMERAL INTERACTION RESPONSE, which Discord delivers over the interaction token
 * and not as a channel message, so it needs no channel permission at all. Declaring
 * `SendMessages` would be a preflight that refuses to run in a channel where the command would
 * in fact have worked — locking a user out of managing their own billing because the bot cannot
 * chat in the room they happen to be standing in.
 *
 * WHY `surface: 'both'`: a DM is the natural place to hand over a credential, and there is
 * nothing guild-scoped in any of these operations — the scope is the user.
 */
export function credentialCommands(svc: CredentialService, perms: CredentialPerms): readonly CommandSpec[] {
  return [
    {
      name: 'credentials set',
      description: 'Bill your builds to your own Claude subscription or API key',
      surface: 'both',
      options: [],
      permission: perms.manage,
      // Opening a modal spends nothing, so this bucket only exists to stop a loop. The bucket
      // that matters is on the SUBMIT handler below, which talks to the GitHub API.
      limit: [limit.perUser(10, 60_000)],
      needs: [],
      // MUST be 'form', and this handler MUST NOT await before returning: Discord forbids
      // defer-then-modal, so a single await here is a 100% reproducible production failure that
      // no unit test would ever see.
      ack: 'form',
      async handle(): Promise<Outcome> {
        return { kind: 'form', form: credentialForm() };
      },
    },
    {
      name: 'credentials status',
      description: 'Show which of your own build credentials are stored',
      surface: 'both',
      options: [],
      permission: perms.manage,
      limit: [limit.perUser(10, 60_000)],
      needs: [],
      ack: 'defer-ephemeral',
      async handle(inv): Promise<Outcome> {
        const status = await svc.status(inv.actor.userId);
        return status.ok ? { kind: 'view', view: present.status(status.value) } : { kind: 'fail', error: status.error };
      },
    },
    {
      name: 'credentials clear',
      description: 'Remove your own build credentials',
      surface: 'both',
      options: [],
      permission: perms.manage,
      limit: [limit.perUser(10, 60_000)],
      needs: [],
      ack: 'defer-ephemeral',
      async handle(inv): Promise<Outcome> {
        const removed = await svc.clear(inv.actor.userId, inv.space.guildId);
        return removed.ok ? { kind: 'view', view: present.cleared(removed.value) } : { kind: 'fail', error: removed.error };
      },
    },
  ];
}

// ---------------------------------------------------------------------------------------
// The modal comes back
// ---------------------------------------------------------------------------------------

export function credentialForms(svc: CredentialService, perms: CredentialPerms): readonly FormHandlerSpec[] {
  return [
    {
      name: SET_FORM,
      permission: perms.manage,
      // This one writes to the GitHub API, so it carries the real bucket. Deliberately tighter
      // than the command that opens the modal.
      limit: [limit.perUser(5, 3_600_000)],
      needs: [],
      // EPHEMERAL. The reply names a secret name and a billing arrangement; neither belongs in
      // a channel other people read.
      ack: 'defer-ephemeral',
      idempotency: {
        kind: 'naturally-idempotent',
        why: 'A submission fully replaces one named secret in the SUBMITTER’S OWN store. There is no counter, no queue and no spend, so a double submit writes the same bytes twice and the second write is indistinguishable from the first. Nonce-and-CAS would be ceremony over a value with no prior state to race.',
      },
      fields: [CREDENTIAL_FIELD],
      async handle(sub): Promise<Outcome> {
        // `sub.actor.userId` — NOT `sub.ref.entityId`. The custom_id round-tripped through the
        // client; the actor did not.
        const stored = await svc.set(
          sub.actor.userId,
          sub.space.guildId,
          sub.fields.textRequired(CREDENTIAL_FIELD),
        );
        return stored.ok ? { kind: 'view', view: present.stored(stored.value) } : { kind: 'fail', error: stored.error };
      },
    },
  ];
}
