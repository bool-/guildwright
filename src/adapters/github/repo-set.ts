/**
 * ONE GITHUB ADAPTER PER CONFIGURED REPOSITORY (RFC-001 PR 2.1, sections 7.1 and 7.4).
 *
 * The composition root used to build one adapter, bound to `GITHUB_OWNER`/`GITHUB_REPO`. It now
 * builds the set: every repository of `GITHUB_REPOS_JSON` (or the one-repository set the shim
 * makes of the old pair) gets its own `assembleGithubAdapter` - its own issues, builds and
 * secrets ports, its own containment probes, its own gate-file cache, its own bound ref and
 * workflow, and its own approval-token `repository` field. Modules reach them through
 * `RepoScoped<T>.at(repo)`.
 *
 * WHAT IS SHARED, AND WHY:
 *
 *  - PAT mode: ONE client, so one token, one throttler and one retry policy for the whole set
 *    (RFC-001 6.6: a fine-grained PAT is scoped to the repositories it lists). Only the ports
 *    built on it are per repository.
 *  - App mode: ONE App - one private key, one JWT, one `GET /app` - and an INSTALLATION PER
 *    REPOSITORY (RFC-001 6.4 step 2, run once per repository): each repository's installation
 *    is looked up (or its pinned `installationId` checked), its permissions compared with 6.1 and
 *    its `repository_selection` refused if `all`, independently. Two repositories on one account
 *    usually share one installation id; each still gets its own client, so an uninstall is
 *    reported naming the repository whose call learned it.
 *
 * WHAT A FAILURE IS SCOPED TO:
 *
 *  - Anything RFC-001 5.4 says refuses to start (an App not installed on a repository, a missing
 *    permission, a public repository, a missing APPROVAL_HMAC_KEY secret, ...) still refuses to
 *    start: each repository passes the full preflight independently (7.1), and a bot whose set
 *    contains a misconfigured repository is a misconfigured bot. Every repository is checked
 *    before the answer is given, so `doctor` and the boot both name every repository at fault in
 *    one pass instead of one restart each.
 *  - Anything 5.4 says only disables builds (a transient probe failure, drifted gate files, an
 *    unresolvable ref) is scoped to THAT repository: its adapter reports `down`, the others stay
 *    `ready`, because the containment gate and the gate-file cache are per adapter.
 */

import { Err, Ok, type Result } from '#core/result';
import type { AppError } from '#core/errors';
import type { GithubRepoConfig, Secret } from '#core/config';
import type { GuildId } from '#core/ids';
import type { BuildsPort, ClockPort, GithubAuthSummary, IssuesPort, LoggerPort, SecretsPort } from '#core/ports';
import {
  createRepoSet,
  createReposPort,
  noActivity,
  noGuildMapping,
  repoScoped,
  type RepoActivityReport,
  type RepoRef,
  type RepoScoped,
  type RepoSet,
  type ReposPort,
} from '#core/ports/repos';
import { createGithubClient } from '#adapters/github/client';
import { openGithubInstallation, startGithubApp, type GithubCredentials } from '#adapters/github/app-auth';
import type { GateFile, GithubRequest } from '#adapters/github/gates';
import type { GithubPreflightReport } from '#adapters/github/preflight';
import { PAT_MODE_WARNING, assembleGithubAdapter, type GithubAdapter, type GithubConnection } from '#adapters/github/index';

export interface GithubRepoSetInput {
  /** ONE credential for the whole set: a PAT, or an App. */
  readonly auth: GithubCredentials;
  /** The configured set, from `cfg.github.repos`. */
  readonly repos: readonly GithubRepoConfig[];
  readonly clock: ClockPort;
  readonly logger: LoggerPort;
  /** One key per instance, a repository secret in every repository of the set (RFC-001 7.1). */
  readonly approvalHmacKey: Secret;
  readonly allowPublicTargetRepo: boolean;
  /** As for `createGithubAdapter`: the build-path probes run only when the builder loads. */
  readonly builder: { readonly requireOwnCredentials: boolean } | null;
  readonly engineVersion: string;
  /** The gate files' expected digests for one repository (its workflow file name is per repository). */
  readonly gateReference: (repo: GithubRepoConfig) => Result<readonly GateFile[], AppError>;
  /** Transport override, for tests. */
  readonly fetch?: typeof globalThis.fetch;
  /** Per-repository request seam for the containment probes and the gate check, for tests. */
  readonly probeRequest?: (repo: GithubRepoConfig) => GithubRequest | undefined;
  /**
   * The repository key a guild is linked to (`repo.target` in `core_settings`, written by
   * `/repo use`), or null. The composition root passes `repoTargetReader(settings)`; left out,
   * nothing is mapped and every guild resolves to the default repository.
   */
  readonly guildMapping?: (guildId: GuildId) => string | null;
  /**
   * What installed modules report about their work per repository (`ModuleHandle.repoActivity`),
   * late-bound because the modules install after this set exists. Left out: nothing reports.
   */
  readonly activity?: () => readonly RepoActivityReport[];
}

/** One repository of the set, with its adapter. */
export interface RepoAdapter {
  readonly ref: RepoRef;
  readonly config: GithubRepoConfig;
  readonly adapter: GithubAdapter;
}

/** One repository's boot preflight answer. */
export interface RepoPreflight {
  readonly ref: RepoRef;
  readonly config: GithubRepoConfig;
  readonly result: Result<GithubPreflightReport, AppError>;
}

