/**
 * WHICH BUILD IS RUNNING.
 *
 * POSTMORTEM THIS FILE CLOSES: "an operator was handed a bug report and could not tell which
 * build was deployed." Nothing in the process said. The boot log printed the Node version, the
 * pid and the database path; `/status` printed per-module health. Neither printed the thing
 * every triage starts with - is the machine running the code the report is about? Without it,
 * the first twenty minutes of every incident go to establishing what is deployed, usually by
 * SSHing somewhere and running `git log`, which answers what is CHECKED OUT rather than what is
 * running.
 *
 * This file is the pure half: the shape, the parsers, and the one-line rendering. Reading it
 * off the disk is `#adapters/system/version`, because it needs `node:fs` and core must not.
 *
 * WHY THE GIT SHA IS NULLABLE AND THAT IS NOT A DEFECT: a container built from a tarball has no
 * `.git`, and a CI checkout may have one that says something misleading. `null` is an honest
 * "this process cannot tell you", which is strictly better than a plausible wrong sha - the one
 * thing worse than not knowing which build is running is being confidently told the wrong one.
 */

/** How many hex characters of a sha a human actually reads. Git's own default. */
export const SHORT_SHA_LENGTH = 7;

/** A commit sha, as git writes one: 40 hex for sha-1, 64 for a sha-256 repository. */
const SHA_RE = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u;

/** True for a full commit sha. WHY strict: a truncated or branch-shaped value must not be
 *  reported as if the process knew its commit. */
export function isCommitSha(value: string): boolean {
  return SHA_RE.test(value);
}

/** A `package.json` `name` and `version`. */
export interface PackageIdentity {
  readonly name: string;
  readonly version: string;
}

/** The repository the bot was started in: its `package.json`, plus the commit it is at. */
export interface RepoIdentity extends PackageIdentity {
  /** The full commit sha, or `null` when this process genuinely cannot tell. */
  readonly gitSha: string | null;
}

/**
 * What is running, as data. TWO identities, because after RFC-001 they are two things.
 *
 * `engine` is the package this code lives in - read relative to the code's own file, so from an
 * installed engine it is `node_modules/discord-ai-feature-builder/package.json`, which has a
 * version and no `.git`. `repo` is the module repository the bot was started in - read from the
 * working directory, and the one whose commit sha an operator triaging an agent's PR wants. One
 * identity would have to pick: the engine's root reports no sha once installed, and the cwd's
 * would hide which engine version the modules are running against. In the engine's own checkout
 * both point at the same tree and say the same thing.
 *
 * JSON-shaped on purpose: it goes into a log line's fields, and it is returned by
 * `VersionPort.current()` to a module that may render it. Nothing here is a live object.
 */
export interface BuildInfo {
  readonly engine: PackageIdentity;
  readonly repo: RepoIdentity;
  /** `process.version`, e.g. `v24.16.0`. Carried here so one line answers the whole question. */
  readonly node: string;
}

/**
 * What is reported before anything has been read, and what a fake returns.
 *
 * WHY IT IS A NAMED CONSTANT rather than an inline literal at each call site: `unknown` must
 * look identical everywhere it appears, so an operator who sees it once learns to read it, and
 * a renderer cannot accidentally invent a friendlier-looking placeholder that hides the gap.
 */
export const UNKNOWN_BUILD: BuildInfo = {
  engine: { name: 'discord-bot', version: '0.0.0-unknown' },
  repo: { name: 'discord-bot', version: '0.0.0-unknown', gitSha: null },
  node: 'unknown',
};

/** The first `SHORT_SHA_LENGTH` characters, or `null` when there is no sha. */
export function shortSha(sha: string | null): string | null {
  return sha === null ? null : sha.slice(0, SHORT_SHA_LENGTH);
}

/**
 * One line, for a log field, a `/status` footer or a bug report.
 *
 * `engine discord-ai-feature-builder@0.1.0 · my-bot-modules@0.3.0 (a1b2c3d) on node v24.16.0`,
 * and with no sha available `... (no git sha) ...` - the absence is SAID rather than left as a
 * gap, because a missing parenthesis reads as a formatting bug and gets ignored, while
 * "no git sha" reads as the fact it is. The sha sits next to the REPO because that is whose
 * commit it is; the engine is identified by its version alone.
 */
