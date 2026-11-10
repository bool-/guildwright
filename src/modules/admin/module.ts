/**
 * `/admin`, part 3: the wiring. Zero core files are edited by this module.
 *
 * THE ONE LINE THAT IS THE WHOLE REVIEW is `capabilities: ['admin', 'catalog']`. Read the
 * absence: no `db`, so it cannot touch a table — not even its own, and it has none; no
 * `discord`, so it cannot post anywhere except as a reply to the person who asked; no `issues`,
 * `builds` or `secrets`, so it cannot spend a cent or see a credential; no `access`, so the
 * module that displays authorization decisions cannot make one; no `jobs`, so it can count the
 * queue and not touch it; no `clock`, because relative ages come from `inv.at`. `AdminPort`
 * itself has no write method at all. This module can only LOOK.
 *
 * THE CAPABILITY LINE DID NOT GROW THIS ROUND, and that is worth saying out loud, because two
 * of the three things added to it look like they would need it to. Paging and filtering the
 * audit trail is arithmetic over rows the port already returns. Reporting how long the oldest
 * job has been running is a number the port now hands over — and this module asks for it as a
 * DURATION rather than a start instant precisely so that answering "is it stuck?" does not
 * require a clock. See `readOldestRunning` in `domain.ts`.
 *
 * AND THE SECOND LINE IS `permissions.view.fallback`. `guild-admin`, deliberately:
 *
 *   - not `everyone`, because the audit trail is a list of who was denied what, and the job
 *     queue is a picture of what the bot is failing at. Neither is channel content.
 *   - not `nobody`, because a `nobody` fallback on a DIAGNOSTIC is the worst place for one. The
 *     command exists for the moment something is already wrong, and needing `/access grant`
 *     first — which itself needs somebody who can run it — is a bootstrap you discover during
 *     the incident.
 *   - and in a DM `guild-admin` denies EVERYONE (`src/adapters/system/access.ts` returns a deny
 *     for `guild-admin` when `guildId` is null) so the whole-bot view that a DM produces is
 *     reachable only through the application owner's L0 bypass. `module.test.ts` asserts that
 *     against the real access adapter rather than trusting this paragraph.
 *
 * WHY `health()` READS THE JOB TABLE. `/status` said `ok` while a build hung, because no
 * module's health check looked at the queue: the builder reports on its own rows, and nothing
 * reported on the runner. A dead-lettered job is the single clearest machine-checkable sign
 * that something needed a human, so it degrades `/status` here. It is a local `GROUP BY` — no
 * network, no GitHub quota, no Anthropic quota. `src/modules/credentials/module.ts` reasoned
 * that a health check spending the same quota as the feature can take the feature down during
 * exactly the incident that made someone run it; that reasoning bans a probe, not a local read,
 * and this is the local read.
 *
 * WHAT `health()` CAN NEWLY SAY, and it is the point of this round: a job that has been RUNNING
 * past `stuckAfterMs` degrades too. `/status` used to report `1 running` in the same words for a
 * healthy queue and for one wedged since Tuesday, because a count is all it had. `jobs(null)` is
 * passed no clock reading on purpose — the age arrives from the port as a duration, so this path
 * needs none, and a start-instant-only port simply leaves the verdict unmade rather than guessed.
 */

import { z } from 'zod';
import { defineModule } from '#core/module';
import type { AuditRecord, RunningJob } from '#core/ports';
import {
  AdminService,
  DEFAULT_AUDIT_ROWS,
  DEFAULT_STUCK_AFTER_MS,
  MAX_AUDIT_ROWS,
  MAX_AUDIT_SCAN,
  NO_FILTER,
  type AuditPage,
  type JobsSnapshot,
} from '#modules/admin/domain';
import { adminCommands, formatDuration, present } from '#modules/admin/present';

/** A fixed instant for the previews, so a boot-time card is deterministic. */
const PREVIEW_NOW = 1_700_000_000_000;

/**
 * The rows a real install produces, rendered at BOOT through the real component compiler.
 *
 * All four authorization layers appear on purpose: `L0-owner` is the bypass, `L1-allowlist` an
 * explicit grant, `L2-fallback` the declaring module's default, `L3-deny` a refusal. That column
 * is the reason this command exists, and a preview that only ever showed one value would not
 * prove the column renders.
 *
 * `moduleId` VARIES ACROSS THESE ROWS FOR THE SAME REASON. It is the column added this round,
 * and it is only worth having because it can differ from the `action` prefix beside it.
 */
