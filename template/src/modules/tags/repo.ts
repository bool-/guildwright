/**
 * The golden path, part 1: the only file in a module that touches persistence.
 *
 * This is section 9.2 of the design document, adjusted for the two contract changes the
 * attacks forced: table names are derived from `db.tablePrefix` rather than hard-coded, and
 * the parameterised `sql` tag is the only statement producer that exists.
 */

import { sql, type Db } from '#core/ports/db';

export interface Tag {
  readonly name: string;
  readonly body: string;
  readonly authorId: string;
}

export interface TagsRepo {
  get(guildId: string, name: string): Tag | undefined;
  upsert(guildId: string, name: string, body: string, by: string, at: number): Tag;
  list(guildId: string, limit: number): readonly Tag[];
  count(guildId: string): number;
  countAll(): number;
}

/**
 * WHY `db.table('tags')` and not a written-out name: a table name cannot be a bound
 * parameter, so the port mints a validated `SqlIdent` that the `sql` tag splices as text.
 * The only identifiers a module can obtain are its own, so `FROM core_access` is
 * unrepresentable here rather than merely refused at execute time.
 */
export const tagsRepo = (db: Db): TagsRepo => {
  const t = db.table('tags');
  return {
    get: (g, n) =>
      db.queryOne<Tag>(
        sql`SELECT name, body, author_id AS authorId FROM ${t} WHERE guild_id = ${g} AND name = ${n}`,
      ),
    upsert: (g, n, b, by, at) => {
      db.execute(sql`
        INSERT INTO ${t} (guild_id, name, body, author_id, updated_at)
        VALUES (${g}, ${n}, ${b}, ${by}, ${at})
        ON CONFLICT (guild_id, name) DO UPDATE SET body = excluded.body, updated_at = excluded.updated_at`);
      return { name: n, body: b, authorId: by };
    },
    list: (g, limit) =>
      db.query<Tag>(
        sql`SELECT name, body, author_id AS authorId FROM ${t} WHERE guild_id = ${g} ORDER BY name LIMIT ${limit}`,
      ),
    count: (g) => db.queryOne<{ n: number }>(sql`SELECT count(*) AS n FROM ${t} WHERE guild_id = ${g}`)?.n ?? 0,
    countAll: () => db.queryOne<{ n: number }>(sql`SELECT count(*) AS n FROM ${t}`)?.n ?? 0,
  };
};
