/**
 * In-memory fakes for every port.
 *
 * WHY they are trivial to write: that IS the argument for the hexagonal ports. If a fake were
 * hard, the domain would not really be testable and `npm run dev:offline` would be a fiction.
 * Nothing here imports discord.js, octokit or node:sqlite.
 */

import { Ok, type Result } from '#core/result';
import type { AppError } from '#core/errors';
import type { JsonObject } from '#core/json';
import type { AuditEntry, AuditPort, AuditRecord } from '#core/ports/audit';
import type { DbPort, DocRecord, WriteResult } from '#core/ports/db';
import { ident, renderSql, type SqlQuery } from '#core/sql';
import { createHash } from 'node:crypto';
import type {
  AccessPort,
  AdminPort,
  BuildCredentialName,
  BuildInfo,
  BuildsPort,
  CatalogPort,
  ClockPort,
  DiscordPort,
  GithubAuthSummary,
  IssuesPort,
  JobRequest,
  JobsPort,
  JobStats,
  LoggerPort,
  PortRegistry,
  RunReport,
  LogLevel,
  SecretName,
  SecretsPort,
  SettingsPort,
  VersionPort,
} from '#core/ports';
import { UNKNOWN_BUILD, UNKNOWN_GITHUB_AUTH, isRepositoryVariableName, toRepositoryVariable } from '#core/ports';
import { errors } from '#core/errors';
import type { Secret } from '#core/secret';
import type { ChannelId, JobId } from '#core/ids';
import type { SurfaceRef, View } from '#core/view';
import { SHARED_BUILD_ENVIRONMENT, actionsToken, parseHttpsUrl, renderIssueBody, renderPlainName } from '#core/text';
import { Err } from '#core/result';

/** WHY the fake records statements: the ownership test asserts on the exact text. */
export interface FakeDb extends DbPort {
  readonly statements: readonly string[];
  /**
   * Queue outcomes for the next `execute()` calls.
   *
   * WHY THIS EXISTS: `execute` used to return `{ changes: 1 }` unconditionally, so the LOSING
   * arm of a compare-and-set was unreachable in any test that used a fake. That is precisely
   * the arm that stops a double-clicked Approve from dispatching two builds - the single most
   * expensive bug this system can have - so it was the one behaviour the fakes could not
   * express. Queue a `{ changes: 0 }` to exercise it.
   */
  queueExecute(...results: readonly WriteResult[]): void;
}

export function fakeDb(prefix: string): FakeDb {
  const statements: string[] = [];
  const docs = new Map<string, DocRecord>();
  const queued: WriteResult[] = [];
  return {
    queueExecute(...results: readonly WriteResult[]): void {
      queued.push(...results);
    },
    tablePrefix: prefix,
    statements,
    table: (name) => ident(`${prefix}${name}`),
    column: (name) => ident(name),
    query<T>(q: SqlQuery): readonly T[] {
      statements.push(renderSql(q).text);
      return [];
    },
    queryOne<T>(q: SqlQuery): T | undefined {
      statements.push(renderSql(q).text);
      return undefined;
    },
    execute(q: SqlQuery): WriteResult {
      statements.push(renderSql(q).text);
      // Default is the winning arm; a test opts into losing by queueing one.
      return queued.shift() ?? { changes: 1, lastInsertRowid: 1 };
    },
    transaction<T>(fn: () => T): T {
      return fn();
    },
    docs: {
      get: (c, k) => docs.get(`${c}/${k}`),
      put: (c, k, json, expectedVersion) => {
        const cur = docs.get(`${c}/${k}`);
        if ((cur?.version ?? 0) !== expectedVersion) return false;
        docs.set(`${c}/${k}`, { json, version: expectedVersion + 1, updatedAt: 0 });
        return true;
      },
      del: (c, k) => docs.delete(`${c}/${k}`),
      list: (c, n) =>
        [...docs.entries()]
          .filter(([k]) => k.startsWith(`${c}/`))
          .slice(0, n)
          .map(([k, v]) => ({ key: k, json: v.json })),
    },
  };
}