const SAMPLE_ROWS: readonly AuditRecord[] = [
  {
    id: 4,
    atMs: PREVIEW_NOW - 42_000,
    moduleId: 'builder',
    action: 'builder.approve',
    actorId: '200000000000000001',
    guildId: '100000000000000001',
    decisionLayer: 'L1-allowlist',
    detail: { requestId: 'rq_01H8', issue: 41, environment: 'user-200000000000000002' },
  },
  {
    id: 3,
    atMs: PREVIEW_NOW - 900_000,
    moduleId: 'builder',
    action: 'builder.approve_denied',
    actorId: '200000000000000003',
    guildId: '100000000000000001',
    decisionLayer: 'L3-deny',
    detail: { requestId: 'rq_01H8', reason: 'self_approval' },
  },
  {
    id: 2,
    atMs: PREVIEW_NOW - 7_200_000,
    moduleId: 'access',
    action: 'access.grant',
    actorId: '200000000000000001',
    guildId: '100000000000000001',
    decisionLayer: 'L2-fallback',
    detail: { permKey: 'builder.approve', subject: 'role:300000000000000001' },
  },
  {
    id: 1,
    atMs: PREVIEW_NOW - 300_000_000,
    moduleId: 'credentials',
    action: 'credentials.set',
    actorId: '200000000000000002',
    guildId: null,
    decisionLayer: 'L0-owner',
    detail: { name: 'CLAUDE_CODE_OAUTH_TOKEN', superseded: 'ANTHROPIC_API_KEY' },
  },
];

/** Everything a page carries that is not the rows themselves, at its quietest. */
function previewPage(over: Partial<AuditPage>): AuditPage {
  return {
    guildId: '100000000000000001',
    rows: SAMPLE_ROWS,
    page: 1,
    pageSize: 10,
    filter: NO_FILTER,
    scanRequested: 11,
    scanReturned: SAMPLE_ROWS.length,
    windowFull: false,
    matched: SAMPLE_ROWS.length,
    matchedIsTotal: true,
    hasMore: false,
    oldestScannedAtMs: PREVIEW_NOW - 300_000_000,
    presentActions: ['access.grant', 'builder.approve', 'builder.approve_denied', 'credentials.set'],
    ...over,
  };
}

/**
 * One running job, as the PORT reports it, for the preview snapshots.
 *
 * The previews are `JobsSnapshot` literals, whose `stats` is a real `JobStats` - so the port's
 * `RunningJob` and the snapshot's derived `{ name, ageMs }` both have to be written out and
 * they have to agree. This builds the port half from the same two values, so a preview cannot
 * show a card claiming one job while its own stats name another.
 */
function previewRunning(name: string, ageMs: number): RunningJob {
  const [moduleId = name, type = ''] = name.split(':');
  return { moduleId, type, startedAtMs: PREVIEW_NOW - ageMs, ageMs };
}

/** The three shapes of the jobs card that matter: quiet, wedged, and needing a human. */
const HEALTHY: JobsSnapshot = {
  stats: { queued: 1, running: 1, done: 214, dead: 0, cancelled: 3, orphaned: 0, oldestRunning: previewRunning('builder:poll', 4_000) },
  total: 219,
  oldestRunning: { name: 'builder:poll', ageMs: 4_000 },
  stuckAfterMs: DEFAULT_STUCK_AFTER_MS,
  longRunning: false,
  needsAttention: false,
  quarantined: [],
};

const WEDGED: JobsSnapshot = {
  stats: { queued: 4, running: 1, done: 88, dead: 0, cancelled: 0, orphaned: 0, oldestRunning: previewRunning('builder:poll', 297_000_000) },
  total: 93,
  oldestRunning: { name: 'builder:poll', ageMs: 297_000_000 },
  stuckAfterMs: DEFAULT_STUCK_AFTER_MS,
  longRunning: true,
  needsAttention: true,
  quarantined: [],
};

const STUCK: JobsSnapshot = {
  // `running: 2` with NO oldest job: the state a pre-0002 database really produces, where every
  // running row was claimed before `started_at_ms` existed. The card must render the counts and
  // say plainly that it cannot judge them, rather than implying nothing is stuck.
  stats: { queued: 6, running: 2, done: 88, dead: 3, cancelled: 0, orphaned: 4, oldestRunning: null },
  total: 103,
  oldestRunning: null,
  stuckAfterMs: DEFAULT_STUCK_AFTER_MS,
  longRunning: false,
  needsAttention: true,
  quarantined: [{ id: 'tags', reason: 'setup() threw: repo not migrated' }],
};

