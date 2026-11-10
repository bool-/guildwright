/**
 * THE GATE-FILE DIGEST CHECK (RFC-001 5.4 "Workflow copy drifted from the engine's template", 5.5).
 *
 * WHAT IT PROTECTS. Every property that makes a build safe to approve - the approval MAC verified
 * before any spend, the single-use consume step, the nonce prompt fence, the agent's deny list,
 * the post-hoc path gate - lives in three files in the TARGET repository, not in this process:
 *
 *   .github/workflows/<GITHUB_WORKFLOW_FILE>     (the engine's agent-implement-request.yml)
 *   .github/scripts/verify_approval.py
 *   .github/claude/agent-settings.json
 *
 * Anyone with write access to that repository can edit them, and a merged edit weakens every
 * later build without the bot noticing. So before a build is filed or signed, the bot reads those
 * three files AT THE REF THE DISPATCH WILL RUN, hashes them, and compares each to the engine's own
 * copy. A mismatch disables builds (`/request new` refuses, `/status` says `builder: down`
 * naming the files); `/help` and every other module keep working.
 *
 * WHY PER DISPATCH, NOT PER BOOT: drift merged an hour after boot is exactly as dangerous as
 * drift present at boot, and "restart to re-check" is a check nobody runs.
 *
 * WHY IT IS CHEAP ENOUGH TO RUN PER DISPATCH: the ref's commit SHA is read first (one request),
 * and the three Contents reads happen only when that SHA differs from the one the cached verdict
 * was computed at. A busy day of builds against an unchanged branch costs one request per build.
 * The files are read AT THE RESOLVED SHA, not at the ref name, so a push landing between the two
 * reads cannot produce a verdict about a commit that never existed.
 *
 * WHERE THE EXPECTED DIGESTS COME FROM, TODAY. RFC-001 says "the installed engine's
 * `template/MANIFEST.json`"; that manifest is written by `scripts/build.ts` once PR 1.5 adds
 * `template/`, and does not exist yet. Until then the reference is the engine's OWN copies of the
 * three files, read from the engine package root (`package.json` `files` ships them), which is
 * byte-identical to what the template will carry (`build.test.ts` will assert that in 1.2/1.5).
 * PR 1.5 swaps `readEngineGateFiles` for a manifest read; nothing else here changes.
 *
 * NO OVERRIDE FLAG, deliberately (RFC-001 section 12, decision 5). A group that needs a different
 * workflow changes it in the engine, where the contract tests see it.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Octokit } from 'octokit';
import { z } from 'zod';
import { Err, Ok, type Result } from '#core/result';
import { errors, type AppError } from '#core/errors';
import { redactSecrets } from '#core/text';
import type { GitRef, LoggerPort, WorkflowFile } from '#core/ports';
import { GithubAuthFailure, readGithubFailure, type GithubRepo } from '#adapters/github/client';

// ---------------------------------------------------------------------------------------
// A narrow request seam
// ---------------------------------------------------------------------------------------

/**
 * The one thing the containment probes need from octokit: send a request, get status and data.
 *
 * WHY NOT THE OCTOKIT TYPE ITSELF: the transient arms (429, 5xx, no network) are the ones these
 * probes exist to get right, and the real client retries a 5xx with backoff and waits out a 429,
 * so a wire test of them costs tens of seconds and shares octokit's module-global limiters with
 * every other test in the file. Probes are written against this seam; production hands them
 * `githubRequester(octokit)`, which is the real client with every policy intact.
 */
export type GithubRequest = (
  route: string,
  params: Readonly<Record<string, string | number | boolean>>,
) => Promise<{ readonly status: number; readonly data: unknown }>;

/** The production seam: the bot's own client, unchanged. */
export function githubRequester(octokit: Octokit): GithubRequest {
  return async (route, params) => {
    const res = await octokit.request(route, { ...params });
    return { status: res.status, data: res.data };
  };
}

// ---------------------------------------------------------------------------------------
// The three files
// ---------------------------------------------------------------------------------------

