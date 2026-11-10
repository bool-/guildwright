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
 *   4. Generate the two DERIVED files of the module-repo template (RFC-001 4.3, 9.4), in this
 *      order, because the second covers the first:
 *        - `template/AGENTS.md`: this repo's `AGENTS.md` with `agentsSubstitutions()` applied,
 *          so the two guides cannot diverge in substance;
 *        - `template/MANIFEST.json`: `{ engineVersion, files: { <path>: <sha256> } }` over
 *          `template/.github/**` and `template/AGENTS.md` - the bytes a module repo must hold,
 *          and what `template check`, the convention suite's `engineContract` group and the
 *          per-dispatch gate-file check compare against.
 *      Both are COMMITTED, not build output: the engine checkout's own bot and `template check`
 *      read them unbuilt, from the package root. Each is rewritten only when its content
 *      changed, so a build over an up-to-date tree touches nothing. `--skip-template` skips this
 *      step; `src/build.test.ts` passes it, so the test can tell a stale COMMITTED file from one
 *      this build just fixed.
 *
 * `template/` itself is NOT copied into `dist/`: it ships from the package root (`package.json`
 * `files`), which is where the CLI reads it (`<engineRoot>/template`). A second copy under
 * `dist/` would be one more thing that could disagree with the first.
 *
 * `dist/` is deleted first, so a module or migration removed from `src/` cannot linger in a
 * package. It is in `.gitignore`.
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { CLI_BIN } from '#core/version';

/** The engine's package root. Resolved from this file, so the cwd never matters. */
export const ROOT = fileURLToPath(new URL('..', import.meta.url));
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

// ---------------------------------------------------------------------------------------
// The module-repo template's derived files (RFC-001 4.3, 9.4)
// ---------------------------------------------------------------------------------------

/** What the template's generated text names: the package, its bin, and where the engine lives. */
export interface EngineFacts {
  readonly name: string;
  readonly version: string;
  readonly bin: string;
  /** `https://github.com/<owner>/<repo>`, from `package.json` `repository.url`. */
  readonly repoUrl: string;
}

/** The facts, from `<root>/package.json` and `CLI_BIN`: ONE source for every generated mention. */
export function engineFacts(root: string = ROOT): EngineFacts {
  const pkg: unknown = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const field = (name: string): unknown => (typeof pkg === 'object' && pkg !== null ? Reflect.get(pkg, name) : undefined);
  const name = field('name');
  const version = field('version');
  const repository = field('repository');
  const url: unknown = typeof repository === 'object' && repository !== null ? Reflect.get(repository, 'url') : repository;
  if (typeof name !== 'string' || typeof version !== 'string' || typeof url !== 'string') {
    throw new Error('package.json needs a string name, version and repository.url to generate the template');
  }
  return { name, version, bin: CLI_BIN, repoUrl: url.replace(/^git\+/u, '').replace(/\.git$/u, '') };
}

/** One textual substitution: `find` must occur exactly `count` times, or the build fails. */
export interface Substitution {
  readonly why: string;
  readonly find: string;
  readonly replace: string;
  readonly count: number;
}

/**
 * The template's `AGENTS.md` is the engine's with these applied. RFC-001 9.4 names four (1-4);
 * 5 and 6 exist because the engine's sentence would be FALSE in a module repo, and an agent
 * reads that file first:
 *
 *   1. the worked example and the core contract are where a module repo has them;
 *   2. "Start here" says this repository holds modules only, and "If you are blocked" routes a
 *      core change to the engine repository;
 *   3. the permissions integer comes from `npx <bin> invite-url`, not from a source file;
 *   4. the convention test is named as the two-line consumer it is in a module repo;
 *   5. no `--conditions=source`: a module repo runs the COMPILED engine, and that flag would
 *      point `#core/*` inside the installed engine at its shipped `.ts`, which Node refuses to
 *      strip under `node_modules`;
 *   6. the pack-and-install test belongs to the engine; a module repo's `npm run check` has none.
 *
 * Everything else - the six hard rules, the rest of the Operator section, the CI-job table -
 * stays word for word, which is what keeps every `DISCLOSURES` needle in both files.
 *
 * Each `find` must match exactly `count` times: an edit to the engine's AGENTS.md that moves one
 * of these sentences fails the build naming it, instead of shipping a half-substituted guide.
 */
