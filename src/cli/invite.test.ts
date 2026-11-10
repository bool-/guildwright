/**
 * `<bin> invite-url`: the permissions integer is `permissionInteger` over the UNION of every
 * `needs:` the bot would register, across every discovered module (AGENTS.md, "Operator action
 * required" item 2). Driven over the fixture root `src/testing/fixtures/roots/invite/`, whose two
 * modules need `SendMessages + EmbedLinks` and `EmbedLinks + CreatePublicThreads`.
 */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { PERMISSION_BITS } from '#core/permissions';
import { captureIo, VALID_ENV } from '#testing/fixtures/cli-io';

import { runCli } from '../cli.ts';
import { enginePackageRoot } from '#adapters/system/version';

const INVITE_ROOT = fileURLToPath(new URL('../testing/fixtures/roots/invite', import.meta.url));

/** Only the fixture root: no built-ins, so the expected integer is exactly the fixtures' union. */
const ENV = { ...VALID_ENV, MODULES_BUILTIN: 'false', MODULE_DIRS: INVITE_ROOT };

const EXPECTED = PERMISSION_BITS.SendMessages | PERMISSION_BITS.EmbedLinks | PERMISSION_BITS.CreatePublicThreads;

test('invite-url prints the integer for the union of every needs:, each permission once', async () => {
  const c = captureIo(process.cwd(), ENV);
  assert.equal(await runCli(['invite-url', '--client-id', '123456789012345678'], c.io, { engineRoot: enginePackageRoot() }), 0, c.all());
  const out = c.stdout();
  assert.match(out, new RegExp(`^permissions integer: ${EXPECTED.toString()}$`, 'mu'));
  assert.match(out, /across 2 module\(s\) \(needs-a, needs-b\)/u);
  // Listed in `PERMISSION_BITS` order, so the line is stable whatever order modules load in.
  assert.match(out, /^ {2}SendMessages, CreatePublicThreads, EmbedLinks$/mu);
  assert.match(
    out,
    new RegExp(`invite URL: https://discord\\.com/oauth2/authorize\\?client_id=123456789012345678&scope=bot\\+applications\\.commands&permissions=${EXPECTED.toString()}`, 'u'),
  );
});

test('invite-url takes the client id from DISCORD_CLIENT_ID, and refuses one that is not a snowflake', async () => {
  const c = captureIo(process.cwd(), ENV);
  assert.equal(await runCli(['invite-url'], c.io, { engineRoot: enginePackageRoot() }), 0);
  assert.match(c.stdout(), /client_id=123456789012345678/u);
  const bad = captureIo(process.cwd(), ENV);
  assert.equal(await runCli(['invite-url', '--client-id', 'my-bot'], bad.io, { engineRoot: enginePackageRoot() }), 2);
  assert.match(bad.stderr(), /"my-bot" is not a Discord application id/u);
});

test('a disabled module contributes no permissions', async () => {
  const c = captureIo(process.cwd(), { ...ENV, MODULES_DISABLE: 'needs-b' });
  assert.equal(await runCli(['invite-url'], c.io, { engineRoot: enginePackageRoot() }), 0);
  assert.match(c.stdout(), new RegExp(`^permissions integer: ${(PERMISSION_BITS.SendMessages | PERMISSION_BITS.EmbedLinks).toString()}$`, 'mu'));
});
