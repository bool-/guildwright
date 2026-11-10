/**
 * The append-only audit log, over `DbPort`.
 *
 * POSTMORTEM THIS FILE CLOSES: "someone approved a build that pushed to a protected branch and
 * we could not establish who, or which authorization layer let them."
 *
 * THREE THINGS MAKE THAT ANSWERABLE, and each is a mechanism rather than a habit:
 *
 *  1. APPEND ONLY. This adapter issues `INSERT` and `SELECT` and nothing else. There is no
 *     update path and no delete path to call, so "the audit row was corrected" is not a thing
 *     that can happen through this port. (`audit.test.ts` asserts on the recorded statements.)
 *  2. `record` RETURNS `void` AND NEVER THROWS. A fallible audit write is an ignored audit
 *     write. When the caller wraps it in `db.transaction`, the INSERT is part of the same
 *     transaction as the state change that justified it, so an unauditable change is an
 *     impossible change - and when the write itself fails, the failure goes to the logger
 *     rather than up the stack, where it would turn an approval into an error card.
 *  3. `detail` IS `JsonObject`. A `UserText`, a `Secret` and a `ProgressHandle` are all
 *     unassignable, so raw user text cannot reach a row at compile time. At RUNTIME the
 *     serialised detail still goes through `redactSecrets` and a hard size cap, because the
 *     one thing an audit row must never become is a place a credential can hide.
 *
 * WHY the port is minted PER MODULE: `AuditEntry` has no `moduleId`, but `core_audit.module_id`
 * is what makes "which module made this decision?" answerable. Binding it at wiring time is
 * the only way to have it without letting a module claim to be another one.
 */

import type { JsonObject } from '#core/json';
import type { AuditEntry, AuditPort, AuditRecord, ClockPort, DbPort, LoggerPort } from '#core/ports';
import type { DecisionLayer } from '#core/policy';
import { sql } from '#core/sql';
import { redactSecrets } from '#core/text';
import { CORE_TABLES } from '#adapters/system/schema';
import { intCol, jsonCol, textCol, type Row } from '#adapters/system/rows';

/**
 * The cap on one serialised `detail`.
 * WHY it exists: an audit row is not a debugging channel, and a 2MB `detail` is how a table
 * that must stay greppable for years becomes unqueryable in a month.
 */
export const MAX_DETAIL_BYTES = 8_192;

/** WHY `action` is validated: it is a CONSTANT dotted verb by contract, and validating it
 *  here is what stops a free-text action name from becoming a de-facto unfenced text field. */
const ACTION_RE = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/u;

/**
 * One row of `core_audit`, as an investigation reads it back.
 *
 * MOVED TO `#core/ports/audit` and re-exported here. `AdminPort.recentAudit` returns these,
 * and a port in core may not name a type only an adapter defines - but every existing importer
 * of `AuditRecord` reads it from this file, so the name stays where it was.
 */
export type { AuditRecord };

/** The wiring surface. `portFor` is what the composition root hands each module. */
export interface AuditLog {
  /** WHY per-module: see the header. The module id is bound here and cannot be spoofed. */
  portFor(moduleId: string): AuditPort;
  /** Newest first. For an investigation and for the audit test; never rendered raw to a user. */
  recent(limit: number): readonly AuditRecord[];
  /** Every row for one guild, newest first. */
  forGuild(guildId: string, limit: number): readonly AuditRecord[];
}

export interface AuditDeps {
  /** Must be a CORE-scoped port (`tablePrefix === 'core_'`); see `schema.ts`. */
  readonly db: DbPort;
  readonly clock: ClockPort;
  readonly logger: LoggerPort;
}

