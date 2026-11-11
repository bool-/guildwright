/**
 * BRING YOUR OWN CREDENTIALS - the whole wiring, in one object literal.
 *
 * A build costs money, and the bill follows the person who asked for it. Every requester stores
 * their own Anthropic API key or Claude Code OAuth token here, and their builds are billed to
 * them. THAT INCLUDES THE OPERATOR: `modules.builder.requireOwnCredentials` defaults to true and
 * has no owner bypass, so whoever runs the bot uses this module too.
 *
 * SO THIS IS NOT AN ENHANCEMENT - IT IS A PREREQUISITE. `/request new` refuses a submission from
 * anyone with nothing stored here, before it files an issue or posts a card, and refuses again
 * at dispatch in case the credential vanished in between. An operator who wants to fund a
 * private server themselves sets `modules.builder.requireOwnCredentials=false`, and then the
 * shared `ai-agent` environment pays and this module goes back to being a way to move the bill.
 *
 * WHAT THAT MEANS FOR THE VIEWS IN present.ts: this module CANNOT see the builder's config -
 * modules never import each other and no port exposes it - so every sentence it writes has to be
 * true under both settings. They lead with the default, because a user staring at a refusal is
 * badly served by the optimistic half of a setting they cannot inspect.
 *
 * THE PROPERTY THE WHOLE DESIGN IS BUILT AROUND: THE BOT STORES NEITHER.
 *
 * A credential goes modal -> `Secret` -> port -> sealed box -> GitHub, and this process keeps
 * it for the duration of one API call. GitHub's secrets API is write-only, so there is no read
 * path to add later and nothing in the database to leak, exfiltrate, back up by accident, or
 * hand to the next person who gets a shell on the box. Read the capability line below: there is
 * NO `db`. This module persists nothing, which is why it needs no migrations, no table, no
 * repo and no reconciler.
 *
 * WHERE THE PIECES LIVE:
 *   domain.ts   the logic, and the long comment about how a credential reaches the port
 *               unmodified while never reaching a log, an audit row, an error or a view
 *   present.ts  the three commands, the modal, the modal-submit handler, and the views
 *   this file   the manifest
 *
 * ONE THING AN OPERATOR SHOULD KNOW: the shipped `ai-agent` environment holds only
 * `APPROVAL_HMAC_KEY` - neither `ANTHROPIC_API_KEY` nor `CLAUDE_CODE_OAUTH_TOKEN` is set on it,
 * and with the gate on it is never read for a user request anyway. There is no configuration in
 * which a fresh install builds anything before somebody has run `/credentials set`.
 */

import { z } from 'zod';
import { defineModule } from '#core/module';
import { CredentialService } from '#modules/credentials/domain';
import { credentialCommands, credentialForms, present } from '#modules/credentials/present';

/** Repositories for the boot previews only: rendered, never contacted. */
const MAIN = { key: 'main', fullName: 'acme/bot-modules' } as const;
const EVENTS = { key: 'events', fullName: 'acme/events-modules' } as const;

