/**
 * Module discovery for the commands that do not boot the bot (`doctor`, `invite-url`), with the
 * SAME roots `run()` builds (`src/main.ts`, step 4a): the built-ins first, then every
 * `MODULE_DIRS` entry resolved against the working directory.
 *
 * It needs only three variables, so it reads them on their own when the rest of the environment
 * does not parse: `doctor` reports a missing `DISCORD_TOKEN` AND a quarantined module in one pass
 * rather than one restart apart.
 */

import { resolve } from 'node:path';

import { z } from 'zod';

import { EnvSchema, type AppConfig } from '#core/config';
import type { AppError } from '#core/errors';
import type { LoggerPort } from '#core/ports';
import type { Result } from '#core/result';

import { builtinRoot, discoverModules, type DiscoveryReport, type ModuleRoot } from '../loader.ts';

import type { Env } from './io.ts';

export interface DiscoverySettings {
  readonly moduleDirs: readonly string[];
  readonly moduleDirsExplicit: boolean;
  readonly disabled: ReadonlySet<string>;
  readonly builtin: boolean;
}

const DiscoveryEnv = EnvSchema.pick({ MODULE_DIRS: true, MODULES_DISABLE: true, MODULES_BUILTIN: true });

const split = (s: string): string[] => s.split(',').map((x) => x.trim()).filter((x) => x.length > 0);

/** From a parsed config when there is one, else from the three variables alone. */
export function discoverySettings(env: Env, cfg: AppConfig | null): Result<DiscoverySettings, string> {
  if (cfg !== null) {
    return {
      ok: true,
      value: { moduleDirs: cfg.moduleDirs, moduleDirsExplicit: cfg.moduleDirsExplicit, disabled: new Set(cfg.disabledModules), builtin: cfg.builtinModules },
    };
  }
  const parsed = DiscoveryEnv.safeParse(env);
  if (!parsed.success) return { ok: false, error: z.prettifyError(parsed.error) };
  return {
    ok: true,
    value: {
      moduleDirs: split(parsed.data.MODULE_DIRS),
      moduleDirsExplicit: env['MODULE_DIRS'] !== undefined,
      disabled: new Set(split(parsed.data.MODULES_DISABLE)),
      builtin: parsed.data.MODULES_BUILTIN,
    },
  };
}

/** The roots `run()` scans, in its order. */
export function rootsFor(cwd: string, s: DiscoverySettings): readonly ModuleRoot[] {
  return [
    ...(s.builtin ? [builtinRoot()] : []),
    ...s.moduleDirs.map((d) => ({ dir: resolve(cwd, d), entry: 'module.ts' as const, required: s.moduleDirsExplicit })),
  ];
}

export async function discoverForCli(cwd: string, s: DiscoverySettings, logger: LoggerPort): Promise<Result<DiscoveryReport, AppError>> {
  return await discoverModules({ roots: rootsFor(cwd, s), disabled: s.disabled, logger });
}
