/**
 * The golden path, part 2: pure logic. No Discord, no SQL strings, no clock.
 *
 * NOTE the constructor. The design document writes `constructor(private readonly repo: ...)`,
 * which `erasableSyntaxOnly` rejects (TS1294) - the document's own AGENTS.md says so two
 * sections later. Fields are declared and assigned explicitly. This is the first thing a
 * contributor copies, so it has to be the legal form.
 */

import { Err, Ok, type Result } from '#core/result';
import { errors, type AppError } from '#core/errors';
import { toMarkdown, toSlug, type UserText } from '#core/text';
import type { Audit } from '#core/ports/audit';
import type { Tag, TagsRepo } from '#modules/tags/repo';

export interface TagsConfig {
  readonly maxPerGuild: number;
  readonly maxLength: number;
}

export class TagService {
  private readonly repo: TagsRepo;
  private readonly audit: Audit;
  private readonly cfg: TagsConfig;

  constructor(repo: TagsRepo, audit: Audit, cfg: TagsConfig) {
    this.repo = repo;
    this.audit = audit;
    this.cfg = cfg;
  }

  /** WHY `now` is a parameter: a module may not read the ambient clock, and a service that
   *  did could not be tested for TTL behaviour. */
  set(guildId: string, rawName: UserText, rawBody: UserText, by: string, now: number): Result<Tag, AppError> {
    const name = toSlug(rawName, 32);
    if (!name.ok) return name;
    const body = toMarkdown(rawBody, { maxLength: this.cfg.maxLength });
    if (this.repo.count(guildId) >= this.cfg.maxPerGuild && this.repo.get(guildId, name.value) === undefined) {
      return Err(errors.conflict('full', `The limit is ${this.cfg.maxPerGuild} tags.`, 'Ask an admin to raise the tag limit.'));
    }
    const tag = this.repo.upsert(guildId, name.value, body.text, by, now);
    this.audit.record({
      action: 'tags.set',
      actorId: by,
      guildId,
      // `detail` is JsonObject, so a raw UserText here would be TS2322. `removed` records
      // which scrub passes fired, which is what makes an injection attempt visible later.
      detail: { name: name.value, truncated: body.truncated, removed: [...body.removed] },
    });
    return Ok(tag);
  }

  get(guildId: string, rawName: UserText): Result<Tag, AppError> {
    const name = toSlug(rawName, 32);
    if (!name.ok) return name;
    const t = this.repo.get(guildId, name.value);
    return t === undefined ? Err(errors.notFound('tag', 'Start typing in the `name` box of `/tag get` to see existing tags.')) : Ok(t);
  }

  list(guildId: string, limit: number): readonly Tag[] {
    return this.repo.list(guildId, limit);
  }

  count(): number {
    return this.repo.countAll();
  }
}
