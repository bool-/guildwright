/**
 * `/status` carries the GitHub auth line (RFC-001 6.4 step 5), asserted through the SHIPPED
 * manifest's own preview, which is rendered by the same `statusView` the command uses.
 */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { createEventBus } from '#core/events';
import { UNKNOWN_BUILD, describeGithubAuth, describeGithubAuthSet, type GithubAuthSummary } from '#core/ports';
import { renderSafeMarkdown } from '#core/text';
import type { View } from '#core/view';
import { fakeCatalog, fakeLogger, fakeVersion } from '#testing/fakes';

import helpModule from '#modules/help/module';

function viewText(view: View): string {
  return view.nodes
    .map((node) => (node.kind === 'text' ? renderSafeMarkdown(node.md) : node.kind === 'heading' ? node.text : ''))
    .join('\n');
}

function statusPreview(github: GithubAuthSummary): string {
  const installed = helpModule.install({
    ports: { catalog: fakeCatalog(), version: fakeVersion(UNKNOWN_BUILD, github) },
    rawConfig: {},
    bus: createEventBus(() => undefined),
    logger: fakeLogger(),
  });
  assert.ok(installed.ok, 'the help module must install');
  if (!installed.ok) return '';
  const view = installed.value.previews['status'];
  assert.ok(view !== undefined, 'help ships a /status preview');
  return view === undefined ? '' : viewText(view);
}

test('/status names the GitHub App, the repository and the installation in App mode', () => {
  const text = statusPreview({ kind: 'app', slug: 'gw-builder', appId: 424242, repo: 'octo/demo', installationId: 777 });
  assert.match(text, /GitHub: app gw-builder on octo\/demo, installation 777/u);
});

test('/status names the PAT and its expiry date in PAT mode', () => {
  const text = statusPreview({ kind: 'pat', expiresAtMs: Date.parse('2027-01-31T10:00:00Z') });
  assert.match(text, /GitHub: PAT, expires 2027-01-31/u);
});

test('the auth line says what it does not know instead of leaving a gap', () => {
  assert.equal(describeGithubAuth({ kind: 'pat', expiresAtMs: null }), 'GitHub: PAT, no expiry reported');
  assert.equal(
    describeGithubAuth({ kind: 'app', slug: null, appId: 424242, repo: 'octo/demo', installationId: 777 }),
    'GitHub: app id 424242 on octo/demo, installation 777',
  );
  assert.equal(describeGithubAuth({ kind: 'unknown' }), 'GitHub: auth not checked yet');
});

// ---------------------------------------------------------------------------------------
// The repository set (RFC-001 PR 2.1): one auth line for every repository
// ---------------------------------------------------------------------------------------

test('/status names EVERY installation of the App when the bot serves several repositories', () => {
  const installed = helpModule.install({
    ports: {
      catalog: fakeCatalog(),
      version: fakeVersion(UNKNOWN_BUILD, [
        { kind: 'app', slug: 'gw-builder', appId: 424242, repo: 'acme/bot-modules', installationId: 11 },
        { kind: 'app', slug: 'gw-builder', appId: 424242, repo: 'acme/events-modules', installationId: 22 },
      ]),
    },
    rawConfig: {},
    bus: createEventBus(() => undefined),
    logger: fakeLogger(),
  });
  assert.ok(installed.ok);
  const view = installed.ok ? installed.value.previews['status'] : undefined;
  assert.ok(view !== undefined);
  if (view === undefined) return;
  assert.match(viewText(view), /GitHub: app gw-builder on acme\/bot-modules \(installation 11\), acme\/events-modules \(installation 22\)/u);
});

test('describeGithubAuthSet: a one-repository set reads EXACTLY as the single-repository line did', () => {
  const app: GithubAuthSummary = { kind: 'app', slug: 'gw-builder', appId: 424242, repo: 'octo/demo', installationId: 777 };
  assert.equal(describeGithubAuthSet([app]), describeGithubAuth(app));
  const pat: GithubAuthSummary = { kind: 'pat', expiresAtMs: null };
  assert.equal(describeGithubAuthSet([pat]), 'GitHub: PAT, no expiry reported', 'one token for the whole set: one line');
  assert.equal(describeGithubAuthSet([]), 'GitHub: auth not checked yet');
});
