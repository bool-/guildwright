/**
 * Boot configuration.
 *
 * POSTMORTEMS THIS FILE CLOSES:
 *  (1) "The bot ran for two days with an empty GITHUB_TOKEN and every build failed with a 401
 *      we retried." Config is validated ONCE, at boot; a failure is a readable `Err` that
 *      `main` turns into a non-zero exit. There is no `process.env` access anywhere else.
 *  (2) "A pino log line contained the bot token." Secrets are `Secret` objects whose
 *      `toJSON()` returns `[redacted]` - load-bearing, because pino serialises with
 *      `JSON.stringify` - and whose `toString()` is redacted too, so `${cfg.discord.token}`
 *      cannot leak either. `reveal()` is the single greppable unwrap (SC-6).
 *  (3) "Two modules both read `config.maxRetries`." Module config is namespaced under
 *      `modules.<id>` and validated by that module's own schema inside `defineModule`.
 */

import { z } from 'zod';
import { secret } from '#core/secret';
import type { Secret } from '#core/secret';
import type { Result } from '#core/result';
import { Err, Ok } from '#core/result';
import type { AppError } from '#core/errors';
import { errors } from '#core/errors';
import type { GitRef, LogLevel, RepoKey, WorkflowFile } from '#core/ports';
import { DEFAULT_REPO_KEY, REPO_KEY_PATTERN, isRepoKey, toGitRef, toWorkflowFile } from '#core/ports';

/**
 * `Secret` now lives in `#core/secret`, a leaf file with no imports, and is re-exported here
 * so every existing `import type { Secret } from '#core/config'` keeps working.
 *
 * WHY IT MOVED: a user's own Anthropic credential arrives through a Discord MODAL, so
 * `#core/text` has to be able to mint a `Secret` - and `text` importing `config` would invert
 * the layering, because `config` already imports `ports` and `ports` type-imports `text`.
 * See `#core/secret` for the four guarantees the carrier makes.
 */
export type { Secret } from '#core/secret';
export { secret } from '#core/secret';

const snowflake = z.string().regex(/^\d{17,20}$/u, 'must be a Discord snowflake');

/** GitHub's own rules for an account and a repository name; shared by both repository forms. */
const GITHUB_OWNER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/u;
const GITHUB_REPO_PATTERN = /^[A-Za-z0-9._-]{1,100}$/u;
const DEFAULT_WORKFLOW_FILE = 'agent-implement-request.yml';
const DEFAULT_GIT_REF = 'main';

/**
 * Whether a string is shaped like a PEM private key (PKCS#1 `RSA PRIVATE KEY`, which is what
 * GitHub's App settings page downloads, or PKCS#8 `PRIVATE KEY`). Shape only: whether the key
 * belongs to the App is answered by GitHub at boot.
 *
 * Exported because the composition root applies the same check to a key read from
 * `GITHUB_APP_PRIVATE_KEY_FILE`, which `loadConfig` deliberately never opens.
 */
export function isPemPrivateKey(value: string): boolean {
  return /-----BEGIN (?:RSA )?PRIVATE KEY-----/u.test(value) && /-----END (?:RSA )?PRIVATE KEY-----/u.test(value);
}

/**
 * The environment contract.
 * WHY zod: `z.prettifyError` gives an operator every missing variable at once, instead of one
 * restart per typo.
 */
