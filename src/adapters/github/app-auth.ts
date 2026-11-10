/**
 * GITHUB APP AUTH (RFC-001 section 6.4). Boot-time App checks, then installation tokens minted by
 * octokit's own bundled `App`.
 *
 * WHAT HAPPENS AT BOOT, in order, stopping at the first fatal answer:
 *
 *  1. The private key signs an App JWT LOCALLY (no request), so a malformed key is a sentence
 *     about the key rather than a mystery from the first network call.
 *  2. `GET /app` with that JWT: proves the key belongs to the App and learns the App's `slug`
 *     for every later sentence. 401 is fatal.
 *  3. `GET /repos/{owner}/{repo}/installation` (or, with `GITHUB_APP_INSTALLATION_ID` set,
 *     `GET /app/installations/{id}`, which skips the LOOKUP but not the checks): the
 *     installation id, its granted `permissions` and its `repository_selection`. 404 is fatal
 *     and names the installations URL.
 *  4. The granted permissions are compared with the 6.1 table and every missing or too-weak one
 *     is named in ONE refusal. `repository_selection: all` is refused (section 5.4):
 *     Administration write across a whole account is not a blast radius this bot should hold.
 *  5. `github app installation resolved` is logged with the id and the permissions.
 *
 * TOKEN MINTING IS NOT OURS. `octokit` already bundles `@octokit/app` and `@octokit/auth-app`, so
 * `app.getInstallationOctokit(id)` returns a client whose auth hook mints a one-hour installation
 * token on first use and REUSES it from auth-app's in-memory cache until a minute before expiry,
 * then mints a fresh one. Nothing is persisted and nothing here signs a JWT by hand: the RS256
 * signing is `universal-github-app-jwt`, bundled the same way. The class handed to `App` is the
 * bot's own (`githubOctokitClass`), so App clients carry exactly the user agent, retry,
 * throttle, logging and API-version pin a PAT client does.
 *
 * UNINSTALL (RFC-001 6.5). There is no webhook, so an uninstall is learned at the next call: the
 * token mint answers 404. That one route is recognised here and rewritten into a `config` error
 * naming the App and the repository, which is non-retryable by construction. It is rewritten in
 * the TRANSPORT, before any port sees it, because a bare 404 means something benign to two ports
 * (`unset` variable, absent environment) - see `GithubAuthFailure`.
 *
 * WHAT IS NOT FATAL. A 403, 429, 5xx or network failure on `GET /app` is a warning (the slug is
 * then unknown and sentences use the App id). The same on the installation read is a warning
 * ONLY when `GITHUB_APP_INSTALLATION_ID` is set, because tokens can still be minted for a known
 * id; without it, no token can ever be minted in this process, so starting would produce a bot
 * whose every GitHub call fails - that is refused with a sentence that names the variable which
 * lets the next boot skip the lookup. (RFC-001 PR 1.7 owns the wider transient posture.)
 *
 * SECRETS. The private key is a `Secret` and is revealed exactly once, at `new App(...)`. Nothing
 * read off a thrown error reaches a sentence except a status code and an error class name.
 */

import { readFileSync } from 'node:fs';
import { App, type Octokit } from 'octokit';
import { z } from 'zod';
import { Err, Ok, type Result } from '#core/result';
import { errors, type AppError } from '#core/errors';
import { ENV_REPO_SETTING_NAMES, isPemPrivateKey, secret, type GithubAuthConfig, type RepoSettingNames, type Secret } from '#core/config';
import type { ClockPort, GithubAuthSummary, LoggerPort } from '#core/ports';
import type { JsonObject } from '#core/json';
import { GithubAuthFailure, githubOctokitClass, readGithubFailure, type GithubRepo } from '#adapters/github/client';

// ---------------------------------------------------------------------------------------
// The 6.1 permission table
// ---------------------------------------------------------------------------------------

/** One required repository permission: GitHub's key, the label its settings page shows, the access. */
export interface RequiredAppPermission {
  /** The key in an installation's `permissions` object. */
  readonly key: string;
  /** What the App settings page calls it, so a refusal names something the operator can find. */
  readonly label: string;
  readonly access: 'read' | 'write';
}

/**
 * RFC-001 section 6.1, exactly, in its order. Each line is a call this bot makes; the RFC table
 * says which. Organisation and account permissions: none.
 */