export function agentsSubstitutions(f: EngineFacts): readonly Substitution[] {
  return [
    { why: '1. the worked example', find: '`template/src/modules/tags/`', replace: '`src/modules/tags/`', count: 3 },
    { why: '1. the core contract, shipped for reading', find: '`src/core/module.ts`', replace: `\`node_modules/${f.name}/src/core/module.ts\``, count: 2 },
    {
      why: '2. this repository holds modules only',
      find: '## Start here\n\n',
      replace:
        '## Start here\n\n' +
        `This repository holds modules only. The engine is the \`${f.name}\` package in\n` +
        '`node_modules`; `#core/*` resolves into it. Do not edit `node_modules`, and do not add\n' +
        '`#adapters/*` to the imports map.\n\n',
      count: 1,
    },
    {
      why: '2. a core change is a change to the engine',
      find: 'any change under `src/core/`,\n`.github/`, or the dependency list:',
      replace: `any change to the engine (anything\nunder \`node_modules/${f.name}/\`), \`.github/\`, or the dependency list:`,
      count: 1,
    },
    {
      why: '2. where a core change is filed',
      find: '`## Operator action required` heading above — that section is what a human reads to decide.\n',
      replace:
        '`## Operator action required` heading above — that section is what a human reads to decide.\n\n' +
        `A core change is a pull request to the engine repository, ${f.repoUrl}, not to this one.\n` +
        "`CORE-CHANGE-NEEDED:` in this repository's PR body is how the reviewer learns to file it there.\n",
      count: 1,
    },
    {
      why: '3. the permissions integer',
      find: 'new integer: `permissionInteger()` over the union of every `needs:` in the repo, whose bits\n   live in `src/core/permissions.ts`.',
      replace: `new integer: \`npx ${f.bin} invite-url\` prints it - \`permissionInteger()\` over the\n   union of every \`needs:\` the installed modules declare.`,
      count: 1,
    },
    {
      why: '4. the convention test',
      find: '`src/conventions.test.ts` asserts that this section',
      replace: "`src/conventions.test.ts` (two lines that run the installed engine's convention suite)\nasserts that this section",
      count: 1,
    },
    {
      why: '5. no source condition in a module repo',
      find:
        '- **The repo runs its own source through the `source` condition.** `#core/*` resolves to\n' +
        '  `src/core/*.ts` only under `node --conditions=source`, which every `npm run` script passes;\n' +
        '  without it Node resolves to the compiled `dist/`, which usually does not exist. Run tests with\n' +
        '  `npm test`, or a single file with `node --conditions=source --test src/x.test.ts`.',
      replace:
        '- **This repo runs its own `.ts` directly and the engine as compiled JavaScript.** `#core/*`\n' +
        `  resolves through \`imports\` in \`package.json\` to \`node_modules/${f.name}/dist/core/*.js\`\n` +
        '  (and its `.d.ts` for types). There is no build step and no `--conditions=source` here: that\n' +
        '  flag would point the installed engine at its shipped `.ts`, which Node refuses to run from\n' +
        '  `node_modules`. Run tests with `npm test`, or a single file with\n' +
        '  `node --test --experimental-test-module-mocks src/x.test.ts`.',
      count: 1,
    },
    {
      why: "6. the engine's pack-and-install test",
      find:
        '`npm run check` runs offline (the one network-bound test, the pack-and-install smoke test in\n' +
        '`src/build.test.ts`, is opt-in: CI runs it, and `ENGINE_PACK_TEST=1` runs it locally) and cannot\n' +
        'see a pull request.',
      replace: '`npm run check` runs offline and cannot see a pull request.',
      count: 1,
    },
  ];
}

