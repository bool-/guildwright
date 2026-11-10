/**
 * THE MODULE-REPO TEMPLATE, as the CLI reads it: `init`, `template check`, `template apply`
 * (RFC-001 9.1, 9.4, 9.5, section 10 step 4).
 *
 * THE INTERFACE THE TEMPLATE MUST PROVIDE. The real one is `template/` at the engine's package
 * root (RFC-001 PR 1.5); the fixture under `src/testing/fixtures/template/` is the smallest tree
 * that satisfies the same contract, for the tests that need npm to resolve it offline:
 *
 *   <engineRoot>/template/                the whole tree `init` writes, verbatim except below
 *   <engineRoot>/template/MANIFEST.json   { "engineVersion": "<the engine's package.json version>",
 *                                           "files": { "<posix path>": "<sha256 hex of its bytes>" } }
 *
 * `files` lists exactly the GATED files - `.github/**` and `AGENTS.md`, the bytes a module repo
 * must hold byte-for-byte - and is what `template check` compares and `template apply` rewrites.
 * Every listed path must exist under `template/` with that digest, or the template is refused as
 * inconsistent. A listed path outside `.github/` and `AGENTS.md` is refused too: `apply` must be
 * unable, by construction, to touch `src/`.
 *
 * The manifest is read and verified by `#adapters/system/template-manifest`, the same parser the
 * per-dispatch gate-file check uses, so the CLI and the bot cannot disagree about it.
 *
 * Four files are NOT copied verbatim by `init`:
 *   - `MANIFEST.json` is engine metadata, never written into a module repo;
 *   - `package.json` is rewritten: `dependencies[<engine name>]`, when the template lists the
 *     engine, is set to the INSTALLED engine's exact version, and `--existing` keeps the repo's
 *     own `name`;
 *   - `package-lock.json` is never copied: it is regenerated against the rewritten
 *     `package.json` (`npm install --package-lock-only --ignore-scripts`), because a copied or a
 *     left-over lockfile out of sync with it makes every `npm ci` in the spec fail;
 *   - `gitignore` is written as `.gitignore` (`RENAMED_ON_INIT`): npm never ships a file named
 *     `.gitignore`, so the template stores it without the dot.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';

import { errors, type AppError } from '#core/errors';
import { Err, Ok, type Result } from '#core/result';
import { CLI_BIN, type PackageIdentity } from '#core/version';
import { TEMPLATE_MANIFEST, readTemplateManifest, sha256Hex, type TemplateManifest } from '#adapters/system/template-manifest';

import { EXIT_OK, EXIT_PROBLEM, describeAppError, type CliIo } from './io.ts';

export { TEMPLATE_DIR, TEMPLATE_MANIFEST, isGatedPath, sha256Hex } from '#adapters/system/template-manifest';

/** The fix every drift sentence names. */
export const TEMPLATE_APPLY_FIX = `run npx ${CLI_BIN} template apply and commit`;

/**
 * Template files stored under another name, because `npm pack` would drop them, and the name
 * `init` writes them under. npm never ships a `.gitignore` (it reads it as ignore rules for the
 * directory instead), and a module repository without one commits its `.env` on the first
 * `git add .`.
 */
export const RENAMED_ON_INIT: ReadonlyMap<string, string> = new Map([['gitignore', '.gitignore']]);

/** The installed engine's template, verified (`#adapters/system/template-manifest`). */
export type Template = TemplateManifest;

function templateError(internal: string, nextStep = 'Reinstall the engine (npm ci); if it persists, the engine package is broken and should be reported.'): AppError {
  return errors.config('template', internal, nextStep);
}

/** Read and verify `<engineRoot>/template` against its manifest and the engine's own version. */
export function readTemplate(engineRoot: string, engine: PackageIdentity): Result<Template, AppError> {
  const r = readTemplateManifest(engineRoot, engine.version);
  if (r.ok) return r;
  if (r.error.kind === 'missing') {
    return Err(
      templateError(
        `the installed engine (${engine.name}@${engine.version} at ${engineRoot}) ships no template/ directory, so there is nothing to copy or compare against.`,
        'Install an engine version that ships the module-repo template (RFC-001 PR 1.5 adds it), then run this again.',
      ),
    );
  }
  return Err(templateError(r.error.reason));
}

