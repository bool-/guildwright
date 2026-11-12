/**
 * WHICH BUILD IS RUNNING.
 *
 * The property under test is not "it finds a sha" - it is that this code NEVER LIES. A
 * confidently wrong commit sha is worse than no sha at all, because it sends triage down a
 * diff that does not exist. So every branch below either produces a value git itself wrote, or
 * produces `null`.
 *
 * The pure parsers are in `#core/version` and are exercised here against the real file formats,
 * because the formats are the interesting part: a detached HEAD, an attached one, and a ref that
 * lives only in `packed-refs` - which is the state of every branch in a fresh `git clone` and
 * therefore the state of most deploys.
 */

import { strict as assert } from 'node:assert';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test, type TestContext } from 'node:test';

import { checkEnginePin, describeBuild, findPackedRef, isCommitSha, parseGitHead, shortSha, UNKNOWN_BUILD } from '#core/version';
import { enginePackageRoot, readBuildInfo, readRepoManifest, shaFromEnv, shaFromGitDir, SHA_ENV_VARS } from '#adapters/system/version';

const SHA = 'a'.repeat(39) + '7';
const OTHER = 'b'.repeat(40);

function gitDir(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), 'bot-version-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const git = join(dir, '.git');
  mkdirSync(git, { recursive: true });
  return git;
}

// ---------------------------------------------------------------------------------------
// The pure half
// ---------------------------------------------------------------------------------------

test('a sha is 40 hex characters, or 64 in a sha-256 repository, and nothing else', () => {
  assert.equal(isCommitSha(SHA), true);
  assert.equal(isCommitSha('c'.repeat(64)), true);
  assert.equal(isCommitSha(SHA.toUpperCase()), false, 'git writes lower case');
  assert.equal(isCommitSha(SHA.slice(0, 7)), false, 'an abbreviation is not a commit sha');
  assert.equal(isCommitSha('main'), false);
  assert.equal(isCommitSha(''), false);
});

test('HEAD parses in both of its real forms, and refuses anything else', () => {
  assert.deepEqual(parseGitHead(`${SHA}\n`), { kind: 'sha', sha: SHA }, 'a detached HEAD is the sha itself');
  assert.deepEqual(parseGitHead('ref: refs/heads/main\n'), { kind: 'ref', ref: 'refs/heads/main' });
  assert.equal(parseGitHead(''), null);
  assert.equal(parseGitHead('ref: \n'), null);
  // A ref is joined onto the git directory to find a file, so `..` in one has no business
  // there. Refusing it at the parse is cheaper than remembering to refuse it at the join.
  assert.equal(parseGitHead('ref: ../../../etc/passwd\n'), null);
  assert.equal(parseGitHead('ref: heads/main\n'), null, 'a ref path starts at refs/');
});

test('packed-refs skips its header and the peeled-tag lines', () => {
  const packed = [
    '# pack-refs with: peeled fully-peeled sorted',
    `${SHA} refs/heads/main`,
    `${OTHER} refs/tags/v1`,
    `${'c'.repeat(40)} refs/heads/other`,
    // A `^` line is the commit a TAG points at, not a ref of its own. Reading it as one is how
    // a lookup for `refs/tags/v1` returns the wrong object.
    `^${'d'.repeat(40)}`,
    '',
  ].join('\n');
  assert.equal(findPackedRef(packed, 'refs/heads/main'), SHA);
  assert.equal(findPackedRef(packed, 'refs/tags/v1'), OTHER);
  assert.equal(findPackedRef(packed, 'refs/heads/missing'), null);
  assert.equal(findPackedRef('', 'refs/heads/main'), null);
});

test('describeBuild SAYS that there is no sha rather than leaving a gap', () => {
  const withSha = describeBuild({
    engine: { name: 'engine-pkg', version: '1.2.3' },
    repo: { name: 'my-bot-modules', version: '0.4.0', gitSha: SHA },
    node: 'v24.16.0',
  });
  // Both identities, in the shape RFC-001 4.3 gives `/status`: the engine by version, and the
  // repository with the sha beside it, because that is whose commit it is.
  assert.equal(withSha, `engine engine-pkg@1.2.3 · my-bot-modules@0.4.0 (${SHA.slice(0, 7)}) on node v24.16.0`);
  // The absent case is the one that matters: `()` reads as a formatting bug and gets ignored,
  // while "no git sha" reads as the fact it is.
  assert.ok(describeBuild(UNKNOWN_BUILD).includes('(no git sha)'));
  assert.equal(shortSha(null), null);
  assert.equal(shortSha(SHA), SHA.slice(0, 7));
});