/** The engine's own workflow file name; the target repository may name its copy differently. */
export const ENGINE_WORKFLOW_PATH = '.github/workflows/agent-implement-request.yml';
export const VERIFIER_PATH = '.github/scripts/verify_approval.py';
export const AGENT_SETTINGS_PATH = '.github/claude/agent-settings.json';

/**
 * The command the drift sentence tells the operator to run.
 *
 * PR 1.4 builds the CLI that answers it (`template apply` copies the installed engine's template
 * files into the module repo). Until then the operator copies the three files by hand from the
 * engine; the sentence names the command the RFC fixes so the text does not change again.
 */
export const TEMPLATE_APPLY_COMMAND = 'npx discord-ai-feature-builder template apply';

/** One gate file: where it lives in the TARGET repository, and the sha256 it must have. */
export interface GateFile {
  readonly repoPath: string;
  readonly sha256: string;
}

/** Hex sha256 of exact bytes. No normalisation: byte-identical is the property. */
export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * Which repository path is compared to which engine file. The workflow is the one the bot
 * DISPATCHES (`GITHUB_WORKFLOW_FILE`), so a renamed copy is checked rather than skipped.
 */
export function gateFileMap(workflowFile: WorkflowFile): readonly { readonly repoPath: string; readonly enginePath: string }[] {
  return [
    { repoPath: `.github/workflows/${workflowFile}`, enginePath: ENGINE_WORKFLOW_PATH },
    { repoPath: VERIFIER_PATH, enginePath: VERIFIER_PATH },
    { repoPath: AGENT_SETTINGS_PATH, enginePath: AGENT_SETTINGS_PATH },
  ];
}

/**
 * The expected digests, from the engine package's own copies of the three files.
 *
 * An `Err` here is not fatal at boot (the builder reports `down` with it; `/help` keeps working),
 * and it is fail-CLOSED: an engine that cannot say what its gates should be cannot say that the
 * repository's match, so no build runs. PR 1.5 replaces this with a `template/MANIFEST.json` read.
 */
export function readEngineGateFiles(engineRoot: string, workflowFile: WorkflowFile): Result<readonly GateFile[], AppError> {
  const out: GateFile[] = [];
  for (const { repoPath, enginePath } of gateFileMap(workflowFile)) {
    let bytes: Uint8Array;
    try {
      bytes = readFileSync(join(engineRoot, ...enginePath.split('/')));
    } catch {
      return Err(
        errors.config(
          'engine.gates',
          `Builds are disabled: the engine's own copy of ${enginePath} is missing from ${engineRoot}, so the repository's gate files cannot be checked.`,
          'Reinstall the engine (npm ci) so its gate files are present, then restart.',
        ),
      );
    }
    out.push({ repoPath, sha256: sha256Hex(bytes) });
  }
  return Ok(out);
}

// ---------------------------------------------------------------------------------------
// The sentences
// ---------------------------------------------------------------------------------------

/** The RFC-001 5.4 sync sentence: `internal` + `nextStep` read as one line. */
export function gateDriftError(files: readonly string[], fullName: string, engineVersion: string): AppError {
  return errors.config(
    'github.gates',
    `Builds are disabled: ${files.join(', ')} in ${fullName} ${files.length === 1 ? 'does' : 'do'} not match the engine's template (engine ${engineVersion}).`,
    `Run ${TEMPLATE_APPLY_COMMAND}, commit, and restart.`,
  );
}

/** The ref every dispatch names cannot be resolved, so the files that would run cannot be read. */
export function gateRefError(ref: GitRef, fullName: string, status: number): AppError {
  return errors.config(
    'GITHUB_REF',
    `Builds are disabled: GitHub could not resolve GITHUB_REF "${ref}" in ${fullName} (HTTP ${status}), so the gate files a build would run cannot be checked.`,
    'Set GITHUB_REF to a branch or tag that exists, and make sure the token has Contents: read (the gate-file check needs it), then restart.',
  );
}