export const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),

  DISCORD_TOKEN: z.string().min(50, 'looks too short to be a bot token'),
  DISCORD_CLIENT_ID: snowflake,
  DISCORD_OWNER_ID: snowflake,
  /** Guild-scoped command registration in dev; global in prod. */
  DISCORD_DEV_GUILD_ID: snowflake.optional(),
  /**
   * Request the PRIVILEGED MessageContent intent.
   *
   * Off by default, and the default is the point: `/request` is a slash command, so the bot
   * needs no privileged intent and never receives the content of messages that are not
   * addressed to it. Turn this on ONLY if a module declares a `$prefix` message hook — and
   * if one does while this is off, the bot refuses to start rather than running with a hook
   * that can never fire.
   */
  DISCORD_MESSAGE_CONTENT: z.stringbool().default(false),

  /**
   * GitHub auth is EXACTLY ONE of two modes (RFC-001 section 6). The rule is enforced by
   * `githubAuthModeIssues` below rather than by this schema, so that a missing or doubled mode is
   * reported alongside every other bad variable instead of one restart later:
   *
   *   - GitHub App (the documented setup): `GITHUB_APP_ID` plus exactly one of
   *     `GITHUB_APP_PRIVATE_KEY` (the PEM itself, `\n` escapes allowed) or
   *     `GITHUB_APP_PRIVATE_KEY_FILE` (a path to the .pem); optionally
   *     `GITHUB_APP_INSTALLATION_ID`, which skips the installation lookup but not its checks.
   *   - Personal access token (the fallback): `GITHUB_TOKEN` alone.
   */
  GITHUB_TOKEN: z.string().min(20).optional(),
  GITHUB_APP_ID: z.string().regex(/^[1-9]\d{0,11}$/u, 'must be the numeric App ID from the App settings page').optional(),
  GITHUB_APP_PRIVATE_KEY: z
    .string()
    .refine(isPemPrivateKey, 'must be the PEM private key generated on the App settings page, with \\n for each newline')
    .optional(),
  GITHUB_APP_PRIVATE_KEY_FILE: z.string().min(1).optional(),
  GITHUB_APP_INSTALLATION_ID: z.string().regex(/^[1-9]\d{0,15}$/u, 'must be a numeric installation id').optional(),
  /**
   * THE REPOSITORY SET (RFC-001 7.1). Either `GITHUB_REPOS_JSON` (one entry per repository), or
   * the single-repository pair below, which the compatibility shim turns into a one-repository
   * set keyed `default` - so a phase-1 install needs no change. Never both: which one is
   * required, and the never-both rule, are enforced by `githubRepoSetIssues` below, for the same
   * reason the auth rule is (every problem reported in one pass).
   */
  GITHUB_OWNER: z.string().regex(GITHUB_OWNER_PATTERN).optional(),
  GITHUB_REPO: z.string().regex(GITHUB_REPO_PATTERN).optional(),
  GITHUB_WORKFLOW_FILE: z.string().default(DEFAULT_WORKFLOW_FILE),
  GITHUB_REF: z.string().default(DEFAULT_GIT_REF),
  GITHUB_REPOS_JSON: z.string().optional(),
  /** Shared with the repo's Actions secrets and nowhere else (SC-6). */
  APPROVAL_HMAC_KEY: z.string().min(32, 'must be at least 32 chars of entropy'),
  /**
   * The bot REFUSES TO START when the target repository is public (RFC-001 5.4), because every
   * `/request` it files there is then public too. `true` is the operator saying so on purpose.
   */
  ALLOW_PUBLIC_TARGET_REPO: z.stringbool().default(false),

  DATABASE_PATH: z.string().min(1).default('./data/bot.sqlite'),
  /** Per-module config as JSON, namespaced by module id. */
  MODULES_JSON: z.string().default('{}'),
  /** Comma-separated module ids to skip - the operator's escape hatch for a bad module. */
  MODULES_DISABLE: z.string().default(''),
  /**
   * Comma-separated directories, relative to the working directory, each scanned for
   * `<id>/module.ts`. RFC-001 section 4.2. The default is the built-in tree, which is why
   * `main` only treats a MISSING directory as an error when this variable was set explicitly.
   */
  MODULE_DIRS: z.string().default('./src/modules'),
  /** `false` disables every built-in module at once (RFC-001 section 4.2). */
  MODULES_BUILTIN: z.stringbool().default(true),
});

/** The App-mode variables, for the exactly-one-mode rule. */
const APP_VARIABLES = ['GITHUB_APP_ID', 'GITHUB_APP_PRIVATE_KEY', 'GITHUB_APP_PRIVATE_KEY_FILE', 'GITHUB_APP_INSTALLATION_ID'] as const;

/**
 * The exactly-one-mode rule, as finished sentences (empty when the env is consistent).
 *
 * WHY it reads the RAW env and not the parsed one: it has to run even when `EnvSchema` failed on
 * some unrelated variable, so the operator is told about every problem in one go. WHY "set"
 * means "present", empty string included: `.env.example` already says a blanked line and a
 * deleted one are different things, and a leftover `GITHUB_TOKEN=` next to App variables is
 * exactly the ambiguity this rule exists to refuse.
 */
