/**
 * `SecretsPort` on GitHub environment secrets.
 *
 * THE ONE THING TO UNDERSTAND ABOUT THIS FILE: GitHub returns **201 for any well-formed
 * base64 body**. It never checks that the ciphertext decrypts. A sealed box built with the
 * wrong algorithm, the wrong nonce, the wrong base64 alphabet or a stale key id is accepted
 * silently, and the mistake surfaces as an opaque auth failure roughly thirty minutes later
 * inside somebody ELSE's build, with no feedback path back to the write that caused it.
 *
 * That is why the tests next door do not assert on the response status or on the length of the
 * base64: both pass on garbage. They seal with this code and open with libsodium's own
 * `crypto_box_seal_open`.
 *
 * WHY `libsodium-wrappers` AND NOT `node:crypto` (measured on node v24.16.0 / OpenSSL 3.5.6,
 * so nobody has to re-derive it):
 *   - `crypto.getCiphers()` contains NO salsa cipher at all. `chacha20-poly1305` is a different
 *     cipher with a different key schedule, not a substitute for XSalsa20-Poly1305, and there
 *     is no HSalsa20 either.
 *   - `createHash('blake2b512', { outputLength: 24 })` throws `not XOF or invalid length`.
 *     BLAKE2b is not extendable-output, and a sealed box's nonce needs the digest length baked
 *     into the BLAKE2b parameter block. Truncating a 64-byte digest yields a DIFFERENT value,
 *     and ciphertext that fails only at run time.
 *   Node can do the X25519 half and nothing else, so "use node:crypto primitives" means writing
 *   HSalsa20 + XSalsa20 + Poly1305 + parameterised BLAKE2b by hand. `crypto_box_seal` is a
 *   named primitive; a hand-rolled composition is a protocol we could get subtly wrong, whose
 *   failure mode is the silent one described above.
 *
 * THE CREDENTIAL'S PATH THROUGH THIS PROCESS, in full: it arrives as a `Secret`, is unwrapped
 * exactly once (`value.reveal()`, in `put`, and a test asserts that string appears exactly once
 * in this file), goes straight into `crypto_box_seal`, and the SEALED BOX is what is sent. The
 * plaintext is never stored, never logged, never interpolated, and - the part that is easy to
 * get wrong - never placed in an `AppError.internal` either. Every user-facing sentence below
 * is a literal in this file selected by status code, exactly as in `client.ts`, so no upstream
 * body has a path to Discord.
 */

import sodium from 'libsodium-wrappers';
import type { Octokit } from 'octokit';
import { z } from 'zod';
import { Err, Ok, type Result } from '#core/result';
import { errors, type AppError } from '#core/errors';
import { redactSecrets } from '#core/text';
import type { Secret } from '#core/config';
import type { ClockPort, LoggerPort } from '#core/ports';
import type { EnvironmentListing, EnvironmentName, SecretName, SecretsPort } from '#core/ports/secrets';
import { mapGithubError, readGithubFailure, type GithubRepo } from '#adapters/github/client';

// ---------------------------------------------------------------------------------------
// Sealing
// ---------------------------------------------------------------------------------------

/**
 * GitHub's `GET .../secrets/public-key` answer.
 *
 * `keyId` IS A DECIMAL STRING, not a number: a real one is `"3380204578043523366"`, which
 * exceeds `Number.MAX_SAFE_INTEGER`. Parsing it into a number silently corrupts the low digits
 * and GitHub then stores the secret under a key id that does not exist. It is a string here,
 * in the zod schema, and in the request body - the whole way.
 */
export interface SecretPublicKey {
  readonly keyId: string;
  readonly keyBase64: string;
}

/**
 * Seal `plaintext` to `publicKey` exactly as GitHub expects.
 *
 * Returns STANDARD base64 (`base64_variants.ORIGINAL`) - padded, `+/` alphabet. GitHub rejects
 * base64url, and `sodium.to_base64()` defaults to URLSAFE_NO_PADDING, so omitting the variant
 * argument is a silent wrong-answer bug. The variant is passed explicitly at both ends.
 *
 * The output is always 48 bytes longer than the UTF-8 plaintext (a 32-byte ephemeral public key
 * plus a 16-byte Poly1305 tag) and is NON-DETERMINISTIC: a fresh ephemeral keypair per call
 * means sealing the same value twice gives different ciphertext. Never assert on a stable
 * ciphertext, and never read a changed ciphertext as evidence the credential changed.
 *
 * `await sodium.ready` is idempotent and already resolved after the first call, so this costs
 * one microtask rather than a re-initialisation - cheaper than an init lifecycle step someone
 * forgets to wire up, and it cannot be skipped, which an init step can.
 */