/** Contents refused outright: a permission, not a missing file. */
export function gateContentsForbiddenError(fullName: string, status: number): AppError {
  return errors.config(
    'github.gates',
    `Builds are disabled: the token cannot read repository contents on ${fullName} (HTTP ${status}), so the gate files cannot be checked.`,
    'Add Contents: read to the PAT (or to the GitHub App); the next /request new or build checks again.',
  );
}

/** GitHub could not answer right now. RETRYABLE: nothing about the configuration is known to be wrong. */
export function gateUnverifiedError(fullName: string, status: number): AppError {
  const why = status === 0 ? 'GitHub could not be reached' : `GitHub answered ${status}`;
  return {
    ...errors.unavailable('GitHub', 'Try again in a few minutes; nothing was filed or spent.'),
    internal: `the gate files in ${fullName} could not be checked (${why}); builds stay disabled until the check passes.`,
  };
}

/** The sentence `/status` shows, from any gate error. */
export function readinessSentence(error: AppError): string {
  return error.internal === null ? error.nextStep : `${error.internal} ${error.nextStep}`;
}

// ---------------------------------------------------------------------------------------
// Wire shapes
// ---------------------------------------------------------------------------------------

const CommitPayload = z.object({ sha: z.string().regex(/^[0-9a-f]{40}$/u) });

/** A file. A directory answers with an array, which is "no file here" for this check. */
const FilePayload = z.object({ type: z.string(), encoding: z.string().optional(), content: z.string().optional() });

/** Transient: worth asking again, says nothing about configuration. A rate-limit 403 is one. */
export function isTransientFailure(cause: unknown, nowMs: number): { readonly transient: boolean; readonly status: number } {
  const f = readGithubFailure(cause, nowMs);
  const rateLimited403 = f.status === 403 && (f.rateLimitRemaining === 0 || f.retryAfterMs !== null);
  return { transient: f.status === 0 || f.status === 429 || f.status >= 500 || rateLimited403, status: f.status };
}

/** The credential itself was rejected, or the App is gone. Same verdict as at boot. */
export function credentialFailure(cause: unknown, nowMs: number, operation: string): AppError | null {
  if (cause instanceof GithubAuthFailure) return cause.appError;
  const f = readGithubFailure(cause, nowMs);
  if (f.status !== 401) return null;
  return errors.config(
    'GITHUB_TOKEN',
    redactSecrets(`${operation}: ${f.name} status=401 - GitHub rejected the credential`),
    'GITHUB_TOKEN is expired, revoked, or malformed. Issue a new token with repository access to contents, issues, actions, environments and secrets, set it, and restart.',
  );
}

// ---------------------------------------------------------------------------------------
// The check
// ---------------------------------------------------------------------------------------

/** What one check concluded. `match` and `drift` are cached by SHA; the rest are re-asked. */
export type GateVerdict =
  | { readonly kind: 'match'; readonly sha: string }
  | { readonly kind: 'drift'; readonly sha: string; readonly files: readonly string[]; readonly error: AppError }
  /** Refused, non-retryable: unresolvable ref, Contents refused, no reference digests. */
  | { readonly kind: 'blocked'; readonly error: AppError }
  /** Could not be asked right now (429, 5xx, network). Retryable. */
  | { readonly kind: 'unverified'; readonly error: AppError };

export interface GateCheck {
  /** One commit read, plus three Contents reads only when the ref's SHA moved. */
  verify(): Promise<GateVerdict>;
  /** The last verdict, without a request; `null` before the first check. */
  last(): GateVerdict | null;
}

export interface GateCheckInput {
  readonly request: GithubRequest;
  readonly repo: GithubRepo;
  /** `owner/name` as GitHub spells it, read at call time (the preflight learns it). */
  readonly fullName: () => string;
  readonly ref: GitRef;
  /** The expected digests, or why there are none. */
  readonly reference: Result<readonly GateFile[], AppError>;
  /** For the sentence: "does not match the engine's template (engine <v>)". */
  readonly engineVersion: string;
  readonly nowMs: () => number;
  readonly logger: LoggerPort;
}

