/**
 * `/repo`, part 1: the logic. No Discord, no SQL, no clock, no network.
 *
 * WHAT THIS MODULE IS FOR (RFC-001 PR 2.2, section 7.2): one bot instance may serve guilds that
 * build into different GitHub repositories. Which repository a guild's requests land in is
 * runtime state - `repo.target` in `core_settings` - and this module is its only writer. The
 * builder never reads the setting itself: it asks `ReposPort.resolve`, which the composition
 * root built over the same setting, and it persists the answer on each request row, so a link
 * changed here moves NEW requests and never an existing one.
 *
 * THE KEY CROSSES THE BOUNDARY AS TEXT, AND IS NEVER TRUSTED. `/repo use key:` autocompletes from
 * `ReposPort.all()`, but Discord lets a client submit a value that was never offered (SC-11), so
 * the value is re-validated with `toEnum` against the configured keys and then turned into a ref
 * by `byKey`. A module cannot assemble a `RepoRef` - the brand is core's - so there is no path by
 * which a typed string reaches the setting without naming a configured repository.
 */

import { Err, Ok, type Result } from '#core/result';
import { errors, type AppError } from '#core/errors';
import { toEnum, toMarkdown, type UserText } from '#core/text';
import { MAX_AUTOCOMPLETE_CHOICES, type AutocompleteChoice } from '#core/module';
import type { GuildId, UserId } from '#core/ids';
import {
  REPO_TARGET_SETTING,
  readRepoTarget,
  repoFullName,
  repoTargetValue,
  type Audit,
  type GuildRepoTarget,
  type RepoRef,
  type ReposPort,
  type SettingsPort,
} from '#core/ports';

/** Discord's cap on an autocomplete choice's `name`. */
const CHOICE_NAME_MAX = 100;

/** RFC-001 7.2, verbatim: the refusal of a key outside the configured set. */
export const UNKNOWN_REPO_DETAIL = 'That is not a repository this bot is configured for.';
export const UNKNOWN_REPO_NEXT_STEP = 'An operator adds it to GITHUB_REPOS_JSON.';

/** A configured repository, as a sentence needs it: plain strings, so a preview needs no ref. */
export interface RepoLabel {
  readonly key: string;
  readonly fullName: string;
  readonly isDefault: boolean;
}

export function labelOf(repo: RepoRef): RepoLabel {
  return { key: repo.key, fullName: repoFullName(repo), isDefault: repo.isDefault };
}

/** What `/repo use` did. `changed: false` is "already linked there": routine, not an error. */
export interface UseOutcome {
  readonly repo: RepoLabel;
  readonly from: string | null;
  readonly changed: boolean;
}

/** What `/repo clear` did. `fallback` is where the guild's new requests land now, if anywhere. */
export interface ClearOutcome {
  readonly from: string | null;
  readonly changed: boolean;
  readonly fallback: RepoLabel | null;
}

/** One installed module's line about the guild's repository. */
export interface ActivityLine {
  readonly moduleId: string;
  readonly inFlight: number;
  readonly detail: string;
}

/** Everything `/repo show` renders. */
export interface RepoOverview {
  /** How the guild's repository is decided right now (`ReposPort.target`), as labels. */
  readonly target:
    | { readonly kind: 'mapped' | 'default'; readonly repo: RepoLabel }
    | { readonly kind: 'stale'; readonly key: string }
    | { readonly kind: 'none' };
  /** Each reporting module's view of THAT repository: in flight there, its health and caps. */
  readonly activity: readonly ActivityLine[];
  /** This guild's own requests still in flight, in any repository. */
  readonly guildInFlight: number;
  /** The configured keys, default first. Keys only: other repositories' names are not this guild's business. */
  readonly configured: readonly { readonly key: string; readonly isDefault: boolean }[];
}

function labelTarget(t: GuildRepoTarget): RepoOverview['target'] {
  switch (t.kind) {
    case 'mapped':
    case 'default':
      return { kind: t.kind, repo: labelOf(t.repo) };
    case 'stale':
      return { kind: 'stale', key: t.key };
    case 'none':
      return { kind: 'none' };
    default: {
      const exhaustive: never = t;
      void exhaustive;
      return { kind: 'none' };
    }
  }
}

export class RepoRoutingService {
  private readonly repos: ReposPort;
  private readonly settings: SettingsPort;
  private readonly audit: Audit;

  constructor(repos: ReposPort, settings: SettingsPort, audit: Audit) {
    // Assigned explicitly: `erasableSyntaxOnly` rejects parameter properties (TS1294).
    this.repos = repos;
    this.settings = settings;
    this.audit = audit;
  }

  /** The configured keys, in configuration order. The allow-list for SC-11. */
  keys(): readonly string[] {
    return this.repos.all().map((r) => r.key);
  }