export async function sealSecret(plaintext: string, publicKey: SecretPublicKey): Promise<string> {
  await sodium.ready;
  const sealed = sodium.crypto_box_seal(
    sodium.from_string(plaintext),
    sodium.from_base64(publicKey.keyBase64, sodium.base64_variants.ORIGINAL),
  );
  return sodium.to_base64(sealed, sodium.base64_variants.ORIGINAL);
}

// ---------------------------------------------------------------------------------------
// Wire schemas. Nothing off the network is trusted (same posture as issues.ts).
// ---------------------------------------------------------------------------------------

/** `key_id` is `z.string()` ON PURPOSE - see `SecretPublicKey`. A number fails loudly here. */
const PublicKeyPayload = z.object({
  key_id: z.string().min(1),
  key: z.string().min(1),
});

/** The listing answer. Only `name` is read: there is no value in this response, by design. */
const SecretListPayload = z.object({
  secrets: z.array(z.object({ name: z.string() })),
});

// ---------------------------------------------------------------------------------------
// Telling GitHub's two 404s apart
// ---------------------------------------------------------------------------------------

/**
 * THE PROBE, and why this feature needs one at all.
 *
 * `GET /repos/{o}/{r}/environments/{env}/secrets` answers **404** for two completely different
 * situations and does not say which:
 *
 *   (a) the environment does not exist - the ordinary state of every user who has never run
 *       `/credentials set`, i.e. almost everyone; and
 *   (b) this token cannot see the repository at all, which GitHub reports as 404 rather than
 *       403 on a private repo, on purpose, to avoid confirming that the repo exists.
 *
 * The integration answered both with (b)'s sentence - "ask an admin to check the token
 * repository access" - so `/credentials status` told the majority case that the bot was broken.
 * Answering both with (a) is worse: it tells somebody whose credential IS stored that it is not,
 * forever, while they paste it again.
 *
 * So we ask a question with an unambiguous answer: the repository's ENVIRONMENT LISTING. It
 * names no particular environment, so it has no existence precondition to fail on. If it answers
 * 200 then this token can reach this repository and read its environments, and the 404 we are
 * holding can therefore only have been about that one environment - case (a). If it answers
 * anything else, the problem is the token or the repository, and that is case (b): an error.
 *
 * WHY THE BODY IS NOT READ, when it does contain the names: the listing is paginated (30 per
 * page by default), so on a busy install the environment we are asking about can be legitimately
 * present and simply not on the page we got. A membership test would then report "you have
 * nothing stored" to a user who does - the exact failure this whole function exists to avoid.
 * The STATUS CODE carries everything the decision needs; the body carries a trap.
 *
 * WHY IT IS NOT CACHED: it runs only on the 404 path, which for `list` is once per
 * `/credentials status` for a user with nothing stored, and a cached "yes" is exactly what would
 * survive an operator revoking the Environments permission mid-session.
 */
type Probe = () => Promise<boolean>;

// ---------------------------------------------------------------------------------------
// The public-key cache
// ---------------------------------------------------------------------------------------

/**
 * How long a fetched public key is reused.
 *
 * WHY CACHE AT ALL: an environment's key is stable, and a write would otherwise cost two
 * round trips - which matters because this runs inside a Discord modal submission, where the
 * user is watching.
 *
 * WHY THE TTL IS SHORT RATHER THAN FOREVER: the key changes when the environment is deleted and
 * recreated, and a stale `key_id` is accepted with a 201 and fails invisibly later (see the
 * file header). Five minutes is long enough to make a burst of writes cheap and short enough
 * that a rotation heals itself without a restart. `deleteEnvironment` drops the entry outright,
 * and so does a 404/422 from a write, so the TTL is the backstop rather than the mechanism.
 */
export const PUBLIC_KEY_TTL_MS = 5 * 60_000;

interface CachedKey {
  readonly key: SecretPublicKey;
  readonly fetchedAtMs: number;
}

// ---------------------------------------------------------------------------------------
// Failure mapping
// ---------------------------------------------------------------------------------------

/**
 * THE 403 SENTENCE, and why it is not `client.ts`'s.
 *
 * Environment secrets are governed by the fine-grained permission named **Environments**, NOT
 * by the one named **Secrets**. "Secrets" grants only `/repos/{owner}/{repo}/actions/secrets/*`
 * - repository-level Actions secrets - so an operator who reads "I am writing a secret", grants
 * `Secrets: write` and tries again gets a 403 on every call with nothing anywhere explaining
 * why. `client.ts`'s generic 403 sends them to check "contents, issues and actions", which are
 * the three permissions that are NOT the problem.
 *
 * Everything else delegates to the shared translator, so there is still exactly one place that
 * knows a 404 usually means "the token cannot see this repository" and that 401/403 must never
 * be retried.
 */
