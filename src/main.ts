/**
 * THE COMPOSITION ROOT. The only file allowed to know every layer at once.
 *
 * Everything below it is either a port (an interface with no idea who implements it) or an
 * adapter (an implementation with no idea who calls it). This file is where the two meet, and
 * it is deliberately the only place `process.env`, `discord.js`, `octokit` and `node:sqlite`
 * are all in scope. That is why it is also the only file that may be boring: no cleverness
 * here, just an order of operations and a shutdown that actually runs.
 *
 * THE ORDER, AND WHY IT IS THAT ORDER:
 *
 *   1. config          - a missing DISCORD_TOKEN must cost one readable sentence and exit 1,
 *                        not a stack trace and not a 401 retry loop two days later.
 *   2. logger          - after config, because its level comes from config. Everything before
 *                        this point prints to stderr in plain English.
 *   3. database        - open, core schema, then per-module migrations. A module whose
 *                        migration fails is QUARANTINED, not fatal.
 *   4. modules         - discovered from the filesystem, installed with per-module ports.
 *                        A collision REFUSES TO START; a broken module is quarantined.
 *   5. ports           - assembled once, handed out per module. `PortRegistry` is spelled in
 *                        full below so that adding a port to core fails to compile HERE until
 *                        someone wires it.
 *  5b. github preflight- three reads per configured repository (RFC-001 PR 2.1: one adapter per
 *                        repository of the set), once, right after the adapters exist. A 401 or a 404 is
 *                        a wrong value in the environment and stops the boot with the same
 *                        sentence a bad DISCORD_TOKEN gets; anything else is warned about and
 *                        the bot starts. Without it the first person to learn that the PAT
 *                        expired is a user who clicked Approve and then waited hours for a
 *                        timeout, about a build that never started. Then the CONTAINMENT
 *                        probes (RFC-001 5.4, `containment.ts`): a public repo, a missing
 *                        APPROVAL_HMAC_KEY secret, unreadable secrets on a PAT, refused
 *                        environments, an unfunded ai-agent each refuse to start; a GitHub blip
 *                        on any of them warns and starts with builds down. And the gate-file
 *                        digest check once, for the log (never fatal; it runs per dispatch).
 *   6. router          - attached BEFORE login, so no interaction arrives without a listener.
 *   7. login           - the first thing that can fail for a reason outside this machine.
 *   8. commands        - deployed only when the payload digest changed. A global PUT is rate
 *                        limited to a handful per day; a restart loop that re-registers every
 *                        boot burns that budget and can leave the command list EMPTY.
 *   9. jobs            - `recover()` first (re-queue what the dead process was running), then
 *                        `start()`. Reversing those two races the reclaimer against itself.
 *
 * AND THE THREE WAYS IT ENDS:
 *
 *   SIGINT/SIGTERM  -> stop taking new work, let in-flight jobs finish or checkpoint inside a
 *                      grace period, detach the router, destroy the client, close the DB,
 *                      exit 0. A SECOND signal exits immediately: an operator hitting Ctrl-C
 *                      twice means "now", and a shutdown that ignores that gets SIGKILLed with
 *                      its leases still held.
 *   uncaughtException / unhandledRejection
 *                   -> log with the stack and exit NON-ZERO. Never die silently, and never
 *                      keep serving from a state nobody can describe. A process that keeps
 *                      running after an unhandled rejection is a process holding job leases it
 *                      may no longer be honouring.
 *   boot failure    -> a sentence, and exit 1.
 */

import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';

import type { AppError } from '#core/errors';
import { errors, operatorMessage } from '#core/errors';
import { createEventBus } from '#core/events';
import {
  builderRequiresOwnCredentials,
  loadConfig,
  moduleConfigSlice,
  removedBuilderKeyWarnings,
  type AppConfig,
} from '#core/config';
import type { AdminPort, CatalogPort, PortRegistry, VersionPort } from '#core/ports';
import { describeBuild, describeGithubAuth } from '#core/ports';
import { checkEnginePin } from '#core/version';
import type { DocStore } from '#core/ports/db';
import { buildCatalog, formatProblems } from '#core/registry';

import {
  channelScopedDelivery,
  createDiscordClient,
  deployCommands,
  login,
  restPut,
  shutdownClient,
  type CommandSyncStore,
  type DeployableCommand,
} from '#adapters/discord/client';
import { attachRouter } from '#adapters/discord/router';
import { logPreflightWarnings, readTemplateGateFiles, resolveGithubAuth } from '#adapters/github/index';
import { createGithubRepoSet } from '#adapters/github/repo-set';
import { ensureCoreSchema, openSqlite } from '#adapters/sqlite/db';
import { readMigrationDir, runCoreMigrations, runMigrations } from '#adapters/sqlite/migrate';
import { createAccess, fallbacksFromCatalog } from '#adapters/system/access';
import { createAuditLog } from '#adapters/system/audit';
import { systemClock } from '#adapters/system/clock';
import { createJobSystem } from '#adapters/system/jobs';
import { createLogger } from '#adapters/system/logger';
import { createRateGate } from '#adapters/system/ratelimit';
import { createSettings } from '#adapters/system/settings';
import { checkZodSingleCopy, enginePackageRoot, readBuildInfo, readRepoManifest } from '#adapters/system/version';

