/**
 * FILESYSTEM MODULE DISCOVERY - the half of the composition root that finds modules.
 *
 * `src/modules/<id>/module.ts` is the entry point, its default export is the
 * `ModuleDescriptor` that `defineModule` returned, and the folder is the wiring. Nothing
 * registers itself; nothing is listed in a manifest that can drift from the tree.
 *
 * THREE SEVERITIES, and keeping them apart is the entire point of this file:
 *
 *  1. SKIPPED.     `MODULES_DISABLE` names it. It is not even imported. That ordering is
 *                  load-bearing: the operator's escape hatch has to work for a module that
 *                  throws AT IMPORT, and a disable checked after the import would not.
 *  2. QUARANTINED. It threw while being imported, its default export is not a module, its
 *                  migrations failed, or `setup()` threw. It is reported, it shows up in
 *                  `/status` through the catalog, and EVERY OTHER MODULE STILL BOOTS. One
 *                  broken module must never be able to take the process down - that is the
 *                  difference between "tags is broken" and "the bot is down".
 *  3. FATAL.       A duplicate module id or a duplicate command name. The process REFUSES TO
 *                  START and names both sides. Discord's command namespace is global, so
 *                  last-wins here means half the team spends three weeks looking at the wrong
 *                  handler's output. A loud refusal at boot is strictly cheaper.
 *
 * WHY `pathToFileURL` AND NOT A BARE PATH - verified by execution on Windows 11 / Node
 * v24.16.0, and re-asserted by `loader.test.ts`:
 *
 *     await import('C:\\...\\module.ts')
 *       -> ERR_UNSUPPORTED_ESM_URL_SCHEME: Only URLs with a scheme in: file, data, and node
 *          are supported by the default ESM loader. On Windows, absolute paths must be valid
 *          file:// URLs. Received protocol 'c:'
 *
 * The drive letter parses as a URL scheme. `pathToFileURL(abs).href` is the fix, it is correct
 * on POSIX too, and it is also what makes a path containing `#` or `?` load at all.
 *
 * WHY THIS FILE INSTALLS MODULES ITSELF INSTEAD OF CALLING `core/registry.loadModules`:
 * `LoaderIO.ports` is ONE port bag shared by every module, but `db`, `audit` and `jobs` are
 * per-module ports - `sqlite.moduleDb(id)` is what scopes a module to `m_<id>_*`, and
 * `auditLog.portFor(id)` is what makes an audit row's `module_id` unspoofable. A single shared
 * bag would hand every module the same database scope. So the install loop below mirrors
 * `loadModules` exactly - same problem kinds, same quarantine-vs-fatal split - but takes a
 * `portsFor(moduleId)` factory. Indexing and every collision check are still core's
 * `buildRegistry`; none of that logic is duplicated here.
 */

import { readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import type { AppError } from '#core/errors';
import { errors, operatorMessage } from '#core/errors';
import type { EventBus } from '#core/events';
import type { InstalledModule, ModuleDescriptor } from '#core/module';
import { MODULE_ID_RE } from '#core/module';
import type { LoggerPort, PortRegistry } from '#core/ports';
import type { LoadReport, QuarantinedModule, RegistryProblem } from '#core/registry';
import { buildRegistry, describeProblem } from '#core/registry';
import { Err, Ok, type Result } from '#core/result';

/** The one file name a module folder must contain. Also what `npm run scaffold` writes. */
export const MODULE_ENTRY = 'module.ts';

/**
 * `src/modules`, resolved from THIS FILE rather than from `process.cwd()`.
 * WHY: `node src/main.ts` and `node --test` do not always run from the same directory, and a
 * cwd-relative module path is a bug waiting for the first cron job or systemd unit.
 */
export function defaultModulesDir(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), 'modules');
}

/**
 * One directory that is scanned for `<id>/<entry>` (RFC-001 section 4.2).
 *
 * WHY `entry` belongs to the root: the published package is compiled, so `dist/loader.js` must
 * look for `module.js` while the source tree looks for `module.ts`.
 */
export interface ModuleRoot {
  readonly dir: string;
  readonly entry: 'module.ts' | 'module.js';
  /** True: a missing directory is a config error. False: it is an empty root (`Ok([])`). */
  readonly required: boolean;
}

