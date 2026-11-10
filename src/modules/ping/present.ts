import type { CommandSpec } from '#core/module';
import { PUBLIC } from '#core/policy';
import { limit } from '#core/ratelimit';
import type { ClockPort } from '#core/ports';
import type { View } from '#core/view';
import { pongWithUptime } from '#modules/ping/domain';

export const present = {
  pong: (uptimeMs: number): View => ({
    accent: 'ok',
    ephemeral: true,
    nodes: [{ kind: 'text', md: pongWithUptime(uptimeMs) }],
  }),
};

/** `startedAtNs` is a `clock.monotonicNs()` reading, so an NTP step cannot make uptime negative. */
export function pingCommands(clock: ClockPort, startedAtNs: bigint): readonly CommandSpec[] {
  return [
    {
      name: 'ping',
      description: 'Check that the bot is alive',
      surface: 'both',
      options: [],
      permission: PUBLIC,
      limit: [limit.perUser(5, 60_000)],
      needs: [],
      ack: 'defer-ephemeral',
      async handle() {
        const uptimeMs = Number((clock.monotonicNs() - startedAtNs) / 1_000_000n);
        return { kind: 'view', view: present.pong(uptimeMs) };
      },
    },
  ];
}