/** WHY the audit fake keeps entries: tests assert that `detail` never carries a `UserText`. */
export interface FakeAudit extends AuditPort {
  readonly entries: readonly AuditEntry[];
}

export function fakeAudit(): FakeAudit {
  const entries: AuditEntry[] = [];
  return { entries, record: (e) => void entries.push(e) };
}

/** WHY `now` is settable: TTL and monotonic-id behaviour is otherwise untestable. */
export function fakeClock(start = 1_700_000_000_000): ClockPort & { set(ms: number): void } {
  let t = start;
  return {
    now: () => t,
    monotonicNs: () => BigInt(t) * 1_000_000n,
    set: (ms) => {
      t = ms;
    },
  };
}

export function fakeLogger(): LoggerPort {
  const noop = (_msg: string, _fields?: JsonObject): void => undefined;
  const self: LoggerPort = {
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    child: () => self,
  };
  return self;
}

export function fakeCatalog(): CatalogPort {
  return {
    modules: () => [],
    commands: () => [],
    permissions: () => [],
    health: async () => [],
  };
}

/** WHY a partial bag: `portsFor` narrows it, and a missing declared port is a boot failure. */
export function fakePorts(prefix: string): Readonly<Partial<PortRegistry>> {
  // EVERY capability, so a module declaring the full set installs instead of being quarantined.
  return {
    db: fakeDb(prefix),
    audit: fakeAudit(),
    clock: fakeClock(),
    catalog: fakeCatalog(),
    jobs: fakeJobs(),
    discord: fakeDiscord(),
    issues: fakeIssues(),
    builds: fakeBuilds(),
    settings: fakeSettings(),
    access: fakeAccess(),
    secrets: fakeSecrets(),
    admin: fakeAdmin(),
    version: fakeVersion(),
  };
}

/**
 * The observability port, with SEEDABLE contents.
 *
 * WHY `seedAudit` exists rather than a bare empty reader: an operator command that renders audit
 * rows has to be tested against rows, and the only alternative is standing up a real database in
 * a test whose subject is a card layout. The rows are held newest-LAST here and reversed on the
 * way out, because that is the order a caller naturally seeds them in and the order the real
 * adapter returns them in is the opposite - a fake that got that backwards would let a module
 * render its history upside down and still pass.
 */
export interface FakeAdmin extends AdminPort {
  /** Append a row, oldest first. `recentAudit` returns them newest first, as the adapter does. */
  seedAudit(record: AuditRecord): void;
  /** Replace what `jobStats()` reports. */
  setJobStats(stats: JobStats): void;
  /** Every `(guildId, limit)` pair asked for, so scoping can be asserted. */
  readonly queries: readonly { readonly guildId: string | null; readonly limit: number }[];
}

/**
 * NOTHING RUNNING, and `oldestRunning: null` written out rather than left off.
 *
 * The field is optional on `JobStats` for one release (see its comment there), so omitting it
 * here would be legal - and would mean every renderer tested against this fake had only ever
 * seen the ABSENT case, never the `null` one, while production only ever produces `null`.
 */
const NO_JOBS: JobStats = { queued: 0, running: 0, done: 0, dead: 0, cancelled: 0, orphaned: 0, oldestRunning: null };

export function fakeAdmin(): FakeAdmin {
  const rows: AuditRecord[] = [];
  const queries: { guildId: string | null; limit: number }[] = [];
  let stats: JobStats = NO_JOBS;
  return {
    queries,
    seedAudit(record) {
      rows.push(record);
    },
    setJobStats(next) {
      stats = next;
    },
    recentAudit(guildId, limit) {
      queries.push({ guildId, limit });
      // The guild filter is MODELLED, not skipped: "this command leaked another server's audit
      // rows into this channel" is the failure the `guildId` argument exists to prevent, and a
      // fake that ignored it would make that bug pass.
      const scoped = guildId === null ? rows : rows.filter((r) => r.guildId === guildId);
      return [...scoped].reverse().slice(0, Math.max(0, limit));
    },
    jobStats() {
      return stats;
    },
  };
}

/**
 * The build identity, fixed.
 *
 * DEFAULTS TO `UNKNOWN_BUILD` rather than to a realistic-looking version, so a renderer that
 * only ever ran against this fake has been exercised on the `gitSha === null` path - which is
 * the path a containerised deploy actually takes.
 */
