/**
 * THE INSTALLED ENGINE'S TEMPLATE MANIFEST, read and verified (RFC-001 4.3, 5.4, 9.4).
 *
 *   <engineRoot>/template/MANIFEST.json   { "engineVersion": "<the engine's package.json version>",
 *                                           "files": { "<posix path>": "<sha256 hex of its bytes>" } }
 *
 * `scripts/build.ts` writes it over `template/.github/**` and `template/AGENTS.md`: the bytes a
 * module repository must hold byte for byte. Two readers, one parser, so they cannot disagree
 * about what a valid manifest is:
 *
 *   - the CLI (`src/cli/template.ts`): `init`, `template check`, `template apply`;
 *   - the gate-file digest check (`src/adapters/github/gates.ts`), which compares the target
 *     repository's gate files against these digests before every build.
 *
 * VERIFIED, NOT TRUSTED: every listed path must exist under `template/` with exactly the digest
 * listed, and the manifest must have been written for THIS engine version. A manifest from
 * another release describes another release's gates; comparing a repository against it would
 * refuse a correct repository or, worse, accept an outdated one.
 *
 * A listed path outside `.github/` and `AGENTS.md` is refused too: `template apply` rewrites
 * exactly the listed paths, so it must be unable, by construction, to touch `src/`.
 *
 * The reasons are plain sentences; each caller wraps them in its own `AppError`, because "init
 * cannot run" and "builds are disabled" need different next steps.
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { z } from 'zod';

import { Err, Ok, type Result } from '#core/result';

export const TEMPLATE_DIR = 'template';
export const TEMPLATE_MANIFEST = 'MANIFEST.json';

export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** A gated path: under `.github/`, or `AGENTS.md`. Nothing else may be listed. */
export function isGatedPath(path: string): boolean {
  if (path.includes('\\') || path.startsWith('/') || path.split('/').some((seg) => seg === '..' || seg === '.' || seg === '')) return false;
  return path === 'AGENTS.md' || path.startsWith('.github/');
}

const Sha256 = z.string().regex(/^[0-9a-f]{64}$/u);
const ManifestSchema = z.object({
  engineVersion: z.string().min(1),
  files: z.record(z.string(), Sha256),
});

/** The installed engine's template, verified against its manifest. */
export interface TemplateManifest {
  /** Absolute `<engineRoot>/template`. */
  readonly root: string;
  readonly engineVersion: string;
  /** Gated path -> sha256, sorted by path. */
  readonly gated: ReadonlyMap<string, string>;
}

/** Why the manifest cannot be used. `missing` is "this engine ships no template at all". */
export type ManifestProblem =
  | { readonly kind: 'missing' }
  | { readonly kind: 'invalid'; readonly reason: string };

/** Read `<engineRoot>/template/MANIFEST.json` and verify it against the files and `engineVersion`. */
export function readTemplateManifest(engineRoot: string, engineVersion: string): Result<TemplateManifest, ManifestProblem> {
  const root = join(engineRoot, TEMPLATE_DIR);
  if (!existsSync(root) || !statSync(root).isDirectory()) return Err({ kind: 'missing' });
  const invalid = (reason: string): Result<TemplateManifest, ManifestProblem> => Err({ kind: 'invalid', reason });

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(join(root, TEMPLATE_MANIFEST), 'utf8'));
  } catch {
    return invalid(`${TEMPLATE_DIR}/${TEMPLATE_MANIFEST} is missing or is not JSON in ${engineRoot}.`);
  }
  const parsed = ManifestSchema.safeParse(raw);
  if (!parsed.success) return invalid(`${TEMPLATE_DIR}/${TEMPLATE_MANIFEST} does not have the expected shape: ${z.prettifyError(parsed.error)}`);
  const manifest = parsed.data;
  if (manifest.engineVersion !== engineVersion) {
    return invalid(
      `${TEMPLATE_DIR}/${TEMPLATE_MANIFEST} was written for engine ${manifest.engineVersion}, but the engine is ${engineVersion}; its gate digests describe another release.`,
    );
  }
  const gated = new Map<string, string>();
  for (const path of Object.keys(manifest.files).sort()) {
    const digest = manifest.files[path] ?? '';
    if (!isGatedPath(path)) {
      return invalid(`${TEMPLATE_DIR}/${TEMPLATE_MANIFEST} lists ${path}, which is not under .github/ and is not AGENTS.md; template apply may only ever rewrite those.`);
    }
    let bytes: Uint8Array;
    try {
      bytes = readFileSync(join(root, ...path.split('/')));
    } catch {
      return invalid(`${TEMPLATE_DIR}/${TEMPLATE_MANIFEST} lists ${path}, but ${TEMPLATE_DIR}/${path} does not exist.`);
    }
    if (sha256Hex(bytes) !== digest) {
      return invalid(`${TEMPLATE_DIR}/${path} does not match the digest ${TEMPLATE_MANIFEST} records for it; the installed template is inconsistent.`);
    }
    gated.set(path, digest);
  }
  if (gated.size === 0) return invalid(`${TEMPLATE_DIR}/${TEMPLATE_MANIFEST} lists no gated files.`);
  return Ok({ root, engineVersion: manifest.engineVersion, gated });
}
