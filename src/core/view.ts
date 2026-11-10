/**
 * `View` - what a handler returns instead of touching Discord.
 *
 * POSTMORTEMS THIS FILE CLOSES:
 *  (1) "The card rendered `[object Object]` in production." Text nodes take `SafeMarkdown`,
 *      never `string`, so the only way text enters a view is through `#core/text`.
 *  (2) "`setCustomId` threw at render time." A button takes `CustomId`, which only
 *      `encodeActionRef` mints, and it already proved the 100-character limit.
 *  (3) "A `javascript:` URL ended up on a link button." `LinkSpec.url` is `HttpsUrl`.
 *  (4) "The card had six buttons in a row and Discord rejected the whole message."
 *      `validateView` enforces Discord's component budget, and the registry runs it over
 *      every declared preview at boot.
 *  (5) "We rewrote every module when Components V2 landed." A `View` is data; the adapter
 *      decides whether it becomes an embed or a component tree.
 */

import type { CustomId } from '#core/ids';
import { CUSTOM_ID_MAX, toUserId } from '#core/ids';
import type { HttpsUrl, SafeMarkdown } from '#core/text';

/** Colour/semantic band for the whole card. */
export type Accent = 'ok' | 'warn' | 'error' | 'info' | 'pending';

/** Small glyph set, mapped to an emoji or a V2 accessory by the adapter. */
export type Icon = 'info' | 'ok' | 'warn' | 'error' | 'build' | 'clock';

/** Button colour. Named rather than numeric so nobody has to remember Primary=1. */
export type ButtonStyle = 'primary' | 'secondary' | 'success' | 'danger';

/** A clickable button. Every field is required; a disabled button is a deliberate state. */
export interface ButtonSpec {
  /** Proven <= 100 characters by construction. */
  readonly customId: CustomId;
  readonly label: string;
  readonly style: ButtonStyle;
  /** WHY resolved cards keep disabled buttons: history stays readable, and a click is inert. */
  readonly disabled: boolean;
}

/** A link button. Separate from `ButtonSpec` because a link has no `custom_id` at all. */
export interface LinkSpec {
  readonly label: string;
  /** WHY `HttpsUrl`: `parseHttpsUrl` is the only producer, so no other scheme can appear. */
  readonly url: HttpsUrl;
}

/** One option in a select menu. `value` is echoed back and MUST be re-validated server-side. */
export interface SelectOption {
  readonly label: string;
  readonly value: string;
  readonly description: string | null;
}

/**
 * A select menu.
 * WHY it exists: the flagship's `fields_json` includes `priority` (single) and `areas`
 * (multi). Faking those with one button per option blows the component budget, which is
 * exactly the failure `validateView` below is built to catch.
 */
export interface SelectSpec {
  readonly customId: CustomId;
  readonly placeholder: string;
  readonly options: readonly SelectOption[];
  readonly minValues: number;
  readonly maxValues: number;
  readonly disabled: boolean;
}

/** The node kinds a module may emit. */
export type ViewNode =
  | { readonly kind: 'text'; readonly md: SafeMarkdown }
  | { readonly kind: 'heading'; readonly text: string; readonly icon: Icon }
  | { readonly kind: 'field'; readonly name: string; readonly md: SafeMarkdown }
  | { readonly kind: 'table'; readonly head: readonly string[]; readonly rows: readonly (readonly string[])[] }
  | { readonly kind: 'buttons'; readonly buttons: readonly ButtonSpec[]; readonly links: readonly LinkSpec[] }
  | { readonly kind: 'select'; readonly select: SelectSpec }
  | { readonly kind: 'divider' };