export function fakeVersion(info: BuildInfo = UNKNOWN_BUILD, github: GithubAuthSummary = UNKNOWN_GITHUB_AUTH): VersionPort {
  return { current: () => info, githubAuth: () => github };
}

/** WHY exported: the ownership test needs an `AppError`-shaped assertion helper. */
export function isForbidden(r: Result<void, AppError>): boolean {
  return !r.ok && r.error.kind === 'forbidden';
}

/** WHY: keeps the fakes honest against the `Result` contract without importing `node:assert`. */
export const alwaysOk: Result<void, AppError> = Ok(undefined);

// ---------------------------------------------------------------------------------------
// The remaining ports.
//
// WHY THEY EXIST: `fakePorts` used to supply only db/audit/clock/catalog, so any module
// declaring `jobs`, `discord`, `issues` or `builds` — which is the flagship — was QUARANTINED
// in every test that used it. `installModules` treats a quarantine as SUCCESS (one bad module
// must not stop the bot), so `registry.boot.test.ts` passed while the module it was meant to
// prove could not install at all. A fake registry that cannot represent the real bot is a
// registry that proves nothing.
// ---------------------------------------------------------------------------------------

/** Records what a module tried to enqueue, so a handoff can be asserted on. */
export interface FakeJobs extends JobsPort {
  readonly enqueued: readonly JobRequest[];
}

export function fakeJobs(): FakeJobs {
  const enqueued: JobRequest[] = [];
  let n = 0;
  return {
    enqueued,
    enqueue(req) {
      enqueued.push(req);
      n += 1;
      return Ok({ id: `job-${n}` as JobId, created: true });
    },
    cancel() {
      return Ok(true);
    },
    findByDedupeKey(key) {
      return enqueued.some((j) => j.dedupeKey === key) ? ('job-1' as JobId) : undefined;
    },
  };
}

/** Records every view it was asked to render, which is how a card's content is asserted. */
export interface FakeDiscord extends DiscordPort {
  readonly posted: readonly { readonly channelId: string; readonly view: View }[];
  readonly edited: readonly { readonly ref: SurfaceRef; readonly view: View }[];
  readonly deleted: readonly SurfaceRef[];
  /** Every card drawn, posted or edited, in order - an ending may arrive either way. */
  readonly drawn: readonly View[];
}

export function fakeDiscord(): FakeDiscord {
  const posted: { channelId: string; view: View }[] = [];
  const edited: { ref: SurfaceRef; view: View }[] = [];
  const deleted: SurfaceRef[] = [];
  const drawn: View[] = [];
  let messageId = 0;
  return {
    posted,
    edited,
    deleted,
    drawn,
    async post(channelId, view) {
      posted.push({ channelId, view });
      drawn.push(view);
      messageId += 1;
      return Ok({ guildId: 'g', channelId, messageId: String(messageId) });
    },
    async edit(ref, view) {
      edited.push({ ref, view });
      drawn.push(view);
      return Ok(ref);
    },
    async disableComponents() {
      return Ok(undefined);
    },
    async delete(ref) {
      deleted.push(ref);
      return Ok(undefined);
    },
    async openThread(_ref, _name) {
      return Ok('thread-1' as ChannelId);
    },
    missingFromAppPermissions() {
      return [];
    },
    async botPermissionsIn() {
      return Ok(0n);
    },
    async memberRoles() {
      return Ok([]);
    },
  };
}

/** Issues that never leave memory. `bodySha256` is real, so the approval MAC can be exercised. */
export interface FakeIssues extends IssuesPort {
  readonly created: readonly { readonly title: string; readonly body: string; readonly labels: readonly string[] }[];
  /** Every `close` call, in order. A CALL LOG, not the state - see `isOpen`. */
  readonly closed: readonly number[];
  /** Every `reopen` call, in order. Likewise a call log. */
  readonly reopened: readonly number[];
  /**
   * Whether an issue is open RIGHT NOW.
   *
   * WHY IT EXISTS ALONGSIDE THE TWO CALL LOGS: the question `/request retry` has to answer is
   * "is an approver being asked to approve against a closed issue?", and that is a question
   * about the issue's STATE. A test that asserted on `closed` alone would pass for a retry path
   * that closes and never reopens (`closed: [7]`) and for one that closes then reopens
   * (`closed: [7]`, and the issue is open) - the same evidence for the bug and for the fix.
   */
  isOpen(issueNumber: number): boolean;
}

