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

import type { AutocompleteChoice, AutocompleteRequest, CommandOption, CommandSpec, FormHandlerSpec, Outcome } from '#core/module';
import { md, mdInlineCode, sanitizeStored, type SafeMarkdown } from '#core/text';
import { encodeActionRef, newCardNonce, type CustomId } from '#core/ids';
import type { AppError } from '#core/errors';
import { Ok, type Result } from '#core/result';
import { limit } from '#core/ratelimit';
import type { PermissionRef } from '#core/policy';
import type { FormSpec, View, ViewNode } from '#core/view';
import type { SecretName } from '#core/ports/secrets';
import {
  labelOf,
  type ClearReport,
  type CredentialService,
  type CredentialStatus,
  type CredentialTarget,
  type RepoClearRow,
  type RepoLabel,
  type RepoStatusRow,
  type StatusReport,
} from '#modules/credentials/domain';

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
 * The entity segment of a modal opened before RFC-001 PR 2.3, which carried no repository
 * (`staticCustomId`). Such a submission is resolved as if no repository had been named.
 */
export const NO_REPO_SEGMENT = '-';

/**
 * The modal's `custom_id`: this module, the `set` handler, and the KEY of the repository the
 * modal names (RFC-001 PR 2.3). The nonce is filler the codec requires; nothing compares it.
 *
 * WHY THE REPOSITORY RIDES IN THE `custom_id`: the modal tells the user where the credential
 * goes, so the submission must go THERE - not wherever a fresh resolution points by the time
 * they press Submit. The key round-trips through the client, so it is NEVER trusted: the handler
 * re-validates it against the configured set, and in a server requires it to still be the
 * server's repository (`CredentialService.submitTarget`). A user who edits it can only name a
 * repository they could have chosen with `repo:` in a DM anyway.
 *
 * WHAT IS STILL NOT CARRIED: the user. The scope of a submission is the AUTHENTICATED
 * SUBMITTER, read from `sub.actor.userId`, and carrying a user id here would only tempt a future
 * editor into trusting a value that round-tripped through the client.
 */
