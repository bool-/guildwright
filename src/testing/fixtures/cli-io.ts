/**
 * A `CliIo` that records what a subcommand printed, plus the temp directories and the minimal
 * valid environment the CLI tests share. Test-only: under `fixtures/`, which the build excludes.
 */

import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { CliIo, Env } from '../../cli/io.ts';

export interface CapturedIo {
  readonly io: CliIo;
  readonly stdout: () => string;
  readonly stderr: () => string;
  /** Both streams, in the order written. */
  readonly all: () => string;
}

export function captureIo(cwd: string, env: Env = {}, nowMs: () => number = () => Date.parse('2026-11-09T12:00:00Z')): CapturedIo {
  const out: string[] = [];
  const err: string[] = [];
  const both: string[] = [];
  return {
    io: {
      cwd,
      env,
      out: (t) => {
        out.push(t);
        both.push(t);
      },
      err: (t) => {
        err.push(t);
        both.push(t);
      },
      nowMs,
    },
    stdout: () => out.join(''),
    stderr: () => err.join(''),
    all: () => both.join(''),
  };
}

/** A fresh temp directory, removed by the returned `cleanup`. */
export function tempDir(prefix: string): { readonly dir: string; readonly cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** Every variable `loadConfig` requires, valid, in PAT mode. */
export const VALID_ENV: Env = {
  DISCORD_TOKEN: 'x'.repeat(60),
  DISCORD_CLIENT_ID: '123456789012345678',
  DISCORD_OWNER_ID: '223456789012345678',
  GITHUB_TOKEN: `github_pat_${'C'.repeat(40)}`,
  GITHUB_OWNER: 'o',
  GITHUB_REPO: 'r',
  APPROVAL_HMAC_KEY: 'h'.repeat(48),
};

/** `src/testing/fixtures/template`: the smallest tree that satisfies the template contract. */
export const FIXTURE_TEMPLATE = fileURLToPath(new URL('./template', import.meta.url));

/** The engine version `FIXTURE_TEMPLATE/MANIFEST.json` was written for. */
export const FIXTURE_ENGINE_VERSION = '0.0.0-fixture';

/** The engine's package name, as the CLI reads it from `<engineRoot>/package.json`. */
export const ENGINE_NAME = 'guildwright';

/**
 * A fake installed engine: `<dir>/package.json` at `FIXTURE_ENGINE_VERSION` and `<dir>/template`
 * copied from the fixture, so a test can damage either without touching the repository.
 */
export function fakeEngineRoot(dir: string, extra: Readonly<Record<string, unknown>> = {}): string {
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: ENGINE_NAME, version: FIXTURE_ENGINE_VERSION, ...extra }, null, 2));
  cpSync(FIXTURE_TEMPLATE, join(dir, 'template'), { recursive: true });
  return dir;
}
