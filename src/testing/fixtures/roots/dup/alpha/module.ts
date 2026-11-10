/** A second module with id `alpha`, in another root: the cross-root duplicate. `loader.test.ts` only. */

import { z } from 'zod';
import { defineModule, type Outcome } from '#core/module';
import { PUBLIC } from '#core/policy';
import { NO_LIMIT } from '#core/ratelimit';

export default defineModule({
  id: 'alpha',
  summary: 'Fixture: a duplicate of the alpha module.',
  capabilities: [],
  config: z.object({}),
  permissions: {},
  publishes: {},
  migrations: false,

  setup() {
    return {
      commands: [
        {
          name: 'alpha-dup',
          description: 'Fixture command.',
          surface: 'guild',
          options: [],
          permission: PUBLIC,
          limit: NO_LIMIT,
          needs: [],
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