// ---------------------------------------------------------------------------------------
// The reads
// ---------------------------------------------------------------------------------------

test('the environment answers first, because a container has no .git at all', () => {
  for (const name of SHA_ENV_VARS) {
    assert.equal(shaFromEnv({ [name]: SHA }), SHA, `${name} must be honoured`);
  }
  assert.equal(shaFromEnv({}), null);
  // A branch name in GITHUB_SHA is somebody's mistake, not a sha. Reporting it would put a
  // plausible-looking wrong value in every log line for the life of the deploy.
  assert.equal(shaFromEnv({ GITHUB_SHA: 'main' }), null);
  assert.equal(shaFromEnv({ GITHUB_SHA: `  ${SHA}  ` }), SHA, 'trimmed, because a shell adds newlines');
});

test('a detached HEAD is read straight out of .git/HEAD', (t) => {
  const git = gitDir(t);
  writeFileSync(join(git, 'HEAD'), `${SHA}\n`);
  assert.equal(shaFromGitDir(git), SHA);
});

test('an attached HEAD follows the loose ref file', (t) => {
  const git = gitDir(t);
  writeFileSync(join(git, 'HEAD'), 'ref: refs/heads/main\n');
  mkdirSync(join(git, 'refs', 'heads'), { recursive: true });
  writeFileSync(join(git, 'refs', 'heads', 'main'), `${SHA}\n`);
  assert.equal(shaFromGitDir(git), SHA);
});

test('a ref that exists only in packed-refs is still found - which is most deploys', (t) => {
  // NOT an edge case. `git clone` packs every ref, and `git gc` packs the rest, so a deploy that
  // clones and checks out a tag has no loose ref file at all. Skipping this fallback makes sha
  // discovery work on a developer's laptop and fail on the server.
  const git = gitDir(t);
  writeFileSync(join(git, 'HEAD'), 'ref: refs/heads/main\n');
  writeFileSync(join(git, 'packed-refs'), `# pack-refs with: peeled\n${SHA} refs/heads/main\n`);
  assert.equal(shaFromGitDir(git), SHA);
});

test('no .git, an unreadable HEAD, or a ref that resolves nowhere is null - never a guess', (t) => {
  const git = gitDir(t);
  assert.equal(shaFromGitDir(git), null, 'no HEAD file');
  writeFileSync(join(git, 'HEAD'), 'ref: refs/heads/gone\n');
  assert.equal(shaFromGitDir(git), null, 'a ref with no loose file and no packed entry');
  writeFileSync(join(git, 'HEAD'), 'not a sha and not a ref\n');
  assert.equal(shaFromGitDir(git), null);
  assert.equal(shaFromGitDir(join(git, 'nope')), null);
});

test('started in the engine checkout, both identities name this repository, and nothing throws', () => {
  // The real package.json, read off disk - so a rename or a version bump shows up here rather
  // than in a fixture that quietly disagrees with what ships.
  const info = readBuildInfo({}, enginePackageRoot());
  assert.equal(info.engine.name, 'guildwright');
  assert.match(info.engine.version, /^\d+\.\d+\.\d+/u);
  // In the engine's own checkout the engine and the repo are the same tree (RFC-001 4.3).
  assert.equal(info.repo.name, info.engine.name);
  assert.equal(info.repo.version, info.engine.version);
  assert.equal(info.node, process.version);
  assert.ok(info.repo.gitSha === null || isCommitSha(info.repo.gitSha), 'a sha, or an honest null');
});