export function describeBuild(info: BuildInfo): string {
  const sha = shortSha(info.repo.gitSha);
  return (
    `engine ${info.engine.name}@${info.engine.version} · ` +
    `${info.repo.name}@${info.repo.version} (${sha ?? 'no git sha'}) on node ${info.node}`
  );
}

/**
 * HOW this process authenticates to GitHub, as data, for the `/status` auth line (RFC-001 6.4
 * step 5). The second question of every triage after "which build?" is "running as what?" - a
 * PAT that expires on a date somebody has to remember, or an App installation that can be
 * uninstalled from the repository's settings by anyone with admin.
 *
 * Nothing here is a credential: an App slug and installation id are visible to every admin of
 * the repository, and a PAT's expiry date is the header GitHub sends back on every response.
 * `unknown` is what a fake reports and what a process reports before its preflight ran, said
 * out loud for the same reason `describeBuild` says "no git sha".
 */
export type GithubAuthSummary =
  | {
      readonly kind: 'app';
      /** The App's slug from `GET /app`, or `null` when that read failed transiently at boot. */
      readonly slug: string | null;
      readonly appId: number;
      /** `owner/repo`. */
      readonly repo: string;
      readonly installationId: number;
    }
  | {
      readonly kind: 'pat';
      /** From the fine-grained-PAT expiry header; `null` for a token that does not send one. */
      readonly expiresAtMs: number | null;
    }
  | { readonly kind: 'unknown' };

/** What a fake returns, and what is reported before anything was learned. */
export const UNKNOWN_GITHUB_AUTH: GithubAuthSummary = { kind: 'unknown' };

/**
 * `GitHub: app my-builder on octo/demo, installation 42` or `GitHub: PAT, expires 2027-01-31`.
 * A PAT without an expiry header says so instead of leaving the date out.
 */
export function describeGithubAuth(auth: GithubAuthSummary): string {
  switch (auth.kind) {
    case 'app':
      return `GitHub: app ${auth.slug ?? `id ${auth.appId}`} on ${auth.repo}, installation ${auth.installationId}`;
    case 'pat':
      return auth.expiresAtMs === null
        ? 'GitHub: PAT, no expiry reported'
        : `GitHub: PAT, expires ${new Date(auth.expiresAtMs).toISOString().slice(0, 10)}`;
    case 'unknown':
      return 'GitHub: auth not checked yet';
  }
}

/**
 * What `.git/HEAD` says.
 *
 * Two forms, both real: a detached head is the sha itself, and an attached one is
 * `ref: refs/heads/main`. Anything else - an empty file, a partially written one - is `null`
 * rather than a guess.
 *
 * WHY THIS IS PARSED IN CORE, away from the filesystem: it is the only part of sha discovery
 * with branches in it, so it is the only part worth a unit test, and a test for it should not
 * need a repository on disk.
 */
export type GitHead =
  | { readonly kind: 'sha'; readonly sha: string }
  | { readonly kind: 'ref'; readonly ref: string };

export function parseGitHead(raw: string): GitHead | null {
  const line = raw.trim();
  if (line.startsWith('ref:')) {
    const ref = line.slice('ref:'.length).trim();
    // A ref name is a path under `.git/`, so it is joined onto a directory later. `..` has no
    // business in one, and refusing it here is cheaper than remembering to refuse it there.
    if (ref.length === 0 || ref.includes('..') || !ref.startsWith('refs/')) return null;
    return { kind: 'ref', ref };
  }
  return isCommitSha(line) ? { kind: 'sha', sha: line } : null;
}

/**
 * Find `ref` in a `.git/packed-refs` file.
 *
 * WHY IT IS NEEDED AT ALL: after a `git gc` - and after a plain `git clone`, for every branch
 * but the checked-out one - `.git/refs/heads/main` does not exist as a file, and the sha is in
 * `packed-refs` instead. Skipping this makes sha discovery work on a developer's machine and
 * fail on a fresh deploy, which is the worst possible split.
 *
 * Lines are `<sha> <ref>`; a line beginning `#` is a header and a line beginning `^` is the
 * peeled target of the tag above it, which is not what was asked for.
 */
export function findPackedRef(packed: string, ref: string): string | null {
  for (const line of packed.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith('#') || trimmed.startsWith('^')) continue;
    const space = trimmed.indexOf(' ');
    if (space < 0) continue;
    const sha = trimmed.slice(0, space);
    if (trimmed.slice(space + 1).trim() === ref && isCommitSha(sha)) return sha;
  }
  return null;
}
