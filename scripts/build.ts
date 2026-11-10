/**
 * Build the engine into `dist/`, so it can be installed as a package (RFC-001 section 4.3).
 *
 *   npm run build            (node --conditions=source scripts/build.ts)
 *
 * WHY A BUILD AT ALL, when the repo itself runs its `.ts` unbuilt: Node strips types from any
 * `.ts` file EXCEPT one under `node_modules` (`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`). An
 * installed engine is under `node_modules` by definition, so it has to ship JavaScript. The repo
 * keeps running source through the `source` condition in `package.json` `imports`; only an
 * install, and the tests that prove an install works, ever touch `dist/`.
 *
 * FOUR STEPS, and the last three are things `tsc` does not do:
 *
 *   1. `tsc -p tsconfig.build.json`: `.js`, `.d.ts`, declaration and source maps.
 *      `rewriteRelativeImportExtensions` turns `./x.ts` into `./x.js`; `#core/x` is left as
 *      written and resolves through the package's own `imports` map at runtime.
 *   2. Copy every HAND-WRITTEN `src/**\/*.d.ts` (each module's `events.d.ts`, and
 *      `engine-events.d.ts`). `tsc` neither emits nor copies declaration inputs, and without
 *      them a module repo's `ctx.bus.on('builder.pr_opened', ...)` names an event that does not
 *      exist.
 *   3. Copy every `src/core/migrations/*.sql` and `src/modules/*\/migrations/*.sql` BYTE FOR
 *      BYTE. The migration ledger checksums file bytes and refuses to boot when an applied
 *      file's checksum moves (`src/core/migrate.ts`), so a copy that re-encoded or normalised
 *      line endings would brick every existing database. `copyFileSync` copies bytes;
 *      `.gitattributes` pins LF in the checkout it copies from.
 *   4. Copy `template/` if it exists. It does not yet: PR 1.5 of RFC-001 adds it, together with
 *      `template/MANIFEST.json`, which this script will then write. Until then this step is a
 *      no-op on purpose, not an oversight.
 *
 * `dist/` is deleted first, so a module or migration removed from `src/` cannot linger in a
 * package. It is in `.gitignore`.
 */

import { spawnSync } from 'node:child_process';
import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The engine's package root. Resolved from this file, so the cwd never matters. */
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SRC = join(ROOT, 'src');
const DIST = join(ROOT, 'dist');

/** Test fixtures are not part of the package, exactly as `tsconfig.build.json` excludes them. */
const FIXTURES = join(SRC, 'testing', 'fixtures');

function fail(message: string): never {
  process.stderr.write(`\nbuild failed: ${message}\n`);
  process.exit(1);
}

/** Every file under `dir`, recursively, as absolute paths. */
function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (abs === FIXTURES) continue;
      out.push(...walk(abs));
    } else if (entry.isFile()) {
      out.push(abs);
    }
  }
  return out;
}

/** Copy `abs` (under `src/`) to the same relative path under `dist/`, byte for byte. */
function copyIntoDist(abs: string): string {
  const rel = relative(SRC, abs);
  const target = join(DIST, rel);
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(abs, target);
  return rel.split(sep).join('/');
}

/**
 * The `tsc` that `npm run typecheck` uses, run through THIS Node rather than a shell shim.
 * WHY not `npx tsc` or `node_modules/.bin/tsc`: on Windows the `.bin` entry is a `.cmd` file
 * that needs a shell to run, and a shell is one more thing to get quoting wrong in.
 */
function tscEntry(): string {
  const require = createRequire(import.meta.url);
  return join(dirname(require.resolve('typescript/package.json')), 'bin', 'tsc');
}

function main(): void {
  rmSync(DIST, { recursive: true, force: true });

  // --- 1. emit -----------------------------------------------------------------------------
  const tsc = spawnSync(process.execPath, [tscEntry(), '-p', join(ROOT, 'tsconfig.build.json')], {
    cwd: ROOT,
    stdio: 'inherit',
  });
  if (tsc.error !== undefined) fail(`could not run tsc: ${tsc.error.message}`);
  if (tsc.status !== 0) fail(`tsc -p tsconfig.build.json exited ${String(tsc.status)}`);

  const files = walk(SRC);

  // --- 2. hand-written declarations ----------------------------------------------------------
  const declarations = files.filter((f) => f.endsWith('.d.ts')).map(copyIntoDist);

  // --- 3. migrations, byte for byte ----------------------------------------------------------
  const isMigration = (f: string): boolean => {
    const parts = relative(SRC, f).split(sep);
    if (!f.endsWith('.sql')) return false;
    // src/core/migrations/<file>.sql
    if (parts.length === 3 && parts[0] === 'core' && parts[1] === 'migrations') return true;
    // src/modules/<id>/migrations/<file>.sql
    return parts.length === 4 && parts[0] === 'modules' && parts[2] === 'migrations';
  };
  const migrations = files.filter(isMigration).map(copyIntoDist);

  // --- 4. template/, once it exists (RFC-001 PR 1.5) -----------------------------------------
  // PR 1.5 adds `template/` and makes this step also write `template/MANIFEST.json`. Until then
  // there is nothing to copy, and skipping quietly is correct rather than a warning to ignore.
  const template = join(ROOT, 'template');
  const copiedTemplate = existsSync(template);
  if (copiedTemplate) cpSync(template, join(DIST, 'template'), { recursive: true });

  process.stdout.write(
    `\nbuilt dist/: ${String(declarations.length)} hand-written .d.ts, ` +
      `${String(migrations.length)} migrations` +
      (copiedTemplate ? ', template/' : '') +
      '\n',
  );
}

if (import.meta.main) main();
