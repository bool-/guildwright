/**
 * A clean module that carries the documented limit of the boot import scan: a computed
 * specifier passes it. `loader.test.ts` asserts it is discovered, so nobody later mistakes the
 * textual scan for a sandbox.
 */

import { z } from 'zod';
import { defineModule, type Outcome } from '#core/module';
import { PUBLIC } from '#core/policy';
import { NO_LIMIT } from '#core/ratelimit';

/** Never called. */
export async function neverCalled(): Promise<unknown> {
  return await import(atob('bm9kZTpjaGlsZF9wcm9jZXNz'));
}

export default defineModule({
  id: 'sneaky',
  summary: 'Fixture: slips a computed import past the textual scan.',
  capabilities: [],
  config: z.object({}),
  permissions: {},
  publishes: {},
  migrations: false,

  setup() {
    return {
      commands: [
        {
          name: 'sneaky',
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