  /**
   * Autocomplete answers: KEYS ONLY, never `owner/repo`.
   *
   * WHY: the router answers an autocomplete WITHOUT checking the command's permission, so whoever
   * can open `/repo use` sees these. A key is a label the operator chose; the name of every
   * private repository the operator runs is not something a member of one server needs to learn.
   */
  suggest(partial: UserText): readonly AutocompleteChoice[] {
    const q = toMarkdown(partial, { maxLength: CHOICE_NAME_MAX }).text.trim().toLowerCase();
    const out: AutocompleteChoice[] = [];
    for (const r of this.repos.all()) {
      if (out.length >= MAX_AUTOCOMPLETE_CHOICES) break;
      if (q.length > 0 && !r.key.includes(q)) continue;
      out.push({ name: r.isDefault ? `${r.key} (default)` : r.key, value: r.key });
    }
    return out;
  }

  /** `/repo use key:<key>`: link this guild to a configured repository (RFC-001 7.2). */
  use(input: { readonly guildId: GuildId; readonly key: UserText; readonly actorId: UserId }): Result<UseOutcome, AppError> {
    const chosen = toEnum(input.key, this.keys());
    const repo = chosen.ok ? this.repos.byKey(chosen.value) : null;
    if (repo === null) return Err(errors.validation('key', UNKNOWN_REPO_DETAIL, UNKNOWN_REPO_NEXT_STEP));

    const from = readRepoTarget(this.settings, input.guildId);
    if (from === repo.key) return Ok({ repo: labelOf(repo), from, changed: false });

    this.settings.set(input.guildId, REPO_TARGET_SETTING, repoTargetValue(repo));
    // RFC-001 7.2: audited as `repos.use` with `{ guildId, from, to }`.
    this.audit.record({
      action: 'repos.use',
      actorId: input.actorId,
      guildId: input.guildId,
      detail: { guildId: input.guildId, from, to: repo.key },
    });
    return Ok({ repo: labelOf(repo), from, changed: true });
  }

  /**
   * `/repo clear`: remove the link, so the guild falls back to the default repository (if any).
   *
   * REFUSED WHILE ANY OF THIS GUILD'S REQUESTS IS NOT TERMINAL (RFC-001 7.2). Each request keeps
   * the repository it was filed in whatever the link says, so this is not about moving them; it
   * is that clearing can leave a server with NO repository (a set without a default), and a
   * server whose requests are still being built is the wrong moment to find that out.
   */
  clear(input: { readonly guildId: GuildId; readonly actorId: UserId }): Result<ClearOutcome, AppError> {
    // The RAW row, not `readRepoTarget`: an unparseable value is still something to clear.
    if (this.settings.get(input.guildId, REPO_TARGET_SETTING) === undefined) {
      return Ok({ from: null, changed: false, fallback: this.fallbackLabel(input.guildId) });
    }
    const inFlight = this.guildInFlight(input.guildId);
    if (inFlight > 0) {
      return Err(
        errors.conflict(
          'repos.in_flight',
          `This server has ${String(inFlight)} request(s) still in flight, so its repository link cannot be cleared yet.`,
          'Wait for them to finish, or cancel them with /request cancel, then run /repo clear again.',
          'in-flight',
        ),
      );
    }
    const from = readRepoTarget(this.settings, input.guildId);
    this.settings.clear(input.guildId, REPO_TARGET_SETTING);
    this.audit.record({
      action: 'repos.clear',
      actorId: input.actorId,
      guildId: input.guildId,
      detail: { guildId: input.guildId, from },
    });
    return Ok({ from, changed: true, fallback: this.fallbackLabel(input.guildId) });
  }

  /** `/repo show`. */
  overview(guildId: GuildId): RepoOverview {
    const target = this.repos.target(guildId);
    const repo = target.kind === 'mapped' || target.kind === 'default' ? target.repo : null;
    const activity: ActivityLine[] = [];
    if (repo !== null) {
      for (const a of this.repos.activity()) {
        const seen = a.inRepo(repo);
        activity.push({ moduleId: a.moduleId, inFlight: seen.inFlight, detail: seen.detail });
      }
    }
    const all = this.repos.all();
    return {
      target: labelTarget(target),
      activity,
      guildInFlight: this.guildInFlight(guildId),
      configured: [...all.filter((r) => r.isDefault), ...all.filter((r) => !r.isDefault)].map((r) => ({ key: r.key, isDefault: r.isDefault })),
    };
  }

  /** How many repositories are configured, and which is the default - for `health()`. */
  summary(): string {
    const all = this.repos.all();
    const dflt = all.find((r) => r.isDefault);
    return `${String(all.length)} repositories configured; default ${dflt === undefined ? 'none' : dflt.key}`;
  }

  private guildInFlight(guildId: GuildId): number {
    return this.repos.activity().reduce((n, a) => n + a.inFlightForGuild(guildId), 0);
  }

  private fallbackLabel(guildId: GuildId): RepoLabel | null {
    const repo = this.repos.resolve(guildId);
    return repo === null ? null : labelOf(repo);
  }
}
