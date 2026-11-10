/**
 * THE CONTAINMENT PREFLIGHT (RFC-001 5.4): the GitHub misconfigurations that would make the bot
 * leak, or spend, or run an unverified gate - each probed at boot, each with one exact sentence.
 *
 *   probe                 asks                                                   refuses to start when
 *   visibility            GET /repos/{o}/{r} (`private`; read by the preflight)  the repo is public and ALLOW_PUBLIC_TARGET_REPO is not true
 *   approval-secret       GET .../actions/secrets/APPROVAL_HMAC_KEY              404 with a readable secrets list (absent);
 *                         (+ GET .../actions/secrets on a 404)                     403/404 on the list, or 403 on the secret, in PAT mode (permission)
 *   environments          GET .../environments  (requireOwnCredentials true)     403/404/422
 *   shared-environment    GET .../environments/ai-agent/secrets                  404 with a readable listing (absent), or no credential in it
 *                         (requireOwnCredentials false)
 *
 * THE TRANSIENT POSTURE, the same rule the original preflight drew (`preflight.ts` header): a 429,
 * a 5xx, a rate-limit 403, a network failure - and, in App mode, a 403/404 on a secrets read whose
 * permission the installation check already verified - say nothing about configuration. They WARN,
 * the bot STARTS, and the probe is marked unverified: `/status` reports `builder: down` and builds
 * are refused until the probe passes. Unverified probes re-run at the next `verifyGates` (the next
 * `/request new` or dispatch), so a GitHub blip at boot costs builds until GitHub answers rather
 * than until somebody restarts. They do NOT re-run on `/status`: a health check that spends the
 * feature's API budget can take the feature down during the incident it reports.
 *
 * Only an answer that is EVIDENCE of misconfiguration refuses to start. Nothing on this list has a
 * "degrade and keep building" branch, with one deliberate exception carried over unchanged: with
 * `requireOwnCredentials` false and the environments listing unreadable, `resolveBuildPayer`
 * already dispatches to `ai-agent` without reading it, because the operator chose to pay; that is
 * warned about here, not refused.
 *
 * NOTHING HERE READS A SECRET VALUE. GitHub's secrets endpoints return names and dates only.
 */

import { z } from 'zod';
import { Err, Ok, type Result } from '#core/result';
import { errors, type AppError } from '#core/errors';
import { SHARED_BUILD_ENVIRONMENT } from '#core/text';
import type { LoggerPort } from '#core/ports';
import type { GithubRepo } from '#adapters/github/client';
import { credentialFailure, isTransientFailure, readinessSentence, type GithubRequest } from '#adapters/github/gates';

// ---------------------------------------------------------------------------------------
// The sentences (RFC-001 5.4, verbatim: `internal` is the diagnosis, `nextStep` the fix)
// ---------------------------------------------------------------------------------------

export const APPROVAL_SECRET_NAME = 'APPROVAL_HMAC_KEY';

export function publicRepoError(fullName: string): AppError {
  return errors.config(
    'ALLOW_PUBLIC_TARGET_REPO',
    `${fullName} is PUBLIC, so every request filed into it would be public.`,
    'Make the repository private, or set ALLOW_PUBLIC_TARGET_REPO=true if that is what you want.',
  );
}

export function approvalSecretMissingError(fullName: string): AppError {
  return errors.config(
    'APPROVAL_HMAC_KEY',
    `${fullName} has no repository secret APPROVAL_HMAC_KEY, so every build would be rejected at the approval gate.`,
    'Settings -> Secrets and variables -> Actions -> Repository secrets; set it to the same value as APPROVAL_HMAC_KEY in .env.',
  );
}

export function secretsUnreadableError(fullName: string, status: number): AppError {
  return errors.config(
    'GITHUB_TOKEN',
    `the token cannot read repository secrets on ${fullName} (HTTP ${status}), so the APPROVAL_HMAC_KEY check cannot run.`,
    'Add Secrets: read to the PAT (or to the GitHub App), then restart.',
  );
}

export function environmentsRefusedError(fullName: string, status: number): AppError {
  return errors.config(
    'modules.builder.requireOwnCredentials',
    `GitHub refused to list environments for ${fullName} (HTTP ${status}).`,
    'Bring-your-own-credentials needs environments: grant the App the Environments permission, or check that your GitHub plan allows environments on a private repository, or set MODULES_JSON={"builder":{"requireOwnCredentials":false}} and fund builds yourself.',
  );
}

