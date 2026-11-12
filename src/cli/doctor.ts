/**
 * `<bin> doctor [--offline]`: every check the bot would make before it is useful, in ONE pass,
 * WITHOUT logging in to Discord (RFC-001 4.2, 5.4, 6.6).
 *
 * WHAT IT RUNS, and where each check already lives (nothing here re-implements one):
 *
 *   engine pin            `checkEnginePin`                 (#core/version, PR 1.7)       refuses
 *   one copy of zod       `checkZodSingleCopy`             (#adapters/system/version)   refuses
 *   config                `loadConfig` + each module's own config schema                refuses
 *   App private key       `resolveGithubAuth`              (#adapters/github/app-auth)  refuses
 *   discovery             `discoverModules` + the boot import scan (src/loader.ts)     quarantines
 *   ignored builder keys  `removedBuilderKeyWarnings`      (#core/config, PR 1.7)       warns
 *   PAT mode              the PAT-to-App nudge (RFC-001 6.6)                            note
 *   src/engine.d.ts       missing in a module repo (RFC-001 4.3)                        warns
 *   GitHub (not --offline), for EVERY repository of the set (RFC-001 PR 2.1):
 *                         `createGithubRepoSet` + `preflight()` - `GET /app` and the
 *                         installation checks in App mode, the three preflight reads, every
 *                         containment probe of 5.4 and the gate-file digest check - then the
 *                         builder's readiness exactly as `/status` would report it.
 *
 * Exit 1 when anything would refuse to start, quarantine a module, or leave builds disabled - and
 * when a check could not be ANSWERED (a 429, a 5xx, no network): an operator who ran doctor on
 * purpose must not be told everything is fine about something nobody could check (RFC-001 5.4,
 * "Transient failures on the new probes").
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';

import type { AppConfig } from '#core/config';
import { builderRequiresOwnCredentials, loadConfig, moduleConfigSlice, parseModuleConfig, removedBuilderKeyWarnings } from '#core/config';
import type { AppError } from '#core/errors';
import { systemClock } from '#adapters/system/clock';
import { checkZodSingleCopy, readPackage, readRepoManifest } from '#adapters/system/version';
import { BOOT_REFUSAL_PREFIX, checkEnginePin, describeGithubAuth, type PackageIdentity } from '#core/version';
import {
  PAT_MODE_WARNING,
  readTemplateGateFiles,
  resolveGithubAuth,
  type GithubCredentials,
  type GithubRequest,
} from '#adapters/github/index';
import { createGithubRepoSet } from '#adapters/github/repo-set';

import { describeQuarantine } from '../loader.ts';
import { formatConfigFailure } from '../main.ts';

import { discoverForCli, discoverySettings } from './discover.ts';
import { EXIT_OK, EXIT_PROBLEM, describeAppError, silentLogger, type CliIo } from './io.ts';

export interface DoctorDeps {
  /** The engine package root: where its `package.json`, gate files and template live. */
  readonly engineRoot: string;
  /** Transport override for the GitHub client, for tests. */
  readonly fetch?: typeof globalThis.fetch;
  /** Request seam for the containment probes and the gate check, for tests. */
  readonly probeRequest?: GithubRequest;
}

/** One finding. `refuse` and `problem` exit 1; `warn` and `note` do not. */
interface Finding {
  readonly level: 'refuse' | 'problem' | 'warn' | 'note';
  readonly text: string;
}

/**
 * A preflight warning that means a check could NOT be answered, as opposed to an answer that is
 * merely worth knowing (an expiring PAT, a mis-cased repo name). These are the shapes
 * `preflight.ts`, `containment.ts` and `app-auth.ts` give a transient failure; each is pinned by
 * a test in `src/cli/doctor.test.ts`.
 */
export function isUnansweredWarning(warning: string): boolean {
  return /^(?:could not (?:check|reach GitHub)|GitHub (?:answered \d+|got no response) (?:during|while))/u.test(warning);
}