export function githubAuthModeIssues(env: Readonly<Record<string, string | undefined>>): readonly string[] {
  const has = (name: string): boolean => env[name] !== undefined;
  const pat = has('GITHUB_TOKEN');
  const appSet = APP_VARIABLES.filter(has);
  if (pat && appSet.length > 0) {
    return [
      `both GitHub auth modes are configured (GITHUB_TOKEN and ${appSet.join(', ')}); pick ONE: a GitHub App (GITHUB_APP_ID plus GITHUB_APP_PRIVATE_KEY or GITHUB_APP_PRIVATE_KEY_FILE) or a personal access token (GITHUB_TOKEN alone). An empty GITHUB_TOKEN= line still counts as set; delete it.`,
    ];
  }
  if (!pat && appSet.length === 0) {
    return [
      'no GitHub credential is configured: set GITHUB_APP_ID plus GITHUB_APP_PRIVATE_KEY or GITHUB_APP_PRIVATE_KEY_FILE (a GitHub App, the documented setup), or GITHUB_TOKEN (a personal access token).',
    ];
  }
  if (pat) return [];
  const issues: string[] = [];
  if (!has('GITHUB_APP_ID')) {
    issues.push(`${appSet.join(', ')} is set but GITHUB_APP_ID is not; App mode needs the App ID from the App settings page.`);
  }
  const inline = has('GITHUB_APP_PRIVATE_KEY');
  const file = has('GITHUB_APP_PRIVATE_KEY_FILE');
  if (inline && file) {
    issues.push('GITHUB_APP_PRIVATE_KEY and GITHUB_APP_PRIVATE_KEY_FILE are both set; set exactly one of them.');
  } else if (!inline && !file) {
    issues.push(
      'App mode needs the private key: set GITHUB_APP_PRIVATE_KEY (the PEM, \\n for newlines) or GITHUB_APP_PRIVATE_KEY_FILE (a path to the .pem).',
    );
  }
  return issues;
}

// ---------------------------------------------------------------------------------------
// The repository set (RFC-001 7.1)
// ---------------------------------------------------------------------------------------

/** The single-repository variables that `GITHUB_REPOS_JSON` replaces, and so must not sit beside. */
const SINGLE_REPO_VARIABLES = ['GITHUB_OWNER', 'GITHUB_REPO', 'GITHUB_REF', 'GITHUB_WORKFLOW_FILE', 'GITHUB_APP_INSTALLATION_ID'] as const;

/** One `GITHUB_REPOS_JSON` entry. Strict: a misspelt `workflowfile` is refused, not ignored. */
const RepoEntrySchema = z.strictObject({
  owner: z.string().regex(GITHUB_OWNER_PATTERN, 'must be a GitHub user or organisation name'),
  repo: z.string().regex(GITHUB_REPO_PATTERN, 'must be a GitHub repository name'),
  ref: z.string().default(DEFAULT_GIT_REF),
  workflowFile: z.string().default(DEFAULT_WORKFLOW_FILE),
  installationId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
  default: z.boolean().optional(),
});

/** One finished sentence and the variable it is about. */
export interface RepoSetIssue {
  readonly message: string;
  readonly at: string;
}

/** The parsed set, or every reason it does not parse. */
export type RepoSetParse =
  | { readonly repos: readonly GithubRepoConfig[]; readonly source: 'env' | 'json' }
  | { readonly issues: readonly RepoSetIssue[] };

/**
 * The top-level keys of a JSON object, IN THE ORDER WRITTEN AND WITH DUPLICATES - which
 * `JSON.parse` cannot report: it keeps the last of two equal keys and silently drops the first,
 * so a repository pasted twice under one key with two different `owner`s would boot against
 * whichever came second. `null` when the text is not an object this scanner can walk (the
 * caller has already run `JSON.parse`, so that only happens for a non-object).
 */
export function topLevelJsonKeys(text: string): readonly string[] | null {
  const keys: string[] = [];
  let depth = 0;
  let i = 0;
  let expectKey = false;
  while (i < text.length) {
    const c = text[i];
    if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
      const literal = text.slice(i, j + 1);
      if (depth === 1 && expectKey) {
        const decoded: unknown = JSON.parse(literal);
        if (typeof decoded === 'string') keys.push(decoded);
        expectKey = false;
      }
      i = j + 1;
      continue;
    }
    if (c === '{' || c === '[') {
      depth += 1;
      expectKey = depth === 1 && c === '{';
      if (depth === 1 && c === '[') return null;
    } else if (c === '}' || c === ']') {
      depth -= 1;
    } else if (c === ',' && depth === 1) {
      expectKey = true;
    }
    i += 1;
  }
  return keys;
}