export function createGateCheck(input: GateCheckInput): GateCheck {
  const { owner, repo } = input.repo;
  const log = input.logger.child({ component: 'github.gates' });
  /** The last verdict computed from file reads, keyed by the commit it was computed at. */
  let cached: { readonly sha: string; readonly verdict: GateVerdict } | null = null;
  let latest: GateVerdict | null = null;

  const settle = (verdict: GateVerdict): GateVerdict => {
    latest = verdict;
    return verdict;
  };

  /** Turn a thrown failure on either read into a verdict. */
  const failed = (cause: unknown, operation: string, notFound: (status: number) => GateVerdict): GateVerdict => {
    const nowMs = input.nowMs();
    const credential = credentialFailure(cause, nowMs, operation);
    if (credential !== null) return { kind: 'blocked', error: credential };
    const { transient, status } = isTransientFailure(cause, nowMs);
    if (transient) return { kind: 'unverified', error: gateUnverifiedError(input.fullName(), status) };
    if (status === 403) return { kind: 'blocked', error: gateContentsForbiddenError(input.fullName(), status) };
    return notFound(status);
  };

  async function readFileDigest(path: string, sha: string): Promise<{ readonly digest: string | null } | { readonly verdict: GateVerdict }> {
    try {
      const res = await input.request('GET /repos/{owner}/{repo}/contents/{path}', { owner, repo, path, ref: sha });
      const parsed = FilePayload.safeParse(res.data);
      // An array (a directory at that path), a symlink or submodule, or a file too large to be
      // inlined: none of them is the engine's file, so all of them are drift.
      if (!parsed.success || parsed.data.type !== 'file' || parsed.data.encoding !== 'base64' || parsed.data.content === undefined) {
        return { digest: null };
      }
      return { digest: sha256Hex(Buffer.from(parsed.data.content, 'base64')) };
    } catch (cause: unknown) {
      // 404 at a commit that resolved: the file is not there. That is drift, not an error.
      const verdict = failed(cause, 'gates.contents', () => ({ kind: 'drift', sha, files: [path], error: gateDriftError([path], input.fullName(), input.engineVersion) }));
      if (verdict.kind === 'drift') return { digest: null };
      return { verdict };
    }
  }

  return {
    last: () => latest,

    async verify(): Promise<GateVerdict> {
      if (!input.reference.ok) return settle({ kind: 'blocked', error: input.reference.error });
      const expected = input.reference.value;

      // 1. Which commit would a dispatch run right now?
      let sha: string;
      try {
        const res = await input.request('GET /repos/{owner}/{repo}/commits/{ref}', { owner, repo, ref: input.ref });
        const parsed = CommitPayload.safeParse(res.data);
        if (!parsed.success) return settle({ kind: 'unverified', error: gateUnverifiedError(input.fullName(), res.status) });
        sha = parsed.data.sha;
      } catch (cause: unknown) {
        return settle(
          failed(cause, 'gates.ref', (status) => ({ kind: 'blocked', error: gateRefError(input.ref, input.fullName(), status) })),
        );
      }

      // 2. Unchanged commit: the files cannot have changed either.
      if (cached !== null && cached.sha === sha) return settle(cached.verdict);

      // 3. The SHA moved (or this is the first check): read and hash the three files at it.
      const mismatched: string[] = [];
      for (const file of expected) {
        const got = await readFileDigest(file.repoPath, sha);
        if ('verdict' in got) return settle(got.verdict);
        if (got.digest !== file.sha256) mismatched.push(file.repoPath);
      }
      const verdict: GateVerdict =
        mismatched.length === 0
          ? { kind: 'match', sha }
          : { kind: 'drift', sha, files: mismatched, error: gateDriftError(mismatched, input.fullName(), input.engineVersion) };
      if (verdict.kind === 'drift') {
        log.warn('gate files drifted from the engine template; builds are disabled', {
          ref: input.ref,
          sha,
          files: mismatched.join(','),
        });
      } else if (cached !== null && cached.verdict.kind === 'drift') {
        log.info('gate files match the engine template again; builds are enabled', { ref: input.ref, sha });
      }
      cached = { sha, verdict };
      return settle(verdict);
    },
  };
}