export function sharedEnvironmentMissingError(fullName: string): AppError {
  return errors.config(
    'modules.builder.requireOwnCredentials',
    `requireOwnCredentials is false but ${fullName} has no environment named ${SHARED_BUILD_ENVIRONMENT} to pay from.`,
    'Create it (Settings -> Environments) and add ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN.',
  );
}

/** Not a row of its own in 5.4; the PR 1.7 operator entry says the environment must HOLD a credential. */
export function sharedEnvironmentEmptyError(fullName: string): AppError {
  return errors.config(
    'modules.builder.requireOwnCredentials',
    `requireOwnCredentials is false but the ${SHARED_BUILD_ENVIRONMENT} environment in ${fullName} holds neither ANTHROPIC_API_KEY nor CLAUDE_CODE_OAUTH_TOKEN, so nothing would pay for a build.`,
    `Add ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN to it (Settings -> Environments -> ${SHARED_BUILD_ENVIRONMENT}).`,
  );
}

// ---------------------------------------------------------------------------------------
// Verdicts
// ---------------------------------------------------------------------------------------

/** One probe's answer. `notes` are non-fatal findings, printed at boot. */
export type ProbeVerdict =
  | { readonly kind: 'ok'; readonly notes: readonly string[] }
  | { readonly kind: 'refused'; readonly error: AppError }
  /** GitHub could not answer; `status` is 0 for no network. Builds stay off until it passes. */
  | { readonly kind: 'unverified'; readonly status: number };

const OK: ProbeVerdict = { kind: 'ok', notes: [] };

export type ProbeId = 'visibility' | 'approval-secret' | 'environments' | 'shared-environment';

/** What each probe is called in a sentence. */
export const PROBE_LABEL: Readonly<Record<ProbeId, string>> = {
  visibility: 'whether the repository is private',
  'approval-secret': `the ${APPROVAL_SECRET_NAME} repository secret`,
  environments: 'the environments listing (bring-your-own-credentials)',
  'shared-environment': `the ${SHARED_BUILD_ENVIRONMENT} environment`,
};

function statusWords(status: number): string {
  return status === 0 ? 'GitHub could not be reached' : `GitHub answered ${status}`;
}

/** The boot warning for an unverified probe. */
export function unverifiedWarning(id: ProbeId, fullName: string, status: number): string {
  return `could not check ${PROBE_LABEL[id]} on ${fullName} (${statusWords(status)}); the bot is starting, but builds stay disabled until the check passes. It runs again at the next /request new or build.`;
}

/** The `/status` line for an unverified probe. */
export function unverifiedDetail(id: ProbeId, fullName: string, status: number): string {
  return `Builds are disabled: ${PROBE_LABEL[id]} on ${fullName} has not been verified (${statusWords(status)}). It is checked again at the next /request new or build.`;
}

/**
 * The visibility verdict from the `private` field of `GET /repos/{o}/{r}`. Pure, so the boot
 * path (which already holds the preflight's answer) and a re-run reach the same conclusion.
 */
export function visibilityVerdict(isPrivate: boolean | null, fullName: string, allowPublic: boolean): ProbeVerdict {
  // GitHub always sends `private`; its absence is a response this code cannot read, not a "no".
  if (isPrivate === null) return { kind: 'unverified', status: 200 };
  if (isPrivate) return OK;
  if (!allowPublic) return { kind: 'refused', error: publicRepoError(fullName) };
  return {
    kind: 'ok',
    notes: [`${fullName} is PUBLIC and ALLOW_PUBLIC_TARGET_REPO=true, so every request filed into it, and every build log, is public.`],
  };
}

// ---------------------------------------------------------------------------------------
// The probes
// ---------------------------------------------------------------------------------------

export interface ContainmentInput {
  readonly request: GithubRequest;
  readonly repo: GithubRepo;
  /** `owner/name` as GitHub spells it, read at call time. */
  readonly fullName: () => string;
  /** PAT or App: decides whether a 403 on a secrets read is evidence or noise. */
  readonly authKind: 'pat' | 'app';
  readonly allowPublicTargetRepo: boolean;
  /**
   * The builder's funding switch, or `null` when the builder is not loaded - then nothing on the
   * build path is probed, because nothing will build.
   */
  readonly builder: { readonly requireOwnCredentials: boolean } | null;
  readonly nowMs: () => number;
  readonly logger: LoggerPort;
}

const RepoVisibility = z.object({ private: z.boolean().optional() });
const SecretNames = z.object({ secrets: z.array(z.object({ name: z.string() })) });

