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
import type { GitRef, LogLevel, WorkflowFile } from '#core/ports';
import { toGitRef, toWorkflowFile } from '#core/ports';

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
  GITHUB_OWNER: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/u),
  GITHUB_REPO: z.string().regex(/^[A-Za-z0-9._-]{1,100}$/u),
  GITHUB_WORKFLOW_FILE: z.string().default('agent-implement-request.yml'),
  GITHUB_REF: z.string().default('main'),
  /** Shared with the repo's Actions secrets and nowhere else (SC-6). */
  APPROVAL_HMAC_KEY: z.string().min(32, 'must be at least 32 chars of entropy'),

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
      /** `GITHUB_APP_INSTALLATION_ID`, or `null` to look it up from the repository. */
      readonly installationId: number | null;
    };

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
    /** PAT or GitHub App; see `GithubAuthConfig`. */
    readonly auth: GithubAuthConfig;
    readonly owner: string;
    readonly repo: string;
    /** Branded at boot, so a module can never hand `dispatch` a free-text workflow name. */
    readonly workflowFile: WorkflowFile;
    readonly ref: GitRef;
    readonly approvalHmacKey: Secret;
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
  if (!parsed.success || modeIssues.length > 0) {
    // ONE error naming everything, in zod's own `✖ ... → at X` shape, so the GitHub auth rule
    // reads like every other line of the report rather than like a second, later failure.
    const lines = [
      ...(parsed.success ? [] : [z.prettifyError(parsed.error)]),
      ...modeIssues.map((issue) => `✖ ${issue}\n  → at GitHub auth mode`),
    ];
    return Err(errors.config('env', lines.join('\n'), 'Set the missing environment variables and restart. See .env.example.'));
  }
  const e = parsed.data;

  const workflowFile = toWorkflowFile(e.GITHUB_WORKFLOW_FILE);
  if (!workflowFile.ok) return workflowFile;
  const ref = toGitRef(e.GITHUB_REF);
  if (!ref.ok) return ref;

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
      owner: e.GITHUB_OWNER,
      repo: e.GITHUB_REPO,
      workflowFile: workflowFile.value,
      ref: ref.value,
      approvalHmacKey: secret(e.APPROVAL_HMAC_KEY),
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
  return {
    kind: 'app',
    appId: Number.parseInt(e.GITHUB_APP_ID ?? '0', 10),
    privateKey,
    installationId:
      e.GITHUB_APP_INSTALLATION_ID === undefined ? null : Number.parseInt(e.GITHUB_APP_INSTALLATION_ID, 10),
  };
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