import {
  builtinRoot,
  describeQuarantine,
  discoverModules,
  installModules,
  migrationsDirFor,
  type DiscoveredModule,
  type ModuleRoot,
} from './loader.ts';

// ---------------------------------------------------------------------------------------
// Constants an operator may need to reason about at 3am
// ---------------------------------------------------------------------------------------

/** How long in-flight jobs get to finish or checkpoint after a signal. */
export const SHUTDOWN_GRACE_MS = 10_000;

/** The point at which a hung shutdown is worse than an abrupt one. */
export const SHUTDOWN_HARD_LIMIT_MS = 20_000;

/** `core_docs` collection holding the last-deployed command digest, per scope. */
export const COMMAND_SYNC_COLLECTION = 'command-sync';

/** The audit `module_id` for rows the ROUTER writes (a denial is nobody's module's fault). */
export const ROUTER_AUDIT_ID = 'router';

// ---------------------------------------------------------------------------------------
// One engine per process
// ---------------------------------------------------------------------------------------

/** The engine's npm package name, as `npm ls` wants it. */
export const ENGINE_PACKAGE = 'discord-ai-feature-builder';

/**
 * Where a running engine registers itself. `Symbol.for`, so a second copy of this file - which
 * has its own module scope and would never see a module-level `let` - finds the same key.
 */
export const ENGINE_KEY: unique symbol = Symbol.for(`${ENGINE_PACKAGE}.engine`);

/** What the registration holds. */
export interface EngineClaim {
  readonly version: string;
  /** The engine's package root: two copies of the engine are two different directories. */
  readonly path: string;
}

/**
 * Register this engine on `registry` (`globalThis` in production), or say why it must not start.
 *
 * WHY THIS EXISTS (RFC-001 section 4.3, "Module identity"): every runtime symbol core relies on -
 * the `UserText` brands, the `Ok`/`Err` shapes, the event bus - is one instance only because the
 * engine's own imports and a module repo's `#core/*` imports land on ONE file under
 * `node_modules/discord-ai-feature-builder/dist/`. A nested second copy of the package (some
 * dependency pulling in another version) breaks that silently: a `UserText` minted by one copy
 * fails the other's brand check, deep inside a handler. Refusing at boot names the two paths and
 * the command that fixes it instead.
 *
 * Returns `null` when the claim succeeded (including a re-claim by the same path, which is the
 * same engine), and the refusal sentence otherwise. Pure apart from writing `registry`, so a test
 * can hand it an object instead of `globalThis`.
 */
export function claimEngine(self: EngineClaim, registry: object = globalThis): string | null {
  const prior: unknown = Reflect.get(registry, ENGINE_KEY);
  if (prior !== undefined) {
    const priorPath =
      typeof prior === 'object' && prior !== null && typeof Reflect.get(prior, 'path') === 'string'
        ? String(Reflect.get(prior, 'path'))
        : 'an unknown path';
    if (priorPath === self.path) return null;
    return `two copies of ${ENGINE_PACKAGE} are loaded (${priorPath}, ${self.path}); run npm ls ${ENGINE_PACKAGE} and dedupe`;
  }
  const claim: EngineClaim = { version: self.version, path: self.path };
  Reflect.set(registry, ENGINE_KEY, claim);
  return null;
}

// ---------------------------------------------------------------------------------------
// Failure text, before a logger exists
// ---------------------------------------------------------------------------------------

/**
 * The message an operator reads when the bot refuses to start.
 *
 * NOT a stack trace, and not a pino line: at this point the logger does not exist yet, and
 * `internal` on a config error is `z.prettifyError` output that already names EVERY missing
 * variable at once - one restart per typo is the failure mode this replaces.
 */
export function formatConfigFailure(error: AppError): string {
  const where = error.kind === 'config' ? error.location : error.code;
  const detail = error.internal ?? 'no further detail was recorded';
  return [
    '',
    `discord-bot cannot start: ${error.userDetail}`,
    `  where: ${where}`,
    '',
    ...detail.split('\n').map((line) => `  ${line}`),
    '',
    `  what to do: ${error.nextStep}`,
    '',
  ].join('\n');
}

/** WHY stderr and not the logger: this runs before, or instead of, a logger. */
function say(text: string): void {
  process.stderr.write(`${text}\n`);
}

function thrownMessage(cause: unknown): string {
  if (cause instanceof Error) return `${cause.name}: ${cause.message}`;
  if (typeof cause === 'string') return cause;
  return Object.prototype.toString.call(cause);
}

function thrownStack(cause: unknown): string {
  return cause instanceof Error && typeof cause.stack === 'string' ? cause.stack : '(no stack)';
}

// ---------------------------------------------------------------------------------------
// The command-sync store
// ---------------------------------------------------------------------------------------