export async function doctor(io: CliIo, deps: DoctorDeps, opts: { readonly offline: boolean }): Promise<number> {
  const findings: Finding[] = [];
  const add = (level: Finding['level'], text: string): void => {
    findings.push({ level, text });
  };
  const engine: PackageIdentity = readPackage(deps.engineRoot);
  const repo = readPackage(io.cwd);
  io.out(`doctor: engine ${engine.name}@${engine.version}, repository ${repo.name}@${repo.version} at ${io.cwd}${opts.offline ? ' (offline)' : ''}\n`);

  // --- the engine pin and one copy of zod: both refuse to start ---------------------------
  const manifest = readRepoManifest(io.cwd);
  const pin = checkEnginePin(manifest, engine);
  if (pin.kind === 'refuse') add('refuse', pin.sentence);
  if (pin.kind === 'warn') add('warn', pin.sentence);
  const zod = checkZodSingleCopy(deps.engineRoot, io.cwd);
  if (zod.kind === 'refuse') add('refuse', zod.sentence);

  // --- config ------------------------------------------------------------------------------
  const parsed = loadConfig(io.env);
  const cfg: AppConfig | null = parsed.ok ? parsed.value : null;
  if (!parsed.ok) add('refuse', formatConfigFailure(parsed.error).trim());
  if (cfg !== null) {
    for (const w of removedBuilderKeyWarnings(cfg.modules)) add('warn', w);
    if (cfg.github.auth.kind === 'pat') {
      add('note', `GitHub auth: ${PAT_MODE_WARNING}. Register a GitHub App (docs/SETUP.md) and set GITHUB_APP_ID plus GITHUB_APP_PRIVATE_KEY_FILE in place of GITHUB_TOKEN.`);
    }
    if (!cfg.builtinModules) add('warn', 'MODULES_BUILTIN=false: no built-in module will load, so this bot has no /request, /help or /status.');
  }

  // A module repo (one that depends on the engine) needs the built-ins' event declarations.
  const dependsOnEngine = (() => {
    const deps: unknown = typeof manifest === 'object' && manifest !== null ? Reflect.get(manifest, 'dependencies') : undefined;
    return typeof deps === 'object' && deps !== null && Object.hasOwn(deps, engine.name);
  })();
  if (dependsOnEngine && !existsSync(join(io.cwd, 'src', 'engine.d.ts'))) {
    add('warn', `src/engine.d.ts is missing, so a module subscribing to a built-in event (builder.pr_opened) will not typecheck. Create it containing exactly: import '${engine.name}/events';`);
  }

  // --- the App key file is read here, offline, like at boot -------------------------------
  const auth = cfg === null ? null : resolveGithubAuth(cfg.github.auth);
  if (auth !== null && !auth.ok) add('refuse', formatConfigFailure(auth.error).trim());

  // --- discovery: the same roots as run(), the same import scan ---------------------------
  const logger = silentLogger();
  const settings = discoverySettings(io.env, cfg);
  let builderLoads = false;
  if (!settings.ok) {
    add('refuse', `the module discovery variables do not parse:\n${settings.error}`);
  } else {
    const found = await discoverForCli(io.cwd, settings.value, logger);
    if (!found.ok) {
      add('refuse', formatConfigFailure(found.error).trim());
    } else {
      const ids = found.value.discovered.map((m) => m.descriptor.manifest.id);
      builderLoads = ids.includes('builder');
      io.out(`  modules discovered: ${ids.length === 0 ? '(none)' : ids.join(', ')}\n`);
      if (found.value.skipped.length > 0) io.out(`  skipped by MODULES_DISABLE: ${found.value.skipped.join(', ')}\n`);
      for (const q of found.value.quarantined) add('problem', describeQuarantine(q));
      // Each module's own schema over its MODULES_JSON slice: what `install` would refuse.
      if (cfg !== null) {
        for (const m of found.value.discovered) {
          const id = m.descriptor.manifest.id;
          const checked = parseModuleConfig(id, m.descriptor.manifest.configSchema, moduleConfigSlice(cfg, id));
          if (!checked.ok) add('problem', `module ${id} would be quarantined: its config does not parse.\n      ${describeAppError(checked.error)}`);
        }
      }
      if (ids.length === 0) add('warn', 'no modules were discovered; the bot would start with no commands.');
    }
  }

  if (cfg !== null && builderLoads) {
    add('note', 'APPROVAL_HMAC_KEY in .env must equal the APPROVAL_HMAC_KEY repository secret. GitHub never reveals a secret value, so this cannot be checked: if they differ, every build fails at "Verify the Discord approval".');
  }

  // --- GitHub ------------------------------------------------------------------------------
  if (opts.offline) {
    io.out('  GitHub: skipped (--offline)\n');
  } else if (cfg === null || auth === null || !auth.ok) {
    add('problem', 'GitHub was not checked, because the configuration above has to be fixed first.');
  } else {
    await githubChecks(io, deps, cfg, auth.value, builderLoads, add);
  }

  return report(io, findings);
}