export function createAuditLog(deps: AuditDeps): AuditLog {
  const { db, clock } = deps;
  const logger = deps.logger.child({ component: 'audit' });
  const table = db.table(CORE_TABLES.audit);

  function insert(moduleId: string, entry: AuditEntry): void {
    const action = ACTION_RE.test(entry.action) ? entry.action : `${moduleId}.invalid_action`;
    if (action !== entry.action) {
      // Not fatal, but it means somebody built an action name out of a variable, which is the
      // first step towards an unfenced text field in a security table.
      logger.warn('audit action is not a constant dotted verb', { moduleId });
    }
    const detail = serialiseDetail(entry.detail);
    db.execute(
      sql`INSERT INTO ${table} (at_ms, module_id, action, actor_id, guild_id, decision_layer, detail_json)
          VALUES (${clock.now()}, ${moduleId}, ${action}, ${entry.actorId}, ${entry.guildId}, ${entry.decisionLayer ?? null}, ${detail})`,
    );
  }

  return {
    portFor(moduleId: string): AuditPort {
      return {
        record(entry: AuditEntry): void {
          try {
            insert(moduleId, entry);
          } catch (cause: unknown) {
            // The contract says this never fails. It also must never lie about having
            // written: the operator log is where a lost audit row surfaces.
            logger.error('audit write failed', {
              moduleId,
              action: entry.action,
              cause: cause instanceof Error ? cause.name : 'unknown',
            });
          }
        },
      };
    },

    recent(limit: number): readonly AuditRecord[] {
      const rows = db.query<Row>(sql`SELECT * FROM ${table} ORDER BY id DESC LIMIT ${clampLimit(limit)}`);
      return readRecords(rows);
    },

    forGuild(guildId: string, limit: number): readonly AuditRecord[] {
      const rows = db.query<Row>(
        sql`SELECT * FROM ${table} WHERE guild_id = ${guildId} ORDER BY id DESC LIMIT ${clampLimit(limit)}`,
      );
      return readRecords(rows);
    },
  };
}

/**
 * `JsonObject` -> the TEXT that is stored.
 *
 * WHY it is exported: the property that matters ("nothing token-shaped survives, whatever the
 * field is called") is worth asserting directly rather than only through a database.
 */
export function serialiseDetail(detail: JsonObject): string {
  let raw: string;
  try {
    raw = JSON.stringify(detail);
  } catch {
    // A `JsonObject` cannot be circular by type, but this value was produced at runtime.
    return JSON.stringify({ error: 'detail was not serialisable' });
  }
  const scrubbed = redactSecrets(raw);
  if (Buffer.byteLength(scrubbed, 'utf8') <= MAX_DETAIL_BYTES) return scrubbed;
  return JSON.stringify({ error: 'detail exceeded the audit size cap', bytes: Buffer.byteLength(scrubbed, 'utf8') });
}

function clampLimit(limit: number): number {
  if (!Number.isFinite(limit) || limit <= 0) return 1;
  return Math.min(Math.floor(limit), 1_000);
}

const LAYERS: readonly DecisionLayer[] = ['L0-owner', 'L1-allowlist', 'L2-fallback', 'L3-deny'];

/** WHY re-proven: a `decision_layer` written by an older deploy is bytes, not a union. */
function readLayer(raw: string | null): DecisionLayer | null {
  for (const l of LAYERS) if (l === raw) return l;
  return null;
}

function readRecords(rows: readonly Row[]): readonly AuditRecord[] {
  const out: AuditRecord[] = [];
  for (const row of rows) {
    const id = intCol(row, 'id');
    const atMs = intCol(row, 'at_ms');
    const moduleId = textCol(row, 'module_id');
    const action = textCol(row, 'action');
    const actorId = textCol(row, 'actor_id');
    if (id === null || atMs === null || moduleId === null || action === null || actorId === null) continue;
    out.push({
      id,
      atMs,
      moduleId,
      action,
      actorId,
      guildId: textCol(row, 'guild_id'),
      decisionLayer: readLayer(textCol(row, 'decision_layer')),
      detail: jsonCol(row, 'detail_json') ?? {},
    });
  }
  return out;
}
