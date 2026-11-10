/**
 * `/admin`, part 2: commands plus rendering. Every spec field is mandatory.
 *
 * SIX THINGS TO NOTICE, because each one is a decision somebody could reasonably have made
 * differently:
 *
 *  1. `ephemeral: true` ON EVERY VIEW. Job counts and an audit trail are operational detail,
 *     not channel content. An `/admin audit` card left in a public channel is a permanent,
 *     searchable list of who was denied what — which is exactly the material a well-meaning
 *     operator should not publish by accident, and the only way to make that impossible is for
 *     the module to own no non-ephemeral view at all.
 *
 *  2. `needs: []`, not `['SendMessages']`. Every reply here is an ephemeral interaction
 *     response, which needs no channel permission — the same reasoning `/credentials` records.
 *     It also means shipping this module does not change the permissions integer in the invite
 *     URL, so nobody has to re-invite the bot to get it.
 *
 *  3. THE CLOCK COMES FROM `inv.at`. Ages are relative, because "4m" answers "is it stuck?" and
 *     an absolute timestamp does not. The router captures `clock.now()` once per invocation and
 *     hands it over as `inv.at`, so this module renders relative time WITHOUT declaring the
 *     `clock` capability and without touching the ambient clock — and `formatDuration` stays a
 *     pure function of one number, which is why it can be asserted at its boundaries.
 *
 *  4. `detail` IS SERIALISED, NOT DESCRIBED. `compactDetail` runs `JSON.stringify` and cuts the
 *     result to a fixed width. It never reads a key, never picks a field, never builds a
 *     sentence. Audit `detail` is a `JsonObject` precisely so that raw user text cannot reach a
 *     security table; re-assembling it into prose on the way out would be the same mistake
 *     pointing the other way. The renderer additionally runs every table cell through
 *     `sanitizeStored`, so the fence cannot be closed early by content.
 *
 *  5. `module` IS ITS OWN COLUMN, and it is not decoration. `AuditPort` is minted PER MODULE, so
 *     `AuditRecord.moduleId` is bound at wiring time and cannot be claimed; `action` is a plain
 *     string the calling module chose. Nothing stops the `tags` module from recording
 *     `action: 'builder.approve'` — that row reads `module_id = tags`, and until this round the
 *     card showed only the half a module gets to write. Showing both is what makes "which module
 *     decided this" answerable rather than merely conventional.
 *
 *  6. PAGING IS AN ARGUMENT, NOT A BUTTON — AND THE ARITHMETIC IS WHY. Routing is a stateless
 *     `custom_id` decode (a collector dies with the process, so it is banned outright), and
 *     `encodeActionRef` puts the whole click target in one segment matched by
 *     `/^[A-Za-z0-9._-]{1,40}$/`. This query is a page, a page size, an actor snowflake (up to
 *     20 characters), an action prefix (up to 40) and a layer: comfortably past 40 even with the
 *     tightest packing. So a pager button here could only ever have carried PART of the query,
 *     and "Older →" that silently drops the filter you set is exactly the sort of thing this
 *     round exists to delete. `page:` carries all of it, survives a restart trivially because
 *     there is nothing to survive, and Discord re-offers a recent invocation for editing.
 */

import type { CommandSpec, Invocation } from '#core/module';
import { Ok, type Result } from '#core/result';
import type { AppError } from '#core/errors';
import type { SafeMarkdown } from '#core/text';
import { joinSafe, md, mdInlineCode, mdMention } from '#core/text';
import { limit } from '#core/ratelimit';
import type { PermissionRef } from '#core/policy';
import type { JsonObject } from '#core/json';
import type { AuditRecord } from '#core/ports';
import type { View, ViewNode } from '#core/view';
import {
  ACTION_FILTER_MAX,
  LAYER_CHOICES,
  MAX_AUDIT_PAGE,
  MAX_AUDIT_ROWS,
  filterIsActive,
  parseActionFilter,
  type AdminService,
  type AuditFilter,
  type AuditPage,
  type AuditQuery,
  type JobsSnapshot,
  type LayerFilter,
} from '#modules/admin/domain';

/** How wide one serialised `detail` may be. The renderer clips cells at 40 too; this is ours. */
export const DETAIL_CELL_MAX = 36;
/** Dotted verbs are short by contract; this only bounds a pathological one. */
export const ACTION_CELL_MAX = 28;
/** `MODULE_ID_RE` allows 31 characters; every real id is under 12. This bounds the table. */
export const MODULE_CELL_MAX = 16;
/** How many quarantined modules the jobs card names before it stops listing them. */
export const MAX_QUARANTINE_LINES = 5;