export default defineModule({
  id: 'credentials', // MUST equal the folder name

  summary: 'Store the Claude login or API key that pays for your builds.',

  /**
   * THE BLAST RADIUS, in one reviewable line - and the ABSENCES are the interesting part.
   *
   * No `db`: nothing is persisted, because the credential must not be. No `builds` and no
   * `issues`: this module cannot spend anything or write to the repository; it only decides
   * WHOSE account a later build draws on. No `discord`: every reply is an interaction response
   * the router delivers, so there is no way for this module to post into a channel - which is
   * what makes "the confirmation leaked into chat" unwritable rather than merely avoided.
   *
   * `secrets` is its own capability rather than a corner of `builds` precisely because it moves
   * the spend onto somebody else's account. That deserves its own word here.
   *
   * `repos` (RFC-001 PR 2.1): `secrets` is now one port PER CONFIGURED REPOSITORY, and `repos`
   * is the read-only list that says which one. It grants no write anywhere: it is how this
   * module learns WHICH repository's environment a credential goes into - since PR 2.3, the
   * server's own repository (its `/repo use` link, else the default), or in a DM the one named
   * with `repo:`.
   */
  capabilities: ['secrets', 'audit', 'repos'],

  /**
   * Nothing to configure, and that is a decision rather than an omission. The two credential
   * shapes are Anthropic's, the two secret names are the build workflow's, and where a secret
   * is stored is the adapter's business. A knob on any of those would be a knob that lets an
   * operator break the contract with the workflow.
   */
  config: z.object({}),

  permissions: {
    /**
     * `everyone`, and deliberately so. Every operation in this module acts on the CALLER's own
     * store and moves cost ONTO the caller. Gating it behind a grant would mean a user has to
     * ask permission to pay for their own builds, while the ungranted default leaves the
     * operator paying - exactly backwards. The thing that spends the operator's money is
     * `builder.approve`, whose fallback is `nobody`.
     */
    manage: { summary: 'Manage your own build credentials', fallback: 'everyone' },
  },

  /** Nothing to announce. A credential changing hands is not another module's business. */
  publishes: {},

  /** No tables. See the header: storing a credential is the thing this module refuses to do. */
  migrations: false,

  setup(ctx) {
    // WHICH REPOSITORY'S ENVIRONMENTS (RFC-001 PR 2.3): decided per command by the service - a
    // server's own repository, a DM's `repo:` choice, or every one for `status`/`clear` in a DM.
    // For a one-repository install that is always the one repository, exactly as before.
    // The closure IS the dependency injection - no container, no registration call.
    const svc = new CredentialService(ctx.ports.repos, ctx.ports.secrets, ctx.ports.audit);

    return {
      commands: credentialCommands(svc, ctx.perms),
      forms: credentialForms(svc, ctx.perms),

      /**
       * Rendered through the real component compiler at BOOT, so a card that Discord would
       * reject fails the deploy instead of failing in front of a user.
       */
      previews: {
        stored: present.stored('CLAUDE_CODE_OAUTH_TOKEN', null),
        storedApiKey: present.stored('ANTHROPIC_API_KEY', null),
        storedInRepo: present.stored('CLAUDE_CODE_OAUTH_TOKEN', EVENTS),
        statusEmpty: present.status({ names: [] }, null),
        statusBoth: present.status({ names: ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN'] }, null),
        statusInRepo: present.status({ names: ['CLAUDE_CODE_OAUTH_TOKEN'] }, EVENTS),
        statusEach: present.statusEach([
          { repo: MAIN, names: ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN'], problem: null },
          { repo: EVENTS, names: [], problem: null },
          { repo: { key: 'ops', fullName: 'acme/ops-modules' }, names: null, problem: 'GitHub is not answering. Try again in a minute.' },
        ]),
        cleared: present.cleared(true, null),
        nothingToClear: present.cleared(false, null),
        clearedInRepo: present.cleared(true, EVENTS),
        clearedEach: present.clearedEach([
          { repo: MAIN, existed: true, problem: null },
          { repo: EVENTS, existed: false, problem: null },
          { repo: { key: 'ops', fullName: 'acme/ops-modules' }, existed: null, problem: 'GitHub is not answering. Try again in a minute.' },
        ]),
      },

      /**
       * WHY THIS IS `ok` WITHOUT A PROBE: the honest health check would be a GitHub API call,
       * and `/status` runs every module's check on demand. Spending a GitHub rate-limit token
       * per `/status` to learn something the next real write would tell us anyway is a bad
       * trade - and a health check that consumes the same quota as the feature can take the
       * feature down by itself.
       */
      async health() {
        // NOT `down` WITHOUT A DEFAULT REPOSITORY (it was, before PR 2.3): a server linked with
        // `/repo use` stores into its own repository, and a DM names one with `repo:`.
        const n = svc.keys().length;
        return { status: 'ok', detail: n > 1 ? `ready for ${n} repositories; nothing is stored locally` : 'ready; nothing is stored locally' };
      },
    };
  },
});
