/**
 * The pino adapter - structured NDJSON with two independent secret filters.
 *
 * POSTMORTEM THIS FILE CLOSES (SC-6): "a pino log line contained the bot token." It reached
 * the line as a nested field on an octokit error object, which is why ONE filter is not
 * enough. There are three layers here and they fail independently:
 *
 *   1. THE TYPE. `LoggerPort` takes `JsonObject`, and a `Secret` carries a method and a
 *      module-private symbol, so `logger.info('x', { token: cfg.discord.token })` is TS2322
 *      before it is anything else.
 *   2. `redact` PATHS. Anything token-shaped by NAME (`token`, `authorization`, `apiKey`,
 *      one and two levels deep) is replaced by pino's own redactor, which runs before
 *      serialisation, so the value never reaches the JSON at all.
 *   3. `hooks.streamWrite`. The finished NDJSON line is passed through `redactSecrets` from
 *      `#core/text` before it is written. This is the layer that catches a credential that
 *      arrived in the MESSAGE rather than in a field - `logger.error('gh said: ghp_...')` -
 *      which layers 1 and 2 structurally cannot see.
 *
 * WHY a correlation id is not optional: the whole product is one request crossing a message
 * hook, an interaction, a durable job and two REST APIs over half an hour. Without one field
 * that is constant across all of it, "what happened to my build?" is answered by reading
 * timestamps. `child({ correlationId })` is bound once by the router and inherited by every
 * job the request spawns.
 */

import pino from 'pino';
import type { JsonObject } from '#core/json';
import { isJsonObject } from '#core/json';
import type { ClockPort, LoggerPort, LogLevel } from '#core/ports';
import { redactSecrets } from '#core/text';

/** The field name every layer agrees on, so one grep follows a request end to end. */
export const CORRELATION_FIELD = 'correlationId';

/**
 * Paths pino redacts by name.
 *
 * WHY two wildcard depths and not a recursive matcher: `fast-redact` compiles these into a
 * straight-line function, and the fields that have actually leaked in this system live at
 * depth 0..2 (`token`, `github.token`, `err.config.headers.authorization`). Layer 3 is the
 * backstop for everything deeper, so this list buys precision, not coverage.
 */
export const DEFAULT_REDACT_PATHS: readonly string[] = [
  'token',
  '*.token',
  '*.*.token',
  'secret',
  '*.secret',
  '*.*.secret',
  'password',
  '*.password',
  'authorization',
  '*.authorization',
  '*.*.authorization',
  'apiKey',
  '*.apiKey',
  'api_key',
  '*.api_key',
  'accessToken',
  '*.accessToken',
  'refreshToken',
  '*.refreshToken',
  'clientSecret',
  '*.clientSecret',
  'privateKey',
  '*.privateKey',
  'hmacKey',
  '*.hmacKey',
  'DISCORD_TOKEN',
  '*.DISCORD_TOKEN',
  'GITHUB_TOKEN',
  '*.GITHUB_TOKEN',
  'GITHUB_APP_PRIVATE_KEY',
  '*.GITHUB_APP_PRIVATE_KEY',
  'APPROVAL_HMAC_KEY',
  '*.APPROVAL_HMAC_KEY',
];

/** What `createLogger` needs. Everything has a default except the level. */
export interface LoggerDeps {
  readonly level: LogLevel;
  /**
   * WHY the clock is injected: a log assertion against a real `Date.now()` is a snapshot test
   * that fails at midnight. With a `manualClock` the `time` field is a fixed number.
   */
  readonly clock?: ClockPort;
  /** Defaults to `process.stdout`. Tests pass an array-backed sink. */
  readonly destination?: pino.DestinationStream;
  /** Permanent root bindings, e.g. `{ service: LOG_SERVICE, bootId }` (`#core/version`). */
  readonly base?: JsonObject;
  /** Extra `redact` paths on top of `DEFAULT_REDACT_PATHS`. */
  readonly redactPaths?: readonly string[];
}

/**
 * Build the root logger.
 *
 * WHY `LoggerPort` and not pino's own `Logger`: the port takes `(msg, fields)` while pino
 * takes `(fields, msg)`. Every argument-order mistake anyone will ever make with pino is made
 * once, here, instead of once per call site - and nothing outside this file can pass pino a
 * value that is not a `JsonObject`.
 */
export function createLogger(deps: LoggerDeps): LoggerPort {
  const clock = deps.clock;
  const root = pino(
    {
      level: deps.level,
      base: deps.base === undefined ? {} : { ...deps.base },
      redact: {
        paths: [...DEFAULT_REDACT_PATHS, ...(deps.redactPaths ?? [])],
        censor: '[redacted]',
      },
      // Layer 3. Runs on the finished line, so it also covers `msg` and any field name nobody
      // thought to list. `redactSecrets` is the same matcher the untrusted-text wall uses.
      hooks: {
        streamWrite: (s: string): string => redactSecrets(s),
      },
      timestamp:
        clock === undefined
          ? pino.stdTimeFunctions.epochTime
          : (): string => `,"time":${String(clock.now())}`,
    },
    deps.destination,
  );
  return wrap(root);
}

/**
 * Bind a correlation id, once, at the top of a request.
 * WHY a named helper rather than `logger.child({ correlationId: id })` at each call site: the
 * field name has to be spelled identically everywhere or the grep that makes it useful fails.
 */
export function withCorrelation(logger: LoggerPort, correlationId: string): LoggerPort {
  return logger.child({ [CORRELATION_FIELD]: correlationId });
}

/** A logger that writes nowhere. WHY here: `stop()` paths and boot preflights need one. */
export function silentLogger(): LoggerPort {
  const noop = (_msg: string, _fields?: JsonObject): void => undefined;
  const self: LoggerPort = { debug: noop, info: noop, warn: noop, error: noop, child: () => self };
  return self;
}

/** A destination that keeps every line, for tests and for `/status`-style introspection. */
export interface MemorySink extends pino.DestinationStream {
  readonly lines: readonly string[];
  /** Parsed lines, for assertions that care about a field rather than the text. */
  records(): readonly JsonObject[];
}

export function memorySink(): MemorySink {
  const lines: string[] = [];
  return {
    lines,
    write(msg: string): void {
      lines.push(msg);
    },
    records(): readonly JsonObject[] {
      const out: JsonObject[] = [];
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.length === 0) continue;
        try {
          // `isJsonObject` is a predicate, so this narrows without a cast - the repo has
          // exactly one sanctioned `as`, and it is in the octokit dispatch adapter.
          const parsed: unknown = JSON.parse(trimmed);
          if (isJsonObject(parsed)) out.push(parsed);
        } catch {
          // A line that does not parse is itself the assertion failure the test wants to see,
          // so it is skipped here rather than throwing inside the sink.
        }
      }
      return out;
    },
  };
}

function wrap(p: pino.Logger): LoggerPort {
  return {
    debug(msg: string, fields?: JsonObject): void {
      p.debug(fields ?? {}, msg);
    },
    info(msg: string, fields?: JsonObject): void {
      p.info(fields ?? {}, msg);
    },
    warn(msg: string, fields?: JsonObject): void {
      p.warn(fields ?? {}, msg);
    },
    error(msg: string, fields?: JsonObject): void {
      p.error(fields ?? {}, msg);
    },
    child(bindings: JsonObject): LoggerPort {
      return wrap(p.child({ ...bindings }));
    },
  };
}