function setFormCustomId(repoKey: string): Result<CustomId, AppError> {
  return encodeActionRef({ moduleId: MODULE_ID, action: SET_FORM, entityId: repoKey, nonce: newCardNonce() });
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
 *
 * THE INTRO IS THE HONESTY LINE (RFC-001 5.2, PR 1.7). It used to say "Nobody can read it back,
 * including you", which is true of the GitHub API and false of the people who matter: anyone who
 * administers the repository this bot builds in can add a workflow step that uses or prints an
 * environment secret. Handing a key to this bot is trusting whoever runs it, exactly like handing
 * a deploy key to someone's CI, so the modal says that, and says what limits the damage.
 *
 * AND IT NAMES THE REPOSITORY (RFC-001 8.1, PR 2.3). With several repositories, "this bot's
 * repository" no longer says which admins the honesty line is about, so the sentence before it
 * - `credentialDestination` - names `owner/repo`.
 */
export const CREDENTIAL_TRUST_LINE =
  'It is stored encrypted as a GitHub environment secret. Whoever runs this bot, and any admin of that repository, can use it, so prefer a spend-limited key.';

/** Where the credential goes, in the words RFC-001 8.1 gives the modal. Configuration only. */
export function credentialDestination(target: CredentialTarget): string {
  const where = labelOf(target.repo).fullName;
  return target.inServer
    ? `This stores your credential in ${where}, run by this server's bot operator, who can use it for your builds here.`
    : `This stores your credential in ${where}, for builds you request in any server that builds there.`;
}

export function credentialForm(target: CredentialTarget): Result<FormSpec, AppError> {
  const customId = setFormCustomId(target.repo.key);
  if (!customId.ok) return customId;
  return Ok({
    customId: customId.value,
    title: 'Use your own Claude credentials',
    intro: `${credentialDestination(target)} ${CREDENTIAL_TRUST_LINE}`,
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
  });
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

/** `main (acme/bot-modules)`: how a repository is named in a field label. Configuration only. */
function repoName(repo: RepoLabel): string {
  return `${repo.key} (${repo.fullName})`;
}

/**
 * The "which repository" field, on a bot with several (RFC-001 PR 2.3). `null` - a one-repository
 * install - adds nothing, so those views are exactly what they were.
 */
function repoField(repo: RepoLabel | null): readonly ViewNode[] {
  return repo === null ? [] : [{ kind: 'field', name: 'Repository', md: mdInlineCode(repoName(repo)) }];
}

/** The names stored in one repository, on one line. The API key is unused when both are set. */
function namesLine(names: readonly SecretName[]): SafeMarkdown {
  if (names.length === 0) return md`nothing stored`;
  const parts = names.map((name) => (names.length > 1 && name === 'ANTHROPIC_API_KEY' ? md`${mdInlineCode(name)} (unused)` : mdInlineCode(name)));
  return parts.reduce((acc, p) => md`${acc}, ${p}`);
}

/** The warning `clear` owes the person who just removed a working credential. */
const CLEARED_WARNING = md`${mdInlineCode('/request new')} and any approved-but-unstarted request will fail until you run ${mdInlineCode('/credentials set')} again.`;

export const present = {
  /**
   * Confirmation after a successful write.
   *
   * It names the SECRET NAME and nothing else, because that is the only fact about the value
   * this process still knows - the credential went straight into a sealed box and is not
   * readable back by anything, including the bot. On a bot with several repositories it also
   * names WHERE it went (RFC-001 8.1: "each confirmation names where it went").
   */
  stored: (name: SecretName, repo: RepoLabel | null): View => ({
    accent: 'ok',
    ephemeral: true,
    nodes: [
      { kind: 'heading', text: 'Credential stored', icon: 'ok' },
      { kind: 'field', name: 'Stored as', md: mdInlineCode(name) },
      ...repoField(repo),
      billing(name),
      {
        kind: 'text',
        md: md`Run ${mdInlineCode('/credentials set')} to replace it or ${mdInlineCode('/credentials clear')} to remove it.`,
      },
    ],
  }),

  /** Which names exist. Never values; there is no way to read one anyway. */
  status: (status: CredentialStatus, repo: RepoLabel | null): View =>
    status.names.length === 0
      ? {
          accent: 'info',
          ephemeral: true,
          nodes: [
            { kind: 'heading', text: 'No credential of your own', icon: 'info' },
            ...repoField(repo),
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
            ...repoField(repo),
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

  /**
   * A DM `/credentials status` on a bot with several repositories: one row per repository,
   * `<key> (owner/repo): CLAUDE_CODE_OAUTH_TOKEN` or `nothing stored` (RFC-001 8.1). Names only.
   */
  statusEach: (rows: readonly RepoStatusRow[]): View => {
    const anyStored = rows.some((r) => r.names !== null && r.names.length > 0);
    const anyProblem = rows.some((r) => r.problem !== null);
    return {
      accent: anyProblem ? 'warn' : anyStored ? 'ok' : 'info',
      ephemeral: true,
      nodes: [
        { kind: 'heading', text: 'Your build credentials, per repository', icon: anyProblem ? 'warn' : anyStored ? 'ok' : 'info' },
        ...rows.map((r): ViewNode => ({
          kind: 'field',
          name: repoName(r.repo),
          md: r.names !== null ? namesLine(r.names) : md`could not be checked: ${sanitizeStored(r.problem ?? '')}`,
        })),
        {
          kind: 'text',
          md: md`A credential is kept per repository, and a build uses the one in the repository it runs in. Run ${mdInlineCode('/credentials set')} in a server to store one for that server's builds. Values are never shown.`,
        },
      ],
    };
  },

  /**
   * After `/credentials clear`. The two arms read differently on purpose. `repo` names the
   * repository on a bot with several; null leaves the one-repository view as it was.
   */
  cleared: (existed: boolean, repo: RepoLabel | null): View => ({
    accent: existed ? 'ok' : 'info',
    ephemeral: true,
    nodes: [
      ...repoField(repo),
      existed
        ? {
            kind: 'text',
            // A WARNING, not a receipt. Clearing is the one action here that can take the
            // flagship command away from the person who ran it, and they will not find that out
            // until the next time they try to use it. Saying so costs one sentence.
            md: md`Removed. ${CLEARED_WARNING}`,
          }
        : { kind: 'text', md: md`You had no credential stored, so there was nothing to remove.` },
    ],
  }),

  /**
   * After `/credentials clear everywhere:True` (or a DM) on a bot with several repositories: one
   * row per repository, keeping the removed / nothing-there distinction per repository.
   */
  clearedEach: (rows: readonly RepoClearRow[]): View => {
    const anyRemoved = rows.some((r) => r.existed === true);
    const anyProblem = rows.some((r) => r.problem !== null);
    return {
      accent: anyProblem ? 'warn' : anyRemoved ? 'ok' : 'info',
      ephemeral: true,
      nodes: [
        { kind: 'heading', text: 'Cleared in every repository', icon: anyProblem ? 'warn' : anyRemoved ? 'ok' : 'info' },
        ...rows.map((r): ViewNode => ({
          kind: 'field',
          name: repoName(r.repo),
          md:
            r.existed === true
              ? md`removed`
              : r.existed === false
                ? md`nothing stored`
                : md`could not be cleared: ${sanitizeStored(r.problem ?? '')}`,
        })),
        {
          kind: 'text',
          md: anyRemoved ? md`${CLEARED_WARNING}` : md`You had no credential stored in any repository that could be checked.`,
        },
      ],
    };
  },

  /** `status`, by the shape the service answered with. */
  statusReport: (report: StatusReport): View =>
    report.kind === 'one' ? present.status(report.status, report.repo) : present.statusEach(report.rows),

  /** `clear`, by the shape the service answered with. */
  clearReport: (report: ClearReport): View =>
    report.kind === 'one' ? present.cleared(report.existed, report.repo) : present.clearedEach(report.rows),
};

// ---------------------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------------------

/**
 * `repo:` on `/credentials set` (RFC-001 8.1). Discord cannot make an option required in a DM
 * only, so it is optional here and the service refuses a DM without it when there is more than
 * one repository. In a server it may only name the server's own repository.
 *
 * `maxLength: 31` is the repository key's own limit, and it is also why this option cannot carry
 * a credential by mistake: every Anthropic credential is longer, so Discord refuses the paste.
 */
export const REPO_OPTION: CommandOption = {
  name: 'repo',
  description: 'Which repository, in a direct message when the bot has several (a server uses its own)',
  type: 'text',
  required: false,
  // A suggestion list, never the check: the service re-validates against the configured set.
  autocomplete: true,
  minLength: 1,
  maxLength: 31,
};

/** `everywhere:` on `/credentials clear` (RFC-001 8.1). Implied in a DM. */
export const EVERYWHERE_OPTION: CommandOption = {
  name: 'everywhere',
  description: "Remove it from every repository this bot uses, not just this server's",
  type: 'boolean',
  required: false,
};

/**
 * WHY `needs: []` ON ALL THREE, when the flagship writes `needs: ['SendMessages']`: every reply
 * here is an EPHEMERAL INTERACTION RESPONSE, which Discord delivers over the interaction token
 * and not as a channel message, so it needs no channel permission at all. Declaring
 * `SendMessages` would be a preflight that refuses to run in a channel where the command would
 * in fact have worked — locking a user out of managing their own billing because the bot cannot
 * chat in the room they happen to be standing in.
 *
 * WHY `surface: 'both'`: a DM is the natural place to hand over a credential. Since RFC-001 PR
 * 2.3 WHERE you run it matters: in a server it acts on that server's repository, in a DM on the
 * repository you name (`set`) or on every one (`status`, `clear`).
 */
export function credentialCommands(svc: CredentialService, perms: CredentialPerms): readonly CommandSpec[] {
  /** REQUIRED because `repo` sets `autocomplete: true`. Keys only - see `CredentialService.suggest`. */
  async function suggestRepo(req: AutocompleteRequest): Promise<readonly AutocompleteChoice[]> {
    return svc.suggest(req.partial);
  }

  return [
    {
      name: 'credentials set',
      description: 'Bill your builds to your own Claude subscription or API key',
      surface: 'both',
      options: [REPO_OPTION],
      permission: perms.manage,
      // Opening a modal spends nothing, so this bucket only exists to stop a loop. The bucket
      // that matters is on the SUBMIT handler below, which talks to the GitHub API.
      limit: [limit.perUser(10, 60_000)],
      needs: [],
      // MUST be 'form', and this handler MUST NOT await before returning: Discord forbids
      // defer-then-modal, so a single await here is a 100% reproducible production failure that
      // no unit test would ever see. Resolving the repository is synchronous for that reason.
      ack: 'form',
      async handle(inv): Promise<Outcome> {
        const target = svc.openTarget(inv.space.guildId, inv.args.text(REPO_OPTION.name));
        if (!target.ok) return { kind: 'fail', error: target.error };
        const form = credentialForm(target.value);
        return form.ok ? { kind: 'form', form: form.value } : { kind: 'fail', error: form.error };
      },
      autocomplete: suggestRepo,
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
        const status = await svc.status(inv.actor.userId, inv.space.guildId);
        return status.ok ? { kind: 'view', view: present.statusReport(status.value) } : { kind: 'fail', error: status.error };
      },
    },
    {
      name: 'credentials clear',
      description: 'Remove your own build credentials',
      surface: 'both',
      options: [EVERYWHERE_OPTION],
      permission: perms.manage,
      limit: [limit.perUser(10, 60_000)],
      needs: [],
      ack: 'defer-ephemeral',
      async handle(inv): Promise<Outcome> {
        const everywhere = inv.args.bool(EVERYWHERE_OPTION.name) ?? false;
        const removed = await svc.clear(inv.actor.userId, inv.space.guildId, everywhere);
        return removed.ok ? { kind: 'view', view: present.clearReport(removed.value) } : { kind: 'fail', error: removed.error };
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
        why: 'A submission fully replaces one named secret in the SUBMITTER’S OWN store, in the one repository the modal named. There is no counter, no queue and no spend, so a double submit writes the same bytes twice and the second write is indistinguishable from the first. Nonce-and-CAS would be ceremony over a value with no prior state to race.',
      },
      fields: [CREDENTIAL_FIELD],
      async handle(sub): Promise<Outcome> {
        // WHICH REPOSITORY: the one the modal named, re-validated - see `setFormCustomId`.
        const carried = sub.ref.entityId === NO_REPO_SEGMENT ? null : sub.ref.entityId;
        const target = svc.submitTarget(sub.space.guildId, carried);
        if (!target.ok) return { kind: 'fail', error: target.error };
        // `sub.actor.userId` — NOT anything from the custom_id. The custom_id round-tripped
        // through the client; the actor did not.
        const stored = await svc.set(
          sub.actor.userId,
          sub.space.guildId,
          target.value,
          sub.fields.textRequired(CREDENTIAL_FIELD),
        );
        return stored.ok
          ? { kind: 'view', view: present.stored(stored.value.name, stored.value.repo) }
          : { kind: 'fail', error: stored.error };
      },
    },
  ];
}