function occurrences(text: string, find: string): number {
  return text.split(find).length - 1;
}

/** The template's AGENTS.md, from the engine's. Throws naming the substitution that no longer fits. */
export function templateAgentsMd(engineAgents: string, facts: EngineFacts): string {
  let out = engineAgents;
  for (const s of agentsSubstitutions(facts)) {
    const n = occurrences(out, s.find);
    if (n !== s.count) {
      throw new Error(
        `AGENTS.md substitution "${s.why}" expected ${String(s.count)} occurrence(s) of ${JSON.stringify(s.find.slice(0, 70))}, found ${String(n)}. ` +
          'Change agentsSubstitutions() in scripts/build.ts together with the AGENTS.md edit.',
      );
    }
    out = out.split(s.find).join(s.replace);
  }
  return out;
}

const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

/** Every file under `dir`, as sorted POSIX paths relative to it. */
function walkRelative(dir: string, base: string = dir): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkRelative(abs, base));
    else if (entry.isFile()) out.push(relative(base, abs).split(sep).join('/'));
  }
  return out.sort();
}

/**
 * `template/MANIFEST.json` for the template tree at `templateRoot`, as the exact text written.
 * The gated files are `.github/**` and `AGENTS.md`, nothing else (the CLI refuses a manifest
 * that lists anything else). `agents`, when given, is hashed in place of the AGENTS.md on disk:
 * the manifest describes the AGENTS.md the build writes, not one it is about to replace.
 */
export function templateManifest(templateRoot: string, engineVersion: string, agents?: string): string {
  const files: Record<string, string> = {};
  const gated = [...walkRelative(join(templateRoot, '.github')).map((p) => `.github/${p}`), 'AGENTS.md'].sort();
  for (const path of gated) {
    files[path] = path === 'AGENTS.md' && agents !== undefined ? sha256(Buffer.from(agents, 'utf8')) : sha256(readFileSync(join(templateRoot, ...path.split('/'))));
  }
  return `${JSON.stringify({ engineVersion, files }, null, 2)}\n`;
}

/**
 * Bring `template/AGENTS.md` and `template/MANIFEST.json` under `root` up to date - or, with
 * `write: false`, only report which are stale. Returns the stale paths, relative to `root`.
 * A file is written only when its content differs, so a reader of an up-to-date tree never
 * meets a half-written file.
 */
export function syncTemplate(root: string, opts: { readonly write: boolean }): readonly string[] {
  const facts = engineFacts(root);
  const agents = templateAgentsMd(readFileSync(join(root, 'AGENTS.md'), 'utf8'), facts);
  const expected: readonly (readonly [string, string])[] = [
    ['template/AGENTS.md', agents],
    ['template/MANIFEST.json', templateManifest(join(root, 'template'), facts.version, agents)],
  ];
  const stale: string[] = [];
  for (const [rel, text] of expected) {
    const path = join(root, ...rel.split('/'));
    const current = existsSync(path) ? readFileSync(path, 'utf8') : null;
    if (current === text) continue;
    stale.push(rel);
    if (opts.write) writeFileSync(path, text, 'utf8');
  }
  return stale;
}

function main(): void {
  const skipTemplate = process.argv.includes('--skip-template');
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

  // --- 4. the template's derived files (committed; rewritten only when they changed) ---------
  let templateNote = 'template/ skipped (--skip-template)';
  if (!skipTemplate) {
    let updated: readonly string[];
    try {
      updated = syncTemplate(ROOT, { write: true });
    } catch (cause: unknown) {
      fail(cause instanceof Error ? cause.message : String(cause));
    }
    templateNote = updated.length === 0 ? 'template/ up to date' : `updated ${updated.join(' and ')} - commit them`;
  }

  process.stdout.write(
    `\nbuilt dist/: ${String(declarations.length)} hand-written .d.ts, ` +
      `${String(migrations.length)} migrations; ${templateNote}\n`,
  );
}

if (import.meta.main) main();