/** The built-in modules, resolved from THIS FILE so the cwd never matters. */
export function builtinRoot(): ModuleRoot {
  return {
    dir: resolve(dirname(fileURLToPath(import.meta.url)), 'modules'),
    entry: import.meta.url.endsWith('.ts') ? 'module.ts' : 'module.js',
    required: false,
  };
}

/** One module folder that produced a descriptor. */
export interface DiscoveredModule {
  /** The folder name. What an operator writes in `MODULES_DISABLE`. */
  readonly folder: string;
  /** Absolute path to the folder, so `migrationsDirFor` needs no second lookup. */
  readonly dir: string;
  /** The entry path, as printed on both sides of a collision. */
  readonly source: string;
  readonly descriptor: ModuleDescriptor;
}

/** What a scan found. Nothing here is fatal: a fatal problem needs the whole set to be known. */
export interface DiscoveryReport {
  readonly discovered: readonly DiscoveredModule[];
  /** Folders that failed to import, or whose default export is not a module. */
  readonly quarantined: readonly QuarantinedModule[];
  /** Folder names `MODULES_DISABLE` skipped, before any import ran. */
  readonly skipped: readonly string[];
}

export interface DiscoverOptions {
  /** Scanned in order, built-ins first. Defaults to `[builtinRoot()]`. Wins over `dir`. */
  readonly roots?: readonly ModuleRoot[];
  /** Convenience for tests: one optional `module.ts` root. Ignored when `roots` is given. */
  readonly dir?: string;
  /** `MODULES_DISABLE`, already split by `loadConfig`. Matched against the FOLDER name here. */
  readonly disabled: ReadonlySet<string>;
  readonly logger: LoggerPort;
}

/** Where a module's `*.sql` files live. */
export function migrationsDirFor(m: DiscoveredModule): string {
  return join(m.dir, 'migrations');
}

/** Prefer a cwd-relative path in operator output, but never an ambiguous one. */
function displayPath(abs: string): string {
  const rel = relative(process.cwd(), abs);
  return rel.length > 0 && !rel.startsWith('..') ? rel.split('\\').join('/') : abs;
}

function thrownMessage(cause: unknown): string {
  if (cause instanceof Error) return `${cause.name}: ${cause.message}`;
  if (typeof cause === 'string') return cause;
  return Object.prototype.toString.call(cause);
}

/**
 * Is this the thing `defineModule` returns?
 *
 * WHY a structural probe and not a cast: the default export of a `.ts` file discovered on disk
 * is genuinely `unknown` - a half-edited module can export a string - and casting it would
 * turn "you exported the wrong thing" into a `TypeError` thrown out of `install` and blamed
 * on core.
 */
function isModuleDescriptor(value: unknown): value is ModuleDescriptor {
  if (typeof value !== 'object' || value === null) return false;
  if (typeof Reflect.get(value, 'install') !== 'function') return false;
  const manifest: unknown = Reflect.get(value, 'manifest');
  if (typeof manifest !== 'object' || manifest === null) return false;
  return typeof Reflect.get(manifest, 'id') === 'string';
}

/** A module folder on disk, before anything has been imported. */
export interface ModuleFolder {
  readonly folder: string;
  readonly dir: string;
  readonly entry: string;
}

/** Folders under `dir` that contain `entry`, sorted, so boot order is deterministic. */
export function findModuleFolders(dir: string, entryName: string = MODULE_ENTRY): Result<readonly ModuleFolder[], AppError> {
  if (statSync(dir, { throwIfNoEntry: false })?.isDirectory() !== true) return Ok([]);

  let entries: readonly string[];
  try {
    entries = readdirSync(dir);
  } catch (cause: unknown) {
    return Err(
      errors.config(
        'modules',
        `cannot read ${dir}: ${thrownMessage(cause)}`,
        'Make src/modules readable by the bot process and restart.',
      ),
    );
  }

  const found: ModuleFolder[] = [];
  for (const folder of [...entries].sort((a, b) => a.localeCompare(b))) {
    const folderDir = join(dir, folder);
    if (statSync(folderDir, { throwIfNoEntry: false })?.isDirectory() !== true) continue;
    const entry = join(folderDir, entryName);
    if (statSync(entry, { throwIfNoEntry: false })?.isFile() !== true) continue;
    found.push({ folder, dir: folderDir, entry });
  }
  return Ok(found);
}