/** Whether the raw env selects PAT mode unambiguously (the auth rule reports every other case). */
function isPatOnly(env: Readonly<Record<string, string | undefined>>): boolean {
  return env['GITHUB_TOKEN'] !== undefined && APP_VARIABLES.every((name) => env[name] === undefined);
}

/**
 * THE REPOSITORY SET, from the raw env (RFC-001 7.1).
 *
 * WHY THE RAW ENV, like `githubAuthModeIssues`: it must report its problems in the same pass as
 * every other bad variable, even when `EnvSchema` failed on something unrelated.
 *
 * TWO FORMS, NEVER BOTH:
 *
 *  - `GITHUB_REPOS_JSON` absent: THE COMPATIBILITY SHIM. `GITHUB_OWNER`, `GITHUB_REPO`,
 *    `GITHUB_REF`, `GITHUB_WORKFLOW_FILE` and `GITHUB_APP_INSTALLATION_ID` define one repository
 *    keyed `default`, marked default - exactly the phase-1 meaning of each variable, so an
 *    existing install needs no change and behaves identically.
 *  - `GITHUB_REPOS_JSON` present: one entry per repository, keyed by `/^[a-z][a-z0-9-]{0,30}$/`;
 *    `owner`/`repo` use the same rules as the pair; `ref` and `workflowFile` default as before;
 *    `installationId` optional (App mode only); at most one `"default": true`. A set of exactly
 *    one entry that says nothing about `default` is the default, so a one-entry JSON set behaves
 *    exactly like the pair. The pair's variables beside it are refused rather than merged: two
 *    places to say which repository the bot builds in is how a build lands in the wrong one.
 *
 * Refused as well: a key written twice (see `topLevelJsonKeys`), and two keys naming the same
 * repository (compared case-insensitively, as GitHub does), which would give one repository two
 * adapters, two gate caches and two answers to "how many builds ran today?".
 */
export function githubRepoSet(env: Readonly<Record<string, string | undefined>>): RepoSetParse {
  const raw = env['GITHUB_REPOS_JSON'];
  return raw === undefined ? shimRepoSet(env) : jsonRepoSet(raw, env);
}

/** The phase-1 pair as a one-repository set. */
function shimRepoSet(env: Readonly<Record<string, string | undefined>>): RepoSetParse {
  const issues: RepoSetIssue[] = [];
  const owner = env['GITHUB_OWNER'];
  const repo = env['GITHUB_REPO'];
  for (const [name, value] of [['GITHUB_OWNER', owner], ['GITHUB_REPO', repo]] as const) {
    if (value === undefined) {
      issues.push({
        message: `${name} is required: set GITHUB_OWNER and GITHUB_REPO to the module repository, or list the repositories in GITHUB_REPOS_JSON.`,
        at: name,
      });
    }
  }
  const workflowFile = toWorkflowFile(env['GITHUB_WORKFLOW_FILE'] ?? DEFAULT_WORKFLOW_FILE);
  if (!workflowFile.ok) issues.push({ message: `${workflowFile.error.internal ?? 'not a workflow file'}. ${workflowFile.error.nextStep}`, at: 'GITHUB_WORKFLOW_FILE' });
  const ref = toGitRef(env['GITHUB_REF'] ?? DEFAULT_GIT_REF);
  if (!ref.ok) issues.push({ message: `${ref.error.internal ?? 'not a git ref'}. ${ref.error.nextStep}`, at: 'GITHUB_REF' });
  const pinned = env['GITHUB_APP_INSTALLATION_ID'];
  // A malformed GITHUB_OWNER/GITHUB_REPO/GITHUB_APP_INSTALLATION_ID is reported by `EnvSchema`;
  // this only has to stop building a set from it.
  if (
    issues.length > 0 ||
    owner === undefined ||
    repo === undefined ||
    !workflowFile.ok ||
    !ref.ok ||
    !GITHUB_OWNER_PATTERN.test(owner) ||
    !GITHUB_REPO_PATTERN.test(repo) ||
    (pinned !== undefined && !/^[1-9]\d{0,15}$/u.test(pinned)) ||
    // Never refuses (`default` matches the key pattern); it is here because the predicate IS the brand.
    !isRepoKey(DEFAULT_REPO_KEY)
  ) {
    return { issues };
  }
  return {
    source: 'env',
    repos: [
      {
        key: DEFAULT_REPO_KEY,
        owner,
        repo,
        workflowFile: workflowFile.value,
        ref: ref.value,
        installationId: pinned === undefined ? null : Number.parseInt(pinned, 10),
        isDefault: true,
        names: ENV_REPO_SETTING_NAMES,
      },
    ],
  };
}

