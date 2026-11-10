import { z } from 'zod';
import { defineModule } from '#core/module';
import { pingCommands, present } from '#modules/ping/present';

export default defineModule({
  id: 'ping', // MUST equal the folder name
  summary: 'Check that the bot is alive.',
  capabilities: ['clock'],
  config: z.object({}),
  permissions: {},
  publishes: {},
  migrations: false,

  setup(ctx) {
    const clock = ctx.ports.clock;
    return {
      commands: pingCommands(clock, clock.monotonicNs()),
      previews: { pong: present.pong(3 * 3_600_000 + 12 * 60_000) },
      async health() {
        return { status: 'ok', detail: 'ping ready' };
      },
    };
  },
});