// ---------------------------------------------------------------------------------------
// The boot import scan (AGENTS.md rule 1, enforced at runtime for directories we did not write)
// ---------------------------------------------------------------------------------------

const BANNED_EXACT: ReadonlySet<string> = new Set([
  'discord.js',
  'octokit',
  'node:sqlite',
  'node:fs',
  'node:child_process',
  'node:net',
  'node:http',
  'node:https',
  'node:dns',
  'pino',
]);
const BANNED_PREFIXES: readonly string[] = ['node:fs/', '@octokit/', '#adapters/', '#lib/'];

function isBannedSpecifier(spec: string): boolean {
  return BANNED_EXACT.has(spec) || BANNED_PREFIXES.some((p) => spec.startsWith(p));
}

/** Same regexes as `importsOf` in `conventions.test.ts`, plus the bare `import 'x'` form. */
function specifiersOf(source: string): string[] {
  const text = source.replace(/\/\*[\s\S]*?\*\//gu, ' ').replace(/(^|[^:])\/\/[^\n]*/gu, '$1 ');
  return [
    ...[...text.matchAll(/from\s+['"]([^'"]+)['"]/gu)].map((m) => m[1] ?? ''),
    ...[...text.matchAll(/import\(\s*['"]([^'"]+)['"]\s*\)/gu)].map((m) => m[1] ?? ''),
    ...[...text.matchAll(/(?:^|[\s;])import\s+['"]([^'"]+)['"]/gu)].map((m) => m[1] ?? ''),
  ];
}

function sourceFilesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules') out.push(...sourceFilesUnder(full));
    } else if (/\.(?:ts|js)$/u.test(entry.name) && !/\.test\.(?:ts|js)$/u.test(entry.name)) {
      out.push(full);
    }
  }
  return out.sort((a, b) => a.localeCompare(b));
}

/**
 * The first banned import in a module folder, found WITHOUT importing anything.
 *
 * WHAT THIS IS NOT: a sandbox. It is a textual scan that catches mistakes and agent output, not
 * a determined author - `import(atob('...'))`, a computed specifier, or `process.binding` all
 * pass it. A module directory is still trusted code; this only makes the common wrong turn fail
 * at boot instead of in review. `*.test.*` files are skipped because module tests legitimately
 * import `node:fs` and friends.
 */
function findBannedImport(folderDir: string): { readonly file: string; readonly spec: string } | null {
  for (const file of sourceFilesUnder(folderDir)) {
    for (const spec of specifiersOf(readFileSync(file, 'utf8'))) {
      if (isBannedSpecifier(spec)) return { file, spec };
    }
  }
  return null;
}

/** A directory's identity: the real path when it exists, otherwise its resolved spelling. */
function rootIdentity(dir: string): string {
  try {
    return realpathSync(dir);
  } catch {
    return resolve(dir);
  }
}

/**
 * Import every module folder under one root.
 *
 * An `Err` here means the DIRECTORY could not be read, which is an operator problem. A module
 * that fails to import is an `Ok` with a quarantine entry, because the bot must still start.
 */