/** `GITHUB_REPOS_JSON`, validated entry by entry so every problem is named at once. */
function jsonRepoSet(raw: string, env: Readonly<Record<string, string | undefined>>): RepoSetParse {
  const issues: RepoSetIssue[] = [];
  const mixed = SINGLE_REPO_VARIABLES.filter((name) => env[name] !== undefined);
  if (mixed.length > 0) {
    issues.push({
      message: `GITHUB_REPOS_JSON is set, so ${mixed.join(', ')} must not be: the repository set comes from one place. Move each value onto its GITHUB_REPOS_JSON entry (owner, repo, ref, workflowFile, installationId) and delete ${mixed.length === 1 ? 'it' : 'them'} from .env. An empty line still counts as set.`,
      at: 'GITHUB_REPOS_JSON',
    });
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw);
  } catch (cause: unknown) {
    issues.push({ message: `not valid JSON: ${cause instanceof Error ? cause.message : 'unknown'}`, at: 'GITHUB_REPOS_JSON' });
    return { issues };
  }
  if (typeof parsedJson !== 'object' || parsedJson === null || Array.isArray(parsedJson)) {
    issues.push({ message: 'must be a JSON object keyed by repository key, e.g. {"main":{"owner":"acme","repo":"bot-modules"}}', at: 'GITHUB_REPOS_JSON' });
    return { issues };
  }

  const written = topLevelJsonKeys(raw) ?? [];
  const twice = [...new Set(written.filter((k, i) => written.indexOf(k) !== i))];
  for (const key of twice) {
    issues.push({ message: `the key "${key}" is written more than once; JSON keeps only the last, so the others would be silently dropped. Give each repository one entry.`, at: `GITHUB_REPOS_JSON.${key}` });
  }

  const patOnly = isPatOnly(env);
  const repos: GithubRepoConfig[] = [];
  const entries = Object.entries(parsedJson);
  if (entries.length === 0) {
    issues.push({ message: 'lists no repositories; add at least one entry, e.g. {"main":{"owner":"acme","repo":"bot-modules"}}', at: 'GITHUB_REPOS_JSON' });
  }
  for (const [key, value] of entries) {
    const at = `GITHUB_REPOS_JSON.${key}`;
    if (!isRepoKey(key)) {
      issues.push({ message: `"${key}" is not a repository key: use a lowercase letter, then up to 30 lowercase letters, digits or dashes (${REPO_KEY_PATTERN.source}).`, at });
      continue;
    }
    const entry = RepoEntrySchema.safeParse(value);
    if (!entry.success) {
      for (const issue of entry.error.issues) {
        issues.push({ message: issue.message, at: [at, ...issue.path.map(String)].join('.') });
      }
      continue;
    }
    const workflowFile = toWorkflowFile(entry.data.workflowFile);
    if (!workflowFile.ok) issues.push({ message: `${workflowFile.error.internal ?? 'not a workflow file'}. ${workflowFile.error.nextStep}`, at: `${at}.workflowFile` });
    const ref = toGitRef(entry.data.ref);
    if (!ref.ok) issues.push({ message: `${ref.error.internal ?? 'not a git ref'}. ${ref.error.nextStep}`, at: `${at}.ref` });
    if (patOnly && entry.data.installationId !== undefined) {
      issues.push({
        message: 'installationId pins a GitHub App installation, but the bot authenticates with GITHUB_TOKEN (a personal access token, one token for the whole set). Remove installationId, or switch to a GitHub App.',
        at: `${at}.installationId`,
      });
    }
    if (!workflowFile.ok || !ref.ok) continue;
    repos.push({
      key,
      owner: entry.data.owner,
      repo: entry.data.repo,
      workflowFile: workflowFile.value,
      ref: ref.value,
      installationId: entry.data.installationId ?? null,
      // A one-entry set that says nothing about `default` IS the default, as the shim's is.
      isDefault: entry.data.default ?? entries.length === 1,
      names: jsonRepoSettingNames(key),
    });
  }

  const defaults = repos.filter((r) => r.isDefault);
  if (defaults.length > 1) {
    issues.push({ message: `more than one repository is marked "default": true (${defaults.map((r) => r.key).join(', ')}); mark at most one.`, at: 'GITHUB_REPOS_JSON' });
  }
  const byName = new Map<string, string>();
  for (const r of repos) {
    const name = `${r.owner}/${r.repo}`.toLowerCase();
    const first = byName.get(name);
    if (first === undefined) {
      byName.set(name, r.key);
    } else {
      issues.push({
        message: `"${first}" and "${r.key}" both name ${r.owner}/${r.repo}; a repository may appear in the set once (GitHub compares names case-insensitively).`,
        at: `GITHUB_REPOS_JSON.${r.key}`,
      });
    }
  }
  return issues.length > 0 ? { issues } : { repos, source: 'json' };
}