export function fakeIssues(): FakeIssues {
  const created: { title: string; body: string; labels: readonly string[] }[] = [];
  const closed: number[] = [];
  const reopened: number[] = [];
  // Modelled, not inferred from the call logs: an issue is open until it is closed, and open
  // again after a reopen. This is the fact a retry path is actually judged on.
  const open = new Map<number, boolean>();
  return {
    created,
    closed,
    reopened,
    isOpen(issueNumber) {
      return open.get(issueNumber) ?? false;
    },
    async create(input) {
      const body = renderIssueBody(input.body);
      created.push({ title: renderPlainName(input.title), body, labels: input.labels });
      const number = created.length;
      open.set(number, true);
      const url = parseHttpsUrl(`https://github.com/o/r/issues/${number}`);
      return url.ok
        ? Ok({ number, url: url.value, bodySha256: createHash('sha256').update(body, 'utf8').digest('hex') })
        : Err(url.error);
    },
    async comment() {
      return Ok(undefined);
    },
    async addLabel() {
      return Ok(undefined);
    },
    async bodySha256(n) {
      const row = created[n - 1];
      return Ok(row === undefined ? '' : createHash('sha256').update(row.body, 'utf8').digest('hex'));
    },
    async close(n) {
      closed.push(n);
      open.set(n, false);
      return Ok(undefined);
    },
    /**
     * IDEMPOTENT, exactly like the adapter: GitHub answers 200 for an issue that is already
     * open. A fake that refused, or that only worked on an issue it had seen closed, would make
     * a second `/request retry` fail here and nowhere else.
     */
    async reopen(n) {
      reopened.push(n);
      open.set(n, true);
      return Ok(undefined);
    },
  };
}

/** Dispatches nothing. Records what WOULD have been dispatched — that is the assertion. */
export interface FakeBuilds extends BuildsPort {
  readonly dispatched: readonly Readonly<Record<string, unknown>>[];
  /** What the tuple the approval MAC covered actually was, in order. */
  readonly signed: readonly Readonly<Record<string, unknown>>[];
  /**
   * Which environments hold which paying secrets. Seed it to model bring-your-own-credentials.
   * A name that is absent reports `exists: false`, which is what "this user never configured
   * anything" looks like to the builder.
   */
  readonly environments: Map<string, readonly BuildCredentialName[]>;
  /**
   * What `runsSince` reports: how many agent runs the repository has already spent in the
   * current window.
   *
   * MUTABLE, and that is the point. The interesting arm of the daily cap is "today's runs are
   * gone", and it cannot be reached from a port that always answers zero. Assign it
   * (`builds.runsToday = 4`) to model a repository at its cap; leave it alone and every test
   * that does not care about spend sees an untouched window.
   */
  runsToday: number;
  /** Every run id `cancelRun` was asked to stop, in order. */
  readonly cancelled: readonly number[];
  /**
   * Run ids GitHub would answer 409 for: the run is over, so there is nothing left to cancel.
   *
   * MUTABLE, and for the same reason `runsToday` is. `already-finished` is the arm that says
   * "the money was already spent", and a fake that always answered `requested` would make a
   * card claiming "cancelled, nothing was spent" pass while being wrong every time somebody
   * clicks a second after their build finished. Add an id (`builds.finishedRuns.add(1)`) to
   * model that race.
   */
  readonly finishedRuns: Set<number>;
  /**
   * Repository Actions variables, by name, holding the RAW string GitHub would return.
   *
   * RAW rather than parsed on purpose: the interesting cases are `'4'` (agrees with the bot),
   * `'8'` (drifted) and `' 4 '` or `'four'` (set to something the workflow's own guard kills
   * every build over). A map of numbers could not express the third, which is the one nobody
   * finds out about until a build dies in its first seconds.
   *
   * EMPTY BY DEFAULT, which models the ordinary install: nobody has created
   * `AGENT_DAILY_RUN_CAP`, so the workflow's built-in default applies and the port answers
   * `unset`. Seeding one is how a test opts into the drift it means to check.
   */
  readonly variables: Map<string, string>;
  /** What `findRunReport` answers. Null by default: a workflow that posted no report. */
  report: RunReport | null;
}