/** The arms every probe shares: a rejected credential refuses, a transient is unverified. */
function common(cause: unknown, nowMs: number, operation: string): ProbeVerdict | { readonly status: number } {
  const credential = credentialFailure(cause, nowMs, operation);
  if (credential !== null) return { kind: 'refused', error: credential };
  const t = isTransientFailure(cause, nowMs);
  if (t.transient) return { kind: 'unverified', status: t.status };
  return { status: t.status };
}

export function containmentProbes(input: ContainmentInput): ReadonlyMap<ProbeId, () => Promise<ProbeVerdict>> {
  const { owner, repo } = input.repo;
  const { request } = input;
  const probes = new Map<ProbeId, () => Promise<ProbeVerdict>>();

  probes.set('visibility', async () => {
    try {
      const res = await request('GET /repos/{owner}/{repo}', { owner, repo });
      const parsed = RepoVisibility.safeParse(res.data);
      return visibilityVerdict(parsed.success ? (parsed.data.private ?? null) : null, input.fullName(), input.allowPublicTargetRepo);
    } catch (cause: unknown) {
      const v = common(cause, input.nowMs(), 'containment.visibility');
      // A 404 here, after the boot preflight already saw the repository, is the token losing
      // access mid-run: not evidence this probe can act on, so it stays unverified.
      return 'kind' in v ? v : { kind: 'unverified', status: v.status };
    }
  });

  if (input.builder === null) return probes;

  probes.set('approval-secret', async () => {
    const nowMs = input.nowMs();
    try {
      await request('GET /repos/{owner}/{repo}/actions/secrets/{secret_name}', { owner, repo, secret_name: APPROVAL_SECRET_NAME });
      return OK;
    } catch (cause: unknown) {
      const v = common(cause, nowMs, 'containment.approval_secret');
      if ('kind' in v) return v;
      if (v.status === 403) {
        // In App mode the boot permission check already proved `Secrets: read` was granted, so a
        // 403 is not evidence (RFC-001 5.4). A PAT has no such check: this IS the evidence.
        return input.authKind === 'pat' ? { kind: 'refused', error: secretsUnreadableError(input.fullName(), 403) } : { kind: 'unverified', status: 403 };
      }
      if (v.status !== 404) return { kind: 'unverified', status: v.status };
    }
    // A 404 on the one secret: is the secret absent, or can this token not read secrets at all?
    // GitHub answers 404 for both. The LISTING names no particular secret, so it has no existence
    // precondition to fail on - the same two-404 disambiguation `secrets.ts` does for environments.
    try {
      await request('GET /repos/{owner}/{repo}/actions/secrets', { owner, repo, per_page: 1 });
      return { kind: 'refused', error: approvalSecretMissingError(input.fullName()) };
    } catch (cause: unknown) {
      const v = common(cause, input.nowMs(), 'containment.secrets_list');
      if ('kind' in v) return v;
      if (v.status === 403 || v.status === 404) {
        return input.authKind === 'pat'
          ? { kind: 'refused', error: secretsUnreadableError(input.fullName(), v.status) }
          : { kind: 'unverified', status: v.status };
      }
      return { kind: 'unverified', status: v.status };
    }
  });

  const environmentsListing = async (): Promise<{ readonly readable: true } | { readonly readable: false; readonly verdict: ProbeVerdict | { readonly status: number } }> => {
    try {
      await request('GET /repos/{owner}/{repo}/environments', { owner, repo, per_page: 1 });
      return { readable: true };
    } catch (cause: unknown) {
      return { readable: false, verdict: common(cause, input.nowMs(), 'containment.environments') };
    }
  };

  if (input.builder.requireOwnCredentials) {
    probes.set('environments', async () => {
      const listing = await environmentsListing();
      if (listing.readable) return OK;
      const v = listing.verdict;
      if ('kind' in v) return v;
      // 403 (no Environments permission), 404 or 422 (the plan does not offer environments on a
      // private repository): bring-your-own-credentials cannot work, and with the gate on there
      // is no fallback. Evidence, in either auth mode.
      if (v.status === 403 || v.status === 404 || v.status === 422) {
        return { kind: 'refused', error: environmentsRefusedError(input.fullName(), v.status) };
      }
      return { kind: 'unverified', status: v.status };
    });
  } else {
    probes.set('shared-environment', async () => {
      const unreadable = (status: number): ProbeVerdict => ({
        kind: 'ok',
        notes: [
          `could not read the ${SHARED_BUILD_ENVIRONMENT} environment on ${input.fullName()} (HTTP ${status}); with requireOwnCredentials false, builds are still dispatched to it, exactly as before. Grant the token the Environments permission so the bot can confirm it holds a credential.`,
        ],
      });
      try {
        const res = await request('GET /repos/{owner}/{repo}/environments/{environment_name}/secrets', {
          owner,
          repo,
          environment_name: SHARED_BUILD_ENVIRONMENT,
          per_page: 30,
        });
        const parsed = SecretNames.safeParse(res.data);
        if (!parsed.success) return { kind: 'unverified', status: res.status };
        const names = parsed.data.secrets.map((s) => s.name);
        return names.includes('ANTHROPIC_API_KEY') || names.includes('CLAUDE_CODE_OAUTH_TOKEN')
          ? OK
          : { kind: 'refused', error: sharedEnvironmentEmptyError(input.fullName()) };
      } catch (cause: unknown) {
        const v = common(cause, input.nowMs(), 'containment.shared_environment');
        if ('kind' in v) return v;
        if (v.status !== 404) return v.status === 403 ? unreadable(403) : { kind: 'unverified', status: v.status };
      }
      // A 404: no such environment, or no access to environments at all. Same disambiguation.
      const listing = await environmentsListing();
      if (listing.readable) return { kind: 'refused', error: sharedEnvironmentMissingError(input.fullName()) };
      const v = listing.verdict;
      if ('kind' in v) return v;
      if (v.status === 403 || v.status === 404 || v.status === 422) return unreadable(v.status);
      return { kind: 'unverified', status: v.status };
    });
  }

  return probes;
}