export const REQUIRED_APP_PERMISSIONS: readonly RequiredAppPermission[] = [
  { key: 'metadata', label: 'Metadata', access: 'read' },
  { key: 'issues', label: 'Issues', access: 'write' },
  { key: 'actions', label: 'Actions', access: 'write' },
  { key: 'pull_requests', label: 'Pull requests', access: 'read' },
  { key: 'contents', label: 'Contents', access: 'read' },
  { key: 'environments', label: 'Environments', access: 'write' },
  { key: 'administration', label: 'Administration', access: 'write' },
  { key: 'secrets', label: 'Secrets', access: 'read' },
  { key: 'actions_variables', label: 'Variables', access: 'read' },
];

/** `admin` (which some permissions offer) covers `write`, which covers `read`. */
const ACCESS_RANK: Readonly<Record<string, number>> = { read: 1, write: 2, admin: 3 };

/**
 * Every required permission the installation lacks or holds too weakly, as `Label (access)`,
 * in table order. Empty means the installation is sufficient.
 */
export function missingAppPermissions(granted: Readonly<Record<string, string>>): readonly string[] {
  return REQUIRED_APP_PERMISSIONS.filter((p) => (ACCESS_RANK[granted[p.key] ?? ''] ?? 0) < (ACCESS_RANK[p.access] ?? 0)).map(
    (p) => `${p.label} (${p.access})`,
  );
}

// ---------------------------------------------------------------------------------------
// The sentences. Each `internal` is the diagnosis, each `nextStep` the imperative.
// ---------------------------------------------------------------------------------------

/** The App as a sentence names it: its slug once known, its id before. */
function appName(slug: string | null, appId: number): string {
  return slug ?? `id ${appId}`;
}

/** 401 on `GET /app`, or a JWT GitHub will not accept: the key is not this App's (6.4 step 1). */
export function appKeyRejectedError(appId: number): AppError {
  return errors.config(
    'GITHUB_APP_PRIVATE_KEY',
    `GITHUB_APP_PRIVATE_KEY does not belong to GitHub App ${appId}; download a new key from the App settings page`,
    `Check GITHUB_APP_ID, generate a new private key on the App settings page (GitHub -> Settings -> Developer settings -> GitHub Apps -> your App -> Private keys), set GITHUB_APP_PRIVATE_KEY or GITHUB_APP_PRIVATE_KEY_FILE to it, and restart.`,
  );
}

/** The App is not installed on the module repository (RFC-001 4.2 table). */
export function appNotInstalledError(slug: string | null, appId: number, repo: GithubRepo): AppError {
  const where = `${repo.owner}/${repo.repo}`;
  const url = slug === null ? 'https://github.com/settings/apps' : `https://github.com/apps/${slug}/installations/new`;
  return errors.config(
    'github.app',
    `the GitHub App "${appName(slug, appId)}" (id ${appId}) is not installed on ${where}`,
    `Open ${url}, pick ${where}, then restart.`,
  );
}

/** The installation lacks one or more 6.1 permissions (RFC-001 5.4 table). */
export function appPermissionsMissingError(missing: readonly string[], slug: string | null, appId: number, repo: GithubRepo): AppError {
  return errors.config(
    'github.app',
    `the GitHub App installation on ${repo.owner}/${repo.repo} lacks: ${missing.join(', ')}`,
    `Grant them under Settings -> GitHub Apps -> ${appName(slug, appId)} -> Configure (accept the new permissions on the installation if GitHub asks), then restart.`,
  );
}

/** Installed on every repository of the account (RFC-001 5.4 table). */
export function appInstalledOnAllError(repo: GithubRepo): AppError {
  return errors.config(
    'github.app',
    `the GitHub App is installed on ALL repositories of ${repo.owner}; reinstall it on only the module repository.`,
    `Change the installation to "Only select repositories" with just ${repo.owner}/${repo.repo} selected, then restart.`,
  );
}

/** The token mint answered 404: the App was uninstalled while the bot ran (RFC-001 6.5). */
export function appUninstalledError(slug: string | null, appId: number, repo: GithubRepo): AppError {
  return errors.config(
    'github.app',
    `the GitHub App ${appName(slug, appId)} is no longer installed on ${repo.owner}/${repo.repo}`,
    'Reinstall the App on the module repository, then restart the bot.',
  );
}

/** The pinned installation id (`GITHUB_APP_INSTALLATION_ID`, or an entry's `installationId`) names nothing this App can see. */
function configuredInstallationUnknownError(installationId: number, slug: string | null, appId: number, names: RepoSettingNames): AppError {
  const v = names.installationId;
  return errors.config(
    v,
    `${v} ${installationId} is not an installation of the GitHub App "${appName(slug, appId)}"`,
    `Remove ${v} to let the bot find the installation itself, or set it to the number at the end of the installation's Configure URL, then restart.`,
  );
}

