/**
 * `<bin> gc-approvals` (RFC-001 section 12 decision 7), on a FAKE transport only: a `GithubRequest`
 * that holds a set of `refs/approvals/*` refs and a workflow-run list, and records every call.
 * The properties: a dry run deletes nothing and lists exactly what `--yes` would delete; `--yes`
 * deletes only refs older than the duration; a ref no run dates is kept; a ref under the prefix
 * that is not an approval id is never touched; the bot App's 403 prints the git command instead.
 */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { githubRepoSet } from '#core/config';
import type { GithubRequest } from '#adapters/github/gates';
import { enginePackageRoot } from '#adapters/system/version';
import { captureIo, VALID_ENV } from '#testing/fixtures/cli-io';
import { githubError } from '#testing/fixtures/github-fake';

import { runCli } from '../cli.ts';
import { parseOlderThan, pickGcRepo } from './gc-approvals.ts';

const NOW = Date.parse('2026-11-09T12:00:00Z');
const DAY = 24 * 60 * 60 * 1000;

const OLD_A = '11111111-1111-4111-8111-111111111111';
const OLD_B = '22222222-2222-4222-8222-222222222222';
const YOUNG = '33333333-3333-4333-8333-333333333333';
const UNDATED = '44444444-4444-4444-8444-444444444444';

interface FakeRefs {
  readonly request: GithubRequest;
  readonly refs: Set<string>;
  readonly deletes: string[];
  readonly routes: string[];
  denyDelete: boolean;
}

function fakeRefs(): FakeRefs {
  const refs = new Set([OLD_A, OLD_B, YOUNG, UNDATED].map((id) => `refs/approvals/${id}`));
  refs.add('refs/approvals/not-an-approval');
  const runs = [
    // Newest first, as GitHub lists them. The young one; then a refused REPLAY of OLD_A that is
    // newer than the run that created its ref; then the two creating runs.
    { id: 40, display_title: `agent R4 -> issue #4 approval ${YOUNG}`, created_at: new Date(NOW - 2 * DAY).toISOString() },
    { id: 31, display_title: `agent R1 -> issue #1 approval ${OLD_A}`, created_at: new Date(NOW - 95 * DAY).toISOString() },
    { id: 20, display_title: `agent R2 -> issue #2 approval ${OLD_B}`, created_at: new Date(NOW - 120 * DAY).toISOString() },
    { id: 10, display_title: `agent R1 -> issue #1 approval ${OLD_A}`, created_at: new Date(NOW - 100 * DAY).toISOString() },
  ];
  const state: FakeRefs = {
    refs,
    deletes: [],
    routes: [],
    denyDelete: false,
    request: async (route, params) => {
      state.routes.push(route);
      assert.equal(params['owner'], 'o');
      assert.equal(params['repo'], 'r');
      switch (route) {
        case 'GET /repos/{owner}/{repo}/git/matching-refs/{ref}':
          assert.equal(params['ref'], 'approvals/');
          return { status: 200, data: [...refs].sort().map((ref) => ({ ref, object: { sha: 'a'.repeat(40) } })) };
        case 'GET /repos/{owner}/{repo}/actions/workflows/{workflow_id}/runs':
          assert.equal(params['workflow_id'], 'agent-implement-request.yml');
          return { status: 200, data: { total_count: runs.length, workflow_runs: params['page'] === 1 ? runs : [] } };
        case 'DELETE /repos/{owner}/{repo}/git/refs/{ref}': {
          if (state.denyDelete) throw githubError(403);
          const ref = `refs/${String(params['ref'])}`;
          state.deletes.push(ref);
          refs.delete(ref);
          return { status: 204, data: null };
        }
        default:
          throw new Error(`fake GitHub: unexpected route ${route}`);
      }
    },
  };
  return state;
}

async function gc(fake: FakeRefs, ...argv: string[]) {
  const c = captureIo(process.cwd(), VALID_ENV, () => NOW);
  const code = await runCli(['gc-approvals', ...argv], c.io, { engineRoot: enginePackageRoot(), gcRequest: fake.request });
  return { code, c };
}