// ---------------------------------------------------------------------------------------
// The state the adapter keeps
// ---------------------------------------------------------------------------------------

export interface Containment {
  /**
   * Run every probe once, at boot. `visibility` may be pre-answered from the preflight's own
   * `GET /repos/{o}/{r}` (so the repository is not asked twice); `null` there means the preflight
   * could not ask, and the probe is left unverified without another request.
   *
   * `Err` is the FIRST refusal, which refuses the boot. `Ok` carries every warning and note.
   */
  boot(visibility: { readonly isPrivate: boolean | null } | null): Promise<Result<readonly string[], AppError>>;
  /**
   * Re-run every probe that is not `ok`. `Err` non-retryable: a probe now refuses (builds off).
   * `Err` retryable: one is still unverified. Costs nothing when everything passed at boot.
   */
  recheck(): Promise<Result<void, AppError>>;
  /** The `/status` sentence for the first probe that is not `ok`, or `null` when all pass. */
  downDetail(): string | null;
}

export function createContainment(input: ContainmentInput): Containment {
  const probes = containmentProbes(input);
  const state = new Map<ProbeId, ProbeVerdict>();
  const log = input.logger.child({ component: 'github.containment' });

  const record = (id: ProbeId, verdict: ProbeVerdict): ProbeVerdict => {
    state.set(id, verdict);
    return verdict;
  };

  return {
    async boot(visibility) {
      const warnings: string[] = [];
      for (const [id, run] of probes) {
        let verdict: ProbeVerdict;
        if (id === 'visibility' && visibility === null) {
          // The preflight's repository read was itself transient; asking again a second later
          // would only repeat the story, and every later probe would too.
          verdict = { kind: 'unverified', status: 0 };
        } else if (id === 'visibility' && visibility !== null) {
          verdict = visibilityVerdict(visibility.isPrivate, input.fullName(), input.allowPublicTargetRepo);
        } else {
          verdict = await run();
        }
        record(id, verdict);
        if (verdict.kind === 'refused') return Err(verdict.error);
        if (verdict.kind === 'unverified') warnings.push(unverifiedWarning(id, input.fullName(), verdict.status));
        else warnings.push(...verdict.notes);
      }
      return Ok(warnings);
    },

    async recheck() {
      for (const [id, run] of probes) {
        const before = state.get(id);
        if (before !== undefined && before.kind === 'ok') continue;
        const verdict = record(id, await run());
        if (verdict.kind === 'refused') {
          log.warn('containment check refused builds', { check: id, detail: readinessSentence(verdict.error) });
          return Err(verdict.error);
        }
        if (verdict.kind === 'unverified') {
          return Err({
            ...errors.unavailable('GitHub', 'Try again in a few minutes; nothing was filed or spent.'),
            internal: unverifiedDetail(id, input.fullName(), verdict.status),
          });
        }
        log.info('containment check passed on re-run', { check: id });
      }
      return Ok(undefined);
    },

    downDetail() {
      for (const id of probes.keys()) {
        const verdict = state.get(id);
        if (verdict === undefined) return unverifiedDetail(id, input.fullName(), 0);
        if (verdict.kind === 'refused') return readinessSentence(verdict.error);
        if (verdict.kind === 'unverified') return unverifiedDetail(id, input.fullName(), verdict.status);
      }
      return null;
    },
  };
}