/**
 * Remember the last deployed command digest across restarts, in `core_docs`.
 *
 * WHY the document store and not a table of its own: it is one string per scope, `core_docs`
 * is already created by `ensureCoreSchema`, and putting it there means the deploy guard works
 * on a database whose migrations have not run yet.
 *
 * WHY a failed `put` is swallowed rather than surfaced: the worst case is one redundant PUT on
 * the next boot. Refusing to start because a cache write lost a compare-and-set would be a
 * strictly worse trade.
 */
export function commandSyncStore(docs: DocStore): CommandSyncStore {
  return {
    read(scope: string): string | undefined {
      const digest = docs.get(COMMAND_SYNC_COLLECTION, scope)?.json['digest'];
      return typeof digest === 'string' ? digest : undefined;
    },
    write(scope: string, digest: string): void {
      const current = docs.get(COMMAND_SYNC_COLLECTION, scope);
      docs.put(COMMAND_SYNC_COLLECTION, scope, { digest }, current?.version ?? 0);
    },
  };
}

// ---------------------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------------------

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
}

/** WHY not `let resolve!: ...`: a definite-assignment assertion is a claim the compiler cannot
 *  check, and this costs one no-op instead. */
function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve: (value: T) => resolve(value) };
}

/**
 * A `CatalogPort` that forwards to the catalog once it exists.
 *
 * WHY IT HAS TO BE LATE-BOUND: `access` needs permission fallbacks, which come from the
 * catalog, which is built from the registry, which is built by installing the modules that
 * `access` is handed to. A snapshot taken at wiring time would be permanently empty - and an
 * empty fallback resolver DENIES, which is the safe direction but would deny everything
 * forever. The indirection is one object; the alternative is a wiring cycle.
 */
function lateCatalog(read: () => CatalogPort | null): CatalogPort {
  return {
    modules: () => read()?.modules() ?? [],
    commands: () => read()?.commands() ?? [],
    permissions: () => read()?.permissions() ?? [],
    async health() {
      const live = read();
      return live === null ? [] : await live.health();
    },
  };
}

// ---------------------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------------------

/**
 * Run the bot until it is asked to stop. Resolves with the process exit code.
 *
 * WHY it returns a code rather than calling `process.exit`: `process.exit` truncates pending
 * writes on a pipe, and the last thing written is usually the reason for the exit.
 */
