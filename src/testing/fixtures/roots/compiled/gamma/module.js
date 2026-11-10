/**
 * A fixture module written as plain JavaScript, the shape a compiled `dist/` tree has. Read by
 * `src/loader.test.ts` only. `#core/*` resolves through package.json `imports`.
 */

import { z } from 'zod';
import { defineModule } from '#core/module';
import { PUBLIC } from '#core/policy';
import { NO_LIMIT } from '#core/ratelimit';

export default defineModule({
  id: 'gamma',
  summary: 'Fixture: a compiled module.',
  capabilities: [],
  config: z.object({}),
  permissions: {},
  publishes: {},
  migrations: false,

  setup() {
    return {
      commands: [
        {
          name: 'gamma',
          description: 'Fixture command.',
          surface: 'guild',
          options: [],
          permission: PUBLIC,
          limit: NO_LIMIT,
          needs: [],
          ack: 'instant',
          async handle() {
            return { kind: 'silent' };
          },
        },
      ],
      async health() {
        return { status: 'ok', detail: 'fixture' };
      },
    };
  },
});
