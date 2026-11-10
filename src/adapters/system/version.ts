/**
 * READING THE BUILD IDENTITY OFF THE DISK. The impure half of `#core/version`.
 *
 * Everything with a branch in it is pure and lives in core; this file is the three reads and
 * the order they are tried in.
 *
 * THE ORDER, AND WHY IT IS THAT ORDER:
 *
 *   1. THE ENVIRONMENT, first. A container has no `.git` and a deploy pipeline knows exactly
 *      what it built. `GITHUB_SHA` is set by every GitHub Actions job; `GIT_SHA`, `GIT_COMMIT`
 *      and `SOURCE_COMMIT` are what the common image builders set. An operator who can set one
 *      of these gets a correct answer with no repository present, which is the whole point.
 *   2. `.git/HEAD`, second. Correct on a developer's machine and on a plain checkout, and it
 *      answers about the WORKING COPY, which is why it is not first: a deploy that copies a
 *      built tree next to somebody's checkout would otherwise report the checkout's sha.
 *   3. `null`. Not a guess, and not a value scraped from anywhere less trustworthy.
 *
 * NOTHING HERE SHELLS OUT. `git rev-parse` would be the obvious implementation and it is the
 * wrong one: `node:child_process` is banned in modules for good reasons that apply just as much
 * here, spawning a process at boot is a failure mode (no git on the host, a hung filesystem) in
 * exchange for information that is already sitting in two files, and a process spawn is a far
 * larger thing to have on the boot path than two `readFileSync` calls.
 *
 * EVERY READ IS BEST-EFFORT, AND THAT IS DELIBERATE. Not knowing which build is running is a
 * diagnostic inconvenience; refusing to start because `package.json` moved is an outage. So
 * every failure here degrades to `UNKNOWN_BUILD`'s value for that field and the bot boots.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { findPackedRef, isCommitSha, parseGitHead, UNKNOWN_BUILD, type BuildInfo, type PackageIdentity } from '#core/version';

/**
 * The environment variables a deploy pipeline may have already answered this question in.
 *
 * ORDERED, most specific first. `GITHUB_SHA` is set by Actions itself and is therefore the one
 * that is right without anybody opting in.
 */
export const SHA_ENV_VARS: readonly string[] = ['GIT_SHA', 'GITHUB_SHA', 'GIT_COMMIT', 'SOURCE_COMMIT'];

/**
 * The ENGINE's package root, resolved from this file rather than from `process.cwd()`.
 *
 * `../../../` from `src/adapters/system/version.ts` in a checkout, and from
 * `dist/adapters/system/version.js` in an installed engine - which is
 * `node_modules/discord-ai-feature-builder/`, holding the engine's `package.json` and no `.git`.
 * That is exactly why this root answers only `engine`, and the sha comes from the working
 * directory instead.
 */
export function enginePackageRoot(): string {
  return fileURLToPath(new URL('../../../', import.meta.url));
}

function readTextOrNull(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    // Absent, unreadable, or a directory. All three mean the same thing to a caller that is
    // only trying to be helpful: we do not know.
    return null;
  }
}

/** A sha somebody already established, from the environment. */
export function shaFromEnv(env: Readonly<Record<string, string | undefined>>): string | null {
  for (const name of SHA_ENV_VARS) {
    const raw = env[name]?.trim();
    if (raw !== undefined && isCommitSha(raw)) return raw;
  }
  return null;
}

/**
 * A sha from a `.git` directory: `HEAD`, then the ref it names, then `packed-refs`.
 *
 * The `packed-refs` fallback is not an edge case. A fresh `git clone` packs every ref except
 * the checked-out branch, and `git gc` packs the rest - so a deploy that clones and checks out
 * a tag has no loose ref file at all, and skipping this step would make sha discovery work
 * everywhere it is convenient and fail everywhere it matters.
 */
export function shaFromGitDir(gitDir: string): string | null {
  const headRaw = readTextOrNull(join(gitDir, 'HEAD'));
  if (headRaw === null) return null;
  const head = parseGitHead(headRaw);
  if (head === null) return null;
  if (head.kind === 'sha') return head.sha;

  // `parseGitHead` already refused a ref containing `..` or not starting with `refs/`, so this
  // join cannot escape the git directory.
  const loose = readTextOrNull(join(gitDir, head.ref))?.trim();
  if (loose !== undefined && loose !== null && isCommitSha(loose)) return loose;

  const packed = readTextOrNull(join(gitDir, 'packed-refs'));
  return packed === null ? null : findPackedRef(packed, head.ref);
}

/** `name` and `version` out of `package.json`, or the unknown placeholders. */
function readPackage(root: string): PackageIdentity {
  const raw = readTextOrNull(join(root, 'package.json'));
  if (raw === null) return { name: UNKNOWN_BUILD.engine.name, version: UNKNOWN_BUILD.engine.version };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { name: UNKNOWN_BUILD.engine.name, version: UNKNOWN_BUILD.engine.version };
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return { name: UNKNOWN_BUILD.engine.name, version: UNKNOWN_BUILD.engine.version };
  }
  const fields: Readonly<Record<string, unknown>> = { ...parsed };
  const name = fields['name'];
  const version = fields['version'];
  return {
    name: typeof name === 'string' && name.length > 0 ? name : UNKNOWN_BUILD.engine.name,
    version: typeof version === 'string' && version.length > 0 ? version : UNKNOWN_BUILD.engine.version,
  };
}

/**
 * What is running. Called ONCE, at boot, and the answer is carried around after that.
 *
 * WHY ONCE: three synchronous reads are nothing at boot and would be silly on the request path,
 * and - more importantly - the answer must not be able to CHANGE while the process lives. A
 * `/status` that re-read `.git/HEAD` would start reporting a new sha the moment somebody pulled
 * on the host, while the code in memory was still the old one. That is a worse answer than no
 * answer, because it is a confident one.
 *
 * TWO ROOTS (RFC-001 section 4.3, "Build identity after the split"): `engine` from the package
 * this file lives in, `repo` from `cwd` - the module repository the operator started the bot in,
 * whose `.git` holds the sha of the agent's merged PR. The environment still answers the sha
 * first (`SHA_ENV_VARS`), for the same container reasons as before. In the engine's own checkout
 * both roots are the same directory.
 */
export function readBuildInfo(
  env: Readonly<Record<string, string | undefined>> = process.env,
  cwd: string = process.cwd(),
): BuildInfo {
  const repo = readPackage(cwd);
  return {
    engine: readPackage(enginePackageRoot()),
    repo: {
      name: repo.name,
      version: repo.version,
      gitSha: shaFromEnv(env) ?? shaFromGitDir(join(cwd, '.git')),
    },
    node: process.version,
  };
}

/**
 * The working directory's `package.json`, parsed, or `null` when it cannot be read or parsed.
 * Input to `checkEnginePin` (`#core/version`); best-effort like everything else in this file,
 * because a manifest the bot cannot read is not evidence of a wrong pin.
 */
export function readRepoManifest(cwd: string = process.cwd()): unknown {
  const raw = readTextOrNull(join(cwd, 'package.json'));
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed;
  } catch {
    return null;
  }
}
