/** Fixture for `src/cli/invite.test.ts`: a module whose command needs ['EmbedLinks', 'CreatePublicThreads']. */

import { z } from 'zod';
import { defineModule, type Outcome } from '#core/module';
import { PUBLIC } from '#core/policy';
import { NO_LIMIT } from '#core/ratelimit';

export default defineModule({
  id: 'needs-b',
  summary: 'Fixture: a module with Discord permission needs.',
  capabilities: [],
  config: z.object({}),
  permissions: {},
  publishes: {},
  migrations: false,

  setup() {
    return {
      commands: [
        {
          name: 'needs-b',
          description: 'Fixture command.',
          surface: 'guild',
          options: [],
          permission: PUBLIC,
          limit: NO_LIMIT,
          needs: ['EmbedLinks', 'CreatePublicThreads'],
          ack: 'instant',
          async handle(): Promise<Outcome> {
            return { kind: 'silent' };
          },
        },
      ],
      async health() {
        return { status: 'ok' as const, detail: 'fixture' };
      },
    };
  },
});