/** The pinned installation id is an installation on a different account. */
function configuredInstallationElsewhereError(installationId: number, account: string, repo: GithubRepo, names: RepoSettingNames): AppError {
  const v = names.installationId;
  return errors.config(
    v,
    `${v} ${installationId} is an installation on ${account}, not on ${repo.owner}`,
    `Remove ${v} to let the bot find the installation on ${repo.owner}/${repo.repo} itself, then restart.`,
  );
}

// ---------------------------------------------------------------------------------------
// Wire shapes. Nothing off the network is trusted.
// ---------------------------------------------------------------------------------------

const AppPayload = z.object({ slug: z.string().min(1) });

const InstallationPayload = z.object({
  id: z.number().int().positive(),
  repository_selection: z.string(),
  permissions: z.record(z.string(), z.string()),
  account: z.object({ login: z.string() }).nullable().optional(),
});

type Installation = z.infer<typeof InstallationPayload>;

/** The token-mint route, the one 404 that means "uninstalled" rather than "not found". */
const TOKEN_MINT_ROUTE = /\/app\/installations\/\d+\/access_tokens(?:\?|$)/u;

/** Read one property off an unknown value without a cast and without throwing. */
function prop(target: unknown, key: string): unknown {
  if (typeof target !== 'object' || target === null) return undefined;
  return Reflect.get(target, key);
}

/** True for a 404 from the installation-token mint. Reads the URL only; never a header. */
export function isTokenMintNotFound(cause: unknown, nowMs: number): boolean {
  if (readGithubFailure(cause, nowMs).status !== 404) return false;
  const url = prop(prop(cause, 'request'), 'url');
  return typeof url === 'string' && TOKEN_MINT_ROUTE.test(url);
}

// ---------------------------------------------------------------------------------------
// The session
// ---------------------------------------------------------------------------------------

/** What a successful App boot hands the adapter. */
export interface GithubAppSession {
  /** The installation client every port uses. Its auth hook mints and refreshes tokens. */
  readonly octokit: Octokit;
  /** For `/status`. */
  readonly summary: Extract<GithubAuthSummary, { kind: 'app' }>;
  /** Non-fatal findings, one finished sentence each, for the boot preflight's report. */
  readonly warnings: readonly string[];
}

export interface GithubAppSessionInput extends GithubAppInput, GithubInstallationInput {}

/** Steps 1-2: the App itself. ONE per process, however many repositories it is installed on. */
export interface GithubAppInput {
  readonly appId: number;
  readonly privateKey: Secret;
  readonly clock: ClockPort;
  readonly logger: LoggerPort;
  /** Transport override; see `githubOctokitClass`. */
  readonly fetch?: typeof globalThis.fetch;
}

/** Steps 3-5: one installation, for one repository of the set. */
export interface GithubInstallationInput {
  /** The pinned id (`GITHUB_APP_INSTALLATION_ID` or the entry's `installationId`); `null` looks it up from `repo`. */
  readonly installationId: number | null;
  readonly repo: GithubRepo;
  /** How sentences name this repository's settings; the single-repository env names by default. */
  readonly names?: RepoSettingNames;
}

/**
 * The App, authenticated (steps 1-2 of the header). Hand it to `openGithubInstallation` once per
 * repository: one App, one key, one `GET /app`, an installation each (RFC-001 PR 2.1).
 */
export interface GithubAppHandle {
  readonly app: App;
  readonly appId: number;
  /** From `GET /app`, or `null` when that read failed transiently. */
  readonly slug: string | null;
  /** Non-fatal findings of steps 1-2, reported ONCE for the whole set. */
  readonly warnings: readonly string[];
  readonly clock: ClockPort;
  readonly logger: LoggerPort;
}

/** A sentence for a probe that failed for a reason that is not evidence of misconfiguration. */
function transientWarning(what: string, status: number): string {
  const answer = status === 0 ? 'got no response' : `answered ${status}`;
  return `GitHub ${answer} while the bot ${what} at boot; the bot is starting anyway, but this is unverified until the next restart.`;
}

/** Steps 1-5 of the header, then the installation client: the single-repository shape. */
export async function startGithubAppSession(input: GithubAppSessionInput): Promise<Result<GithubAppSession, AppError>> {
  const started = await startGithubApp(input);
  if (!started.ok) return started;
  const opened = await openGithubInstallation(started.value, input);
  if (!opened.ok) return opened;
  return Ok({ ...opened.value, warnings: [...started.value.warnings, ...opened.value.warnings] });
}

