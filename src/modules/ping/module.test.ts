import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import type { InstalledModule, Invocation, ProgressHandle } from '#core/module';
import { createEventBus } from '#core/events';
import { PUBLIC } from '#core/policy';
import { toChannelId, toUserId, newRequestId } from '#core/ids';
import { renderSafeMarkdown } from '#core/text';
import { fakeClock, fakeLogger } from '#testing/fakes';
import { renderView } from '#adapters/discord/render';

import pingModule from '#modules/ping/module';
import { formatUptime } from '#modules/ping/domain';

const NOW = 1_700_000_000_000;

function installed(clock = fakeClock(NOW)): InstalledModule {
  const r = pingModule.install({
    ports: { clock },
    rawConfig: {},
    bus: createEventBus(() => undefined),
    logger: fakeLogger(),
  });
  assert.ok(r.ok, 'the ping module must install with only the clock port and no config');
  if (!r.ok) throw new Error('unreachable');
  return r.value;
}

/** `ProgressHandle` is unforgeable by design; nothing on the `/ping` path reads it. */
function invocation(): Invocation {
  const user = toUserId('200000000000000001');
  const channel = toChannelId('300000000000000009');
  assert.ok(user.ok && channel.ok);
  if (!user.ok || !channel.ok) throw new Error('unreachable');
  const progress = { tokenExpiresAtMs: NOW + 900_000, update: (): void => undefined };
  return {
    id: newRequestId(NOW),
    actor: { userId: user.value, roleIds: [], isAppOwner: false, memberPermissions: 0n, appPermissions: 0n },
    space: { guildId: null, channelId: channel.value },
    args: {} as Invocation['args'],
    progress: progress as unknown as ProgressHandle,
    at: NOW,
  };
}

test('/ping is one public command that asks for no Discord permission', () => {
  const commands = installed().commands;
  assert.deepEqual(commands.map((c) => c.name), ['ping']);
  const ping = commands[0];
  assert.ok(ping !== undefined);
  assert.equal(ping.permission, PUBLIC);
  assert.deepEqual(ping.needs, []);
  assert.deepEqual(ping.options, []);
});

test('/ping replies "✅ Pong. Up for 0s" the moment the bot starts, visible only to the person who ran it', async () => {
  const ping = installed().commands[0];
  assert.ok(ping !== undefined);

  const outcome = await ping.handle(invocation());
  assert.equal(outcome.kind, 'view');
  if (outcome.kind !== 'view') return;

  assert.equal(outcome.view.ephemeral, true, 'the view must be marked ephemeral');
  assert.equal(ping.ack, 'defer-ephemeral', 'the acknowledgement must be ephemeral too, or the reply is public');

  const text = outcome.view.nodes.map((n) => (n.kind === 'text' ? renderSafeMarkdown(n.md) : ''));
  assert.deepEqual(text, ['✅ Pong. Up for 0s']);

  const rendered = renderView(outcome.view);
  assert.ok(rendered.ok, 'the reply must pass the real renderer');
  if (rendered.ok) assert.equal(rendered.value.ephemeral, true);
});

test('/ping reports how long the module has been running, read from ctx.ports.clock', async () => {
  const clock = fakeClock(NOW);
  const ping = installed(clock).commands[0];
  assert.ok(ping !== undefined);

  const say = async (): Promise<string[]> => {
    const outcome = await ping.handle(invocation());
    assert.equal(outcome.kind, 'view');
    if (outcome.kind !== 'view') return [];
    return outcome.view.nodes.map((n) => (n.kind === 'text' ? renderSafeMarkdown(n.md) : ''));
  };

  clock.set(NOW + (3 * 3600 + 12 * 60) * 1000);
  assert.deepEqual(await say(), ['✅ Pong. Up for 3h 12m']);

  clock.set(NOW + (3 * 3600 + 13 * 60) * 1000);
  assert.deepEqual(await say(), ['✅ Pong. Up for 3h 13m'], 'it must be read on every call, not once');
});

test('uptime drops seconds past a minute, adds days past a day, and never goes negative', () => {
  assert.equal(formatUptime(-5_000), '0s');
  assert.equal(formatUptime(42_000), '42s');
  assert.equal(formatUptime(60_000), '1m');
  assert.equal(formatUptime(5 * 60_000 + 59_000), '5m');
  assert.equal(formatUptime(3 * 3_600_000 + 12 * 60_000), '3h 12m');
  assert.equal(formatUptime(2 * 86_400_000 + 5 * 60_000), '2d 0h 5m');
});

test('the module declares only the clock capability, no permission key and reports healthy', async () => {
  const m = installed();
  assert.deepEqual(m.manifest.capabilities, ['clock']);
  assert.deepEqual(Object.keys(m.manifest.permissions), []);
  assert.equal((await m.health()).status, 'ok');
});
