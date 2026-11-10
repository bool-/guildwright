/**
 * What every CLI subcommand is handed, so each one runs against a temp directory, a fake
 * environment and a fake transport in a test exactly as it runs against the operator's checkout.
 *
 * Nothing in `src/cli/**` reads `process.cwd()`, `process.env` or writes `process.stdout`
 * directly; `src/cli.ts` builds the one real `CliIo` and passes it down.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseEnv } from 'node:util';

import type { AppError } from '#core/errors';
import type { LoggerPort } from '#core/ports';

export type Env = Readonly<Record<string, string | undefined>>;

export interface CliIo {
  /** The directory the command acts on: the module repository (or the engine's own checkout). */
  readonly cwd: string;
  readonly env: Env;
  /** Writes text verbatim; callers add their own newlines. */
  readonly out: (text: string) => void;
  readonly err: (text: string) => void;
  /** Wall clock in epoch ms. Injected, so `gc-approvals` ages are testable. */
  readonly nowMs: () => number;
}

/** Exit codes: 0 fine, 1 a problem was found or an action was refused, 2 the command line was wrong. */
export const EXIT_OK = 0;
export const EXIT_PROBLEM = 1;
export const EXIT_USAGE = 2;

/**
 * `<cwd>/.env` merged UNDER `env` (a variable already set wins, as with `node --env-file`), for
 * the commands that read configuration without starting the bot. `start` itself uses
 * `process.loadEnvFile` (RFC-001 4.2), because it hands `process.env` to `run()`.
 *
 * Parsed with Node's own `.env` parser, so `doctor` reads a file exactly as `start` will.
 */
export function withDotEnv(cwd: string, env: Env): Env {
  const path = join(cwd, '.env');
  if (!existsSync(path)) return env;
  const parsed = parseEnv(readFileSync(path, 'utf8'));
  const merged: Record<string, string | undefined> = { ...parsed };
  for (const [key, value] of Object.entries(env)) if (value !== undefined) merged[key] = value;
  return merged;
}

/** A logger that drops everything: the CLI prints its own findings, in sentences, once. */
export function silentLogger(): LoggerPort {
  const self: LoggerPort = {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    child: () => self,
  };
  return self;
}

/** One `AppError` as a problem line plus its fix, in the voice of `formatConfigFailure`. */
export function describeAppError(e: AppError): string {
  const where = e.kind === 'config' ? e.location : e.code;
  const detail = e.internal ?? e.userDetail;
  return `${detail}\n      where: ${where}\n      what to do: ${e.nextStep}`;
}