test('started in a module repository, the engine and the repo are two different identities', (t) => {
  // RFC-001 4.3: an installed engine's own root is `node_modules/<pkg>/`, with a version and no
  // `.git`. The sha an operator triages with is the MODULE REPO's, read from the working
  // directory - so a cwd that is not the engine's root must produce a different `repo`, while
  // `engine` still comes from the package this code lives in.
  const git = gitDir(t);
  const repoDir = dirname(git);
  writeFileSync(join(repoDir, 'package.json'), JSON.stringify({ name: 'my-bot-modules', version: '0.4.0' }));
  writeFileSync(join(git, 'HEAD'), `${OTHER}\n`);

  const info = readBuildInfo({}, repoDir);
  assert.equal(info.engine.name, 'guildwright', 'the engine is read relative to its own file');
  assert.deepEqual(info.repo, { name: 'my-bot-modules', version: '0.4.0', gitSha: OTHER });
  assert.ok(describeBuild(info).startsWith('engine guildwright@'));
  assert.ok(describeBuild(info).includes(` · my-bot-modules@0.4.0 (${OTHER.slice(0, 7)})`));
});

test('a repo directory with no package.json and no .git degrades to the placeholders', (t) => {
  const repoDir = join(dirname(gitDir(t)), 'empty');
  mkdirSync(repoDir);
  const info = readBuildInfo({}, repoDir);
  assert.deepEqual(info.repo, UNKNOWN_BUILD.repo);
  assert.equal(info.engine.name, 'guildwright');
});

test('an explicit environment sha wins over whatever the working copy says', (t) => {
  // A build artefact copied next to somebody's checkout must report what it WAS BUILT FROM, not
  // what happens to be checked out beside it.
  const git = gitDir(t);
  writeFileSync(join(git, 'HEAD'), `${OTHER}\n`);
  assert.equal(readBuildInfo({ GIT_SHA: SHA }, dirname(git)).repo.gitSha, SHA);
});

// ---------------------------------------------------------------------------------------
// The engine pin (RFC-001 5.4, PR 1.7)
// ---------------------------------------------------------------------------------------

const ENGINE = { name: 'guildwright', version: '1.7.0' };

test('ROW: a module repo pinning a different engine than is installed refuses to start, with the exact sentence', () => {
  assert.deepEqual(checkEnginePin({ dependencies: { 'guildwright': '1.6.2' } }, ENGINE), {
    kind: 'refuse',
    sentence: 'package.json asks for guildwright@1.6.2 but 1.7.0 is installed. Run npm ci.',
  });
});

test('the matching exact pin, and no pin at all (the engine checkout itself), both start', () => {
  assert.deepEqual(checkEnginePin({ dependencies: { 'guildwright': '1.7.0' } }, ENGINE), { kind: 'ok' });
  assert.deepEqual(checkEnginePin({ name: 'guildwright', dependencies: { octokit: '5.0.5' } }, ENGINE), { kind: 'ok' });
  assert.deepEqual(checkEnginePin({ name: 'x' }, ENGINE), { kind: 'ok' });
  assert.deepEqual(checkEnginePin(null, ENGINE), { kind: 'ok' }, 'an unreadable package.json is not evidence of a wrong pin');
});

test('a range, tag, file: or git spec is a WARNING (the convention suite insists on exact), never a refusal', () => {
  for (const spec of ['^1.7.0', '~1.7.0', 'latest', 'file:../engine', 'github:o/engine']) {
    const verdict = checkEnginePin({ dependencies: { 'guildwright': spec } }, ENGINE);
    assert.equal(verdict.kind, 'warn', spec);
    assert.match(verdict.kind === 'warn' ? verdict.sentence : '', /is not an exact version; pin it to 1\.7\.0/u);
  }
});

test("the engine's own checkout passes its own pin check (so `npm start` here keeps working)", () => {
  const build = readBuildInfo({}, enginePackageRoot());
  assert.deepEqual(checkEnginePin(readRepoManifest(enginePackageRoot()), build.engine), { kind: 'ok' });
});

test('readRepoManifest is best-effort: a missing or broken package.json is null', (t) => {
  const dir = tempDir(t);
  assert.equal(readRepoManifest(dir), null);
  writeFileSync(join(dir, 'package.json'), '{not json');
  assert.equal(readRepoManifest(dir), null);
  writeFileSync(join(dir, 'package.json'), '{"dependencies":{"guildwright":"1.0.0"}}');
  assert.deepEqual(readRepoManifest(dir), { dependencies: { 'guildwright': '1.0.0' } });
});

function tempDir(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), 'bot-pin-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