/** Every file under `dir`, as sorted POSIX paths relative to it. */
function walk(dir: string, base: string = dir): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(abs, base));
    else if (entry.isFile()) out.push(relative(base, abs).split(sep).join('/'));
  }
  return out.sort();
}

function readOrNull(path: string): Buffer | null {
  try {
    return readFileSync(path);
  } catch {
    return null;
  }
}

function writeBytes(target: string, bytes: Uint8Array): void {
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, bytes);
}

// ---------------------------------------------------------------------------------------
// template check
// ---------------------------------------------------------------------------------------

/** One gated file that does not match: missing from the repo, or different bytes. */
export interface Drift {
  readonly path: string;
  readonly kind: 'missing' | 'differs';
}

export function templateDrift(cwd: string, template: Template): readonly Drift[] {
  const out: Drift[] = [];
  for (const [path, digest] of template.gated) {
    const bytes = readOrNull(join(cwd, ...path.split('/')));
    if (bytes === null) out.push({ path, kind: 'missing' });
    else if (sha256Hex(bytes) !== digest) out.push({ path, kind: 'differs' });
  }
  return out;
}

/** `<bin> template check`: the offline mirror of the boot digest check (RFC-001 9.4, 9.5). */
export function templateCheck(io: CliIo, template: Template): number {
  const drift = templateDrift(io.cwd, template);
  if (drift.length === 0) {
    io.out(`template check: ${String(template.gated.size)} gated files match the installed engine's template (engine ${template.engineVersion}).\n`);
    return EXIT_OK;
  }
  io.err(`template check: ${String(drift.length)} gated file(s) do not match the installed engine's template (engine ${template.engineVersion}):\n`);
  for (const d of drift) {
    io.err(`  ${d.path}: ${d.kind === 'missing' ? 'missing from this repository' : "differs from the engine's copy"}; ${TEMPLATE_APPLY_FIX}.\n`);
  }
  return EXIT_PROBLEM;
}

// ---------------------------------------------------------------------------------------
// template apply
// ---------------------------------------------------------------------------------------

/**
 * Paths among `paths` with uncommitted changes (modified, staged, deleted or untracked), or why
 * that cannot be told. `git status --porcelain` is the one source that knows both the index and
 * the working tree; reimplementing it from file reads would be wrong in exactly the cases that
 * matter.
 */
export function dirtyPaths(cwd: string, paths: readonly string[]): Result<readonly string[], string> {
  const r = spawnSync('git', ['status', '--porcelain=v1', '--untracked-files=all', '--', ...paths], { cwd, encoding: 'utf8' });
  if (r.error !== undefined) return Err(`git could not be run (${r.error.message})`);
  if (r.status !== 0) return Err(`${cwd} is not a git working tree (${(r.stderr || '').trim().split('\n')[0] ?? 'git status failed'})`);
  return Ok(
    r.stdout
      .split('\n')
      .filter((line) => line.length > 3)
      .map((line) => line.slice(3).trim()),
  );
}

/**
 * `<bin> template apply`: rewrite every gated file from the installed engine's template.
 *
 * REFUSES on a dirty tree for those paths, and outside a git working tree: this overwrites
 * files, and the guarantee is that nothing is overwritten unseen - every change it makes is a
 * `git diff` away, and every change it would destroy is committed somewhere first. Never touches
 * anything outside the gated set, so never anything under `src/`.
 */
