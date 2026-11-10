/**
 * THE ARCHITECTURE RULES, ENFORCED.
 *
 * The assertions that used to live in this file moved to `src/testing/conventions.ts`
 * (RFC-001 section 4.4), because the engine will be published as a package and every group's
 * module repository must run the same checks with the same failure sentences. This file is now
 * the engine's consumer of that helper; a module repo's `src/conventions.test.ts` is the same
 * call without `coreDir` and `allowedAsNever`.
 *
 * Nothing here is engine-only enough to stay behind: the two engine-specific tests (the core
 * hexagon and the `as never` allow-list) are registered by the helper when `coreDir` is set.
 *
 * WHEN YOU HIT ONE OF THESE: the rule is the product. Do not add an exception to make your change
 * compile - see "If you are blocked" in AGENTS.md.
 */

import { registerConventionTests } from '#testing/conventions';

registerConventionTests({
  root: process.cwd(),
  coreDir: 'src/core',
  allowedAsNever: ['src/adapters/github/dispatch.ts'],
});
