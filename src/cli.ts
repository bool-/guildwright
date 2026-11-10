#!/usr/bin/env node
/**
 * THE ENGINE'S CLI (RFC-001 section 4.1, PR 1.4), published as the package `bin` (`CLI_BIN`):
 *
 *   <bin> start                          load ./.env if present, then run the bot (src/main.ts)
 *   <bin> doctor [--offline]             every boot check in one pass, without Discord
 *   <bin> invite-url [--client-id <id>]  the permissions integer and the invite URL
 *   <bin> scaffold <id> [--summary "..."] [--db] [--force]
 *   <bin> init <dir> [--existing]        write the module-repo template (or convert a repo)
 *   <bin> template check|apply           compare / rewrite the gated .github files and AGENTS.md
 *   <bin> gc-approvals [--older-than 90d] [--yes]
 *
 * WHY THE ARGUMENT PARSER IS HAND-ROLLED: it is twenty lines, every subcommand takes at most three
 * flags, and a dependency is behind human approval for a reason (AGENTS.md "If you are blocked").
 *
 * Every subcommand takes a `CliIo` (cwd, env, out, err, clock), so each one is tested against a
 * temp directory and a fake transport exactly as it runs in an operator's module repo. Only the
 * block at the bottom touches the real process.
 */

import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { CLI_BIN, type PackageIdentity } from '#core/version';
import type { GithubRequest } from '#adapters/github/index';
import { enginePackageRoot, readPackage } from '#adapters/system/version';

import { doctor } from './cli/doctor.ts';
import { DEFAULT_OLDER_THAN, gcApprovals } from './cli/gc-approvals.ts';
import { inviteUrlCommand } from './cli/invite.ts';
import { EXIT_OK, EXIT_PROBLEM, EXIT_USAGE, describeAppError, withDotEnv, type CliIo, type Env } from './cli/io.ts';
import { npmLockfileRegenerator } from './cli/npm.ts';
import { scaffold } from './cli/scaffold.ts';
import { init, readTemplate, templateApply, templateCheck, type LockfileRegenerator } from './cli/template.ts';

export const USAGE = `usage: ${CLI_BIN} <command>

  start                            load ./.env if present, then run the bot
  doctor [--offline]               check config, modules, versions and GitHub without starting
  invite-url [--client-id <id>]    print the bot's permissions integer and invite URL
  scaffold <id> [--summary "..."] [--db] [--force]
                                   generate a module under src/modules/<id>/ that is already green
  init <dir> [--existing]          write the module-repo template into <dir>;
                                   --existing converts the repository there (never src/modules/, never .env)
  template check                   do the gated .github files and AGENTS.md match the installed engine?
  template apply                   rewrite them from the installed engine (refuses a dirty tree)
  gc-approvals [--older-than ${DEFAULT_OLDER_THAN}] [--yes]
                                   list (and with --yes delete) old refs/approvals/* refs
`;

/** Everything a subcommand needs from outside the process, injectable for tests. */
export interface CliDeps {
  /** The engine package root (`enginePackageRoot()` in production). */
  readonly engineRoot: string;
  /** `doctor`: transport override for the GitHub client. */
  readonly fetch?: typeof globalThis.fetch;
  /** `doctor`: request seam for the containment probes and the gate check. */
  readonly probeRequest?: GithubRequest;
  /** `gc-approvals`: request seam in place of the bot's own credential. */
  readonly gcRequest?: GithubRequest;
  /** `init`: how `package-lock.json` is regenerated (npm, in production). */
  readonly regenerateLockfile?: LockfileRegenerator;
  /** `start`: what runs the bot once `.env` is loaded (`run` from src/main.ts in production). */
  readonly run?: (env: Env) => Promise<number>;
}

// ---------------------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------------------

type FlagKind = 'boolean' | 'value';

export interface ParsedArgs {
  readonly positionals: readonly string[];
  readonly flags: ReadonlyMap<string, string | true>;
}

/** `--flag`, `--flag value`, `--flag=value`; `--` ends flags. Unknown flags are an error. */
export function parseArgv(argv: readonly string[], spec: Readonly<Record<string, FlagKind>>): ParsedArgs | string {
  const positionals: string[] = [];
  const flags = new Map<string, string | true>();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? '';
    if (arg === '--') {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    if (!arg.startsWith('--')) {
      positionals.push(arg);
      continue;
    }
    const eq = arg.indexOf('=');
    const name = arg.slice(2, eq < 0 ? undefined : eq);
    const kind = spec[name];
    if (kind === undefined) return `unknown option: --${name}`;
    if (kind === 'boolean') {
      if (eq >= 0) return `--${name} takes no value`;
      flags.set(name, true);
      continue;
    }
    const value = eq >= 0 ? arg.slice(eq + 1) : argv[i + 1];
    if (value === undefined || (eq < 0 && value.startsWith('--'))) return `--${name} needs a value`;
    if (eq < 0) i += 1;
    flags.set(name, value);
  }
  return { positionals, flags };
}

function stringFlag(p: ParsedArgs, name: string): string | null {
  const v = p.flags.get(name);
  return typeof v === 'string' ? v : null;
}

// ---------------------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------------------