export default defineModule({
  id: 'admin', // MUST equal the folder name
  summary: 'See what the bot is working on and who did what in this server.',
  // One reviewable line = the whole blast radius. See the header for what is absent and why.
  capabilities: ['admin', 'catalog'],
  config: z.object({
    /** Rows `/admin audit` shows per page when the operator gives no `limit`. */
    auditRows: z.coerce.number().int().min(1).max(MAX_AUDIT_ROWS).default(DEFAULT_AUDIT_ROWS),
    /**
     * How long a job may sit in `running` before this module calls it wedged.
     * WHY IT IS CONFIG: a lease is 60s and the runner ticks every 15s, so the default of ten
     * minutes is an order of magnitude past normal — but "normal" is a property of the jobs an
     * install actually runs, and an install with a genuinely long attempt should be able to say
     * so rather than have `/status` cry wolf every day.
     */
    stuckAfterMs: z.coerce.number().int().min(1_000).default(DEFAULT_STUCK_AFTER_MS),
  }),
  permissions: {
    // NOT `nobody`: a diagnostic gated on a grant you can only obtain by asking someone else is
    // a diagnostic that is unavailable during the incident. See the header.
    view: { summary: 'Read the job queue and this server’s audit trail', fallback: 'guild-admin' },
  },
  publishes: {},
  migrations: false,

  setup(ctx) {
    const svc = new AdminService(ctx.ports.admin, ctx.ports.catalog, {
      defaultRows: ctx.config.auditRows,
      stuckAfterMs: ctx.config.stuckAfterMs,
    });
    return {
      commands: adminCommands(svc, ctx.perms), // the closure IS the dependency injection

      /**
       * Compiled through the REAL renderer at boot, so a card Discord would reject fails the
       * deploy rather than failing in front of the operator mid-incident.
       */
      previews: {
        jobsHealthy: present.jobs(HEALTHY),
        jobsWedged: present.jobs(WEDGED),
        jobsStuck: present.jobs(STUCK),
        jobsEmpty: present.jobs({
          stats: { queued: 0, running: 0, done: 0, dead: 0, cancelled: 0, orphaned: 0, oldestRunning: null },
          total: 0,
          oldestRunning: null,
          stuckAfterMs: DEFAULT_STUCK_AFTER_MS,
          longRunning: false,
          needsAttention: false,
          quarantined: [],
        }),
        auditEmpty: present.audit(previewPage({ rows: [], matched: 0, presentActions: [] }), PREVIEW_NOW),
        auditRows: present.audit(previewPage({}), PREVIEW_NOW),
        auditGlobal: present.audit(previewPage({ guildId: null }), PREVIEW_NOW),
        // The three cards a paged, filtered, window-limited investigation actually produces.
        auditPaged: present.audit(
          previewPage({ page: 2, pageSize: 2, rows: SAMPLE_ROWS.slice(2), matched: 4, hasMore: false }),
          PREVIEW_NOW,
        ),
        auditFiltered: present.audit(
          previewPage({
            filter: { action: 'builder.', actorId: '200000000000000003', layer: 'L3-deny' },
            rows: SAMPLE_ROWS.slice(1, 2),
            matched: 1,
            scanRequested: MAX_AUDIT_SCAN,
            scanReturned: MAX_AUDIT_SCAN,
            windowFull: true,
          }),
          PREVIEW_NOW,
        ),
        auditNoMatch: present.audit(
          previewPage({
            filter: { action: 'tags.', actorId: null, layer: null },
            rows: [],
            matched: 0,
            scanRequested: MAX_AUDIT_SCAN,
            scanReturned: MAX_AUDIT_SCAN,
            windowFull: true,
          }),
          PREVIEW_NOW,
        ),
      },

      /**
       * THE `/status` FIX. A local count, never a probe — see the file header.
       *
       * `dead` and `orphaned` both mean a human is needed and neither can be inferred from any
       * other module's health, so they degrade. So, now, does an attempt that has been RUNNING
       * past the configured threshold: that is the case `/status` used to report as `ok` in the
       * same words it used for a healthy queue, and it is the reason this round happened.
       * `queued`/`running` counts alone are still reported without a verdict, because a count on
       * its own genuinely cannot carry one.
       */
      async health() {
        // `null`: there is no clock here and none is needed. An age reported as a duration is
        // usable; one reported only as a start instant is not, and stays unjudged rather than
        // guessed at.
        const snap = svc.jobs(null);
        const s = snap.stats;
        if (s.dead > 0) {
          return { status: 'degraded', detail: `${s.dead} jobs dead-lettered; run /admin jobs` };
        }
        if (s.orphaned > 0) {
          return { status: 'degraded', detail: `${s.orphaned} orphaned job rows; run /admin jobs` };
        }
        const oldest = snap.oldestRunning;
        if (snap.longRunning && oldest !== null) {
          return {
            status: 'degraded',
            detail: `${oldest.name} has been running for ${formatDuration(oldest.ageMs)}; run /admin jobs`,
          };
        }
        return { status: 'ok', detail: `${s.queued} queued, ${s.running} running` };
      },
    };
  },
});
