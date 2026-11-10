/**
 * Per-guild settings, over `DbPort`, with a write-through-invalidating cache.
 *
 * WHY A CACHE AT ALL: `SettingsPort` is SYNCHRONOUS and `AccessPort.check` reads it on every
 * interaction, inside the 3-second window. A guild's settings are a handful of rows that
 * change when an admin runs a command, so the read path should not touch SQLite at all.
 *
 * WHY INVALIDATION AND NOT WRITE-THROUGH-UPDATE: updating the cache in place makes the cache
 * the source of truth for one process and the table the source of truth for everyone else,
 * and the two diverge the first time a write half-fails. Dropping the guild's entry means the
 * next read re-derives from the table, so the table is always the answer and the cache is only
 * ever a shortcut. `invalidate()` is exported for the same reason: an operator editing rows out
 * of band has one obvious lever.
 *
 * WHY THIS IS NOT `config`: config is per-process, comes from env, and is validated once at
 * boot. Settings are per-guild and edited at runtime by an admin command. Conflating them is
 * how "why is this different in the other server?" happens.
 */

import type { JsonObject } from '#core/json';
import type { GuildId } from '#core/ids';
import type { ClockPort, DbPort, LoggerPort, SettingsPort } from '#core/ports';
import { sql } from '#core/sql';
import { CORE_TABLES } from '#adapters/system/schema';
import { jsonCol, textCol, type Row } from '#adapters/system/rows';

/** The port plus the two levers the composition root needs. */
export interface SettingsStore extends SettingsPort {
  /** Drop one guild's cache, or every guild's when called with no argument. */
  invalidate(guildId?: GuildId): void;
  /** Remove one key. `false` when it was not set. */
  clear(guildId: GuildId, key: string): boolean;
}

export interface SettingsDeps {
  /** Must be a CORE-scoped port (`tablePrefix === 'core_'`). */
  readonly db: DbPort;
  readonly clock: ClockPort;
  readonly logger: LoggerPort;
}

export function createSettings(deps: SettingsDeps): SettingsStore {
  const { db, clock } = deps;
  const logger = deps.logger.child({ component: 'settings' });
  const table = db.table(CORE_TABLES.settings);
  const cache = new Map<string, Map<string, JsonObject>>();

  function load(guildId: GuildId): Map<string, JsonObject> {
    const hit = cache.get(guildId);
    if (hit !== undefined) return hit;
    const fresh = new Map<string, JsonObject>();
    const rows = db.query<Row>(sql`SELECT key, value_json FROM ${table} WHERE guild_id = ${guildId}`);
    for (const row of rows) {
      const key = textCol(row, 'key');
      const value = jsonCol(row, 'value_json');
      if (key === null || value === null) {
        // A row written by an older deploy, or hand-edited. Skipping it is right: a setting
        // nobody can parse must read as "unset", never as a half-applied policy.
        logger.warn('unreadable settings row skipped', { guildId, key: key ?? '?' });
        continue;
      }
      fresh.set(key, value);
    }
    cache.set(guildId, fresh);
    return fresh;
  }

  return {
    get(guildId: GuildId, key: string): JsonObject | undefined {
      return load(guildId).get(key);
    },

    all(guildId: GuildId): Readonly<Record<string, JsonObject>> {
      return Object.fromEntries(load(guildId));
    },

    set(guildId: GuildId, key: string, value: JsonObject): void {
      const now = clock.now();
      const json = JSON.stringify(value);
      // WHY `INSERT OR REPLACE` and not `ON CONFLICT ... DO UPDATE SET`: core's
      // `checkTableOwnership` scans for `UPDATE <name>` to find table references, and the
      // upsert form makes it read `SET` as a table name and refuse the statement. See the
      // core change request in the handover notes; `INSERT OR REPLACE` is the same write here,
      // because the row is a full replacement anyway.
      db.execute(
        sql`INSERT OR REPLACE INTO ${table} (guild_id, key, value_json, updated_at_ms)
            VALUES (${guildId}, ${key}, ${json}, ${now})`,
      );
      // Explicit invalidation, AFTER the write. If the write throws, the cache is untouched
      // and still agrees with the table.
      cache.delete(guildId);
    },

    clear(guildId: GuildId, key: string): boolean {
      const res = db.execute(sql`DELETE FROM ${table} WHERE guild_id = ${guildId} AND key = ${key}`);
      cache.delete(guildId);
      return res.changes > 0;
    },

    invalidate(guildId?: GuildId): void {
      if (guildId === undefined) cache.clear();
      else cache.delete(guildId);
    },
  };
}