/** A whole message, as data. */
export interface View {
  readonly accent: Accent;
  /**
   * WHY the router refuses an ephemeral view on the long path: an ephemeral reply is
   * per-interaction and cannot be edited once the token dies, so a card a job will update
   * later must not be ephemeral.
   */
  readonly ephemeral?: boolean;
  /**
   * THE ONLY THING IN THIS SYSTEM THAT CAN PING ANYBODY, and it can ping exactly one person.
   *
   * `render.ts` hardcodes `allowed_mentions: { parse: [] }` on every payload, which is right:
   * an `@everyone` typed by a user is then a literal string, permanently. But it also meant a
   * build that finished twenty minutes after the click was delivered by an edit that notified
   * nobody, so the requester had to go back and look. That is the failure this field closes.
   *
   * THE RULES, AND WHY EACH IS STRUCTURAL RATHER THAN A HABIT:
   *
   *  1. `parse: []` STAYS. The renderer adds `users: [id]` beside it; it never removes the
   *     empty parse list. `@everyone`, `@here` and any role ping are therefore still
   *     impossible for any text in any node, whoever wrote it.
   *  2. `users` is a ONE-element allow list. Putting a ROLE id here pings nothing, because a
   *     role mention is only resolved by `allowed_mentions.roles`, which this renderer has no
   *     way to emit at all. Smuggling is not blocked by a check; it is unrepresentable.
   *  3. IT MUST BE AN ID THE BOT CHOSE, from a persisted snowflake - the requester recorded on
   *     the build row - never a value scraped out of user text. A `UserText` cannot reach this
   *     field without going through `toSnowflake`, and nothing in `#core/text` will hand you a
   *     snowflake it read out of a message body.
   *  4. `validateView` rejects anything that is not snowflake-shaped, so a malformed id is a
   *     boot-time or render-time `AppError` naming the view, not a 400 from Discord in front
   *     of a user.
   *
   * THE ONE THING THAT WILL CATCH YOU, AND IT IS NOT A TYPE. Discord notifies on message
   * CREATE. Editing an existing message to add a mention does not reliably notify anybody - the
   * markup appears, the ping does not. So a card that is EDITED from "Building..." to "Done"
   * must, if it is meant to tell the requester, POST a short new message carrying this field
   * rather than expect the edit to do it. `DiscordPort.post` is that call, and it takes the
   * persisted `channelId`, so it works thirty minutes after the interaction token died.
   *
   * (The renderer puts the `<@id>` in the message `content` for the same reason: a mention
   * inside an EMBED is decoration, and never notifies. `allowed_mentions` alone is permission
   * to resolve a mention, not a mention.)
   *
   * Absent means "notify nobody", which is what almost every view should say.
   */
  readonly mentionUserId?: string;
  readonly nodes: readonly ViewNode[];
}

/**
 * A durable handle to a message we posted.
 *
 * THIS IS THE CENTRAL TYPE OF THE 15-MINUTE-TOKEN FIX. A token expires ~15 minutes after the
 * click; a Claude Code build takes 5-30. So the "PR opened" message cannot go through
 * `editReply`. A `SurfaceRef` is plain JSON, so it is written to
 * `m_builder_requests.surface_json`, survives a restart, and is edited later by a fresh REST
 * call keyed on these ids.
 *
 * WHY it carries `guildId`: without it a poll job cannot write a guild-scoped audit row, read
 * per-guild settings, or resolve member roles, and modules start smuggling the guild id as a
 * loose extra field in every payload.
 *
 * WHY a type ALIAS and not an `interface`: an anonymous object type gets an implicit index
 * signature and is therefore assignable to `JsonObject`. An `interface` silently would not be,
 * and being storable in a job payload is the entire point of this type.
 */
export type SurfaceRef = {
  readonly guildId: string | null;
  readonly channelId: string;
  readonly messageId: string;
};

/**
 * Modal text field. `LabelBuilder` wraps these in discord.js 14.27; the module never sees it.
 *
 * WHY `description` is required and nullable rather than optional: same rule as every other
 * spec here. `null` is a decision a reviewer can see; an omitted key is not.
 */
export interface FormTextField {
  readonly kind: 'text';
  readonly name: string;
  readonly label: string;
  /** Shown under the label. Guidance goes here, not crammed into the placeholder. */
  readonly description: string | null;
  readonly style: 'short' | 'paragraph';
  readonly required: boolean;
  readonly maxLength: number;
  readonly placeholder: string;
}

/**
 * Modal dropdown: one choice from a fixed list. The submitted value is echoed back by the
 * client, so it is read only through `FormValues.choice`, which re-validates it against the
 * allow-list the handler passes in.
 */