/** Steps 1-2 of the header: sign a JWT locally, then `GET /app`. */
export async function startGithubApp(input: GithubAppInput): Promise<Result<GithubAppHandle, AppError>> {
  const { appId, clock } = input;
  const warnings: string[] = [];

  const GithubOctokit = githubOctokitClass(
    input.fetch === undefined ? { logger: input.logger } : { logger: input.logger, fetch: input.fetch },
  );
  // The ONE reveal of the App key (SC-6), at App construction, as RFC-001 6.4 specifies.
  const app = new App({ appId, privateKey: input.privateKey.reveal(), Octokit: GithubOctokit });

  // --- 1. sign a JWT locally --------------------------------------------------------------
  try {
    await app.octokit.auth({ type: 'app' });
  } catch (cause: unknown) {
    // The error's MESSAGE is not read: a key parser's message is the last place to gamble on.
    const name = cause instanceof Error ? cause.name : 'unknown';
    return Err(
      errors.config(
        'GITHUB_APP_PRIVATE_KEY',
        `the private key could not sign a JWT for GitHub App ${appId} (${name})`,
        'Set GITHUB_APP_PRIVATE_KEY (\\n for newlines) or GITHUB_APP_PRIVATE_KEY_FILE to the .pem downloaded from the App settings page, and restart.',
      ),
    );
  }

  // --- 2. GET /app ------------------------------------------------------------------------
  let slug: string | null = null;
  try {
    const res = await app.octokit.request('GET /app');
    const parsed = AppPayload.safeParse(res.data);
    if (parsed.success) slug = parsed.data.slug;
  } catch (cause: unknown) {
    const status = readGithubFailure(cause, clock.now()).status;
    if (status === 401) return Err(appKeyRejectedError(appId));
    warnings.push(transientWarning(`read GitHub App ${appId}`, status));
  }
  return Ok({ app, appId, slug, warnings: [...warnings], clock, logger: input.logger });
}

/**
 * Steps 3-5 of the header for ONE repository, then its installation client. Each repository of
 * the set gets its own call, so each is checked (permissions, `repository_selection`) on its
 * own, and an App missing from one repository refuses naming THAT repository.
 */
export async function openGithubInstallation(
  handle: GithubAppHandle,
  input: GithubInstallationInput,
): Promise<Result<GithubAppSession, AppError>> {
  const { app, appId, slug, clock } = handle;
  const { repo } = input;
  const names = input.names ?? ENV_REPO_SETTING_NAMES;
  const log = handle.logger.child({ component: 'github-app' });
  const warnings: string[] = [];

  // --- 3. the installation ----------------------------------------------------------------
  let installation: Installation | null = null;
  let installationId = input.installationId;
  if (installationId === null) {
    try {
      const res = await app.octokit.request('GET /repos/{owner}/{repo}/installation', { owner: repo.owner, repo: repo.repo });
      const parsed = InstallationPayload.safeParse(res.data);
      if (parsed.success) {
        installation = parsed.data;
        installationId = parsed.data.id;
      }
    } catch (cause: unknown) {
      const status = readGithubFailure(cause, clock.now()).status;
      if (status === 401) return Err(appKeyRejectedError(appId));
      if (status === 404) return Err(appNotInstalledError(slug, appId, repo));
      return Err(
        errors.config(
          'github.app',
          `could not look up the GitHub App installation on ${repo.owner}/${repo.repo} (GitHub ${status === 0 ? 'gave no response' : `answered ${status}`}), and without it no token can be minted`,
          `Restart once GitHub is reachable, or set ${names.installationId} to the installation id so the next boot can skip the lookup.`,
        ),
      );
    }
    if (installationId === null) {
      return Err(
        errors.config(
          'github.app',
          `GitHub answered the installation lookup for ${repo.owner}/${repo.repo} with a shape the bot does not recognise`,
          `Set ${names.installationId} to the installation id (the number at the end of its Configure URL), then restart.`,
        ),
      );
    }
  } else {
    // The configured id skips the LOOKUP, never the checks.
    try {
      const res = await app.octokit.request('GET /app/installations/{installation_id}', { installation_id: installationId });
      const parsed = InstallationPayload.safeParse(res.data);
      if (parsed.success) installation = parsed.data;
      else warnings.push(`GitHub described installation ${installationId} in a shape the bot does not recognise, so its permissions are unverified.`);
    } catch (cause: unknown) {
      const status = readGithubFailure(cause, clock.now()).status;
      if (status === 401) return Err(appKeyRejectedError(appId));
      if (status === 404) return Err(configuredInstallationUnknownError(installationId, slug, appId, names));
      warnings.push(transientWarning(`checked installation ${installationId}`, status));
    }
    const account = installation?.account?.login;
    if (account !== undefined && account.toLowerCase() !== repo.owner.toLowerCase()) {
      return Err(configuredInstallationElsewhereError(installationId, account, repo, names));
    }
  }

  // --- 4. the checks ----------------------------------------------------------------------
  if (installation !== null) {
    const missing = missingAppPermissions(installation.permissions);
    if (missing.length > 0) return Err(appPermissionsMissingError(missing, slug, appId, repo));
    if (installation.repository_selection === 'all') return Err(appInstalledOnAllError(repo));
  }

  // --- 5. the log line --------------------------------------------------------------------
  const permissions: JsonObject = installation === null ? {} : { ...installation.permissions };
  log.info('github app installation resolved', {
    installationId,
    permissions,
    verified: installation !== null,
    app: slug ?? `id ${appId}`,
    repositorySelection: installation?.repository_selection ?? 'unknown',
    lookup: input.installationId === null ? 'discovered' : 'configured',
  });

  // --- the installation client ------------------------------------------------------------
  //
  // `getInstallationOctokit` makes no request: it builds a client of OUR class whose auth hook
  // mints on first use. The uninstall rewrite is registered on THAT client, outermost, so it
  // sees the mint's 404 however deep in the hook chain it was thrown.
  const octokit = await app.getInstallationOctokit(installationId);
  const gone = appUninstalledError(slug, appId, repo);
  octokit.hook.error('request', (error) => {
    if (error instanceof GithubAuthFailure) throw error;
    if (isTokenMintNotFound(error, clock.now())) {
      log.error('github app is no longer installed', { installationId, repo: `${repo.owner}/${repo.repo}` });
      throw new GithubAuthFailure(gone);
    }
    throw error;
  });

  return Ok({
    octokit,
    summary: { kind: 'app', slug, appId, repo: `${repo.owner}/${repo.repo}`, installationId },
    warnings: [...warnings],
  });
}