/** Shown in the `layer` column for a row that recorded no authorization decision. */
export const NO_LAYER = '-';

/** The columns of the audit table, in order. Exported so a test can pin the column index it
 *  asserts on to the name rather than to a number that quietly shifts. */
export const AUDIT_COLUMNS = ['age', 'module', 'action', 'actor', 'layer', 'detail'] as const;

/**
 * A duration as something a human reads at a glance.
 *
 * WHY IT IS PURE: a module may not read the ambient clock, and a formatter that did could not be
 * asserted at its boundaries. The caller supplies the number — `inv.at - row.atMs` for a card,
 * the port's reported age for a running job, a fixed constant for a boot preview.
 *
 * WHY `ahead` IS A CASE: `at_ms` is written by whichever process recorded the row, and an NTP
 * step or a second process on the same database can leave a row stamped in the future. Printing
 * `-3s` there reads like a bug in this card rather than a fact about the clock.
 */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms)) return '?';
  if (ms < 0) return 'ahead';
  const seconds = Math.floor(ms / 1_000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

/** `now - then`, formatted. Both arguments come from the caller; see `formatDuration`. */
export function formatAge(nowMs: number, atMs: number): string {
  return formatDuration(nowMs - atMs);
}

/** Cut to `max` CODE POINTS. WHY not `.slice`: splitting a surrogate pair produces a lone
 *  surrogate, which SQLite stores happily and Discord rejects. */
function cut(s: string, max: number): string {
  const points = [...s];
  if (points.length <= max) return s;
  return `${points.slice(0, Math.max(0, max - 1)).join('')}…`;
}

/**
 * Audit `detail`, as DATA.
 *
 * Read what it does not do: it does not look at a key, does not special-case a shape, and does
 * not produce a sentence. See note (4) in the file header.
 */
export function compactDetail(detail: JsonObject, max: number = DETAIL_CELL_MAX): string {
  let json: string;
  try {
    json = JSON.stringify(detail);
  } catch {
    // Unreachable through the type — a `JsonObject` cannot be circular — but this value was
    // read back out of SQLite at runtime, so it has not really proven anything.
    return '{unserialisable}';
  }
  // `JSON.stringify` returns `undefined` for a handful of inputs the type forbids.
  return json === undefined ? '{}' : cut(json, max);
}

/**
 * Short labels for the actors on one page, in first-seen order: A, B, C...
 *
 * WHY: the table is a code block, where a mention cannot render, so a raw snowflake was all the
 * reader got. The table carries the label and a line under it maps each label to a mention.
 */
export function actorLabels(rows: readonly AuditRecord[]): ReadonlyMap<string, string> {
  const labels = new Map<string, string>();
  for (const r of rows) {
    if (labels.has(r.actorId)) continue;
    const i = labels.size;
    labels.set(r.actorId, i < 26 ? String.fromCharCode(65 + i) : `#${String(i + 1)}`);
  }
  return labels;
}

/** One table row of `/admin audit`. Exported so the size proof can build a worst case. */
export function auditRowCells(row: AuditRecord, nowMs: number, actorLabel: string = row.actorId): readonly string[] {
  return [
    formatAge(nowMs, row.atMs),
    cut(row.moduleId, MODULE_CELL_MAX),
    cut(row.action, ACTION_CELL_MAX),
    actorLabel,
    row.decisionLayer ?? NO_LAYER,
    compactDetail(row.detail),
  ];
}

/** How many pages `matched` rows come to at this page size. At least one, so "page 1 of 0" is
 *  unwritable. */
function pageCount(matched: number, pageSize: number): number {
  return Math.max(1, Math.ceil(matched / Math.max(1, pageSize)));
}

/** The one-line account of what was narrowed, or `null` when nothing was. */
function filterLine(filter: AuditFilter): ViewNode | null {
  if (!filterIsActive(filter)) return null;
  const parts: SafeMarkdown[] = [];
  if (filter.action !== null) parts.push(md`action starting ${mdInlineCode(filter.action)}`);
  if (filter.actorId !== null) parts.push(md`actor ${mdMention('user', filter.actorId)}`);
  if (filter.layer !== null) parts.push(md`layer ${mdInlineCode(filter.layer)}`);
  return { kind: 'text', md: md`Filtered to ${joinSafe(parts, ', ')}.` };
}

/**
 * What the search actually covered — the sentence that keeps "nothing matched" honest.
 *
 * `null` when the window was not filled, because then the answer really is the whole trail for
 * this scope and there is nothing to disclose.
 */
function windowLine(page: AuditPage, nowMs: number): ViewNode | null {
  if (!page.windowFull) return null;
  const back =
    page.oldestScannedAtMs === null
      ? md``
      : md` (back to ${mdInlineCode(formatAge(nowMs, page.oldestScannedAtMs))} ago)`;
  return {
    kind: 'text',
    md: md`Only the newest ${mdInlineCode(String(page.scanReturned))} rows${back} were searched.`,
  };
}

export const present = {
  /**
   * "Is anything stuck?"
   *
   * IT IS NOW A QUESTION THIS CARD ANSWERS. It used to print six counts and a disclaimer,
   * because `running: 1` is what a healthy job and a job wedged since Tuesday both look like
   * from one sample — so the honest thing was to say "run it twice". The port now reports the
   * oldest running attempt's name and age, so the card compares that against a configured
   * threshold and says which of the two it is. The disclaimer survives for exactly the case that
   * still deserves it: something is running and no age came back with it.
   */
  jobs(snap: JobsSnapshot): View {
    const s = snap.stats;
    const nodes: ViewNode[] = [
      { kind: 'heading', text: 'Jobs', icon: 'build' },
      {
        kind: 'table',
        head: ['state', 'rows'],
        rows: [
          ['queued', String(s.queued)],
          ['running', String(s.running)],
          ['done', String(s.done)],
          ['dead', String(s.dead)],
          ['cancelled', String(s.cancelled)],
          ['orphaned', String(s.orphaned)],
        ],
      },
    ];

    const oldest = snap.oldestRunning;
    const threshold = mdInlineCode(formatDuration(snap.stuckAfterMs));
    if (oldest !== null) {
      nodes.push({
        kind: 'field',
        name: 'oldest running',
        md: md`${mdInlineCode(oldest.name)} - running for ${mdInlineCode(formatDuration(oldest.ageMs))}`,
      });
      nodes.push(
        snap.longRunning
          ? {
              kind: 'text',
              md: md`Past the ${threshold} stuck mark. Check the process log for this job.`,
            }
          : {
              kind: 'text',
              md: md`Nothing has been running longer than ${threshold}, so nothing is wedged.`,
            },
      );
    } else if (s.running > 0) {
      nodes.push({
        kind: 'text',
        md: md`Can't tell how long it has run. Run ${mdInlineCode('/admin jobs')} again; if the count hasn't moved, it's stuck.`,
      });
    }

    if (snap.total === 0) {
      nodes.push({ kind: 'text', md: md`Nothing has ever been queued on this database.` });
    }
    if (s.dead > 0) {
      nodes.push({
        kind: 'text',
        md: md`${mdInlineCode(String(s.dead))} dead - out of retries or past deadline. ${mdInlineCode('/admin audit')} shows why.`,
      });
    }
    if (s.orphaned > 0) {
      nodes.push({
        kind: 'text',
        md: md`${mdInlineCode(String(s.orphaned))} orphaned - no loaded module handles these jobs. A module was renamed, removed or disabled at startup.`,
      });
    }
    if (snap.quarantined.length > 0) {
      nodes.push({
        kind: 'table',
        head: ['quarantined module', 'why'],
        rows: snap.quarantined.slice(0, MAX_QUARANTINE_LINES).map((q) => [q.id, q.reason]),
      });
    }
    if (!snap.needsAttention && snap.total > 0) {
      nodes.push({ kind: 'text', md: md`Nothing is dead or orphaned, and every module loaded.` });
    }

    return {
      accent: s.dead > 0 ? 'error' : snap.needsAttention ? 'warn' : 'ok',
      ephemeral: true,
      nodes,
    };
  },

  /**
   * The audit trail: readable, pageable and narrowable.
   *
   * `layer` is the column this card was built for — `L0-owner` for the application owner's
   * bypass, `L1-allowlist` for an explicit grant, `L2-fallback` for the declaring module's
   * default, `L3-deny` for a refusal — and `module` is the column that makes it trustworthy; see
   * note (5) in the file header.
   *
   * EVERY EMPTY ANSWER SAYS WHICH KIND OF EMPTY IT IS. "Nothing has happened here", "nothing
   * matched what you asked for, and here is what is in the window", and "that page is past the
   * end" are three different facts, and one shared "no rows" would have made an investigation
   * guess between them.
   */
  audit(page: AuditPage, nowMs: number): View {
    const scope = page.guildId === null ? 'every server' : 'this server';
    const active = filterIsActive(page.filter);

    if (page.rows.length === 0) {
      const nodes: ViewNode[] = [];
      if (page.matched === 0 && !active) {
        nodes.push({
          kind: 'text',
          md: md`No audit rows for ${mdInlineCode(scope)} yet. A row is written when a decision is made - an approval, a rejection, a grant.`,
        });
      } else if (page.matched === 0) {
        nodes.push({
          kind: 'text',
          md: md`No audit row for ${mdInlineCode(scope)} matched what you asked for.`,
        });
        const line = filterLine(page.filter);
        if (line !== null) nodes.push(line);
        if (page.presentActions.length > 0) {
          nodes.push({
            kind: 'text',
            md: md`Actions present in the searched window: ${joinSafe(page.presentActions.map((a) => mdInlineCode(a)), ', ')}.`,
          });
        }
      } else {
        nodes.push({
          kind: 'text',
          md: md`Page ${mdInlineCode(String(page.page))} is past the end: ${mdInlineCode(String(page.matched))} rows matched, which is ${mdInlineCode(String(pageCount(page.matched, page.pageSize)))} page(s) at ${mdInlineCode(String(page.pageSize))} per page.`,
        });
      }
      const window = windowLine(page, nowMs);
      if (window !== null) nodes.push(window);
      return { accent: 'info', ephemeral: true, nodes };
    }

    const first = (page.page - 1) * page.pageSize + 1;
    const last = first + page.rows.length - 1;
    const labels = actorLabels(page.rows);
    const nodes: ViewNode[] = [
      { kind: 'heading', text: `Audit - ${scope}`, icon: 'info' },
      {
        kind: 'table',
        head: [...AUDIT_COLUMNS],
        rows: page.rows.map((r) => auditRowCells(r, nowMs, labels.get(r.actorId))),
      },
      {
        kind: 'text',
        md: md`Actors: ${joinSafe(
          [...labels].map(([id, label]) => md`${mdInlineCode(label)} ${mdMention('user', id)}`),
          ', ',
        )}`,
      },
      {
        kind: 'text',
        // THE TOTAL IS PRINTED ONLY WHERE IT IS KNOWN. An unfiltered page reads as far as the
        // page it was asked for and one row further, so `matched` is then a lower bound — and a
        // card that turned that into "of 11, page 1 of 2" on a table of ten thousand rows would
        // be inventing the one number the reader would rely on. See `AuditPage.matchedIsTotal`.
        md: md`Newest first. Rows ${mdInlineCode(`${String(first)}-${String(last)}`)}${
          page.matchedIsTotal
            ? md` of ${mdInlineCode(String(page.matched))}, page ${mdInlineCode(String(page.page))} of ${mdInlineCode(String(pageCount(page.matched, page.pageSize)))}`
            : md`, page ${mdInlineCode(String(page.page))}`
        }.${page.hasMore ? md` Run it again with ${mdInlineCode(`page:${String(page.page + 1)}`)} for the next one.` : md``}`,
      },
    ];

    const line = filterLine(page.filter);
    if (line !== null) nodes.push(line);
    const window = windowLine(page, nowMs);
    if (window !== null) nodes.push(window);

    nodes.push({
      kind: 'text',
      md: md`${mdInlineCode('layer')} shows what allowed it; ${mdInlineCode(NO_LAYER)} means no decision.`,
    });

    return { accent: 'info', ephemeral: true, nodes };
  },
};

/**
 * Read an optional integer option.
 *
 * WHY IT CHECKS `args.names` FIRST: `args.integer` reports an ABSENT option as a validation
 * failure, which is the right answer for a required option and the wrong one here. Calling it
 * unconditionally would turn "I did not pass a limit" into "That number is missing."
 */
function readOptionalInt(
  inv: Invocation,
  name: string,
  fallback: number,
  bounds: { readonly min: number; readonly max: number },
): Result<number, AppError> {
  if (!inv.args.names.includes(name)) return Ok(fallback);
  return inv.args.integer(name, bounds);
}

/**
 * Everything the operator asked for EXCEPT whose rows to read.
 *
 * READ THE RETURN TYPE. It is `Omit<AuditQuery, 'guildId'>`, so the function that parses options
 * cannot produce a guild scope even by accident — the scope is assigned at the call site from
 * `inv.space.guildId`, which is the property decision (2) in `domain.ts` rests on, expressed as
 * a type rather than as a convention.
 */
function readAuditQuery(inv: Invocation, defaultRows: number): Result<Omit<AuditQuery, 'guildId'>, AppError> {
  const pageSize = readOptionalInt(inv, 'limit', defaultRows, { min: 1, max: MAX_AUDIT_ROWS });
  if (!pageSize.ok) return pageSize;
  const page = readOptionalInt(inv, 'page', 1, { min: 1, max: MAX_AUDIT_PAGE });
  if (!page.ok) return page;

  let action: string | null = null;
  const rawAction = inv.args.text('action');
  if (rawAction !== undefined) {
    // `UserText` never becomes a string except through a named converter (AGENTS.md rule 3);
    // `parseActionFilter` is that converter plus the shape check. See `domain.ts` decision (4).
    const parsed = parseActionFilter(rawAction);
    if (!parsed.ok) return parsed;
    action = parsed.value;
  }

  let layer: LayerFilter | null = null;
  if (inv.args.names.includes('layer')) {
    // The allow-list is checked SERVER SIDE, because Discord permits a client to submit a value
    // that was never offered (SC-11) — `args.choice` is the door that does it.
    const chosen = inv.args.choice('layer', LAYER_CHOICES);
    if (!chosen.ok) return chosen;
    layer = chosen.value;
  }

  const filter: AuditFilter = { action, actorId: inv.args.user('actor') ?? null, layer };
  return Ok({ page: page.value, pageSize: pageSize.value, filter });
}

/** WHY the perms bag is typed by its keys: `perms.veiw` is TS2551 with a suggestion. */
export function adminCommands(
  svc: AdminService,
  perms: Readonly<Record<'view', PermissionRef>>,
): readonly CommandSpec[] {
  return [
    {
      name: 'admin jobs',
      description: 'Job counts by state - is anything stuck?',
      // Both surfaces: the job queue is process-wide, so a DM is a legitimate place to ask. In
      // a DM the `guild-admin` fallback denies everyone, so this is the owner's view there.
      surface: 'both',
      options: [],
      permission: perms.view, // REQUIRED — omitting it is TS2741
      limit: [limit.perUser(10, 60_000)], // REQUIRED — NO_LIMIT to opt out
      needs: [], // REQUIRED — see note (2) in the header for why it is empty and not SendMessages
      ack: 'defer-ephemeral',
      async handle(inv) {
        // `inv.at` is the router's single `clock.now()` for this invocation, and it is what lets
        // an age reported as a start instant be turned into one. See `readOldestRunning`.
        return { kind: 'view', view: present.jobs(svc.jobs(inv.at)) };
      },
    },
    {
      name: 'admin audit',
      description: 'Recent decisions: module, action, actor, the layer that allowed it, and when',
      surface: 'both',
      options: [
        {
          name: 'limit',
          description: `Rows per page (1-${MAX_AUDIT_ROWS})`,
          type: 'integer',
          required: false,
          // Discord enforces these client-side; `clampRows` enforces them server-side, because
          // a bound that lives only in the command payload is not a bound.
          minValue: 1,
          maxValue: MAX_AUDIT_ROWS,
        },
        {
          name: 'page',
          description: `Which page, newest first (1-${MAX_AUDIT_PAGE})`,
          type: 'integer',
          required: false,
          minValue: 1,
          maxValue: MAX_AUDIT_PAGE,
        },
        {
          // THE ONLY TYPED TEXT ON `/admin`, and it is narrowed to a lowercase dotted verb
          // before it reaches anything. NOT `autocomplete: true`: the router answers an
          // autocomplete WITHOUT checking the command's permission, so a handler suggesting the
          // actions present in this guild's audit log would be an ungated read of the very table
          // this command is gated on.
          name: 'action',
          description: 'Only this action, matched by prefix: builder, builder.approve',
          type: 'text',
          required: false,
          minLength: 1,
          maxLength: ACTION_FILTER_MAX,
        },
        {
          // A user option, so an actor is PICKED rather than typed: `args.user` hands back a
          // branded snowflake and free text never enters the query at all.
          name: 'actor',
          description: 'Only decisions made by this person',
          type: 'user',
          required: false,
        },
        {
          name: 'layer',
          description: 'Only this authorization layer - L3-deny is every refusal',
          type: 'text',
          required: false,
          choices: [...LAYER_CHOICES],
        },
      ],
      permission: perms.view,
      limit: [limit.perUser(10, 60_000)],
      needs: [],
      ack: 'defer-ephemeral',
      async handle(inv) {
        const query = readAuditQuery(inv, svc.defaultAuditRows);
        if (!query.ok) return { kind: 'fail', error: query.error };
        // THE GUILD SCOPE IS THE INVOCATION'S, NEVER AN OPTION'S. See domain.ts, decision (2).
        const page = svc.audit({ ...query.value, guildId: inv.space.guildId });
        return { kind: 'view', view: present.audit(page, inv.at) };
      },
    },
  ];
}