/**
 * Where the App's private key comes from. A FILE is read by the composition root, not here:
 * `loadConfig` stays a pure function of the env, which is what makes it testable.
 */
export type GithubAppPrivateKeySource =
  | { readonly kind: 'inline'; readonly pem: Secret }
  | { readonly kind: 'file'; readonly path: string };

/** How this process authenticates to GitHub. Exactly one mode, by construction. */
export type GithubAuthConfig =
  | { readonly kind: 'pat'; readonly token: Secret }
  | {
      readonly kind: 'app';
      readonly appId: number;
      readonly privateKey: GithubAppPrivateKeySource;
      // NO installation id here any more (RFC-001 PR 2.1): one App has one installation PER
      // REPOSITORY, so the pinned id lives on each `GithubRepoConfig`. The shim puts
      // `GITHUB_APP_INSTALLATION_ID` on its single repository.
    };

/**
 * What a sentence about one repository's settings calls each of them, so an operator is told
 * the variable they actually wrote: `GITHUB_REF` for the single-repository pair,
 * `GITHUB_REPOS_JSON.events.ref` for an entry of the set.
 */
export interface RepoSettingNames {
  readonly owner: string;
  readonly repo: string;
  /** Both, as one location (`GITHUB_OWNER/GITHUB_REPO`). */
  readonly ownerRepo: string;
  readonly ref: string;
  readonly workflowFile: string;
  readonly installationId: string;
}

/** The single-repository variables, as every phase-1 sentence named them. */
export const ENV_REPO_SETTING_NAMES: RepoSettingNames = {
  owner: 'GITHUB_OWNER',
  repo: 'GITHUB_REPO',
  ownerRepo: 'GITHUB_OWNER/GITHUB_REPO',
  ref: 'GITHUB_REF',
  workflowFile: 'GITHUB_WORKFLOW_FILE',
  installationId: 'GITHUB_APP_INSTALLATION_ID',
};

/** The same names for the `GITHUB_REPOS_JSON` entry `key`. */
export function jsonRepoSettingNames(key: string): RepoSettingNames {
  const at = `GITHUB_REPOS_JSON.${key}`;
  return {
    owner: `${at}.owner`,
    repo: `${at}.repo`,
    ownerRepo: `${at}.owner/repo`,
    ref: `${at}.ref`,
    workflowFile: `${at}.workflowFile`,
    installationId: `${at}.installationId`,
  };
}

/**
 * ONE configured repository (RFC-001 7.1). Everything a per-repository GitHub adapter binds:
 * the dispatch ref and workflow are per repository, exactly as `GITHUB_REF` and
 * `GITHUB_WORKFLOW_FILE` were for the one repository of phase 1.
 */
export interface GithubRepoConfig {
  readonly key: RepoKey;
  readonly owner: string;
  readonly repo: string;
  readonly workflowFile: WorkflowFile;
  readonly ref: GitRef;
  /** Pinned App installation id, or `null` to look it up (`GET /repos/{o}/{r}/installation`). */
  readonly installationId: number | null;
  readonly isDefault: boolean;
  /** How sentences name this repository's settings. */
  readonly names: RepoSettingNames;
}

/** Raw per-module slices. Each module's own schema validates its own slice. */
export type ModuleConfigMap = Readonly<Record<string, unknown>>;