async function scanRoot(
  root: ModuleRoot,
  opts: { readonly disabled: ReadonlySet<string>; readonly logger: LoggerPort },
): Promise<Result<DiscoveryReport, AppError>> {
  const dir = root.dir;
  if (root.required && statSync(dir, { throwIfNoEntry: false })?.isDirectory() !== true) {
    return Err(
      errors.config(
        'MODULE_DIRS',
        `${displayPath(dir)} is not a directory`,
        'Fix MODULE_DIRS in .env, or remove it to use ./src/modules.',
      ),
    );
  }
  const folders = findModuleFolders(dir, root.entry);
  if (!folders.ok) return folders;

  const discovered: DiscoveredModule[] = [];
  const quarantined: QuarantinedModule[] = [];
  const skipped: string[] = [];

  for (const found of folders.value) {
    const source = displayPath(found.entry);

    // BEFORE the import, on purpose: a module that throws at import can only be escaped by a
    // disable that is checked first.
    if (opts.disabled.has(found.folder)) {
      skipped.push(found.folder);
      opts.logger.warn('module disabled by MODULES_DISABLE; not imported', { module: found.folder, source });
      continue;
    }

    // Also BEFORE the import: a banned module must never get to run its top level.
    let banned: ReturnType<typeof findBannedImport>;
    try {
      banned = findBannedImport(found.dir);
    } catch (cause: unknown) {
      const error = errors.config(
        found.folder,
        `cannot read ${displayPath(found.dir)} for the import scan: ${thrownMessage(cause)}`,
        `Make ${displayPath(found.dir)} readable, or start with MODULES_DISABLE=${found.folder}.`,
      );
      opts.logger.error('module unreadable; quarantined', { module: found.folder, source });
      quarantined.push({ moduleId: found.folder, cause: error });
      continue;
    }
    if (banned !== null) {
      const error = errors.config(
        found.folder,
        `${displayPath(banned.file)} imports "${banned.spec}", which a module may not (AGENTS.md rule 1)`,
        `Fix the import or start with MODULES_DISABLE=${found.folder}.`,
      );
      opts.logger.error('module imports a banned specifier; quarantined', {
        module: found.folder,
        source,
        cause: operatorMessage(error),
      });
      quarantined.push({ moduleId: found.folder, cause: error });
      continue;
    }

    let loaded: object;
    try {
      // THE WINDOWS FIX. A bare absolute path here is ERR_UNSUPPORTED_ESM_URL_SCHEME.
      loaded = await import(pathToFileURL(found.entry).href);
    } catch (cause: unknown) {
      const error = errors.config(
        found.folder,
        `importing ${source} threw: ${thrownMessage(cause)}`,
        `Fix ${source}, or start with MODULES_DISABLE=${found.folder}.`,
      );
      opts.logger.error('module failed to import; quarantined', {
        module: found.folder,
        source,
        cause: operatorMessage(error),
      });
      quarantined.push({ moduleId: found.folder, cause: error });
      continue;
    }

    const descriptor: unknown = Reflect.get(loaded, 'default');
    if (!isModuleDescriptor(descriptor)) {
      const error = errors.config(
        found.folder,
        `${source} does not default-export the result of defineModule()`,
        `Add "export default defineModule({ ... })" to ${source}.`,
      );
      opts.logger.error('module has no usable default export; quarantined', { module: found.folder, source });
      quarantined.push({ moduleId: found.folder, cause: error });
      continue;
    }

    const id = descriptor.manifest.id;
    if (id !== found.folder) {
      // NOT fatal, and not silent: the folder name is what an operator disables and where the
      // migrations are read from, while the id is the table prefix and half of every
      // custom_id. A mismatch still works; it just makes every later instruction ambiguous.
      opts.logger.warn('module id does not match its folder name', { module: id, folder: found.folder, source });
    }

    discovered.push({ folder: found.folder, dir: found.dir, source, descriptor });
  }

  opts.logger.info('module root scanned', {
    dir: displayPath(dir),
    entry: root.entry,
    discovered: discovered.length,
    quarantined: quarantined.length,
    skipped: skipped.length,
  });

  return Ok({ discovered, quarantined, skipped });
}

/**
 * Scan every root, in order (built-ins first), and merge the reports.
 *
 * Roots that resolve to the same real directory are scanned ONCE, first spelling wins: in the
 * engine checkout the built-in root and the default `MODULE_DIRS=./src/modules` are the same
 * directory, and without this every built-in would be found twice and `installModules` would
 * refuse to start with `duplicate-module`. A module id found in two DIFFERENT roots is still
 * fatal there, naming both sources.
 */
