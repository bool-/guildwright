/**
 * The audit port.
 *
 * POSTMORTEM THIS FILE CLOSES: "someone approved a build that pushed to a protected branch and
 * we could not establish who, or which authorization layer let them."
 *
 * WHY `record` returns `void` and never fails: an audit write a caller could ignore would be
 * ignored. The adapter writes it inside the same transaction as the state change, so an
 * unauditable change is an impossible change rather than a discouraged one.
 */

import type { JsonObject } from '#core/json';
import type { DecisionLayer } from '#core/policy';

/** One row of `core_audit`. */
export interface AuditEntry {
  /** Dotted verb: `builder.approve`, `tags.set`. Constant strings only, never user text. */
  readonly action: string;
  /** Who did it. */
  readonly actorId: string;
  /** Where, or `null` in DMs. */
  readonly guildId: string | null;
  /**
   * Structured context.
   * WHY `JsonObject` and not `Record<string, unknown>`: the previous design's `unknown` let a
   * live `ProgressHandle`, a raw `UserText` and an octokit error object complete with request
   * headers into an audit row. All three are now TS2322 at the call site.
   */
  readonly detail: JsonObject;
  /** Which authorization layer allowed it (SC-7). Omitted for non-gated bookkeeping. */
  readonly decisionLayer?: DecisionLayer;
}

/**
 * One row of `core_audit`, READ BACK.
 *
 * WHY IT LIVES IN CORE and not beside the adapter that reads it: `AdminPort.recentAudit`
 * returns these, and a port is core's word about what an implementation must produce. A DTO
 * defined in `#adapters/system/audit` would have made `#core/ports/admin` import an adapter,
 * which is the one direction the hexagon does not allow. The adapter re-exports this name, so
 * `import type { AuditRecord } from '#adapters/system/audit'` still resolves to this type.
 *
 * `detail` is `JsonObject` on the way out for the same reason it is on the way in: whatever a
 * command renders from it, it is rendering JSON, not a live object somebody stored.
 */
export interface AuditRecord {
  readonly id: number;
  readonly atMs: number;
  readonly moduleId: string;
  readonly action: string;
  readonly actorId: string;
  readonly guildId: string | null;
  readonly decisionLayer: DecisionLayer | null;
  readonly detail: JsonObject;
}

/** The audit port a module receives when it declares the `audit` capability. */
export interface AuditPort {
  record(entry: AuditEntry): void;
}

/** Short alias used throughout modules. */
export type Audit = AuditPort;