export function fakeBuilds(): FakeBuilds {
  const dispatched: Readonly<Record<string, unknown>>[] = [];
  const signed: Readonly<Record<string, unknown>>[] = [];
  const cancelled: number[] = [];
  const finishedRuns = new Set<number>();
  const variables = new Map<string, string>();
  // The DEFAULT models the ordinary install: the operator funds builds and nobody has brought
  // their own key. Deliberately not "every environment has a credential" — that default would
  // make a test pass whether or not the per-user selection worked.
  const environments = new Map<string, readonly BuildCredentialName[]>([
    [SHARED_BUILD_ENVIRONMENT, ['ANTHROPIC_API_KEY']],
  ]);
  // BOUND TO A LOCAL rather than returned as a bare literal, because `runsSince` has to read
  // the field as it is AT CALL TIME - a test seeds `builds.runsToday` after construction, and a
  // closure over the initial value would report zero forever while looking correct.
  const builds: FakeBuilds = {
    dispatched,
    signed,
    environments,
    cancelled,
    finishedRuns,
    variables,
    runsToday: 0,
    report: null,
    async dispatch(req) {
      dispatched.push({ ...req.inputs });
      const runUrl = parseHttpsUrl('https://github.com/o/r/actions/runs/1');
      // No cast: RunRef wants an HttpsUrl, and parseHttpsUrl is the door to one. Reaching for
      // `as never` here is what the conventions test caught, correctly, on my own code.
      return runUrl.ok ? Ok({ kind: 'adopted', run: { runId: 1, runUrl: runUrl.value } }) : Err(runUrl.error);
    },
    async findRunByName() {
      return Ok(null);
    },
    async runsSince() {
      // ZERO models an untouched cap window, which is the state every test that does not care
      // about the cap wants. A test that DOES care assigns `builds.runsToday`, so the
      // interesting arm - "the cap is spent" - is always written out explicitly rather than
      // being whatever the default happened to be.
      return Ok(builds.runsToday);
    },
    async runStatus() {
      // `runUrl` is required on every arm of `RunStatus` — see the type's own comment for why
      // the non-terminal arms carry it too. `null` models the ordinary case for a fake: no
      // link, so a card that renders one has to handle its absence.
      return Ok({ kind: 'in-progress', runUrl: null });
    },
    async findRunReport() {
      return Ok(builds.report);
    },
    async findPrForBranch() {
      return Ok(null);
    },
    /**
     * Both arms are reachable, which is the entire point of `finishedRuns`.
     *
     * The DEFAULT is `requested` - the ordinary cancel of a live run. A test that cares about
     * the race seeds the id, and gets `already-finished`: the outcome that means the spend
     * happened anyway.
     */
    async cancelRun(runId) {
      cancelled.push(runId);
      return Ok(finishedRuns.has(runId) ? { kind: 'already-finished' } : { kind: 'requested' });
    },
    /**
     * The three arms of `RepositoryVariable`, from one seeded string.
     *
     * The name is REFUSED here exactly as the adapter refuses it, offline and without recording
     * a lookup: a fake that accepted a name GitHub would 404 on lets a module ship a lookup
     * that works in every test and never once in production.
     */
    async repositoryVariable(name) {
      if (!isRepositoryVariableName(name)) {
        return Err(
          errors.validation(
            'name',
            'That is not a repository variable name.',
            'Report this to an admin; the bot asked GitHub about a variable it could not have named.',
          ),
        );
      }
      const raw = variables.get(name);
      // `unset` is NOT an error and NOT a zero: the workflow's own literal default applies.
      return Ok(raw === undefined ? { kind: 'unset', name } : toRepositoryVariable(name, raw));
    },
    async environmentCredentials(environmentName) {
      const found = environments.get(environmentName);
      return Ok({
        environmentName,
        exists: found !== undefined,
        credentials: found ?? [],
      });
    },
    signApproval(sign) {
      signed.push({ ...sign });
      return actionsToken.sha('a'.repeat(64));
    },
  };
  return builds;
}

