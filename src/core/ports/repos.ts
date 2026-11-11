/**
 * THE REPO SET (RFC-001 section 7.1, 7.2, 7.4): which GitHub repositories this bot instance may
 * reach, as a port, so a module can ask "which repository?" without importing config.
 *
 * The set is STATIC configuration (`GITHUB_REPOS_JSON`, or the `GITHUB_OWNER`/`GITHUB_REPO`
 * pair, which becomes a one-repository set keyed `default`). Adding a repository needs an App
 * installation, a workflow copy and a repository secret anyway, and a repository the bot can
 * reach is one whose Administration the bot holds - so it is never runtime state.
 *
 * THREE THINGS HERE, and why each is shaped the way it is:
 *
 *  1. `RepoRef` - a branded handle on ONE configured repository. Modules cannot write one: the
 *     brand is a module-private symbol, so an object literal does not typecheck. And it is an
 *     IDENTITY, not a value: `RepoScoped.at` looks the ref up by object identity in the map the
 *     composition root built, so even a ref minted by a second `createRepoSet` call (the function
 *     is reachable from `#core`) is refused with an `Err`, never routed. A key that came back
 *     from the database is re-validated through `ReposPort.byKey`, which hands back the ref of
 *     THIS process's set or `null`.
 *
 *  2. `ReposPort` - `all`, `resolve`, `byKey`, exactly the RFC's shape. SYNCHRONOUS, because
 *     `ack: 'form'` handlers must not await before `showModal`.
 *
 *  3. `RepoScoped<T>` - `issues`, `builds` and `secrets` are handed to modules as
 *     `ctx.ports.issues.at(repo)`. The ports' own method signatures do not change, so every fake
 *     and every per-method test stays valid (RFC-001 7.4, "Resolved").
 *
 * THE GUILD MAPPING (PR 2.2): `resolve(guildId)` is "the guild's mapping, else the default
 * repository, else null". The mapping is runtime state, `repo.target` in `core_settings`, written
 * by the built-in `repos` module's `/repo use` and read through a function the composition root
 * passes (`repoTargetReader`), so this file never imports the settings adapter.
 *
 * WHAT INSTALLED MODULES ARE DOING IN EACH REPOSITORY (PR 2.2): `activity()`. `/repo clear`
 * refuses while a guild has a request in flight and `/repo show` counts what is in flight in a
 * repository, but the `repos` module cannot read the builder's table: modules never import each
 * other, and the `db` port mints only the caller's own tables. So a module that holds work in a
 * repository reports it through `ModuleHandle.repoActivity`, and the composition root hands the
 * reports to this port.
 */

import type { Result } from '#core/result';
import { Err, Ok } from '#core/result';
import type { AppError } from '#core/errors';
import { errors } from '#core/errors';
import type { GuildId } from '#core/ids';
import type { JsonObject } from '#core/json';

// ---------------------------------------------------------------------------------------
// RepoKey
// ---------------------------------------------------------------------------------------

declare const REPO_KEY_BRAND: unique symbol;

/** A configured repository's key, e.g. `main`, `events`, or `default` for the single-repo shim. */
export type RepoKey = string & { readonly [REPO_KEY_BRAND]: 'RepoKey' };

/** RFC-001 7.1, verbatim: a lowercase letter, then up to 30 lowercase letters, digits or dashes. */
export const REPO_KEY_PATTERN = /^[a-z][a-z0-9-]{0,30}$/u;

/** The key the single-repository compatibility shim gives `GITHUB_OWNER`/`GITHUB_REPO`. */
export const DEFAULT_REPO_KEY = 'default';

/** Predicate, not a cast: the regex IS the evidence for the brand. */
export function isRepoKey(value: string): value is RepoKey {
  return REPO_KEY_PATTERN.test(value);
}

// ---------------------------------------------------------------------------------------
// RepoRef
// ---------------------------------------------------------------------------------------

/**
 * The brand. A REAL symbol, deliberately not exported: only this file can put the property on
 * an object, so `{ key: 'main', ... }` written anywhere else is a type error, and `createRepoSet`
 * is the only door.
 */
const REPO_REF: unique symbol = Symbol('RepoRef');

/**
 * One configured repository. Plain, non-secret data: an operator already sees all of it in
 * `.env`, and a module needs `owner/repo` to tell a user where something will land.
 *
 * WHY NOT `ref` OR `workflowFile`: those decide what a build RUNS, and they are bound inside the
 * per-repository GitHub adapter exactly as `GITHUB_REF` was (RFC-001 5.4). A module never needs
 * them, so it is never handed them.
 */
export interface RepoRef {
  readonly key: RepoKey;
  /** As configured. GitHub's own spelling is learned by the adapter's preflight. */
  readonly owner: string;
  readonly repo: string;
  /** `"default": true` in `GITHUB_REPOS_JSON`, or the shim's single repository. */
  readonly isDefault: boolean;
  readonly [REPO_REF]: true;
}

/** `owner/repo` as configured, for a sentence. */
export function repoFullName(ref: RepoRef): string {
  return `${ref.owner}/${ref.repo}`;
}