export function templateApply(io: CliIo, template: Template): number {
  const paths = [...template.gated.keys()];
  const dirty = dirtyPaths(io.cwd, paths);
  if (!dirty.ok) {
    io.err(
      `template apply refused: cannot tell whether the gated files have uncommitted changes, because ${dirty.error}.\n` +
        `  template apply overwrites files, so it only runs where git can show what it changed. Run it from the repository root of a git checkout.\n`,
    );
    return EXIT_PROBLEM;
  }
  if (dirty.value.length > 0) {
    io.err(
      `template apply refused: these files have uncommitted changes, and applying would overwrite them unseen:\n` +
        dirty.value.map((p) => `  ${p}\n`).join('') +
        `  Commit or stash them first, then run template apply again.\n`,
    );
    return EXIT_PROBLEM;
  }
  const changed: string[] = [];
  io.out(`template apply: engine ${template.engineVersion}\n`);
  for (const path of paths) {
    const source = readFileSync(join(template.root, ...path.split('/')));
    const target = join(io.cwd, ...path.split('/'));
    const before = readOrNull(target);
    if (before !== null && before.equals(source)) {
      io.out(`  unchanged  ${path}\n`);
      continue;
    }
    writeBytes(target, source);
    changed.push(path);
    io.out(`  ${before === null ? 'created  ' : 'updated  '}  ${path}${before === null ? '' : ` (${String(before.length)} -> ${String(source.length)} bytes)`}\n`);
  }
  io.out(
    changed.length === 0
      ? `Nothing to do: every gated file already matches.\n`
      : `${String(changed.length)} file(s) rewritten. Review with git diff, run npm run check, then commit.\n`,
  );
  return EXIT_OK;
}

// ---------------------------------------------------------------------------------------
// init
// ---------------------------------------------------------------------------------------

/** Regenerate `<dir>/package-lock.json` from `<dir>/package.json`. `Err` is the reason it could not. */
export type LockfileRegenerator = (dir: string) => Result<void, string>;

/** Paths `init` never writes, in any mode: the operator's secrets. */
const NEVER_WRITTEN = new Set(['.env']);

/** Template files `init` handles itself instead of copying (see the header). */
const NOT_COPIED = new Set([TEMPLATE_MANIFEST, 'package.json', 'package-lock.json']);

export interface InitOptions {
  /** The directory to write into, absolute. */
  readonly target: string;
  /** `--existing`: convert the repository in `target` (RFC-001 section 10 step 4). */
  readonly existing: boolean;
}

/**
 * The template's `package.json`, made concrete for this repository: the engine pinned to the
 * installed version (only when the template lists it), and `name` kept from an existing repo.
 */
export function initPackageJson(templatePackage: unknown, engine: PackageIdentity, existingName: string | null): Result<string, string> {
  if (typeof templatePackage !== 'object' || templatePackage === null || Array.isArray(templatePackage)) {
    return Err('the template package.json is not a JSON object');
  }
  const pkg: Record<string, unknown> = { ...templatePackage };
  const deps: unknown = pkg['dependencies'];
  if (typeof deps === 'object' && deps !== null && !Array.isArray(deps) && Object.hasOwn(deps, engine.name)) {
    pkg['dependencies'] = { ...deps, [engine.name]: engine.version };
  }
  if (existingName !== null) pkg['name'] = existingName;
  return Ok(`${JSON.stringify(pkg, null, 2)}\n`);
}