/** Per-guild settings in a Map. */
export function fakeSettings(): SettingsPort {
  const store = new Map<string, JsonObject>();
  const k = (g: string, key: string): string => `${g}:${key}`;
  return {
    get: (g, key) => store.get(k(g, key)),
    set: (g, key, value) => void store.set(k(g, key), value),
    all: (g) => {
      const out: Record<string, JsonObject> = {};
      for (const [key, value] of store) if (key.startsWith(`${g}:`)) out[key.slice(g.length + 1)] = value;
      return out;
    },
  };
}

/**
 * Credential storage, recording NAMES (and, for assertions, the `Secret` carrier it was handed).
 *
 * IT MODELS EXISTENCE SEPARATELY FROM CONTENT, because the real port does and because that
 * distinction is the entire subject of two shipped defects: an environment that EXISTS AND IS
 * EMPTY blocks its owner's builds, while an environment that does not exist falls back to the
 * operator's. A fake with one `Map<env, names>` cannot tell those apart, so a module that
 * confused them would pass against it - which is how "clear always says removed" and "a failed
 * set strands the user" both survived a green suite.
 *
 * `environments` is therefore the set that EXISTS, and `names` only ever holds entries for
 * environments in it.
 */
export interface FakeSecrets extends SecretsPort {
  /** Environments that exist right now, in creation order. */
  readonly environments: readonly string[];
  readonly written: readonly string[];
  readonly writes: readonly { readonly env: string; readonly name: SecretName; readonly credential: Secret }[];
  /** Environments handed to `deleteEnvironment` that actually existed. */
  readonly cleared: readonly string[];
  /** Create the environment and put a name in it - the state after a successful `set`. */
  seed(env: string, name: SecretName): void;
  /** Create an EMPTY environment: the stranding state a failed `put` used to leave behind. */
  seedEmptyEnvironment(env: string): void;
  /** Fail whichever call comes next, whatever it is. */
  failNext(error: AppError): void;
  /**
   * Fail the next call to ONE named method, leaving the others working.
   *
   * WHY IT EXISTS: `set` is now a sequence - `ensureEnvironment`, `put`, and on failure a
   * `list`/`deleteEnvironment` rollback - so a positional `failNext` can only ever reach the
   * first of them. The interesting failure is a `put` that fails AFTER the environment was
   * created, because that is the one that used to strand the user, and it is unreachable
   * without this.
   */
  failOnce(method: keyof SecretsPort, error: AppError): void;
}