/** What `createRepoSet` takes: one entry per configured repository, already validated by config. */
export interface RepoSetEntry {
  readonly key: string;
  readonly owner: string;
  readonly repo: string;
  readonly isDefault: boolean;
}

/** A minted set: the refs in configuration order, and the default (if any). */
export interface RepoSet {
  readonly refs: readonly RepoRef[];
  readonly default: RepoRef | null;
  /** The ref for a key of THIS set, or null. */
  byKey(key: string): RepoRef | null;
}

/**
 * MINT the refs for one configured set. Called by the composition root (and `doctor`), once.
 *
 * It re-checks what config already validated (key shape, unique keys, at most one default)
 * because a set that breaks those rules is a programming error at the call site, and a set
 * with two defaults would make `resolve` answer by accident of order.
 */
export function createRepoSet(entries: readonly RepoSetEntry[]): Result<RepoSet, AppError> {
  const refs: RepoRef[] = [];
  const seen = new Set<string>();
  for (const e of entries) {
    if (!isRepoKey(e.key)) {
      return Err(errors.config('GITHUB_REPOS_JSON', `"${e.key}" is not a repository key`, 'Use a key like main or events: a lowercase letter, then lowercase letters, digits or dashes.'));
    }
    if (seen.has(e.key)) {
      return Err(errors.config('GITHUB_REPOS_JSON', `the repository key "${e.key}" is configured twice`, 'Give each repository its own key.'));
    }
    seen.add(e.key);
    refs.push(Object.freeze({ key: e.key, owner: e.owner, repo: e.repo, isDefault: e.isDefault, [REPO_REF]: true as const }));
  }
  if (refs.length === 0) {
    return Err(errors.config('GITHUB_REPOS_JSON', 'no repository is configured', 'Set GITHUB_OWNER and GITHUB_REPO, or list at least one repository in GITHUB_REPOS_JSON.'));
  }
  const defaults = refs.filter((r) => r.isDefault);
  if (defaults.length > 1) {
    return Err(
      errors.config('GITHUB_REPOS_JSON', `more than one repository is marked default (${defaults.map((r) => r.key).join(', ')})`, 'Mark at most one repository "default": true.'),
    );
  }
  const frozen = Object.freeze([...refs]);
  return Ok({
    refs: frozen,
    default: defaults[0] ?? null,
    byKey: (key) => frozen.find((r) => r.key === key) ?? null,
  });
}

// ---------------------------------------------------------------------------------------
// ReposPort
// ---------------------------------------------------------------------------------------

/**
 * Where a guild's NEW requests land, and why (RFC-001 7.2, 7.3).
 *
 * FOUR ARMS, because each one is a different sentence to a different person:
 *
 *  - `mapped`  `/repo use` linked this guild to a configured repository.
 *  - `default` no link; the set's `"default": true` repository (with one repository, the only one).
 *  - `stale`   a link to a key the operator has since removed from `GITHUB_REPOS_JSON`. NOT the
 *              default: which repository a guild's requests land in is the operator's trust
 *              decision (7.2), so a removed repository must not silently hand the guild to
 *              another of the operator's repositories. Refused until somebody re-links it.
 *  - `none`    no link and no default: refused with the unmapped sentence (7.3).
 */
export type GuildRepoTarget =
  | { readonly kind: 'mapped'; readonly repo: RepoRef }
  | { readonly kind: 'default'; readonly repo: RepoRef }
  | { readonly kind: 'stale'; readonly key: string }
  | { readonly kind: 'none' };

/**
 * What ONE module reports about its work in the repository set, for `/repo show` and the
 * `/repo clear` refusal. Synchronous and request-free, like every method of this port: a module
 * answers from its own database, never from GitHub.
 */
export interface RepoActivity {
  /** This guild's work that has not reached a terminal state, in ANY repository. */
  inFlightForGuild(guildId: GuildId): number;
  /**
   * One repository as this module sees it: how much of its work is in flight there (from any
   * guild), and one short line for a human, e.g. its readiness and caps. No secrets.
   */
  inRepo(repo: RepoRef): { readonly inFlight: number; readonly detail: string };
}

/** One module's `RepoActivity`, named. */
export interface RepoActivityReport extends RepoActivity {
  readonly moduleId: string;
}

/**
 * The configured set, readable by a module that declares `repos` (RFC-001 7.2).
 *
 * Every method is SYNCHRONOUS and makes no request: `ack: 'form'` handlers must not await
 * before `showModal`, and a `/status` render must not spend API budget.
 *
 * `target` AND `activity` ARE ADDITIONS TO THE RFC's THREE METHODS (PR 2.2). `target` is
 * `resolve` with its reason, because "not linked yet" and "linked to a repository that was
 * removed" need different sentences. `activity` is how `/repo show` and `/repo clear` learn what
 * is in flight without the `repos` module reading another module's table.
 */