function readJsonObject(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * `<bin> init <dir>` writes the template into an empty directory; `<bin> init . --existing`
 * converts an existing repository (RFC-001 section 10 step 4): every template file is written
 * EXCEPT anything under `src/modules/` (a group's modules, and their migrations whose checksums
 * are in the ledger, are never touched) and `.env` (never written, in either mode);
 * `package.json` is rewritten to the template shape keeping `name`; `.github/**` is replaced by
 * the template's copies; and `package-lock.json` is DELETED and REGENERATED, because the old one
 * pins the engine's former dependencies and `npm ci` refuses an out-of-sync pair.
 */
export function init(io: CliIo, template: Template, engine: PackageIdentity, opts: InitOptions, regenerate: LockfileRegenerator): number {
  const { target, existing } = opts;
  const shown = relative(io.cwd, target) || '.';

  let existingName: string | null = null;
  if (existing) {
    const pkg = readJsonObject(join(target, 'package.json'));
    const name: unknown = typeof pkg === 'object' && pkg !== null ? Reflect.get(pkg, 'name') : undefined;
    if (typeof name !== 'string' || name.length === 0) {
      io.err(
        `init --existing refused: ${join(shown, 'package.json')} is missing or has no "name".\n` +
          `  --existing converts an existing repository and keeps its package name; for a new one run init <empty-dir>.\n`,
      );
      return EXIT_PROBLEM;
    }
    existingName = name;
  } else if (existsSync(target) && (!statSync(target).isDirectory() || readdirSync(target).length > 0)) {
    io.err(
      `init refused: ${shown} is not an empty directory.\n` +
        `  init writes a new module repository into an empty directory. To convert the repository there, run init ${shown} --existing.\n`,
    );
    return EXIT_PROBLEM;
  }

  const templatePackage = readJsonObject(join(template.root, 'package.json'));
  const pkgText = initPackageJson(templatePackage, engine, existingName);
  if (!pkgText.ok) {
    io.err(`init refused: ${pkgText.error}.\n  ${describeAppError(templateError('the template has no usable package.json'))}\n`);
    return EXIT_PROBLEM;
  }

  const written: string[] = [];
  const kept: string[] = [];
  for (const path of walk(template.root)) {
    if (NOT_COPIED.has(path)) continue;
    if (NEVER_WRITTEN.has(path)) {
      kept.push(`${path} (never written by init)`);
      continue;
    }
    if (existing && path.startsWith('src/modules/')) {
      kept.push(path);
      continue;
    }
    const source = readFileSync(join(template.root, ...path.split('/')));
    const destPath = RENAMED_ON_INIT.get(path) ?? path;
    const dest = join(target, ...destPath.split('/'));
    const before = readOrNull(dest);
    if (before !== null && before.equals(source)) continue;
    writeBytes(dest, source);
    written.push(before === null ? destPath : `${destPath} (replaced)`);
  }
  const pkgPath = join(target, 'package.json');
  const pkgBefore = readOrNull(pkgPath);
  writeBytes(pkgPath, Buffer.from(pkgText.value, 'utf8'));
  written.push(pkgBefore === null ? 'package.json' : 'package.json (rewritten to the template shape, name kept)');

  // `.github/**` is the template's now. A file there the template does not carry is left in
  // place and NAMED, rather than deleted: it may be the operator's own workflow.
  const extraGithub = existing && existsSync(join(target, '.github'))
    ? walk(join(target, '.github')).map((p) => `.github/${p}`).filter((p) => !existsSync(join(template.root, ...p.split('/'))))
    : [];

  io.out(`init: ${existing ? 'converted' : 'created'} ${shown} from the template of engine ${engine.name}@${engine.version}\n`);
  for (const w of written) io.out(`  wrote  ${w}\n`);
  if (kept.length > 0) io.out(`  left untouched: ${String(kept.length)} file(s) under src/modules/ or .env\n`);
  for (const p of extraGithub) io.out(`  note: ${p} is not part of the template and was left in place; the CI gates only check the template's files.\n`);

  // THE LOCKFILE, last, against the package.json just written. The stale one is removed FIRST,
  // so a failed regeneration can never leave the old, out-of-sync pair behind looking valid.
  const lockPath = join(target, 'package-lock.json');
  const hadLock = existsSync(lockPath);
  rmSync(lockPath, { force: true });
  const regenerated = regenerate(target);
  if (!regenerated.ok) {
    io.err(
      `\ninit: could not generate package-lock.json: ${regenerated.error}\n` +
        `  ${hadLock ? 'The old package-lock.json was removed, because it no longer matched package.json. ' : ''}` +
        `Run npm install --package-lock-only --ignore-scripts in ${shown} before npm ci.\n`,
    );
    return EXIT_PROBLEM;
  }
  io.out(`  wrote  package-lock.json (${hadLock ? 'regenerated; the old one pinned the previous dependencies' : 'generated'})\n`);

  io.out(
    `\nNext:\n` +
      (shown === '.' ? '' : `  cd ${shown}\n`) +
      `  npm ci && npm run check\n` +
      (existing ? '' : `  cp .env.example .env      # then fill it in\n`) +
      `  npx ${CLI_BIN} doctor\n` +
      `  npm start\n` +
      `The README in the repository walks through the GitHub App and Discord setup.\n`,
  );
  return EXIT_OK;
}
