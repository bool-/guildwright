/**
 * Every built-in module's `AppEvents` augmentation, in one importable place.
 *
 * Exported as `discord-ai-feature-builder/events` (RFC-001 section 4.3, "`declare module
 * '#core/events'` across the boundary"). A module repository's `src/engine.d.ts` holds exactly
 * `import 'discord-ai-feature-builder/events';`, which puts these files into ITS program, so a
 * module there can `ctx.bus.on('builder.pr_opened', ...)` with full payload inference. Without
 * it the built-ins' declarations are never read, `EventName` does not widen, and the
 * subscription is a type error naming an event that plainly exists.
 *
 * ONE LINE PER BUILT-IN THAT DECLARES EVENTS. `build.test.ts` asserts that every
 * `src/modules/<id>/events.d.ts` is listed here, so a new built-in that publishes cannot be
 * forgotten. The `.js` spelling resolves to the `.d.ts` beside it under `nodenext`, both here in
 * `src/` and in `dist/`, where `scripts/build.ts` copies these files byte for byte.
 */
import './modules/builder/events.js';
import './modules/tags/events.js';
