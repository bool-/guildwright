/**
 * THE ROUTE ALLOW-LIST (RFC-001 6.1, "Concern (Administration)"; PR 1.7).
 *
 * The GitHub App this bot runs as holds Administration WRITE, because GitHub gates environment
 * creation on it. Administration write can also change repository settings and, depending on
 * GitHub's mapping, delete the repository. The mitigation that lives in code is this test: EVERY
 * REST route the GitHub adapter calls is listed here, with the permission that answers it, so a
 * new route - above all a new Administration one - is a red test and a line a reviewer must read,
 * rather than a quiet widening of what the bot does with that permission.
 *
 * HOW IT FINDS ROUTES: every string literal of the form `'<METHOD> /...'` in a non-test file under
 * `src/adapters/github/`, which is how every call is written (`octokit.request('GET /repos/...')`
 * or the containment probes' `request('GET /repos/...')` seam). And the escape hatches that would
 * bypass that - the generated `octokit.rest.*` methods, `paginate`, GraphQL - are banned outright,
 * because a call made through them has no route literal to find.
 *
 * NOT LISTED, because it is not in our source: `POST /app/installations/{installation_id}/access_tokens`,
 * the installation-token mint, which `@octokit/auth-app` performs inside the App client.
 */

import { strict as assert } from 'node:assert';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

const DIR = join('src', 'adapters', 'github');

/** Route -> the App permission that answers it (RFC-001 6.1). Sorted. Edit with care. */
const ALLOWED: Readonly<Record<string, string>> = {
  // --- App identity (App JWT; app-auth.ts) -------------------------------------------------
  'GET /app': 'App JWT',
  'GET /app/installations/{installation_id}': 'App JWT',

  // --- /repos/{owner}/{repo} -----------------------------------------------------------------
  'GET /repos/{owner}/{repo}': 'Metadata (read)',
  'GET /repos/{owner}/{repo}/installation': 'App JWT',
  'GET /repos/{owner}/{repo}/commits/{ref}': 'Contents (read)',
  'GET /repos/{owner}/{repo}/contents/{path}': 'Contents (read)',
  // `<bin> gc-approvals` only (approvals-gc.ts), never the running bot. The DELETE needs Contents
  // WRITE, which the bot's App deliberately does not hold (RFC-001 6.1): with the App it answers
  // 403 and the CLI prints the `git push --delete` command instead.
  'GET /repos/{owner}/{repo}/git/matching-refs/{ref}': 'Contents (read) - gc-approvals',
  'DELETE /repos/{owner}/{repo}/git/refs/{ref}': 'Contents (WRITE) - gc-approvals, operator-run; 403 on the App by design',
  'GET /repos/{owner}/{repo}/issues': 'Issues (read)',
  'POST /repos/{owner}/{repo}/issues': 'Issues (write)',
  'GET /repos/{owner}/{repo}/issues/{issue_number}': 'Issues (read)',
  'PATCH /repos/{owner}/{repo}/issues/{issue_number}': 'Issues (write)',
  'GET /repos/{owner}/{repo}/issues/{issue_number}/comments': 'Issues (read)',
  'POST /repos/{owner}/{repo}/issues/{issue_number}/comments': 'Issues (write)',
  'POST /repos/{owner}/{repo}/issues/{issue_number}/labels': 'Issues (write)',
  'POST /repos/{owner}/{repo}/labels': 'Issues (write)',
  'GET /repos/{owner}/{repo}/pulls': 'Pull requests (read)',
  'GET /repos/{owner}/{repo}/actions/runs': 'Actions (read)',
  'GET /repos/{owner}/{repo}/actions/runs/{run_id}': 'Actions (read)',
  'POST /repos/{owner}/{repo}/actions/runs/{run_id}/cancel': 'Actions (write)',
  'GET /repos/{owner}/{repo}/actions/workflows/{workflow_id}': 'Actions (read)',
  'GET /repos/{owner}/{repo}/actions/workflows/{workflow_id}/runs': 'Actions (read)',
  'POST /repos/{owner}/{repo}/actions/workflows/{workflow_id}/dispatches': 'Actions (write)',
  'GET /repos/{owner}/{repo}/actions/variables/{name}': 'Variables (read)',
  'GET /repos/{owner}/{repo}/actions/secrets': 'Secrets (read) - names only',
  'GET /repos/{owner}/{repo}/actions/secrets/{secret_name}': 'Secrets (read) - name and dates only',
  'GET /repos/{owner}/{repo}/environments': 'Environments (read)',
  'GET /repos/{owner}/{repo}/environments/{environment_name}/secrets': 'Environments (read) - names only',
  'GET /repos/{owner}/{repo}/environments/{environment_name}/secrets/public-key': 'Environments (read)',
  'PUT /repos/{owner}/{repo}/environments/{environment_name}/secrets/{secret_name}': 'Environments (write)',
  'DELETE /repos/{owner}/{repo}/environments/{environment_name}/secrets/{secret_name}': 'Environments (write)',
  // THE ONLY TWO ADMINISTRATION CALLS. A third one is a design change, not a diff.
  'PUT /repos/{owner}/{repo}/environments/{environment_name}': 'ADMINISTRATION (write)',
  'DELETE /repos/{owner}/{repo}/environments/{environment_name}': 'ADMINISTRATION (write)',
};