export interface ReposPort {
  /** The configured set, in configuration order. Never empty. */
  all(): readonly RepoRef[];
  /** The guild's mapping, else the default repository, else null. A stale mapping is null. */
  resolve(guildId: GuildId): RepoRef | null;
  /** `resolve`, with the reason: which arm of the routing rule answered. */
  target(guildId: GuildId): GuildRepoTarget;
  /** Re-validate a persisted key: the ref of this process's set, or null if it is not configured. */
  byKey(key: string): RepoRef | null;
  /** What every installed module that holds work in a repository reports. Empty before install. */
  activity(): readonly RepoActivityReport[];
}

/** Short alias, matching the style of every other port. */
export type Repos = ReposPort;

/**
 * Build the port over a minted set.
 *
 * `mapping` returns the KEY a guild is linked to (`repo.target`), or null. A key that is no
 * longer configured is `stale`: re-validated on the way back out, and answered with neither a
 * ref of some other set nor the default (see `GuildRepoTarget`).
 *
 * `activity` is late-bound: the port exists before the modules that report through it are
 * installed, so the composition root passes a function over the installed set.
 */
export function createReposPort(
  set: RepoSet,
  mapping: (guildId: GuildId) => string | null = noGuildMapping,
  activity: () => readonly RepoActivityReport[] = noActivity,
): ReposPort {
  const target = (guildId: GuildId): GuildRepoTarget => {
    const mapped = mapping(guildId);
    if (mapped !== null) {
      const hit = set.byKey(mapped);
      return hit === null ? { kind: 'stale', key: mapped } : { kind: 'mapped', repo: hit };
    }
    return set.default === null ? { kind: 'none' } : { kind: 'default', repo: set.default };
  };
  return {
    all: () => set.refs,
    resolve: (guildId) => {
      const t = target(guildId);
      return t.kind === 'mapped' || t.kind === 'default' ? t.repo : null;
    },
    target,
    byKey: (key) => set.byKey(key),
    activity: () => activity(),
  };
}

/** No guild is mapped to anything: every guild resolves to the default repository. */
export function noGuildMapping(): string | null {
  return null;
}

/** Nothing reports activity: the answer before any module is installed, and in tools. */
export function noActivity(): readonly RepoActivityReport[] {
  return [];
}

// ---------------------------------------------------------------------------------------
// The guild mapping's storage: `repo.target` in `core_settings` (RFC-001 7.2)
// ---------------------------------------------------------------------------------------

/**
 * The settings key, spelled ONCE: the `repos` module writes it and the composition root reads it.
 * Scope `guild`; value `{ "key": "<repository key>" }`.
 */
export const REPO_TARGET_SETTING = 'repo.target';

/** The narrowest settings read the mapping needs; `SettingsPort` satisfies it. */
export interface SettingsReader {
  get(guildId: GuildId, key: string): JsonObject | undefined;
}

/**
 * The stored key, or null. A value that is not `{ key: <repository key shape> }` reads as UNSET,
 * the rule the settings adapter applies to every unparseable setting, so a hand-edited row is
 * never half-applied. A well-formed key that is no longer configured is returned as it is:
 * `ReposPort.target` reports it `stale`, which is a refusal rather than a fallback.
 */
export function readRepoTarget(settings: SettingsReader, guildId: GuildId): string | null {
  const raw = settings.get(guildId, REPO_TARGET_SETTING);
  if (raw === undefined) return null;
  const key = raw['key'];
  return typeof key === 'string' && isRepoKey(key) ? key : null;
}

/** The value `/repo use` stores. */
export function repoTargetValue(repo: RepoRef): JsonObject {
  return { key: repo.key };
}

/** The mapping function `createReposPort` takes, over the settings port. */
export function repoTargetReader(settings: SettingsReader): (guildId: GuildId) => string | null {
  return (guildId) => readRepoTarget(settings, guildId);
}

// ---------------------------------------------------------------------------------------
// RepoScoped<T>
// ---------------------------------------------------------------------------------------

/**
 * A port that exists once per configured repository. `ctx.ports.issues.at(repo)` is that
 * repository's `IssuesPort`.
 *
 * `at` on a ref this set did not mint is unreachable for a module that only ever holds refs
 * from `ReposPort`, and it STILL returns `Err` rather than throwing or picking a neighbour
 * (RFC-001 7.4): a foreign ref routed to "the first repository" would file an issue, or store a
 * credential, somewhere nobody asked for.
 */
export interface RepoScoped<T> {
  at(repo: RepoRef): Result<T, AppError>;
}

/** The sentence `at` answers for a ref this set did not mint. */
export function unknownRepoError(repo: RepoRef): AppError {
  return errors.config(
    'repos',
    `no GitHub adapter is configured for the repository ref ${repo.key} (${repoFullName(repo)}); it was not minted by this process's repository set`,
    'Look the repository up through ctx.ports.repos rather than constructing a reference.',
  );
}

/**
 * Scope one value per ref. Lookup is by IDENTITY, so a ref equal in every field but minted
 * elsewhere is refused.
 */
export function repoScoped<T>(entries: readonly (readonly [RepoRef, T])[]): RepoScoped<T> {
  const byRef = new Map<RepoRef, T>(entries);
  return {
    at: (repo) => {
      const hit = byRef.get(repo);
      return hit === undefined ? Err(unknownRepoError(repo)) : Ok(hit);
    },
  };
}