/**
 * The GitHub half, for EVERY repository of the set (RFC-001 PR 2.1): the auth checks, the
 * preflight, the containment probes and the gate-file check of each, all reported in this one
 * pass. With one repository the output is what it always was; with several, each repository's
 * lines are prefixed by its key, so a finding says which repository it is about.
 */
async function githubChecks(
  io: CliIo,
  deps: DoctorDeps,
  cfg: AppConfig,
  auth: GithubCredentials,
  builderLoads: boolean,
  add: (level: Finding['level'], text: string) => void,
): Promise<void> {
  const refused = (e: AppError): void => {
    add('refuse', formatConfigFailure(e).trim());
  };
  const engineVersion = readPackage(deps.engineRoot).version;
  const probeRequest = deps.probeRequest;
  const created = await createGithubRepoSet({
    auth,
    repos: cfg.github.repos,
    clock: systemClock(),
    logger: silentLogger(),
    approvalHmacKey: cfg.github.approvalHmacKey,
    allowPublicTargetRepo: cfg.github.allowPublicTargetRepo,
    builder: builderLoads ? { requireOwnCredentials: builderRequiresOwnCredentials(cfg.modules) } : null,
    engineVersion,
    gateReference: (r) => readTemplateGateFiles(deps.engineRoot, engineVersion, r.workflowFile),
    ...(deps.fetch === undefined ? {} : { fetch: deps.fetch }),
    ...(probeRequest === undefined ? {} : { probeRequest: () => probeRequest }),
  });
  if (!created.ok) {
    for (const e of created.error) refused(e);
    return;
  }
  const set = created.value;
  const several = set.adapters.length > 1;
  if (several) {
    const dflt = set.set.default;
    io.out(`  repositories: ${set.adapters.map((a) => `${a.ref.key} (${a.config.owner}/${a.config.repo})`).join(', ')}; default: ${dflt === null ? 'none' : dflt.key}\n`);
    if (dflt === null) {
      add(
        'warn',
        'no repository in GITHUB_REPOS_JSON is marked "default": true, so a server can build only after an operator runs /repo use in it, and /credentials has no repository to act on in any server. Mark one entry "default": true.',
      );
    }
  }
  for (const p of await set.preflight()) {
    const tag = several ? `[${p.ref.key}] ` : '';
    if (!p.result.ok) {
      refused(p.result.error);
      continue;
    }
    const adapter = set.adapters.find((a) => a.ref === p.ref)?.adapter;
    if (adapter === undefined) continue;
    io.out(`  ${tag}${describeGithubAuth(adapter.authSummary())}; repository ${p.result.value.fullName}, workflow ${p.config.workflowFile} (${p.result.value.workflowState}), ref ${p.config.ref}\n`);
    for (const w of p.result.value.warnings) add(isUnansweredWarning(w) ? 'problem' : 'warn', `${tag}${w}`);
    const ready = adapter.builds.readiness();
    if (builderLoads) {
      if (ready.status === 'down') add('problem', `${tag}builder: down. ${ready.detail}`);
      else io.out(`  ${tag}builder: ready (gate files match, containment checks passed)\n`);
    }
  }
}

function report(io: CliIo, findings: readonly Finding[]): number {
  const bad = findings.filter((f) => f.level === 'refuse' || f.level === 'problem');
  for (const f of findings) {
    if (f.level === 'refuse') io.err(`\n${f.text.startsWith(BOOT_REFUSAL_PREFIX) ? f.text : `${BOOT_REFUSAL_PREFIX} ${f.text}`}\n`);
  }
  for (const f of findings) {
    if (f.level === 'problem') io.err(`  problem: ${f.text}\n`);
    if (f.level === 'warn') io.err(`  warning: ${f.text}\n`);
    if (f.level === 'note') io.out(`  note: ${f.text}\n`);
  }
  const warnings = findings.filter((f) => f.level === 'warn').length;
  if (bad.length === 0) {
    io.out(`\ndoctor: no problems found${warnings > 0 ? ` (${String(warnings)} warning(s))` : ''}.\n`);
    return EXIT_OK;
  }
  io.err(`\ndoctor: ${String(bad.length)} problem(s)${warnings > 0 ? `, ${String(warnings)} warning(s)` : ''}. The bot would not start cleanly until they are fixed.\n`);
  return EXIT_PROBLEM;
}