// ---------------------------------------------------------------------------------------
// From config to adapter input
// ---------------------------------------------------------------------------------------

/**
 * The config union with the App key resolved to a `Secret`: ONE credential for the whole
 * repository set (a PAT, or an App). What `createGithubRepoSet` takes.
 */
export type GithubCredentials =
  | { readonly kind: 'pat'; readonly token: Secret }
  | { readonly kind: 'app'; readonly appId: number; readonly privateKey: Secret };

/**
 * What the single-repository `createGithubAdapter` takes: the credentials plus, in App mode, that
 * repository's pinned installation id (`null` to look it up).
 */
export type GithubAdapterAuth =
  | { readonly kind: 'pat'; readonly token: Secret }
  | { readonly kind: 'app'; readonly appId: number; readonly privateKey: Secret; readonly installationId: number | null };

/**
 * Resolve `GITHUB_APP_PRIVATE_KEY_FILE` into the key itself. Everything else passes through.
 *
 * WHY HERE and not in `loadConfig`: config is a pure function of the env (that is what makes it
 * testable), and reading a file is the adapter side's job. `readText` is injectable for tests.
 * The file's contents are checked for PEM SHAPE before they are wrapped, and are never echoed.
 */
export function resolveGithubAuth(
  auth: GithubAuthConfig,
  readText: (path: string) => string = (path) => readFileSync(path, 'utf8'),
): Result<GithubCredentials, AppError> {
  if (auth.kind === 'pat') return Ok(auth);
  if (auth.privateKey.kind === 'inline') {
    return Ok({ kind: 'app', appId: auth.appId, privateKey: auth.privateKey.pem });
  }
  const path = auth.privateKey.path;
  let pem: string;
  try {
    pem = readText(path);
  } catch (cause: unknown) {
    const code = prop(cause, 'code');
    return Err(
      errors.config(
        'GITHUB_APP_PRIVATE_KEY_FILE',
        `cannot read the GitHub App private key at ${path}${typeof code === 'string' ? ` (${code})` : ''}`,
        'Point GITHUB_APP_PRIVATE_KEY_FILE at the .pem downloaded from the App settings page (a path relative to the working directory, or absolute), then restart.',
      ),
    );
  }
  if (!isPemPrivateKey(pem)) {
    return Err(
      errors.config(
        'GITHUB_APP_PRIVATE_KEY_FILE',
        `${path} is not a PEM private key`,
        'Point GITHUB_APP_PRIVATE_KEY_FILE at the .pem downloaded from the App settings page, unmodified, then restart.',
      ),
    );
  }
  return Ok({ kind: 'app', appId: auth.appId, privateKey: secret(pem) });
}