export function fakeSecrets(): FakeSecrets {
  const environments: string[] = [];
  const names = new Map<string, Set<SecretName>>();
  const written: string[] = [];
  const writes: { env: string; name: SecretName; credential: Secret }[] = [];
  const cleared: string[] = [];
  const failures: AppError[] = [];
  const targeted = new Map<keyof SecretsPort, AppError[]>();
  /** A method-targeted failure wins over the positional queue, so the two can be mixed. */
  const nextFailure = (method: keyof SecretsPort): AppError | undefined =>
    targeted.get(method)?.shift() ?? failures.shift();
  const create = (env: string): void => {
    if (!environments.includes(env)) environments.push(env);
  };
  const destroy = (env: string): void => {
    const at = environments.indexOf(env);
    if (at >= 0) environments.splice(at, 1);
  };
  return {
    environments,
    written,
    writes,
    cleared,
    seed(env, name) {
      create(env);
      const set = names.get(env) ?? new Set<SecretName>();
      set.add(name);
      names.set(env, set);
    },
    seedEmptyEnvironment(env) {
      create(env);
      names.delete(env);
    },
    failNext(error) {
      failures.push(error);
    },
    failOnce(method, error) {
      const queue = targeted.get(method) ?? [];
      queue.push(error);
      targeted.set(method, queue);
    },
    ensureEnvironment: async (env) => {
      const failure = nextFailure('ensureEnvironment');
      if (failure !== undefined) return Err(failure);
      create(env);
      return Ok(undefined);
    },
    put: async (env, name, value) => {
      const failure = nextFailure('put');
      if (failure !== undefined) return Err(failure);
      create(env);
      const set = names.get(env) ?? new Set<SecretName>();
      set.add(name);
      names.set(env, set);
      written.push(`${env}/${name}`);
      writes.push({ env, name, credential: value });
      return Ok(undefined);
    },
    list: async (env) => {
      const failure = nextFailure('list');
      if (failure !== undefined) return Err(failure);
      // `exists: false` with an empty `names` - never an error. The real adapter reaches the
      // same answer by probing; a fake that returned an error here would make "status works for
      // a user who has stored nothing" untestable, which is how it shipped broken.
      if (!environments.includes(env)) return Ok({ exists: false, names: [] });
      return Ok({ exists: true, names: [...(names.get(env) ?? [])] });
    },
    remove: async (env, name) => {
      const failure = nextFailure('remove');
      if (failure !== undefined) return Err(failure);
      return Ok(names.get(env)?.delete(name) ?? false);
    },
    deleteEnvironment: async (env) => {
      const failure = nextFailure('deleteEnvironment');
      if (failure !== undefined) return Err(failure);
      const existed = environments.includes(env);
      if (existed) cleared.push(env);
      destroy(env);
      names.delete(env);
      return Ok(existed);
    },
  };
}

/** One captured log line. */
export interface FakeLogLine {
  readonly level: LogLevel;
  readonly msg: string;
  readonly fields: JsonObject;
}

/** A logger that REMEMBERS, so "the credential never reaches a log line" is assertable. */
export interface FakeRecordingLogger extends LoggerPort {
  readonly lines: readonly FakeLogLine[];
  text(): string;
}

export function fakeRecordingLogger(): FakeRecordingLogger {
  const lines: FakeLogLine[] = [];
  const at = (level: LogLevel) => (msg: string, fields?: JsonObject): void => {
    lines.push({ level, msg, fields: fields ?? {} });
  };
  const self: FakeRecordingLogger = {
    lines,
    debug: at('debug'),
    info: at('info'),
    warn: at('warn'),
    error: at('error'),
    child: (bindings: JsonObject) => {
      lines.push({ level: 'debug', msg: 'child', fields: bindings });
      return self;
    },
    text: () => lines.map((l) => `${l.level} ${l.msg} ${JSON.stringify(l.fields)}`).join(' | '),
  };
  return self;
}

/** Allows everything. Authorization is tested against the REAL adapter, never against this. */
export function fakeAccess(): AccessPort {
  return {
    check: () => ({ allowed: true, layer: 'L1-allowlist' }),
    grant: () => Ok(undefined),
    revoke: () => Ok(true),
    // The by-key doors exist so `/access` can name another module's permission without being
    // able to mint its ref. THE REFUSAL OF AN UNKNOWN KEY IS THE POINT OF THEM, and this fake
    // does not model it — like `grant`/`revoke` above it says yes to everything, so a test
    // that means to prove a key is refused must use the real adapter (`createAccess`).
    grantByKey: () => Ok(undefined),
    revokeByKey: () => Ok(true),
    list: () => [],
  };
}

/**
 * A DELIBERATELY INCOMPLETE ports bag.
 *
 * WHY it exists: `fakePorts` now supplies every capability, which is what makes
 * "the bot would boot" testable. But some tests need the opposite — proving that a module
 * declaring a capability the composition root did NOT wire fails at boot, naming it. Those
 * tests must state the restriction explicitly rather than relying on `fakePorts` happening to
 * be short, which is exactly how the boot test came to pass while the flagship was quarantined.
 */
export function fakePortsOnly(
  prefix: string,
  caps: readonly (keyof PortRegistry)[],
): Readonly<Partial<PortRegistry>> {
  const all = fakePorts(prefix) as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const c of caps) if (all[c] !== undefined) out[c] = all[c];
  return out as Readonly<Partial<PortRegistry>>;
}