/** The validated boot config. Secrets are wrapped; everything else is plain. */
export interface AppConfig {
  readonly nodeEnv: 'development' | 'production' | 'test';
  readonly logLevel: LogLevel;
  readonly discord: {
    readonly token: Secret;
    readonly clientId: string;
    readonly ownerId: string;
    readonly devGuildId: string | null;
    /** Whether the privileged MessageContent intent was requested. */
    readonly messageContent: boolean;
  };
  readonly github: {
    /** PAT or GitHub App; see `GithubAuthConfig`. ONE credential for the whole set (6.6, 7.1). */
    readonly auth: GithubAuthConfig;
    /**
     * The repository set, in configuration order, never empty. From `GITHUB_REPOS_JSON`, or the
     * one-element set keyed `default` that the single-repository shim builds.
     */
    readonly repos: readonly GithubRepoConfig[];
    /** Where the set came from, for sentences and `doctor`. */
    readonly reposSource: 'env' | 'json';
    /**
     * ONE key per bot instance, set as a repository secret in every configured repository
     * (RFC-001 7.1, "Resolved"): the signed `repository` field already makes a token
     * non-transferable between repositories.
     */
    readonly approvalHmacKey: Secret;
    /** `ALLOW_PUBLIC_TARGET_REPO`. */
    readonly allowPublicTargetRepo: boolean;
  };
  readonly databasePath: string;
  readonly modules: ModuleConfigMap;
  readonly disabledModules: readonly string[];
  /** `MODULE_DIRS`, split and trimmed. Still relative; `main` resolves against the cwd. */
  readonly moduleDirs: readonly string[];
  /** True when `MODULE_DIRS` was present in the env at all; a missing directory is then fatal. */
  readonly moduleDirsExplicit: boolean;
  /** `MODULES_BUILTIN`. */
  readonly builtinModules: boolean;
}

/**
 * Validate the environment. Called exactly once, from `main`.
 * WHY it takes the env rather than reading `process.env`: it makes config failures testable,
 * which is how you find out that `DISCORD_DEV_GUILD_ID: ''` parses differently from absent.
 */
export function loadConfig(env: Readonly<Record<string, string | undefined>>): Result<AppConfig, AppError> {
  const parsed = EnvSchema.safeParse(env);
  const modeIssues = githubAuthModeIssues(env);
  const repoSet = githubRepoSet(env);
  const repoIssues = 'issues' in repoSet ? repoSet.issues : [];
  if (!parsed.success || modeIssues.length > 0 || repoIssues.length > 0) {
    // ONE error naming everything, in zod's own `✖ ... → at X` shape, so the GitHub auth rule
    // and the repository-set rules read like every other line of the report rather than like a
    // second, later failure.
    const lines = [
      ...(parsed.success ? [] : [z.prettifyError(parsed.error)]),
      ...modeIssues.map((issue) => `✖ ${issue}\n  → at GitHub auth mode`),
      ...repoIssues.map((issue) => `✖ ${issue.message}\n  → at ${issue.at}`),
    ];
    return Err(errors.config('env', lines.join('\n'), 'Set the missing environment variables and restart. See .env.example.'));
  }
  const e = parsed.data;
  if (!('repos' in repoSet)) return Err(errors.internal('config.repos', 'repository set unparsed without an issue'));

  let modules: ModuleConfigMap;
  try {
    const raw: unknown = JSON.parse(e.MODULES_JSON);
    const shape = z.record(z.string(), z.unknown()).safeParse(raw);
    if (!shape.success) {
      return Err(errors.config('MODULES_JSON', z.prettifyError(shape.error), 'MODULES_JSON must be a JSON object keyed by module id.'));
    }
    modules = shape.data;
  } catch (cause: unknown) {
    return Err(
      errors.config('MODULES_JSON', `not valid JSON: ${cause instanceof Error ? cause.message : 'unknown'}`, 'Fix MODULES_JSON so it parses as a JSON object.'),
    );
  }

  return Ok({
    nodeEnv: e.NODE_ENV,
    logLevel: e.LOG_LEVEL,
    discord: {
      token: secret(e.DISCORD_TOKEN),
      clientId: e.DISCORD_CLIENT_ID,
      ownerId: e.DISCORD_OWNER_ID,
      devGuildId: e.DISCORD_DEV_GUILD_ID ?? null,
      messageContent: e.DISCORD_MESSAGE_CONTENT,
    },
    github: {
      auth: githubAuthFrom(e),
      repos: repoSet.repos,
      reposSource: repoSet.source,
      approvalHmacKey: secret(e.APPROVAL_HMAC_KEY),
      allowPublicTargetRepo: e.ALLOW_PUBLIC_TARGET_REPO,
    },
    databasePath: e.DATABASE_PATH,
    modules,
    disabledModules: e.MODULES_DISABLE.split(',').map((s) => s.trim()).filter((s) => s.length > 0),
    moduleDirs: e.MODULE_DIRS.split(',').map((s) => s.trim()).filter((s) => s.length > 0),
    moduleDirsExplicit: env['MODULE_DIRS'] !== undefined,
    builtinModules: e.MODULES_BUILTIN,
  });
}

