/**
 * One call for the composition root.
 *
 * WHY it exists: `issues` and `builds` are two capabilities on purpose - filing an issue is
 * cheap and reversible, dispatching a workflow spends money - but they share one client, one
 * token, one API-version pin and one retry policy. Making the composition root assemble that
 * by hand is how two clients with different policies end up in the same process.
 *
 * WHY the ports are still handed out separately: `PortRegistry` keys them separately, and a
 * module declaring `capabilities: ['issues']` must not receive `builds`.
 */

import type { Secret } from '#core/config';
import type { AppError } from '#core/errors';
import type { Result } from '#core/result';
import type { BuildsPort, ClockPort, GitRef, LoggerPort, SecretsPort, WorkflowFile } from '#core/ports';
import { createGithubClient, type GithubRepo } from '#adapters/github/client';
import { createGithubIssues, type GithubIssuesPort } from '#adapters/github/issues';
import { createGithubBuilds } from '#adapters/github/runs';
import { createGithubSecrets } from '#adapters/github/secrets';
import { preflightGithub, type GithubPreflightReport } from '#adapters/github/preflight';

export { GITHUB_API_VERSION, createGithubClient, mapGithubError, type GithubRepo } from '#adapters/github/client';
export { createGithubIssues, issueMarker, type GithubIssuesPort } from '#adapters/github/issues';
export { createGithubBuilds, toRunStatus } from '#adapters/github/runs';
export { dispatchWorkflow } from '#adapters/github/dispatch';
export { PUBLIC_KEY_TTL_MS, createGithubSecrets, sealSecret, type SecretPublicKey } from '#adapters/github/secrets';
export {
  TOKEN_EXPIRY_HEADER,
  TOKEN_EXPIRY_WARN_MS,
  classifyPreflightFailure,
  daysUntil,
  logPreflightWarnings,
  parseTokenExpiry,
  preflightGithub,
  tokenExpiryWarning,
  workflowStateWarning,
  type GithubPreflightReport,
} from '#adapters/github/preflight';

/** The three ports the GitHub side of the bot provides, plus the one boot-time check. */
export interface GithubAdapter {
  readonly issues: GithubIssuesPort;
  readonly builds: BuildsPort;
  /**
   * WHY IT SHARES THE CLIENT: writing a user's credential uses the same token, the same
   * API-version pin and the same never-retry-a-403 policy as everything else here. WHY IT IS
   * STILL A SEPARATE PORT: `secrets` is the one capability that can overwrite what a build
   * spends, so a module must have to name it in its blast-radius line.
   */
  readonly secrets: SecretsPort;
  /**
   * Verify the GitHub half of the configuration ONCE, at boot. `preflight.ts` documents what is
   * fatal (401/404 - a value in the environment is wrong) and what is only warned about
   * (403/429/5xx/offline - GitHub is having a bad day, which must not take `/help` down too).
   *
   * WHY IT IS A METHOD ON THE ADAPTER RATHER THAN A FREE FUNCTION THE ROOT CALLS: it has to run
   * through the SAME octokit instance as every other call - the same API-version pin, the same
   * never-retry-a-401 rule, the same throttler. A preflight built on a client of its own would
   * be verifying a client the bot does not use, which is the shape of every check that stays
   * green while the thing it checks is broken.
   *
   * WHY IT IS NOT A PORT METHOD: no module may run it. It spends repository-wide quota, and its
   * only correct caller is the composition root, once, before the bot reports ready. It is
   * deliberately absent from `health()` for the same reason - see the header of `preflight.ts`.
   */
  preflight(): Promise<Result<GithubPreflightReport, AppError>>;
}

export function createGithubAdapter(input: {
  readonly token: Secret;
  readonly repo: GithubRepo;
  readonly clock: ClockPort;
  readonly logger: LoggerPort;
  /**
   * Shared with the repository's `ai-agent` environment secret APPROVAL_HMAC_KEY. If the two
   * values differ, every dispatch is refused by the workflow's approval gate and no build ever
   * starts — so this is wired from config in the composition root, never defaulted here.
   */
  readonly approvalHmacKey: Secret;
  /** The workflow every dispatch names. Branded at config load, so never free text. */
  readonly workflowFile: WorkflowFile;
  /** The ref every dispatch is sent against. Branded at config load, likewise. */
  readonly ref: GitRef;
}): GithubAdapter {
  const octokit = createGithubClient({ token: input.token, logger: input.logger });
  const shared = { octokit, repo: input.repo, clock: input.clock, logger: input.logger };
  // THE REPOSITORY'S NAME AS GITHUB SPELLS IT. It is part of the approval token's signed tuple,
  // and the verifier on the runner reads `$GITHUB_REPOSITORY`, which carries GitHub's stored
  // case. `.env` admits any case and the REST paths do not care, so the configured pair is
  // only a default: the preflight's `full_name` overwrites it before any build is signed.
  const identity = { fullName: `${input.repo.owner}/${input.repo.repo}` };
  return {
    issues: createGithubIssues(shared),
    builds: createGithubBuilds({
      ...shared,
      approvalHmacKey: input.approvalHmacKey,
      repositoryName: () => identity.fullName,
    }),
    secrets: createGithubSecrets(shared),
    preflight: async () => {
      const report = await preflightGithub({
        octokit,
        repo: input.repo,
        workflowFile: input.workflowFile,
        ref: input.ref,
        // Read at CALL time, not at construction. Boot does real work between the two, and an
        // expiry warning computed against a stale instant is wrong by exactly that much.
        nowMs: input.clock.now(),
      });
      if (report.ok) identity.fullName = report.value.fullName;
      return report;
    },
  };
}