export async function discoverModules(opts: DiscoverOptions): Promise<Result<DiscoveryReport, AppError>> {
  const requested: readonly ModuleRoot[] =
    opts.roots ??
    (opts.dir !== undefined ? [{ dir: opts.dir, entry: 'module.ts', required: false }] : [builtinRoot()]);

  const seen = new Map<string, string>();
  const roots: ModuleRoot[] = [];
  for (const root of requested) {
    const id = rootIdentity(root.dir);
    const first = seen.get(id);
    if (first !== undefined) {
      opts.logger.debug('duplicate module root dropped', { dropped: root.dir, keptAs: first });
      continue;
    }
    seen.set(id, root.dir);
    roots.push(root);
  }

  const discovered: DiscoveredModule[] = [];
  const quarantined: QuarantinedModule[] = [];
  const skipped: string[] = [];
  for (const root of roots) {
    const report = await scanRoot(root, opts);
    if (!report.ok) return report;
    discovered.push(...report.value.discovered);
    quarantined.push(...report.value.quarantined);
    skipped.push(...report.value.skipped);
  }
  return Ok({ discovered, quarantined, skipped });
}

/** What `installModules` needs. `portsFor` is the reason this is not `core.loadModules`. */
export interface InstallInput {
  readonly discovered: readonly DiscoveredModule[];
  /** The per-module port bag. `portsFor` in `#core/ports` then narrows it to what it declared. */
  portsFor(moduleId: string): Readonly<Partial<PortRegistry>>;
  /** The raw `config.modules.<id>` slice; the module's own zod schema validates it. */
  configFor(moduleId: string): unknown;
  readonly bus: EventBus;
  readonly logger: LoggerPort;
  /** Matched against the module ID here; `discoverModules` already matched the folder name. */
  readonly disabled: ReadonlySet<string>;
  /** Quarantines carried in from discovery and from the migration runner. */
  readonly quarantined?: readonly QuarantinedModule[];
}

/**
 * Install every discovered module, then index them with core's `buildRegistry`.
 *
 * The `Err` arm is the REFUSAL TO START: duplicate ids and duplicate command names, with both
 * sides named. `formatProblems` turns it into the boot log. The `Ok` arm carries the
 * quarantine list, which `buildCatalog` renders through `/status` so a quarantine is never
 * invisible.
 */
export function installModules(input: InstallInput): Result<LoadReport, readonly RegistryProblem[]> {
  const installed: InstalledModule[] = [];
  const quarantined: QuarantinedModule[] = [...(input.quarantined ?? [])];
  const fatal: RegistryProblem[] = [];
  /** id -> the source that claimed it first, so a collision can name BOTH files. */
  const claimedBy = new Map<string, string>();

  for (const m of input.discovered) {
    const id = m.descriptor.manifest.id;

    if (!MODULE_ID_RE.test(id)) {
      fatal.push({ kind: 'bad-module-id', id, source: m.source });
      continue;
    }
    if (input.disabled.has(id)) {
      input.logger.warn('module disabled by MODULES_DISABLE; not installed', { module: id, source: m.source });
      continue;
    }

    const prior = claimedBy.get(id);
    if (prior !== undefined) {
      fatal.push({ kind: 'duplicate-module', id, sources: [prior, m.source] });
      continue;
    }
    claimedBy.set(id, m.source);

    // `install` never throws: `defineModule` catches whatever `setup` did and returns `Err`.
    const result = m.descriptor.install({
      ports: input.portsFor(id),
      rawConfig: input.configFor(id),
      bus: input.bus,
      logger: input.logger,
    });
    if (!result.ok) {
      input.logger.error('module failed to install; quarantined', {
        module: id,
        source: m.source,
        cause: operatorMessage(result.error),
      });
      quarantined.push({ moduleId: id, cause: result.error });
      continue;
    }
    installed.push(result.value);
  }

  const built = buildRegistry(installed);
  // WHY both lists: an operator fixing one collision per restart is a worse outcome than a
  // wall of text, and a duplicate id and a duplicate command are usually the same mistake.
  if (!built.ok) return Err([...fatal, ...built.error]);
  if (fatal.length > 0) return Err(fatal);

  return Ok({ registry: built.value, quarantined });
}

/** One line per quarantined module, in the same voice `formatProblems` uses. */
export function describeQuarantine(q: QuarantinedModule): string {
  return describeProblem({ kind: 'setup-failed', moduleId: q.moduleId, cause: q.cause });
}