export interface FormSelectField {
  readonly kind: 'select';
  readonly name: string;
  readonly label: string;
  readonly description: string | null;
  readonly required: boolean;
  readonly placeholder: string;
  readonly options: readonly SelectOption[];
}

export type FormField = FormTextField | FormSelectField;

/**
 * A modal. Returned only from an `ack: 'form'` handler, which may not await first - Discord
 * forbids defer-then-modal (lint rule `no-await-in-form-handler`).
 */
export interface FormSpec {
  readonly customId: CustomId;
  readonly title: string;
  /**
   * One line of plain text above the fields: what happens after Submit. Counts against
   * Discord's five-component modal budget, exactly like a field.
   */
  readonly intro: string | null;
  readonly fields: readonly FormField[];
}

// ---------------------------------------------------------------------------------------
// Component budget
// ---------------------------------------------------------------------------------------

/** Discord: at most 5 action rows per message. */
export const MAX_ACTION_ROWS = 5;
/** Discord: at most 5 buttons in one action row. */
export const MAX_BUTTONS_PER_ROW = 5;
/** Discord: a select menu occupies a whole action row, and carries at most 25 options. */
export const MAX_SELECT_OPTIONS = 25;

/** One reason a view would be rejected by Discord, as data so boot can list them all. */
export interface ViewProblem {
  readonly code:
    | 'too-many-rows'
    | 'too-many-buttons'
    | 'too-many-options'
    | 'custom-id-too-long'
    | 'bad-select-range'
    | 'bad-mention';
  readonly detail: string;
}

/**
 * Prove a view would survive discord.js.
 *
 * WHY the registry runs this over every declared preview at BOOT: every one of these limits
 * is enforced by Discord at send time, i.e. in front of a user, and `setCustomId` throws
 * rather than returning an error. Boot is the humane place to find out.
 */
export function validateView(view: View): readonly ViewProblem[] {
  const problems: ViewProblem[] = [];
  let rows = 0;

  for (const node of view.nodes) {
    if (node.kind === 'buttons') {
      const total = node.buttons.length + node.links.length;
      rows += Math.max(1, Math.ceil(total / MAX_BUTTONS_PER_ROW));
      if (total > MAX_BUTTONS_PER_ROW * MAX_ACTION_ROWS) {
        problems.push({ code: 'too-many-buttons', detail: `${total} buttons; Discord allows ${MAX_BUTTONS_PER_ROW * MAX_ACTION_ROWS}` });
      }
      for (const b of node.buttons) {
        if (b.customId.length > CUSTOM_ID_MAX) {
          problems.push({ code: 'custom-id-too-long', detail: `${b.customId.length} chars on "${b.label}"` });
        }
      }
    } else if (node.kind === 'select') {
      rows += 1;
      const s = node.select;
      if (s.options.length > MAX_SELECT_OPTIONS) {
        problems.push({ code: 'too-many-options', detail: `${s.options.length} options; Discord allows ${MAX_SELECT_OPTIONS}` });
      }
      if (s.customId.length > CUSTOM_ID_MAX) {
        problems.push({ code: 'custom-id-too-long', detail: `${s.customId.length} chars on select "${s.placeholder}"` });
      }
      if (s.minValues < 0 || s.maxValues < s.minValues || s.maxValues > s.options.length) {
        problems.push({ code: 'bad-select-range', detail: `min ${s.minValues} max ${s.maxValues} over ${s.options.length} options` });
      }
    }
  }

  if (rows > MAX_ACTION_ROWS) {
    problems.push({ code: 'too-many-rows', detail: `${rows} action rows; Discord allows ${MAX_ACTION_ROWS}` });
  }

  // The mention allow-list is the one field on a `View` that changes who gets NOTIFIED, so a
  // malformed value is caught here - at boot for a declared preview, at render for a live card
  // - rather than as a 400 from Discord with the card already half-sent. `toUserId` is the same
  // predicate `#core/ids` uses everywhere else, so "user id" means one thing in this repo.
  const mention = view.mentionUserId;
  if (mention !== undefined && !toUserId(mention).ok) {
    problems.push({ code: 'bad-mention', detail: `mentionUserId ${JSON.stringify(mention)} is not a Discord user id` });
  }
  return problems;
}