export interface GithubRepoSet {
  /** The minted refs. */
  readonly set: RepoSet;
  /** `ctx.ports.repos`. */
  readonly repos: ReposPort;
  /** Every repository's adapter, in configuration order. */
  readonly adapters: readonly RepoAdapter[];
  /** `ctx.ports.issues`, `ctx.ports.builds`, `ctx.ports.secrets`. */
  readonly issues: RepoScoped<IssuesPort>;
  readonly builds: RepoScoped<BuildsPort>;
  readonly secrets: RepoScoped<SecretsPort>;
  /**
   * The boot preflight of EVERY repository, sequentially and in configuration order, each one
   * complete (it never stops at the first repository that fails), so the caller can name every
   * repository at fault at once.
   */
  preflight(): Promise<readonly RepoPreflight[]>;
  /** For `/status`: one PAT summary for the whole set, or one App summary per repository. */
  authSummaries(): readonly GithubAuthSummary[];
  /** The default repository's summary (else the first's), for `VersionPort.githubAuth()`. */
  primaryAuthSummary(): GithubAuthSummary;
}

/**
 * Build the set. `Err` carries EVERY refusal (one per repository the auth checks refused), so a
 * three-repository set with two uninstalled Apps names both.
 */
export async function createGithubRepoSet(input: GithubRepoSetInput): Promise<Result<GithubRepoSet, readonly AppError[]>> {
  const minted = createRepoSet(input.repos.map((r) => ({ key: r.key, owner: r.owner, repo: r.repo, isDefault: r.isDefault })));
  if (!minted.ok) return Err([minted.error]);
  const set = minted.value;
  const transport = input.fetch === undefined ? {} : { fetch: input.fetch };

  const connections: GithubConnection[] = [];
  const failures: AppError[] = [];
  if (input.auth.kind === 'pat') {
    // ONE client for the set: one token, one rate-limit budget, one throttler.
    const octokit = createGithubClient({ token: input.auth.token, logger: input.logger, ...transport });
    input.logger.warn(PAT_MODE_WARNING, {});
    connections.push(...input.repos.map((): GithubConnection => ({ octokit, authKind: 'pat', summary: { kind: 'pat', expiresAtMs: null }, warnings: [] })));
  } else {
    // ONE App: the key is revealed once and `GET /app` is asked once, whatever the set's size.
    const app = await startGithubApp({ appId: input.auth.appId, privateKey: input.auth.privateKey, clock: input.clock, logger: input.logger, ...transport });
    if (!app.ok) return Err([app.error]);
    let first = true;
    for (const r of input.repos) {
      const opened = await openGithubInstallation(app.value, { installationId: r.installationId, repo: { owner: r.owner, repo: r.repo }, names: r.names });
      if (!opened.ok) {
        failures.push(opened.error);
        continue;
      }
      // The App-level findings (a transient `GET /app`) ride on the first repository's report
      // only: they are about the App, and saying them once per repository would read as N faults.
      connections.push({
        octokit: opened.value.octokit,
        authKind: 'app',
        summary: opened.value.summary,
        warnings: first ? [...app.value.warnings, ...opened.value.warnings] : opened.value.warnings,
      });
      first = false;
    }
  }
  if (failures.length > 0) return Err(failures);

  const adapters: RepoAdapter[] = [];
  for (const [i, ref] of set.refs.entries()) {
    const config = input.repos[i];
    const connection = connections[i];
    if (config === undefined || connection === undefined) continue;
    const probe = input.probeRequest?.(config);
    const adapter = assembleGithubAdapter(
      {
        repo: { owner: config.owner, repo: config.repo },
        clock: input.clock,
        logger: input.logger,
        approvalHmacKey: input.approvalHmacKey,
        workflowFile: config.workflowFile,
        ref: config.ref,
        allowPublicTargetRepo: input.allowPublicTargetRepo,
        builder: input.builder,
        engineVersion: input.engineVersion,
        gateReference: input.gateReference(config),
        names: config.names,
        ...(probe === undefined ? {} : { probeRequest: probe }),
      },
      connection,
    );
    adapters.push({ ref, config, adapter });
  }

  const primary = (): RepoAdapter | undefined => adapters.find((a) => a.ref === set.default) ?? adapters[0];

  return Ok({
    set,
    repos: createReposPort(set, input.guildMapping ?? noGuildMapping, input.activity ?? noActivity),
    adapters,
    issues: repoScoped(adapters.map((a) => [a.ref, a.adapter.issues] as const)),
    builds: repoScoped(adapters.map((a) => [a.ref, a.adapter.builds] as const)),
    secrets: repoScoped(adapters.map((a) => [a.ref, a.adapter.secrets] as const)),
    async preflight() {
      const out: RepoPreflight[] = [];
      for (const a of adapters) out.push({ ref: a.ref, config: a.config, result: await a.adapter.preflight() });
      return out;
    },
    authSummaries() {
      const all = adapters.map((a) => a.adapter.authSummary());
      if (input.auth.kind === 'app') return all;
      // ONE token: one line. Its expiry is whichever repository's preflight read it first.
      const known = all.find((s) => s.kind === 'pat' && s.expiresAtMs !== null);
      return [known ?? all[0] ?? { kind: 'unknown' }];
    },
    primaryAuthSummary() {
      return primary()?.adapter.authSummary() ?? { kind: 'unknown' };
    },
  });
}