// ---------------------------------------------------------------------------------------
// The typed settings - the keys this product actually stores
// ---------------------------------------------------------------------------------------

/**
 * WHY typed accessors and not `settings.get(guildId, 'whatever')` at each call site:
 * `JsonObject` in, `JsonObject` out means every reader re-implements the same narrowing, and
 * the FOURTH one gets the default wrong. These are the only spellings of these keys.
 */
export const SETTING_KEYS = {
  /** Channels in which `$request` is honoured. */
  requestChannels: 'builder.request_channels',
  /** May the person who opened a request also approve it? */
  selfApprove: 'access.self_approve',
  /** The guild owner, recorded by the Discord adapter, for the `guild-admin` fallback. */
  guildOwner: 'guild.owner',
} as const;

/**
 * The `$request` channel allow-list.
 *
 * `configured: false` means the guild has never set one. WHY that is distinguished from an
 * empty list: dispatching a paid build is the definition of "fail closed", so an unconfigured
 * guild denies - and a denial that cannot tell the user "an admin has not enabled any channel
 * yet" from "not this channel" is a support ticket.
 */
export interface RequestChannelPolicy {
  readonly configured: boolean;
  readonly channelIds: readonly string[];
}

export function readRequestChannels(settings: SettingsPort, guildId: GuildId): RequestChannelPolicy {
  const raw = settings.get(guildId, SETTING_KEYS.requestChannels);
  if (raw === undefined) return { configured: false, channelIds: [] };
  const value = raw['channelIds'];
  if (!Array.isArray(value)) return { configured: false, channelIds: [] };
  const ids: string[] = [];
  for (const v of value) if (typeof v === 'string' && /^\d{17,20}$/u.test(v)) ids.push(v);
  return { configured: true, channelIds: ids };
}

export function setRequestChannels(settings: SettingsPort, guildId: GuildId, channelIds: readonly string[]): void {
  settings.set(guildId, SETTING_KEYS.requestChannels, { channelIds: [...channelIds] });
}

/** Fail closed: an unconfigured guild honours `$request` nowhere. */
export function channelAllowsRequests(settings: SettingsPort, guildId: GuildId, channelId: string): boolean {
  const policy = readRequestChannels(settings, guildId);
  return policy.configured && policy.channelIds.includes(channelId);
}

/**
 * May a requester approve their own request?
 *
 * DEFAULTS TO FALSE, and the default is expressed HERE rather than at the call site, so
 * "asking is not approving" survives someone adding a second caller.
 */
export function readSelfApprove(settings: SettingsPort, guildId: GuildId): boolean {
  const raw = settings.get(guildId, SETTING_KEYS.selfApprove);
  return raw !== undefined && raw['allowed'] === true;
}

export function setSelfApprove(settings: SettingsPort, guildId: GuildId, allowed: boolean): void {
  settings.set(guildId, SETTING_KEYS.selfApprove, { allowed });
}

/** The recorded guild owner, or `null`. Written by the Discord adapter on GuildCreate. */
export function readGuildOwnerId(settings: SettingsPort, guildId: GuildId): string | null {
  const raw = settings.get(guildId, SETTING_KEYS.guildOwner);
  if (raw === undefined) return null;
  const id = raw['userId'];
  return typeof id === 'string' && /^\d{17,20}$/u.test(id) ? id : null;
}

export function setGuildOwnerId(settings: SettingsPort, guildId: GuildId, userId: string): void {
  settings.set(guildId, SETTING_KEYS.guildOwner, { userId });
}
