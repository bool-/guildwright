/**
 * `Secret` - the carrier for a value that must never be printed.
 *
 * WHY IT MOVED OUT OF `#core/config` (which still re-exports it, so nothing downstream
 * changed): it was born there because the only secrets in the bot were the OPERATOR's own -
 * the Discord token, the GitHub PAT, the approval MAC key - and all three arrive from the
 * environment. A user's own Anthropic credential arrives through a Discord MODAL, never
 * touches `loadConfig`, and has to cross the module -> port boundary with exactly the same
 * guarantees. Leaving the carrier inside the config module would have meant `#core/text`
 * importing `#core/config` in order to mint one, which inverts the layering: `config` already
 * imports `ports`, and `ports` type-imports `text`. A leaf file with NO imports at all is what
 * lets the untrusted-text wall produce a `Secret` without any of that.
 *
 * THE FOUR GUARANTEES. Each one closes a path a credential has actually escaped through:
 *
 *  1. `toJSON()` returns `[redacted]`. This is the load-bearing one: pino serialises with
 *     `JSON.stringify`, so this is the hook that actually fires on a log line.
 *  2. `toString()` returns `[redacted]`, which covers `${cfg.discord.token}` and every other
 *     template-literal interpolation.
 *  3. It carries a module-private `unique symbol` AND methods, so it is not assignable to
 *     `JsonValue`. An audit `detail`, a durable job payload, a `core_docs` row and a
 *     `LoggerPort` field are all typed `JsonObject`, so putting a credential in one of them is
 *     TS2322 at the call site rather than a leak somebody has to spot in review.
 *  4. `reveal()` is the SINGLE unwrap, and it is deliberately unmissable in a grep. One
 *     `grep -rn 'reveal()'` enumerates every place in the repo where a credential becomes a
 *     plain string.
 *
 * WHY NOT A BRANDED STRING: an intersection with `string` IS a `string`, so it prints, it
 * interpolates, and it is assignable to `JsonValue`. Every guarantee above would be a comment.
 */

const SECRET = Symbol('core.secret');

/** A value that must never be printed. See the file header for the four guarantees. */
export interface Secret {
  readonly [SECRET]: true;
  /** pino serialises with JSON.stringify; this is the hook that actually fires. */
  toJSON(): string;
  /** Covers template-literal interpolation. */
  toString(): string;
  /** The single greppable unwrap. One grep audits every use of a credential. */
  reveal(): string;
}

/**
 * Wrap a credential.
 *
 * Callers are `loadConfig` (operator secrets from the environment), `toSecret` in
 * `#core/text` (a user's own credential arriving from a modal), and tests.
 */
export function secret(value: string): Secret {
  return {
    [SECRET]: true,
    toJSON: () => '[redacted]',
    toString: () => '[redacted]',
    reveal: () => value,
  };
}
