/**
 * A fixture module whose `setup()` throws. Read by `src/loader.test.ts` only.
 *
 * It proves the QUARANTINE arm: `defineModule().install()` catches this, the loader records it,
 * and `alpha` in the same folder still installs. A module that explodes must cost the operator
 * one module, never the process.
 */

import { z } from 'zod';
import { defineModule } from '#core/module';

export default defineModule({
  id: 'boom',
  summary: 'Fixture: a module that throws inside setup().',
  capabilities: [],
  config: z.object({}),
  permissions: {},
  publishes: {},
  migrations: false,

  setup() {
    throw new Error('fixture boom: setup() throws on purpose');
  },
});