/**
 * Build the auth union from an env that already passed `githubAuthModeIssues`.
 *
 * The fallbacks below exist only because the compiler cannot see that rule; every `undefined`
 * they cover was already refused with a sentence before this runs.
 */
function githubAuthFrom(e: z.infer<typeof EnvSchema>): GithubAuthConfig {
  if (e.GITHUB_TOKEN !== undefined) return { kind: 'pat', token: secret(e.GITHUB_TOKEN) };
  const privateKey: GithubAppPrivateKeySource =
    e.GITHUB_APP_PRIVATE_KEY !== undefined
      ? { kind: 'inline', pem: secret(e.GITHUB_APP_PRIVATE_KEY) }
      : { kind: 'file', path: e.GITHUB_APP_PRIVATE_KEY_FILE ?? '' };
  return { kind: 'app', appId: Number.parseInt(e.GITHUB_APP_ID ?? '0', 10), privateKey };
}

/**
 * The slice `defineModule().install()` validates.
 * WHY `{}` and not `undefined` for a missing module: every module schema supplies defaults, so
 * "no config supplied" must still parse.
 */
export function moduleConfigSlice(cfg: AppConfig, moduleId: string): unknown {
  return cfg.modules[moduleId] ?? {};
}

/**
 * `MODULES_JSON.builder` keys that used to mean something and are now IGNORED (RFC-001 5.4).
 *
 * `modules.builder.ref` and `modules.builder.workflowFile` named the ref and workflow every
 * dispatch ran, while the boot preflight checked `GITHUB_REF` and `GITHUB_WORKFLOW_FILE`: two
 * values for one fact, and the gate-file digest check would have validated files at one ref while
 * the build ran another. The builder's schema no longer has the keys (zod strips them), the
 * GitHub adapter dispatches at the env pair, and this is the warning that says so instead of an
 * operator discovering it by a build running somewhere they did not expect.
 */
export const REMOVED_BUILDER_KEYS = [
  { key: 'ref', replacement: 'GITHUB_REF' },
  { key: 'workflowFile', replacement: 'GITHUB_WORKFLOW_FILE' },
] as const;

/** One warning sentence per removed `MODULES_JSON.builder` key still present; empty when none. */
export function removedBuilderKeyWarnings(modules: ModuleConfigMap): readonly string[] {
  const slice = modules['builder'];
  if (typeof slice !== 'object' || slice === null) return [];
  return REMOVED_BUILDER_KEYS.filter(({ key }) => Object.hasOwn(slice, key)).map(
    ({ key, replacement }) =>
      `MODULES_JSON.builder.${key} is ignored: builds now dispatch at ${replacement}, the value the preflight and the gate-file check verify. Set ${replacement} instead and remove builder.${key} from MODULES_JSON.`,
  );
}

/**
 * `modules.builder.requireOwnCredentials` as the BOOT PREFLIGHT needs it, before any module is
 * installed: it decides whether the bot must be able to list environments (gate on) or must find
 * a funded `ai-agent` environment (gate off).
 *
 * The default (`true`) matches the builder's own schema, and `config.test.ts` asserts the two
 * agree through the real module install. A value the builder's schema would reject reads as
 * `true` here: the builder is then quarantined at install anyway, and `true` is the reading
 * under which the preflight never asks the operator to fund anything.
 */
export function builderRequiresOwnCredentials(modules: ModuleConfigMap): boolean {
  const parsed = z.object({ requireOwnCredentials: z.boolean().default(true) }).safeParse(modules['builder'] ?? {});
  return parsed.success ? parsed.data.requireOwnCredentials : true;
}

/**
 * Standalone module-config validation, for `npm run doctor` and tests.
 * WHY separate from `install`: the offline preflight must report every module's config errors
 * without wiring a single port.
 */
export function parseModuleConfig<T>(moduleId: string, schema: z.ZodType<T>, raw: unknown): Result<T, AppError> {
  const parsed = schema.safeParse(raw);
  return parsed.success
    ? Ok(parsed.data)
    : Err(errors.config(`modules.${moduleId}`, z.prettifyError(parsed.error), `Fix config.modules.${moduleId}.`));
}