function usageError(io: CliIo, message: string): number {
  io.err(`${message}\n\n${USAGE}`);
  return EXIT_USAGE;
}

/** Parse, or report the usage error. */
function args(io: CliIo, argv: readonly string[], spec: Readonly<Record<string, FlagKind>>, maxPositionals: number): ParsedArgs | number {
  const p = parseArgv(argv, spec);
  if (typeof p === 'string') return usageError(io, p);
  if (p.positionals.length > maxPositionals) return usageError(io, `unexpected argument: ${p.positionals[maxPositionals] ?? ''}`);
  return p;
}

function engineIdentity(deps: CliDeps): PackageIdentity {
  return readPackage(deps.engineRoot);
}

/** Run one CLI invocation. Resolves with the exit code; never calls `process.exit`. */
export async function runCli(argv: readonly string[], io: CliIo, deps: CliDeps): Promise<number> {
  const [command, ...rest] = argv;
  switch (command) {
    case undefined:
    case 'help':
    case '--help':
    case '-h':
      io.out(USAGE);
      return command === undefined ? EXIT_USAGE : EXIT_OK;

    case 'start': {
      const p = args(io, rest, {}, 0);
      if (typeof p === 'number') return p;
      // RFC-001 4.2: `--env-file-if-exists` is a `node` flag, unavailable to a `bin` script, so
      // the CLI loads `.env` itself. A variable already in the environment wins, as with the flag.
      const envFile = join(io.cwd, '.env');
      if (existsSync(envFile)) process.loadEnvFile(envFile);
      const run = deps.run ?? (async (env: Env) => (await import('./main.ts')).run(env));
      return await run(process.env);
    }

    case 'doctor': {
      const p = args(io, rest, { offline: 'boolean' }, 0);
      if (typeof p === 'number') return p;
      return await doctor(
        { ...io, env: withDotEnv(io.cwd, io.env) },
        {
          engineRoot: deps.engineRoot,
          ...(deps.fetch === undefined ? {} : { fetch: deps.fetch }),
          ...(deps.probeRequest === undefined ? {} : { probeRequest: deps.probeRequest }),
        },
        { offline: p.flags.has('offline') },
      );
    }

    case 'invite-url': {
      const p = args(io, rest, { 'client-id': 'value' }, 0);
      if (typeof p === 'number') return p;
      return await inviteUrlCommand({ ...io, env: withDotEnv(io.cwd, io.env) }, stringFlag(p, 'client-id'));
    }

    case 'scaffold':
      // The generator keeps its own parser: it was hand-rolled already and its error sentences
      // are what AGENTS.md readers have seen since it existed.
      return scaffold(rest, io);

    case 'init': {
      const p = args(io, rest, { existing: 'boolean' }, 1);
      if (typeof p === 'number') return p;
      const dir = p.positionals[0];
      if (dir === undefined) return usageError(io, 'init needs a directory: init <dir>, or init . --existing');
      const engine = engineIdentity(deps);
      const template = readTemplate(deps.engineRoot, engine);
      if (!template.ok) {
        io.err(`init: ${describeAppError(template.error)}\n`);
        return EXIT_PROBLEM;
      }
      return init(
        io,
        template.value,
        engine,
        { target: resolve(io.cwd, dir), existing: p.flags.has('existing') },
        deps.regenerateLockfile ?? npmLockfileRegenerator(io.env),
      );
    }

    case 'template': {
      const p = args(io, rest, {}, 1);
      if (typeof p === 'number') return p;
      const sub = p.positionals[0];
      if (sub !== 'check' && sub !== 'apply') return usageError(io, 'template needs a subcommand: template check, or template apply');
      const template = readTemplate(deps.engineRoot, engineIdentity(deps));
      if (!template.ok) {
        io.err(`template ${sub}: ${describeAppError(template.error)}\n`);
        return EXIT_PROBLEM;
      }
      return sub === 'check' ? templateCheck(io, template.value) : templateApply(io, template.value);
    }

    case 'gc-approvals': {
      const p = args(io, rest, { 'older-than': 'value', yes: 'boolean' }, 0);
      if (typeof p === 'number') return p;
      return await gcApprovals(
        { ...io, env: withDotEnv(io.cwd, io.env) },
        deps.gcRequest === undefined ? {} : { request: deps.gcRequest },
        { olderThan: stringFlag(p, 'older-than') ?? DEFAULT_OLDER_THAN, yes: p.flags.has('yes') },
      );
    }

    default:
      return usageError(io, `unknown command: ${command}`);
  }
}

// ---------------------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------------------

/** WHY `import.meta.main`: the tests import `runCli`, and importing must not run a command. */
if (import.meta.main) {
  const argv = process.argv.slice(2);
  const code = await runCli(
    argv,
    {
      cwd: process.cwd(),
      env: process.env,
      out: (text) => process.stdout.write(text),
      err: (text) => process.stderr.write(text),
      nowMs: () => Date.now(),
    },
    { engineRoot: enginePackageRoot() },
  );
  process.exitCode = code;
  // Same ending as src/main.ts: nothing should hold the loop open now, and if something does
  // (a stray gateway handle after `start`), do not hang on it. Unref'd, so it never is the reason.
  setTimeout(() => {
    process.exit(code);
  }, 2_000).unref();
}
