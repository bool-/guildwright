/**
 * The builder's config after RFC-001 PR 1.7: `ref` and `workflowFile` are gone (the adapter
 * dispatches at GITHUB_REF / GITHUB_WORKFLOW_FILE), and the boot preflight's reading of
 * `requireOwnCredentials` is the same fact as the module's own.
 */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { builderRequiresOwnCredentials } from '#core/config';
import { createEventBus } from '#core/events';
import { fakeLogger, fakePorts } from '#testing/fakes';
import builder from '#modules/builder/module';

function installed(rawConfig: unknown) {
  const r = builder.install({ ports: fakePorts('m_builder_'), rawConfig, bus: createEventBus(() => undefined), logger: fakeLogger() });
  assert.ok(r.ok, 'the builder must install');
  if (!r.ok) throw new Error('unreachable');
  return r.value;
}

test('an old MODULES_JSON carrying builder.ref / builder.workflowFile still boots: the keys are stripped, not fatal', async () => {
  const m = installed({ ref: 'release', workflowFile: 'other.yml' });
  assert.equal((await m.health()).status, 'ok');
});

test("the preflight's requireOwnCredentials reading agrees with the builder's own, both ways", async () => {
  assert.equal(builderRequiresOwnCredentials({}), true);
  assert.match((await installed({}).health()).detail, /every requester funds their own build/u);

  assert.equal(builderRequiresOwnCredentials({ builder: { requireOwnCredentials: false } }), false);
  assert.match((await installed({ requireOwnCredentials: false }).health()).detail, /fall back to the shared ai-agent/u);

  // A value the builder would reject reads as the side that asks the operator to fund nothing;
  // the builder itself is then quarantined at install.
  assert.equal(builderRequiresOwnCredentials({ builder: { requireOwnCredentials: 'no' } }), true);
});