export async function run(env: Readonly<Record<string, string | undefined>> = process.env): Promise<number> {
  // --- (-1) one engine per process, before anything else ---------------------------------
  //
  // Read ONCE, here, and carried for the life of the process. Everything that reports which
  // build is running reports this same object, so `/status`, the boot log and a crash line
  // cannot disagree - and none of them can start answering differently because somebody ran
  // `git pull` on the host while the old code was still in memory. It is read this early
  // because the engine guard needs the engine's version, and it never throws.
  const build = readBuildInfo(env);
  const refusal = claimEngine({ version: build.engine.version, path: enginePackageRoot() });
  if (refusal !== null) {
    say(`\ndiscord-bot cannot start: ${refusal}\n`);
    return 1;
  }
  // THE ENGINE PIN (RFC-001 5.4): the module repo's package.json must ask for the engine that is
  // installed, because the gate files the digest check compares against are that engine's.
  const pin = checkEnginePin(readRepoManifest(), build.engine);
  if (pin.kind === 'refuse') {
    say(`\ndiscord-bot cannot start: ${pin.sentence}\n`);
    return 1;
  }
  if (pin.kind === 'warn') say(`  warning: ${pin.sentence}`);
  // ONE COPY OF ZOD (RFC-001 4.3): `doctor` runs the same check, so the sentence is the same.
  const zodCopies = checkZodSingleCopy(enginePackageRoot());
  if (zodCopies.kind === 'refuse') {
    say(`\ndiscord-bot cannot start: ${zodCopies.sentence}\n`);
    return 1;
  }

  // --- (0) crash handlers, before anything can crash -------------------------------------
  //
  // Registered once, and RE-POINTED at the graceful path once there is something to shut down.
  // Two `process.on` registrations would both fire and race each other to exit.
  let onFatal = (reason: string, cause: unknown): void => {
    say(`\ndiscord-bot died during boot (${reason}): ${thrownMessage(cause)}`);
    say(thrownStack(cause));
    process.exit(1);
  };
  process.on('uncaughtException', (cause: unknown) => {
    onFatal('uncaughtException', cause);
  });
  process.on('unhandledRejection', (cause: unknown) => {
    onFatal('unhandledRejection', cause);
  });

  // --- (1) config ------------------------------------------------------------------------
  const parsed = loadConfig(env);
  if (!parsed.ok) {
    say(formatConfigFailure(parsed.error));
    return 1;
  }
  const cfg: AppConfig = parsed.value;

  // --- (2) logger ------------------------------------------------------------------------
  const clock = systemClock();
  const bootId = randomUUID();
  const logger = createLogger({
    level: cfg.logLevel,
    clock,
    // VERSION IS BOUND TO EVERY LINE, not just to the boot line. A log excerpt in a bug report
    // is usually three lines pasted out of the middle, and the build has to be on one of them
    // or the first question back is always the same one.
    base: {
      service: 'discord-bot',
      env: cfg.nodeEnv,
      bootId,
      engineVersion: build.engine.version,
      version: build.repo.version,
      gitSha: build.repo.gitSha ?? 'unknown',
    },
  });
  // THE LINE AN OPERATOR GREPS FOR. Until this existed nothing in the process said which build
  // was deployed, so triaging a report started by establishing that by hand - usually `git log`
  // on the host, which answers what is CHECKED OUT rather than what is running.
  logger.info('booting', {
    build: describeBuild(build),
    // BOTH identities (RFC-001 4.3): the engine package, and the module repository the bot was
    // started in. In the engine's own checkout they name the same tree.
    engine: { name: build.engine.name, version: build.engine.version },
    repo: { name: build.repo.name, version: build.repo.version, gitSha: build.repo.gitSha ?? 'unknown' },
    version: build.repo.version,
    gitSha: build.repo.gitSha ?? 'unknown',
    node: process.version,
    pid: process.pid,
    database: cfg.databasePath,
  });
  // And on stderr too, because the boot log may be JSON going somewhere an operator watching a
  // console restart is not looking.
  say(`discord-bot: ${describeBuild(build)}`);
  if (pin.kind === 'warn') logger.warn('engine pin is not exact', { detail: pin.sentence });
  // Keys that no longer mean anything, said out loud rather than silently ignored.
  for (const warning of removedBuilderKeyWarnings(cfg.modules)) {
    logger.warn('ignored MODULES_JSON key', { detail: warning });
    say(`  warning: ${warning}`);
  }

  // --- (3) database ----------------------------------------------------------------------
  const opened = openSqlite(cfg.databasePath, { now: () => clock.now() });
  if (!opened.ok) {
    say(formatConfigFailure(opened.error));
    logger.error('database could not be opened', { cause: operatorMessage(opened.error) });
    return 1;
  }
  const sqlite = opened.value;

  /** Every failure after this point must close the database, or the WAL stays checked out. */
  /** Several refusals at once - one per repository of the set that refused (RFC-001 PR 2.1). */
  const failBootAll = (all: readonly AppError[]): number => {
    for (const error of all) {
      say(formatConfigFailure(error));
      logger.error('boot failed', { cause: operatorMessage(error) });
    }
    sqlite.close();
    return 1;
  };
  const failBoot = (error: AppError): number => failBootAll([error]);

  try {
    // `core_docs` and `core_migrations` - the ledger the core migration run below writes into.
    ensureCoreSchema(sqlite.connection);
  } catch (cause: unknown) {
    sqlite.close();
    say(`\ndiscord-bot cannot start: the core schema could not be applied to ${cfg.databasePath}\n  ${thrownMessage(cause)}\n`);
    logger.error('core schema failed', { cause: thrownMessage(cause) });
    return 1;
  }

  // --- (3b) CORE migrations, BEFORE any module's -----------------------------------------
  //
  // Core's own tables (audit, jobs, ratelimits, settings, access) now arrive through the same
  // checksummed ledger modules use, as the pseudo-module `@core` holding the `core_` namespace.
  // Until this existed the core schema was one `CREATE TABLE IF NOT EXISTS` blob re-executed on
  // every boot - idempotent, and a dead end, because an idempotent CREATE has nowhere to put an
  // ALTER. No core column could be added, renamed or dropped by any means at all.
  //
  // WHY A FAILURE HERE IS FATAL WHERE A MODULE'S IS NOT: a module whose migration fails is
  // quarantined and the rest of the bot runs. There is nothing to quarantine here - every core
  // port reads these tables - so the honest ending is one sentence and exit 1.
  //
  // ORDER: before module migrations. A module's `setup` runs after both, and every core port it
  // is handed reads a `core_*` table.
  const coreMigrated = runCoreMigrations(sqlite);
  if (!coreMigrated.ok) return failBoot(coreMigrated.error);
  if (coreMigrated.value.length > 0) {
    logger.info('core migrations applied', {
      count: coreMigrated.value.length,
      names: coreMigrated.value.join(','),
    });
  }
  logger.info('database ready', { journalMode: sqlite.journalMode });

  // --- (4a) discovery --------------------------------------------------------------------
  const disabled = new Set(cfg.disabledModules);
  if (!cfg.builtinModules) {
    logger.warn('MODULES_BUILTIN=false: no built-in modules will load, and /request will not exist', {});
  }
  const roots: ModuleRoot[] = [
    ...(cfg.builtinModules ? [builtinRoot()] : []),
    ...cfg.moduleDirs.map((d) => ({
      dir: resolve(process.cwd(), d),
      entry: 'module.ts' as const,
      required: cfg.moduleDirsExplicit,
    })),
  ];
  const discovery = await discoverModules({ roots, disabled, logger });
  if (!discovery.ok) return failBoot(discovery.error);

  const quarantined = [...discovery.value.quarantined];

  // --- (4b) migrations, per module -------------------------------------------------------
  //
  // Before `install`, because a module's `setup` may read its own tables. A migration failure
  // quarantines exactly one module; `tags` failing must not stop `builder`.
  const runnable: DiscoveredModule[] = [];
  for (const m of discovery.value.discovered) {
    const id = m.descriptor.manifest.id;
    if (!m.descriptor.manifest.migrations) {
      runnable.push(m);
      continue;
    }
    const files = readMigrationDir(migrationsDirFor(m));
    if (!files.ok) {
      logger.error('module migrations unreadable; quarantined', { module: id, cause: operatorMessage(files.error) });
      quarantined.push({ moduleId: id, cause: files.error });
      continue;
    }

    // A module that DECLARES migrations and ships none is quarantined, not booted.
    //
    // `readMigrationDir` returns Ok([]) for a missing directory on purpose — a module with no
    // migrations is perfectly legal. But that made "declared migrations, shipped none"
    // indistinguishable from "needs none", and the flagship module shipped exactly that way:
    // its table was never created, every query threw, and the bot reported healthy. The
    // manifest said it needed storage, so an empty result is a contradiction, not a default.
    if (files.value.length === 0) {
      const cause = errors.config(
        `migrations.${id}`,
        'declares `migrations: true` but ships no .sql files',
        `Add src/modules/${id}/migrations/0001_init.sql, or set \`migrations: false\` if it needs no tables.`,
      );
      logger.error('module declares migrations but ships none; quarantined', {
        module: id,
        dir: migrationsDirFor(m),
      });
      quarantined.push({ moduleId: id, cause });
      continue;
    }
    const applied = runMigrations(sqlite, id, files.value);
    if (!applied.ok) {
      logger.error('module migrations failed; quarantined', { module: id, cause: operatorMessage(applied.error) });
      quarantined.push({ moduleId: id, cause: applied.error });
      continue;
    }
    if (applied.value.length > 0) {
      logger.info('migrations applied', { module: id, count: applied.value.length, names: applied.value.join(',') });
    }
    runnable.push(m);
  }

  // --- (5) ports -------------------------------------------------------------------------
  let catalog: CatalogPort | null = null;
  const catalogPort = lateCatalog(() => catalog);

  const coreDb = sqlite.coreDb();
  const auditLog = createAuditLog({ db: coreDb, clock, logger });
  const settings = createSettings({ db: coreDb, clock, logger });
  const access = createAccess({
    db: coreDb,
    clock,
    logger,
    settings,
    fallbacks: fallbacksFromCatalog(catalogPort),
  });
  // Persisted in core_ratelimits, so "3 builds per hour" survives a restart. An in-memory
  // counter would make the limit meaningless to anyone who can bounce the process.
  const rateGate = createRateGate({ db: coreDb });

  // --- (5a) GITHUB AUTH -----------------------------------------------------------------
  //
  // PAT or GitHub App, exactly one (config already refused both and neither). In App mode the
  // key FILE is read here, and `createGithubAdapter` asks GitHub who the App is and whether its
  // installation on the module repository is sufficient (src/adapters/github/app-auth.ts):
  // a key that is not the App's, an App not installed on the repo, a missing permission, or an
  // install on ALL repositories each refuse to start with the sentence that names the fix.
  //
  // ONE ADAPTER PER CONFIGURED REPOSITORY (RFC-001 PR 2.1). `cfg.github.repos` is the set from
  // GITHUB_REPOS_JSON, or the one-repository set keyed `default` that the shim makes of
  // GITHUB_OWNER/GITHUB_REPO - so a phase-1 install builds exactly the one adapter it always did.
  // One credential for the whole set: one PAT client shared by every repository, or one App with
  // an installation looked up and checked per repository. Every repository the auth checks refuse
  // is named before the boot stops (src/adapters/github/repo-set.ts).
  const githubAuth = resolveGithubAuth(cfg.github.auth);
  if (!githubAuth.ok) return failBoot(githubAuth.error);
  const githubSet = await createGithubRepoSet({
    auth: githubAuth.value,
    repos: cfg.github.repos,
    clock,
    logger,
    // The composition root is the only place this key is read. Modules receive a signing
    // FUNCTION on BuildsPort, never the key itself, so a signing secret never enters a
    // module's blast radius or MODULES_JSON.
    approvalHmacKey: cfg.github.approvalHmacKey,
    allowPublicTargetRepo: cfg.github.allowPublicTargetRepo,
    // The build-path probes (APPROVAL_HMAC_KEY, environments, gate files) only when the builder
    // will actually load; which environment probe runs depends on who pays.
    builder: discovery.value.discovered.some((m) => m.descriptor.manifest.id === 'builder')
      ? { requireOwnCredentials: builderRequiresOwnCredentials(cfg.modules) }
      : null,
    engineVersion: build.engine.version,
    // PER REPOSITORY: each repository's ref and workflow are bound in its own adapter - every
    // dispatch runs them, the daily cap counts them, and its preflight and gate-file check
    // verify them. There is no second copy in MODULES_JSON.
    gateReference: (r) => readTemplateGateFiles(enginePackageRoot(), build.engine.version, r.workflowFile),
  });
  if (!githubSet.ok) return failBootAll(githubSet.error);
  const github = githubSet.value;

  // --- (5b) THE GITHUB PREFLIGHT ---------------------------------------------------------
  //
  // Boot refuses to start on a bad DISCORD_TOKEN and, until now, made no GitHub call at all.
  // So the GitHub half of the configuration was unverified at the exact moment the bot
  // reported healthy, and an expired PAT, a deleted GITHUB_REF or a renamed
  // GITHUB_WORKFLOW_FILE first surfaced when somebody clicked Approve — after which the
  // dispatch path collapses every error into a retry and the user waits hours to be told it
  // timed out, about a build that never started.
  //
  // Three reads, once. A 401 or a 404 is a value somebody has to edit, so it fails here with
  // the same sentence a bad DISCORD_TOKEN gets and exits 1. A 403, a 429, a 5xx or an
  // unreachable network is GitHub having a bad day, not a misconfiguration: those are warned
  // about loudly and the bot starts, because a GitHub outage must not take `/help` down with
  // it and a bot in a restart loop hammers an API that is already limiting it.
  //
  // WHY NOT IN `health()`: `/status` is polled, and hardest when something is already wrong. A
  // health check that spends the same quota as the feature it reports on can take that feature
  // down during the incident it exists to surface. See src/adapters/github/preflight.ts.
  //
  // EVERY REPOSITORY of the set, each complete (RFC-001 7.1: "each repo passes the full
  // preflight of 5.4 independently"). A refusal in any of them refuses the boot, after all of
  // them have been asked, naming each; a transient answer or drifted gate files disable builds
  // for THAT repository only, because each adapter holds its own containment state.
  const preflights = await github.preflight();
  const refusals = preflights.flatMap((p) => (p.result.ok ? [] : [p.result.error]));
  if (refusals.length > 0) return failBootAll(refusals);
  for (const p of preflights) {
    if (!p.result.ok) continue;
    logPreflightWarnings(p.result.value, logger, say);
    const adapter = github.adapters.find((a) => a.ref === p.ref)?.adapter;
    logger.info('github preflight passed', {
      repoKey: p.ref.key,
      repo: p.result.value.fullName,
      workflow: p.config.workflowFile,
      workflowState: p.result.value.workflowState,
      ref: p.config.ref,
      warnings: p.result.value.warnings.length,
      auth: describeGithubAuth(adapter === undefined ? { kind: 'unknown' } : adapter.authSummary()),
    });
  }

  // Guilds-only unless a module needs message hooks. See client.ts for why the default moved.
  const client = createDiscordClient({ messageContent: cfg.discord.messageContent });
  const discord = channelScopedDelivery({ client, clock, logger });
  const jobs = createJobSystem({ db: coreDb, clock, logger, discord });
  const bus = createEventBus((failure) => {
    logger.error('event subscriber failed', { event: failure.event, cause: thrownMessage(failure.cause) });
  });

  /**
   * THE OBSERVABILITY PORT. Two reads that were already implemented and called by nothing.
   *
   * `AuditLog.recent`, `AuditLog.forGuild` and `JobSystem.stats` were written, tested, and had
   * no caller outside their own test files - so the append-only table that exists to answer
   * "who approved this, and which layer let them?" was answerable only by opening the SQLite
   * file on the host. This is the door, and it is deliberately a narrow one: two reads, no
   * writes, nothing that spends money or changes state.
   *
   * `guildId === null` means EVERY guild. The branch is here, in the composition root, rather
   * than in a module, so a module holding `admin` cannot reach `forGuild` and `recent` by two
   * different names and treat the unscoped one as the default.
   */
  const adminPort: AdminPort = {
    recentAudit: (guildId, limit) => (guildId === null ? auditLog.recent(limit) : auditLog.forGuild(guildId, limit)),
    jobStats: () => jobs.stats(),
  };

  /** Constant for the life of the process; see `#adapters/system/version` for why. */
  // `githubAuth` is read on every /status, after the preflight above has filled in a PAT's expiry.
  const versionPort: VersionPort = {
    current: () => build,
    githubAuth: () => github.primaryAuthSummary(),
    githubAuthAll: () => github.authSummaries(),
  };

  /** One JobsPort per module id; the runner dispatches on `<moduleId>:<type>`. */
  const jobPorts = new Map<string, ReturnType<typeof jobs.portFor>>();
  const jobPortFor = (moduleId: string): ReturnType<typeof jobs.portFor> => {
    const hit = jobPorts.get(moduleId);
    if (hit !== undefined) return hit;
    const fresh = jobs.portFor(moduleId);
    jobPorts.set(moduleId, fresh);
    return fresh;
  };

  /**
   * The port bag ONE module receives, before `portsFor` narrows it to its declared tuple.
   *
   * Typed as the full `PortRegistry` deliberately: adding a port to core then fails to compile
   * here until it is wired, which is the friction `#core/ports` documents as intentional.
   * `db`, `audit` and `jobs` are per-module - that binding is what makes `m_<id>_*` scoping and
   * an unspoofable audit `module_id` real rather than conventional.
   */
  const portsForModule = (moduleId: string): PortRegistry => ({
    db: sqlite.moduleDb(moduleId),
    audit: auditLog.portFor(moduleId),
    clock,
    jobs: jobPortFor(moduleId),
    discord,
    // One port per configured repository, reached through `.at(repo)` (RFC-001 7.4).
    issues: github.issues,
    builds: github.builds,
    settings,
    catalog: catalogPort,
    access,
    secrets: github.secrets,
    admin: adminPort,
    version: versionPort,
    repos: github.repos,
  });

  // --- (6) install -----------------------------------------------------------------------
  const loaded = installModules({
    discovered: runnable,
    portsFor: portsForModule,
    configFor: (moduleId: string) => moduleConfigSlice(cfg, moduleId),
    bus,
    logger,
    disabled,
    quarantined,
  });
  if (!loaded.ok) {
    // THE REFUSAL. Both sides of every collision are named; nothing is last-wins.
    say(`\n${formatProblems(loaded.error)}\n`);
    logger.error('registry refused to start', { problems: loaded.error.length });
    sqlite.close();
    return 1;
  }
  const report = loaded.value;
  catalog = buildCatalog(report);

  if (report.quarantined.length > 0) {
    // Loud on BOTH channels: a quarantine buried in JSON is a quarantine nobody notices.
    say(`\n${report.quarantined.length} module(s) are QUARANTINED and will not run:`);
    for (const q of report.quarantined) {
      say(`  - ${describeQuarantine(q)}`);
      logger.error(describeQuarantine(q), { module: q.moduleId });
    }
    say('');
  }
  // A message hook cannot fire without the privileged MessageContent intent. Refusing to start
  // is deliberate: the alternative is a bot that connects, reports healthy, and silently never
  // responds to its own declared prefix — which was the single most common failure of the old
  // `$request` design, and the reason the default entry point is now a slash command.
  if (report.registry.hooks.size > 0 && !cfg.discord.messageContent) {
    const owners = [...report.registry.hooks.entries()]
      .map(([prefix, owner]) => `${owner.moduleId} claims "${prefix}"`)
      .join('; ');
    say(
      [
        '',
        'discord-bot cannot start: a module declares a message hook, but the MessageContent intent is off.',
        `  ${owners}`,
        '',
        '  A prefix hook reads message content, which is a PRIVILEGED intent. Either:',
        '    - set DISCORD_MESSAGE_CONTENT=true and enable MESSAGE CONTENT INTENT in the',
        '      Discord Developer Portal (Bot -> Privileged Gateway Intents), or',
        '    - remove the hook and use a slash command, which needs no privileged intent.',
        '',
      ].join('\n'),
    );
    logger.error('module declares a message hook without the MessageContent intent', { owners });
    sqlite.close();
    process.exit(1);
  }

  logger.info('modules installed', {
    modules: [...report.registry.modules.keys()].join(',') || '(none)',
    commands: report.registry.commands.size,
    jobs: report.registry.jobs.size,
    quarantined: report.quarantined.length,
  });
  if (report.registry.modules.size === 0) {
    logger.warn('no modules are installed; the bot will start with no commands');
  }

  // --- (7) jobs: recover BEFORE start ----------------------------------------------------
  jobs.registerJobs(report.registry.jobs);
  const recovered = jobs.recover();
  logger.info('job queue recovered', {
    requeued: recovered.requeued,
    scheduled: recovered.scheduled,
    orphaned: recovered.orphaned.length,
  });
  if (recovered.orphaned.length > 0) {
    // Rows keyed `<moduleId>:<type>` with no handler: a renamed or quarantined module. They
    // are marked `orphaned` rather than left behind a card that says "building..." forever.
    logger.error('queued jobs have no handler and were orphaned', { keys: recovered.orphaned.join(',') });
  }

  // --- (8) reconcile ---------------------------------------------------------------------
  //
  // After migrations, on every boot: this is what recovers a workflow that was dispatched
  // moments before the process died, when no poller had been enqueued yet.
  for (const installedModule of report.registry.installed.values()) {
    if (installedModule.reconcile === null) continue;
    try {
      await installedModule.reconcile();
    } catch (cause: unknown) {
      logger.error('module reconcile threw', { module: installedModule.manifest.id, cause: thrownMessage(cause) });
    }
  }

  // --- (9) router, then login ------------------------------------------------------------
  const router = attachRouter(client, {
    registry: report.registry,
    logger,
    clock,
    access,
    audit: auditLog.portFor(ROUTER_AUDIT_ID),
    discord,
    // The REAL gate, persisted in core_ratelimits. `ALLOW_ALL` remains exported for the
    // offline/dev path and for tests, but must never be wired here: with it, every declared
    // `limit` in every module is decorative and a single user can spend without bound.
    limits: rateGate,
    clientId: cfg.discord.clientId,
    ownerId: cfg.discord.ownerId,
    enqueueJob: (moduleId, job) => jobPortFor(moduleId).enqueue(job),
  });

  const loggedIn = await login(client, cfg.discord.token);
  if (!loggedIn.ok) {
    say(formatConfigFailure(loggedIn.error));
    router.detach();
    await shutdownClient(client, logger);
    sqlite.close();
    return 1;
  }
  logger.info('logged in to Discord', { clientId: cfg.discord.clientId, devGuild: cfg.discord.devGuildId ?? 'global' });

  // --- (10) slash commands, only when the digest changed ---------------------------------
  const commands: readonly DeployableCommand[] = [...report.registry.commands.values()].map((c) => c.spec);
  const deployed = await deployCommands(
    {
      put: restPut(client),
      clientId: cfg.discord.clientId,
      guildId: cfg.discord.devGuildId,
      store: commandSyncStore(coreDb.docs),
      logger,
    },
    commands,
  );
  if (!deployed.ok) {
    if (deployed.error.kind === 'config') {
      // A malformed command DECLARATION. That is a bug in a module, and shipping a bot whose
      // command list cannot be built is worse than not shipping.
      say(formatConfigFailure(deployed.error));
      router.detach();
      await shutdownClient(client, logger);
      sqlite.close();
      return 1;
    }
    // A transport failure. Discord still has whatever was deployed last time, and the bot
    // routes from its own registry, so this is loud but survivable.
    logger.error('slash command deployment failed; continuing with the previously deployed list', {
      cause: operatorMessage(deployed.error),
    });
  } else {
    logger.info('slash commands reconciled', {
      scope: deployed.value.scope,
      commands: deployed.value.commands,
      deployed: deployed.value.deployed,
    });
  }

  // --- (11) start taking work ------------------------------------------------------------
  jobs.start();
  logger.info('ready');

  // --- (12) shutdown ---------------------------------------------------------------------
  const finished = deferred<number>();
  let stopping = false;

  async function shutdown(reason: string, code: number): Promise<void> {
    if (stopping) {
      // A second signal means "now". Leases outlive us either way; a hung shutdown just adds
      // a SIGKILL to the story.
      say('second shutdown signal - exiting immediately');
      process.exit(code === 0 ? 1 : code);
    }
    stopping = true;
    logger.info('shutting down', { reason, graceMs: SHUTDOWN_GRACE_MS });

    // A shutdown that hangs is worse than an abrupt one: systemd escalates to SIGKILL and the
    // job leases are held for their full duration instead of being released.
    const hardLimit = setTimeout(() => {
      say(`shutdown exceeded ${String(SHUTDOWN_HARD_LIMIT_MS)}ms - exiting hard`);
      process.exit(1);
    }, SHUTDOWN_HARD_LIMIT_MS);

    try {
      // Stop taking NEW work first: no further interactions are accepted, and the job runner
      // stops ticking while it drains what is already in flight.
      router.detach();
      await jobs.stop({ graceMs: SHUTDOWN_GRACE_MS });

      for (const installedModule of report.registry.installed.values()) {
        if (installedModule.onShutdown === null) continue;
        try {
          await installedModule.onShutdown();
        } catch (cause: unknown) {
          logger.warn('module onShutdown threw', {
            module: installedModule.manifest.id,
            cause: thrownMessage(cause),
          });
        }
      }

      await shutdownClient(client, logger);
    } catch (cause: unknown) {
      logger.error('shutdown did not complete cleanly', { cause: thrownMessage(cause) });
    } finally {
      clearTimeout(hardLimit);
      try {
        sqlite.close();
      } catch (cause: unknown) {
        logger.warn('database did not close cleanly', { cause: thrownMessage(cause) });
      }
      logger.info('shutdown complete', { reason, code });
      finished.resolve(code);
    }
  }

  onFatal = (reason: string, cause: unknown): void => {
    // Full context, then a NON-ZERO exit. Continuing would mean serving from a state nobody
    // can describe while still holding job leases.
    logger.error(`${reason} - exiting`, {
      cause: thrownMessage(cause),
      stack: thrownStack(cause),
      reason,
    });
    say(`\ndiscord-bot: ${reason}: ${thrownMessage(cause)}`);
    say(thrownStack(cause));
    void shutdown(reason, 1);
  };

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      void shutdown(signal, 0);
    });
  }

  return await finished.promise;
}

// ---------------------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------------------

/**
 * WHY `import.meta.main`: `main.test.ts` imports this file to test `formatConfigFailure` and
 * `commandSyncStore`, and importing the composition root must not connect to Discord.
 */
if (import.meta.main) {
  const code = await run();
  process.exitCode = code;
  // Nothing should be holding the loop open by now. If something is - a stray gateway handle,
  // a socket in TIME_WAIT - do not hang forever waiting for it. Unref'd, so it cannot itself
  // be the reason the process stays alive.
  setTimeout(() => {
    process.exit(code);
  }, 2_000).unref();
}
