/**
 * A fixture module that loads cleanly. Read by `src/loader.test.ts` only.
 *
 * WHY IT IS A REAL FILE ON DISK AND NOT AN OBJECT BUILT IN THE TEST: the thing under test is
 * `await import(pathToFileURL(abs).href)`, which a hand-built descriptor would skip entirely -
 * and skipping it is exactly how the Windows `ERR_UNSUPPORTED_ESM_URL_SCHEME` bug ships.
 *
 * It lives under `src/testing/` rather than `src/modules/`, so the real boot scan never sees
 * it and `/help` never lists it.
 */

import { z } from 'zod';
import { defineModule, type Outcome } from '#core/module';
import { PUBLIC } from '#core/policy';
import { NO_LIMIT } from '#core/ratelimit';

export default defineModule({
  id: 'alpha',
  summary: 'Fixture: a module that installs without complaint.',
  capabilities: [],
  config: z.object({}),
  permissions: {},
  publishes: {},
  migrations: false,

  setup() {
    return {
      commands: [
        {
          name: 'alpha',
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