export function mapSecretsError(cause: unknown, operation: string, nowMs: number): AppError {
  const failure = readGithubFailure(cause, nowMs);

  // A 403 carrying rate-limit evidence is a rate limit, not a permission problem, and
  // `mapGithubError` already turns it into a `rate-limited` error with a wait. Only a bare 403
  // gets the permissions sentence.
  const isRateLimit = failure.rateLimitRemaining === 0 || failure.retryAfterMs !== null;
  if (failure.status === 403 && !isRateLimit) {
    return errors.upstream(
      'github',
      403,
      "The bot isn't allowed to store credentials on GitHub. Ask an admin to check its access.",
      redactSecrets(
        `${operation}: forbidden status=403 - GITHUB_TOKEN needs the repository "Environments" permission (read and write), which is separate from "Secrets"`,
      ),
    );
  }
  return mapGithubError(cause, operation, nowMs);
}

// ---------------------------------------------------------------------------------------
// The port
// ---------------------------------------------------------------------------------------

export function createGithubSecrets(input: {
  readonly octokit: Octokit;
  readonly repo: GithubRepo;
  readonly clock: ClockPort;
  readonly logger: LoggerPort;
}): SecretsPort {
  const { octokit, clock } = input;
  const { owner, repo } = input.repo;
  const log = input.logger.child({ component: 'github.secrets' });

  /** One place turns a thrown value into an `AppError`, so no call site invents wording. */
  const fail = (cause: unknown, operation: string): AppError => mapSecretsError(cause, operation, clock.now());

  const keyCache = new Map<string, CachedKey>();

  /** WHY it is called on a failed write too: a cached key that outlived its environment is the
   *  one failure GitHub will not report, so it must not survive the first sign of trouble. */
  function forgetKey(env: EnvironmentName): void {
    keyCache.delete(env);
  }

  /**
   * "Can this token read this repository's environments at all?" - see the `Probe` doc above.
   *
   * It swallows its own failure into `false` deliberately: every caller is already holding a
   * 404 it must turn into an `AppError`, and a probe that threw would replace that mapped error
   * with an unhandled rejection. `false` means "we could not establish that access is fine",
   * which lands on the safe side - the caller reports the original failure rather than
   * inventing an absence.
   */
  const environmentsReadable: Probe = async () => {
    try {
      await octokit.request('GET /repos/{owner}/{repo}/environments', { owner, repo, per_page: 1 });
      return true;
    } catch {
      return false;
    }
  };

  /**
   * Resolve a caught failure into "there was nothing there" or into an `AppError`.
   *
   * WHY ONE HELPER AND NOT THREE COPIES: `list`, `remove` and `deleteEnvironment` face the
   * identical ambiguity, and three hand-written copies is exactly how two of them come to
   * swallow a permission failure while the third does not. Only a 404 is ambiguous - a 403
   * already IS a permission answer and keeps `mapSecretsError`'s Environments sentence.
   */
  async function absentOrFailure<T>(absent: T, cause: unknown, operation: string): Promise<Result<T, AppError>> {
    if (readGithubFailure(cause, clock.now()).status !== 404) return Err(fail(cause, operation));
    return (await environmentsReadable()) ? Ok(absent) : Err(fail(cause, operation));
  }

  async function publicKeyFor(env: EnvironmentName): Promise<Result<SecretPublicKey, AppError>> {
    const cached = keyCache.get(env);
    if (cached !== undefined && clock.now() - cached.fetchedAtMs < PUBLIC_KEY_TTL_MS) {
      return Ok(cached.key);
    }
    try {
      const res = await octokit.request('GET /repos/{owner}/{repo}/environments/{environment_name}/secrets/public-key', {
        owner,
        repo,
        environment_name: env,
      });
      const parsed = PublicKeyPayload.safeParse(res.data);
      if (!parsed.success) {
        // Reaching here means `key_id` was not a string, i.e. GitHub changed the shape. Failing
        // is the only safe answer: coercing a number would corrupt an id that exceeds 2^53 and
        // produce a secret nothing can decrypt.
        return Err(
          errors.upstream(
            'github',
            res.status,
            'Ask an admin to check the GitHub API version pin.',
            'secrets.publicKey: unrecognised response shape',
          ),
        );
      }
      const key: SecretPublicKey = { keyId: parsed.data.key_id, keyBase64: parsed.data.key };
      keyCache.set(env, { key, fetchedAtMs: clock.now() });
      return Ok(key);
    } catch (cause: unknown) {
      return Err(fail(cause, 'secrets.publicKey'));
    }
  }

  return {
    async ensureEnvironment(name): Promise<Result<void, AppError>> {
      try {
        // Idempotent by GitHub's own contract: this is create-OR-UPDATE, and it answers 200
        // whether or not the environment already existed. No pre-read, so no race.
        //
        // No body is sent, deliberately. A body here would set protection rules - reviewers,
        // wait timers, branch policies - and sending an empty one on every call would silently
        // reset any rule an operator had configured by hand.
        await octokit.request('PUT /repos/{owner}/{repo}/environments/{environment_name}', {
          owner,
          repo,
          environment_name: name,
        });
        return Ok(undefined);
      } catch (cause: unknown) {
        return Err(fail(cause, 'secrets.ensureEnvironment'));
      }
    },

    async put(env, name: SecretName, value: Secret): Promise<Result<void, AppError>> {
      const key = await publicKeyFor(env);
      if (!key.ok) return key;

      // THE SINGLE UNWRAP. `reveal()` appears exactly once in this file - there is a test that
      // asserts it - and its result is consumed by `crypto_box_seal` in the same expression. It
      // is never bound to a name, stored, returned, logged or interpolated.
      const encryptedValue = await sealSecret(value.reveal(), key.value);

      try {
        await octokit.request('PUT /repos/{owner}/{repo}/environments/{environment_name}/secrets/{secret_name}', {
          owner,
          repo,
          environment_name: env,
          secret_name: name,
          encrypted_value: encryptedValue,
          key_id: key.value.keyId,
        });
        // The environment name is a Discord user id, which is not a secret; the VALUE is not
        // here and never will be. This line is what makes "did the bot write it?" answerable
        // without anybody reaching for the credential.
        log.info('stored a credential', { environment: env, secret: name });
        return Ok(undefined);
      } catch (cause: unknown) {
        // 404/422 are what a stale `key_id` looks like from here, so the cached key goes.
        const status = readGithubFailure(cause, clock.now()).status;
        if (status === 404 || status === 422) forgetKey(env);
        return Err(fail(cause, 'secrets.put'));
      }
    },

    async list(env): Promise<Result<EnvironmentListing, AppError>> {
      try {
        const res = await octokit.request('GET /repos/{owner}/{repo}/environments/{environment_name}/secrets', {
          owner,
          repo,
          environment_name: env,
        });
        const parsed = SecretListPayload.safeParse(res.data);
        if (!parsed.success) {
          return Err(
            errors.upstream(
              'github',
              res.status,
              'Ask an admin to check the GitHub API version pin.',
              'secrets.list: unrecognised response shape',
            ),
          );
        }
        return Ok({ exists: true, names: parsed.data.secrets.map((s) => s.name) });
      } catch (cause: unknown) {
        // A 404 IS STILL NOT BLANKET-SWALLOWED. It is SPLIT - see `absentOrFailure` and the
        // `Probe` comment above. "There is no such environment" is `exists: false`, which is the
        // ordinary answer for a user who never ran `/credentials set`; "this token cannot see
        // this repository" stays an error, because reading it as "you have stored nothing" tells
        // a user whose credential IS saved to paste it again, forever.
        return absentOrFailure({ exists: false, names: [] }, cause, 'secrets.list');
      }
    },

    async remove(env, name: SecretName): Promise<Result<boolean, AppError>> {
      try {
        await octokit.request('DELETE /repos/{owner}/{repo}/environments/{environment_name}/secrets/{secret_name}', {
          owner,
          repo,
          environment_name: env,
          secret_name: name,
        });
        log.info('removed a credential', { environment: env, secret: name });
        return Ok(true);
      } catch (cause: unknown) {
        // `false` means "there was nothing to remove" - no such secret, or no such environment.
        // It is reachable ONLY through the probe, so a 404 caused by the token losing its
        // Environments permission still reports as a failure rather than as "your credential is
        // gone" to somebody whose credential is still sitting in GitHub.
        return absentOrFailure(false, cause, 'secrets.remove');
      }
    },

    async deleteEnvironment(name): Promise<Result<boolean, AppError>> {
      try {
        await octokit.request('DELETE /repos/{owner}/{repo}/environments/{environment_name}', {
          owner,
          repo,
          environment_name: name,
        });
        // This is the "forget me" path: deleting the environment takes every secret in it with
        // it, which is the only removal that is complete rather than name-by-name.
        forgetKey(name);
        log.info('deleted an environment', { environment: name });
        return Ok(true);
      } catch (cause: unknown) {
        forgetKey(name);
        // `/credentials clear` on a user who never stored anything is a NORMAL request with a
        // normal answer, and it is also the rollback path for a half-finished `/credentials
        // set`. Neither may report "ask an admin to check the token repository access".
        return absentOrFailure(false, cause, 'secrets.deleteEnvironment');
      }
    },
  };
}