const ROUTE_LITERAL = /['"`]((?:GET|POST|PUT|PATCH|DELETE|HEAD) \/[^'"`\s]*)['"`]/gu;

/** Source files, with comments stripped so prose that quotes a route is not a call. */
function sources(): readonly { readonly file: string; readonly code: string }[] {
  return readdirSync(DIR)
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
    .map((f) => ({
      file: f,
      code: readFileSync(join(DIR, f), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//gu, ' ')
        .replace(/(^|[^:'"`])\/\/[^\n]*/gu, '$1 '),
    }));
}

test('every REST route the GitHub adapter calls is on the allow-list', () => {
  const called = new Map<string, string[]>();
  for (const { file, code } of sources()) {
    for (const m of code.matchAll(ROUTE_LITERAL)) {
      const route = m[1] ?? '';
      called.set(route, [...(called.get(route) ?? []), file]);
    }
  }
  const unlisted = [...called.keys()].filter((r) => !(r in ALLOWED));
  assert.deepEqual(
    unlisted,
    [],
    `new GitHub route(s): ${unlisted.map((r) => `${r} (${(called.get(r) ?? []).join(', ')})`).join('; ')}. ` +
      'Add each to ALLOWED in routes.test.ts with the permission that answers it - and if it needs Administration, that is a design change to argue in the PR, not a line to add.',
  );
  // And the list is not a museum: a route nobody calls any more is removed, so the list stays
  // an exact statement of what the bot does.
  const stale = Object.keys(ALLOWED).filter((r) => !called.has(r));
  assert.deepEqual(stale, [], `allow-listed but no longer called: ${stale.join('; ')}. Remove them from ALLOWED.`);
});

test('exactly two Administration routes, both on one environment, and nothing else under /repos is a settings write', () => {
  const admin = Object.entries(ALLOWED)
    .filter(([, why]) => why.startsWith('ADMINISTRATION'))
    .map(([route]) => route)
    .sort();
  assert.deepEqual(admin, [
    'DELETE /repos/{owner}/{repo}/environments/{environment_name}',
    'PUT /repos/{owner}/{repo}/environments/{environment_name}',
  ]);
  // A write directly on the repository resource is how settings change or a repo is deleted.
  for (const route of Object.keys(ALLOWED)) {
    assert.doesNotMatch(route, /^(?:PUT|PATCH|DELETE|POST) \/repos\/\{owner\}\/\{repo\}$/u, route);
  }
});

test('no call can bypass the allow-list: no generated REST methods, no paginate, no GraphQL', () => {
  // Each of these makes a request with no route literal in our source, so the scan above would
  // never see it. The adapter writes every call as `request('<METHOD> /path')` on purpose.
  const BYPASS = /\.rest\.|\.paginate\s*[.(]|\.graphql\s*[.(]|\bgraphql\s*\(/u;
  const offenders = sources()
    .filter(({ code }) => BYPASS.test(code))
    .map(({ file }) => file);
  assert.deepEqual(offenders, [], 'call octokit.request with a route literal instead, so routes.test.ts can see it');
});

test('the containment preflight is read-only: every route it added is a GET', () => {
  for (const { file, code } of sources().filter((s) => s.file === 'containment.ts' || s.file === 'gates.ts')) {
    for (const m of code.matchAll(ROUTE_LITERAL)) assert.match(m[1] ?? '', /^GET /u, `${file}: ${m[1] ?? ''}`);
  }
});
