/**
 * Running npm from the CLI, for exactly one thing: regenerating `package-lock.json` after `init`
 * (RFC-001 9.1, "The lockfile").
 *
 * WHY THROUGH THIS NODE AND npm's OWN SCRIPT, not `npm` on the PATH: on Windows `npm` is a
 * `.cmd` shim that only runs through a shell, and a shell is one more layer to get quoting wrong
 * in. `npx <bin> init` already runs under npm, which sets `npm_execpath`; failing that, npm ships
 * next to the Node binary in every official install.
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { Err, Ok } from '#core/result';

import type { Env } from './io.ts';
import type { LockfileRegenerator } from './template.ts';

/** npm's CLI script, or `null` when none can be found next to this Node. */
export function findNpmCli(env: Env): string | null {
  const candidates = [
    env['npm_execpath'],
    join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    join(dirname(process.execPath), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ];
  for (const c of candidates) {
    if (c !== undefined && /npm-cli\.[cm]?js$/u.test(c) && existsSync(c)) return c;
  }
  return null;
}

/** The exact command `init` runs, so the failure sentence and the docs name the same one. */
export const LOCKFILE_ARGS = ['install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund'] as const;

/**
 * `npm install --package-lock-only --ignore-scripts` in `dir`: resolves the dependency tree and
 * writes the lockfile, installs nothing, runs no script. `extraEnv` is for tests (an offline
 * cache); production passes nothing.
 */
export function npmLockfileRegenerator(env: Env, extraEnv: Readonly<Record<string, string>> = {}): LockfileRegenerator {
  return (dir) => {
    const npmCli = findNpmCli(env);
    if (npmCli === null) return Err('npm could not be found next to this Node');
    const r = spawnSync(process.execPath, [npmCli, ...LOCKFILE_ARGS], {
      cwd: dir,
      encoding: 'utf8',
      env: { ...process.env, ...extraEnv },
      timeout: 300_000,
    });
    if (r.error !== undefined) return Err(`npm could not be run (${r.error.message})`);
    if (r.status !== 0) {
      const tail = `${r.stderr}\n${r.stdout}`.trim().split('\n').slice(-6).join('\n    ');
      return Err(`npm ${LOCKFILE_ARGS.join(' ')} exited ${String(r.status)}:\n    ${tail}`);
    }
    if (!existsSync(join(dir, 'package-lock.json'))) return Err('npm finished but wrote no package-lock.json');
    return Ok(undefined);
  };
}
