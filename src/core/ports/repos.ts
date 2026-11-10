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
 * THE SEAM PR 2.2 FILLS: `resolve(guildId)` is "the guild's mapping, else the default
 * repository, else null". This PR has no mapping store (`repo.target` in `core_settings` and the
 * `/repo use` command are PR 2.2), so `createReposPort` takes the mapping as a function and the
 * composition root passes one that maps nothing. Everything that asks `resolve` today keeps
 * asking it when the mapping arrives.
 */

import type { Result } from '#core/result';
import { Err, Ok } from '#core/result';
import type { AppError } from '#core/errors';
import { errors } from '#core/errors';
import type { GuildId } from '#core/ids';

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
 * The configured set, readable by a module that declares `repos` (RFC-001 7.2).
 *
 * Every method is SYNCHRONOUS and makes no request: `ack: 'form'` handlers must not await
 * before `showModal`, and a `/status` render must not spend API budget.
 */
export interface ReposPort {
  /** The configured set, in configuration order. Never empty. */
  all(): readonly RepoRef[];
  /** The guild's mapping (PR 2.2), else the default repository, else null. */
  resolve(guildId: GuildId): RepoRef | null;
  /** Re-validate a persisted key: the ref of this process's set, or null if it is not configured. */
  byKey(key: string): RepoRef | null;
}

/** Short alias, matching the style of every other port. */
export type Repos = ReposPort;

/**
 * Build the port over a minted set.
 *
 * `mapping` is THE SEAM for PR 2.2's `repo.target` guild setting: it returns the KEY a guild is
 * pointed at, or null. A key that is no longer configured falls through to the default rather
 * than to a ref of some other set - the RFC's "a persisted key is re-validated on the way back
 * out". This PR passes `noGuildMapping`.
 */
export function createReposPort(set: RepoSet, mapping: (guildId: GuildId) => string | null = noGuildMapping): ReposPort {
  return {
    all: () => set.refs,
    resolve: (guildId) => {
      const mapped = mapping(guildId);
      const hit = mapped === null ? null : set.byKey(mapped);
      return hit ?? set.default;
    },
    byKey: (key) => set.byKey(key),
  };
}

/** No guild is mapped to anything: every guild resolves to the default repository (PR 2.1). */
export function noGuildMapping(): string | null {
  return null;
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