test('a dry run deletes nothing and lists exactly what --yes would delete', async () => {
  const fake = fakeRefs();
  const { code, c } = await gc(fake);
  assert.equal(code, 0, c.all());
  assert.deepEqual(fake.deletes, []);
  assert.ok(!fake.routes.some((r) => r.startsWith('DELETE')), 'a dry run sends no DELETE at all');
  const out = c.stdout();
  assert.match(out, /older than 90d, would delete: 2/u);
  // Dated by the EARLIEST run naming the approval (run 10, 100 days ago), not the replay.
  assert.match(out, new RegExp(`refs/approvals/${OLD_A}  consumed 2026-08-01 by run 10`, 'u'));
  assert.match(out, new RegExp(`refs/approvals/${OLD_B}  consumed`, 'u'));
  assert.match(out, /kept, younger than 90d: 1/u);
  assert.match(out, new RegExp(`kept, age unknown \\(no run of agent-implement-request\\.yml names the approval\\): 1\\n    refs/approvals/${UNDATED}`, 'u'));
  assert.match(out, /left alone, not an approval id: refs\/approvals\/not-an-approval/u);
  assert.match(out, /Dry run: nothing was deleted\. Re-run with --yes to delete the 2 ref\(s\) listed above\./u);
});

test('--yes deletes only the refs older than the duration', async () => {
  const fake = fakeRefs();
  const { code, c } = await gc(fake, '--yes');
  assert.equal(code, 0, c.all());
  assert.deepEqual(fake.deletes.sort(), [`refs/approvals/${OLD_A}`, `refs/approvals/${OLD_B}`].sort());
  assert.ok(fake.refs.has(`refs/approvals/${YOUNG}`));
  assert.ok(fake.refs.has(`refs/approvals/${UNDATED}`), 'an age that cannot be established is never acted on');
  assert.ok(fake.refs.has('refs/approvals/not-an-approval'));
  assert.match(c.stdout(), /Deleted 2 of 2 ref\(s\)\./u);
});

test('--older-than moves the line, and a 403 from the App prints the git command instead', async () => {
  const fake = fakeRefs();
  const narrower = await gc(fake, '--older-than', '110d');
  assert.match(narrower.c.stdout(), /older than 110d, would delete: 1/u);

  fake.denyDelete = true;
  const denied = await gc(fake, '--older-than=12w', '--yes');
  assert.equal(denied.code, 1);
  assert.deepEqual(fake.deletes, []);
  assert.match(denied.c.stderr(), /deleting a ref needs Contents: write, and the bot's GitHub App holds Contents: read only, by design/u);
  assert.match(denied.c.stderr(), new RegExp(`git push origin --delete refs/approvals/${OLD_B} refs/approvals/${OLD_A}`, 'u'));
});

test('--older-than must be a duration of at least one day', async () => {
  assert.deepEqual(parseOlderThan('90d'), { ms: 90 * DAY });
  assert.deepEqual(parseOlderThan('2w'), { ms: 14 * DAY });
  assert.deepEqual(parseOlderThan('36h'), { ms: 1.5 * DAY });
  assert.match(String(Reflect.get(parseOlderThan('12h'), 'error')), /shorter than one day/u);
  assert.match(String(Reflect.get(parseOlderThan('90'), 'error')), /not a duration/u);
  const fake = fakeRefs();
  const r = await gc(fake, '--older-than', '1h', '--yes');
  assert.equal(r.code, 2);
  assert.deepEqual(fake.routes, [], 'a refused duration asks GitHub nothing');
});

// ---------------------------------------------------------------------------------------
// The repository set (RFC-001 PR 2.1): which repository to collect in
// ---------------------------------------------------------------------------------------

test('pickGcRepo: one repository needs no flag; several need --repo, and an unknown key is refused naming the keys', () => {
  const one = githubRepoSet({ GITHUB_OWNER: 'o', GITHUB_REPO: 'r' });
  const two = githubRepoSet({ GITHUB_REPOS_JSON: '{"main":{"owner":"acme","repo":"a","default":true},"events":{"owner":"acme","repo":"b"}}' });
  assert.ok('repos' in one && 'repos' in two);
  if (!('repos' in one) || !('repos' in two)) return;
  const solo = pickGcRepo(one.repos, undefined);
  assert.ok('repo' in solo && solo.repo.key === 'default');
  const missing = pickGcRepo(two.repos, undefined);
  assert.ok('error' in missing && /several repositories \(main, events\); name one with --repo <key>/u.test(missing.error), 'never "the first one" for a delete');
  const picked = pickGcRepo(two.repos, 'events');
  assert.ok('repo' in picked && picked.repo.owner === 'acme' && picked.repo.repo === 'b');
  const unknown = pickGcRepo(two.repos, 'nope');
  assert.ok('error' in unknown && /--repo nope is not a configured repository; the keys are: main, events/u.test(unknown.error));
});
