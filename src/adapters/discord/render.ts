/**
 * `View` -> discord.js. THE PURE HALF OF THE ADAPTER: no client, no network, no clock.
 *
 * POSTMORTEMS THIS FILE CLOSES:
 *  (1) "`setCustomId` threw while rendering a card a user was already looking at." Every
 *      Discord limit that discord.js enforces by THROWING is checked here first and returned
 *      as an `AppError` with a next step. `renderView` cannot throw: the whole builder pass is
 *      bracketed, and a builder that throws anyway becomes an `AppError` too.
 *  (2) "The card pinged @everyone because the text came from a user." Every payload this file
 *      produces carries `allowed_mentions: { parse: [] }`. There is no parameter to turn it
 *      off, so no call site can forget. `View.mentionUserId` ADDS `users: [id]` beside that
 *      empty parse list - it never replaces it - so the single thing a card can notify is one
 *      user id the bot itself chose. `@everyone`, `@here` and role pings stay structurally
 *      impossible: this file cannot emit `allowed_mentions.roles` at all, so a role id put in
 *      `mentionUserId` resolves to nothing rather than to a ping.
 *  (3) "The modal rendered with a deprecation warning and Discord rejected it." Discord
 *      deprecated ActionRow-wrapped `TextInput`s; `renderForm` builds `LabelBuilder`s, which is
 *      the only supported shape in discord.js 14.27.
 *  (4) "The embed came back 400 because a field value was 1100 characters." Everything is
 *      clipped on CODE POINTS - clipping UTF-16 units mid-surrogate is how you produce a lone
 *      surrogate that SQLite stores happily and Discord rejects.
 *
 * WHY it returns raw API JSON rather than a discord.js `MessagePayload`: the channel-scoped
 * delivery path is a fresh REST call keyed on a persisted `channelId`/`messageId` (the
 * 15-minute rule), and REST takes JSON. The same JSON is accepted by `interaction.reply`, so
 * both delivery paths render through exactly one function and cannot drift.
 */

import {
  ButtonBuilder,
  ButtonStyle,
  ComponentType,
  EmbedBuilder,
  LabelBuilder,
  MessageFlags,
  ModalBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  TextDisplayBuilder,
  TextInputBuilder,
  TextInputStyle,
  type APIActionRowComponent,
  type APIComponentInMessageActionRow,
  type APIEmbed,
  type APIModalInteractionResponseCallbackData,
} from 'discord.js';
import { Err, Ok, type Result } from '#core/result';
import { errors, type AppError } from '#core/errors';
import { renderSafeMarkdown, sanitizeStored } from '#core/text';
import { CUSTOM_ID_MAX } from '#core/ids';
import type { Accent, ButtonSpec, FormSpec, Icon, LinkSpec, SelectSpec, View, ViewNode } from '#core/view';
import { MAX_BUTTONS_PER_ROW, validateView } from '#core/view';

// ---------------------------------------------------------------------------------------
// Discord's limits. Every one of these is enforced by discord.js with a THROW, or by the API
// with a 400 in front of a user. They are constants here so the tests can assert the edges.
// ---------------------------------------------------------------------------------------

/** Embed title. */
export const EMBED_TITLE_MAX = 256;
/** Embed description. */
export const EMBED_DESCRIPTION_MAX = 4096;
/** Embed field name. */
export const FIELD_NAME_MAX = 256;
/** Embed field value. */
export const FIELD_VALUE_MAX = 1024;
/** Embed fields per embed. */
export const FIELDS_MAX = 25;
/** Button label. */
export const BUTTON_LABEL_MAX = 80;
/** Select placeholder. */
export const SELECT_PLACEHOLDER_MAX = 150;
/** Select option label and value. */
export const SELECT_OPTION_MAX = 100;
/** Modal title. */
export const MODAL_TITLE_MAX = 45;
/** Label component text, in a modal. */
export const MODAL_LABEL_MAX = 45;
/** Top-level components in one modal: labelled fields plus any text display. */
export const MODAL_FIELDS_MAX = 5;
/** Label description, under the label in a modal. */
export const MODAL_DESCRIPTION_MAX = 100;
/** Text display content. */
export const TEXT_DISPLAY_MAX = 4000;
/** Options in one select menu. */
export const SELECT_OPTIONS_MAX = 25;
/** Text input value. */
export const TEXT_INPUT_MAX = 4000;

/** WHY a zero-width space: a message with no content, no embed text and only components is
 *  rejected by Discord as empty, and "the card with the buttons never posted" is a silent
 *  failure of exactly the flow this bot exists for. */
const EMPTY_DESCRIPTION = '​';

const ACCENT_COLOR: Readonly<Record<Accent, number>> = {
  ok: 0x2e_cc_71,
  warn: 0xf1_c4_0f,
  error: 0xe7_4c_3c,
  info: 0x34_98_db,
  pending: 0x9b_59_b6,
};

/**
 * WHY standard Unicode emoji are safe here: `UseExternalEmojis` gates only CUSTOM emoji from
 * other servers (`<:name:id>`). Unicode emoji are plain text, need no permission and render on
 * every client. NEVER put a custom emoji in this table: that one would need the permission, and
 * a custom emoji that fails to render is indistinguishable from a broken card.
 */
export const ICON_EMOJI: Readonly<Record<Icon, string>> = {
  info: 'ℹ️',
  ok: '✅',
  warn: '⚠️',
  error: '❌',
  build: '🔨',
  clock: '⏳',
};

function icon(i: Icon): string {
  return ICON_EMOJI[i];
}

/**
 * Clip to `max`, counting BOTH ways.
 *
 * WHY not `String#slice`: slicing UTF-16 units splits a surrogate pair, and Discord rejects the
 * lone surrogate with a 400 nobody can read. WHY not code points alone: discord.js validates
 * lengths with `String#length`, i.e. UTF-16 units, so 80 emoji is 160 units and
 * `setLabel` THROWS - verified by this file's test suite. So the budget is the tighter of the
 * two, and the cut always falls on a code-point boundary.
 */
export function clip(s: string, max: number): string {
  if (s.length <= max && [...s].length <= max) return s;
  const budget = Math.max(0, max - 1);
  const out: string[] = [];
  let used = 0;
  for (const point of s) {
    if (used + point.length > budget) break;
    out.push(point);
    used += point.length;
  }
  return `${out.join('')}…`;
}

// ---------------------------------------------------------------------------------------
// What a rendered view is
// ---------------------------------------------------------------------------------------

/**
 * A view, compiled to API JSON, ready for EITHER delivery path.
 * WHY `ephemeral` is carried rather than baked in as a flag: `editReply` may not change the
 * flags of a message that has already been sent, and the channel-scoped path has no concept of
 * ephemeral at all - so the decision belongs to the caller that owns the transport.
 */
export interface RenderedMessage {
  readonly embeds: readonly APIEmbed[];
  readonly components: readonly APIActionRowComponent<APIComponentInMessageActionRow>[];
  readonly ephemeral: boolean;
  /**
   * The one user this message may notify, or `null` for "nobody" - which is every view that
   * does not deliberately opt in.
   *
   * WHY `string | null` AND NOT AN OPTIONAL FIELD: `exactOptionalPropertyTypes` is on, so an
   * absent property and an explicitly-undefined one would be two different types for one
   * meaning, and every transport below would have to handle both.
   */
  readonly mentionUserId: string | null;
}

/**
 * The mention allow-list, in both spellings.
 *
 * `parse` is `readonly []` - the EMPTY TUPLE type, not `string[]` - so there is no assignment
 * anywhere in this repo that can put `'everyone'`, `'here'` or `'roles'` into it. That is the
 * guarantee, and it is a type rather than a convention.
 *
 * `users` is optional and, when present, holds exactly the one id the view asked for. There is
 * deliberately NO `roles` field: a role id handed to `mentionUserId` therefore has nowhere to
 * go, and pings nothing.
 */
export interface AllowedMentions {
  readonly parse: readonly [];
  readonly users?: readonly string[];
}

/** The camelCase spelling discord.js takes on an interaction reply. Same guarantees. */
export interface AllowedMentionsCamel {
  parse: [];
  users?: string[];
}

/**
 * Build the allow-list for one rendered message.
 *
 * ONE function, two spellings, so the wire path and the interaction path cannot drift - the
 * previous shape had `{ parse: [] }` written out four times, and a fifth call site is exactly
 * how one of them ends up different.
 */
function allowedMentions(m: RenderedMessage): AllowedMentions {
  return m.mentionUserId === null ? { parse: [] } : { parse: [], users: [m.mentionUserId] };
}

function allowedMentionsCamel(m: RenderedMessage): AllowedMentionsCamel {
  return m.mentionUserId === null ? { parse: [] } : { parse: [], users: [m.mentionUserId] };
}

/**
 * THE HALF OF A MENTION THAT ISN'T `allowed_mentions`, and the half that is easy to ship broken.
 *
 * A `View` renders entirely into an EMBED. Discord does not notify anybody for a mention that
 * appears inside embed text - embeds are decoration, and `<@id>` in an embed description is
 * rendered as a link and nothing else. So `allowed_mentions.users` on its own changes NOTHING:
 * it is a permission to resolve a mention, not a mention. The markup has to be in the message
 * `content`, which is the plain-text field this renderer otherwise never sets.
 *
 * Hence: one `<@id>` in `content`, and `allowed_mentions` deciding whether it resolves. Both are
 * required, and either alone is a no-op - which is exactly why they are produced together here
 * rather than left to two call sites to remember.
 *
 * WHY IT IS ALWAYS PRESENT, EMPTY STRING INCLUDED. `content` is omitted from a PATCH by leaving
 * it out, and leaving it out means "keep whatever is there". A card that pinged somebody and is
 * later edited into a state that should not would silently keep the old ping text forever. An
 * explicit `''` makes every render fully describe the message, which is the property every other
 * field of this payload already has.
 */
function mentionContent(m: RenderedMessage): string {
  return m.mentionUserId === null ? '' : `<@${m.mentionUserId}>`;
}

/** The body of a raw REST call - the channel-scoped path. Snake case, because it is the wire. */
export interface RestMessageBody {
  /** `<@id>` when the view mentions somebody, `''` otherwise. See `mentionContent`. */
  readonly content: string;
  readonly embeds: readonly APIEmbed[];
  readonly components: readonly APIActionRowComponent<APIComponentInMessageActionRow>[];
  /** WHY it is not optional: an unpingable card is the default and there is no opt-out. */
  readonly allowed_mentions: AllowedMentions;
}

/** The options object for `interaction.editReply` - no flags, ever. See `toEditBody`. */
export interface InteractionEditBody {
  content: string;
  embeds: APIEmbed[];
  components: APIActionRowComponent<APIComponentInMessageActionRow>[];
  allowedMentions: AllowedMentionsCamel;
}

/** The options object for `interaction.reply`, where `flags` may still be set. */
export interface InteractionReplyBody extends InteractionEditBody {
  flags?: MessageFlags.Ephemeral;
}

// ---------------------------------------------------------------------------------------
// The renderer
// ---------------------------------------------------------------------------------------

function viewError(detail: string): AppError {
  return errors.config(
    'view',
    detail,
    'Fix the view in the module that produced it; `validateView` in #core/view checks the same limits at boot.',
  );
}

function renderTable(head: readonly string[], rows: readonly (readonly string[])[]): string {
  const columns = Math.max(head.length, ...rows.map((r) => r.length), 1);
  const cell = (r: readonly string[], i: number): string => clip(renderSafeMarkdown(sanitizeStored(r[i] ?? '')), 40);
  const widths: number[] = [];
  for (let i = 0; i < columns; i += 1) {
    let w = [...cell(head, i)].length;
    for (const r of rows) w = Math.max(w, [...cell(r, i)].length);
    widths[i] = w;
  }
  const line = (r: readonly string[]): string =>
    widths.map((w, i) => cell(r, i).padEnd(w, ' ')).join('  ').trimEnd();
  const body = [line(head), widths.map((w) => '-'.repeat(w)).join('  '), ...rows.map(line)].join('\n');
  // `sanitizeStored` already turned any ``` in the data into ''' , so the fence cannot be
  // closed early by content.
  return `\`\`\`\n${body}\n\`\`\``;
}

function renderButton(b: ButtonSpec): Result<ButtonBuilder, AppError> {
  if (b.label.length === 0) return Err(viewError('a button has an empty label'));
  if (b.customId.length > CUSTOM_ID_MAX) {
    // Unreachable through `encodeActionRef`, which already proved the bound - but a
    // hand-branded id would otherwise reach `setCustomId`, which THROWS.
    return Err(viewError(`custom_id is ${b.customId.length} chars; Discord allows ${CUSTOM_ID_MAX}`));
  }
  const style =
    b.style === 'primary'
      ? ButtonStyle.Primary
      : b.style === 'secondary'
        ? ButtonStyle.Secondary
        : b.style === 'success'
          ? ButtonStyle.Success
          : ButtonStyle.Danger;
  return Ok(
    new ButtonBuilder()
      .setCustomId(b.customId)
      .setLabel(clip(b.label, BUTTON_LABEL_MAX))
      .setStyle(style)
      .setDisabled(b.disabled),
  );
}

function renderLink(l: LinkSpec): Result<ButtonBuilder, AppError> {
  if (l.label.length === 0) return Err(viewError('a link button has an empty label'));
  // `LinkSpec.url` is `HttpsUrl`, minted only by `parseHttpsUrl`, so a `javascript:` URL
  // cannot arrive here at all.
  return Ok(new ButtonBuilder().setStyle(ButtonStyle.Link).setURL(l.url).setLabel(clip(l.label, BUTTON_LABEL_MAX)));
}

function renderSelect(s: SelectSpec): Result<APIActionRowComponent<APIComponentInMessageActionRow>, AppError> {
  if (s.customId.length > CUSTOM_ID_MAX) {
    return Err(viewError(`select custom_id is ${s.customId.length} chars; Discord allows ${CUSTOM_ID_MAX}`));
  }
  if (s.options.length === 0) return Err(viewError('a select menu has no options'));
  const options = s.options.map((o) => {
    const builder = new StringSelectMenuOptionBuilder()
      .setLabel(clip(o.label.length === 0 ? o.value : o.label, SELECT_OPTION_MAX))
      .setValue(clip(o.value, SELECT_OPTION_MAX));
    if (o.description !== null && o.description.length > 0) {
      builder.setDescription(clip(o.description, SELECT_OPTION_MAX));
    }
    return builder;
  });
  const menu = new StringSelectMenuBuilder()
    .setCustomId(s.customId)
    .setPlaceholder(clip(s.placeholder, SELECT_PLACEHOLDER_MAX))
    .setDisabled(s.disabled)
    // Clamped rather than rejected: `validateView` already reported a bad range at boot, and a
    // live card must not die because a module computed max > options.
    .setMinValues(Math.max(0, Math.min(s.minValues, s.options.length)))
    .setMaxValues(Math.max(1, Math.min(s.maxValues, s.options.length)))
    .addOptions(options);
  return Ok({ type: ComponentType.ActionRow, components: [menu.toJSON()] });
}

/**
 * Compile a `View`.
 *
 * WHY `Result` and not a throw: this runs on the request path, and the failure has to land on
 * the card the user is looking at as a readable sentence rather than as an unhandled rejection
 * three frames inside discord.js.
 */
export function renderView(view: View): Result<RenderedMessage, AppError> {
  const problems = validateView(view);
  if (problems.length > 0) {
    return Err(viewError(problems.map((p) => `${p.code}: ${p.detail}`).join('; ')));
  }

  const embed = new EmbedBuilder().setColor(ACCENT_COLOR[view.accent]);
  const rows: APIActionRowComponent<APIComponentInMessageActionRow>[] = [];
  const description: string[] = [];
  const fields: { name: string; value: string }[] = [];
  let title: string | null = null;

  try {
    for (const node of view.nodes) {
      const done = renderNode(node, {
        push: (s) => void description.push(s),
        field: (name, value) => void fields.push({ name, value }),
        row: (r) => void rows.push(r),
        heading: (text) => {
          if (title === null) title = text;
          else description.push(`**${text}**`);
        },
      });
      if (!done.ok) return done;
    }
  } catch (cause: unknown) {
    // Defence in depth: a builder that validates something we did not anticipate must produce
    // an `AppError`, never an unhandled rejection that takes the process down.
    return Err(viewError(`discord.js rejected the view: ${cause instanceof Error ? cause.message : 'unknown'}`));
  }

  if (title !== null) embed.setTitle(clip(title, EMBED_TITLE_MAX));
  const body = description.join('\n');
  if (body.length > 0) embed.setDescription(clip(body, EMBED_DESCRIPTION_MAX));
  else if (title === null && fields.length === 0) embed.setDescription(EMPTY_DESCRIPTION);
  if (fields.length > 0) {
    embed.addFields(fields.slice(0, FIELDS_MAX).map((f) => ({ name: f.name, value: f.value })));
  }

  return Ok({
    embeds: [embed.toJSON()],
    components: rows,
    ephemeral: view.ephemeral === true,
    // `validateView` above already refused a `mentionUserId` that is not snowflake-shaped, so
    // by here it is either absent or an id. Note what is NOT read anywhere in this function:
    // the TEXT of any node. A mention is a decision the caller made about a persisted id, not
    // something parsed out of what somebody typed.
    mentionUserId: view.mentionUserId ?? null,
  });
}

interface NodeSink {
  push(line: string): void;
  field(name: string, value: string): void;
  row(r: APIActionRowComponent<APIComponentInMessageActionRow>): void;
  heading(text: string): void;
}

/** WHY split out: `renderView` stays readable, and the switch stays exhaustive on `ViewNode`. */
function renderNode(node: ViewNode, sink: NodeSink): Result<void, AppError> {
  switch (node.kind) {
    case 'text':
      sink.push(renderSafeMarkdown(node.md));
      return Ok(undefined);
    case 'heading':
      sink.heading(`${icon(node.icon)} ${node.text}`);
      return Ok(undefined);
    case 'field':
      sink.field(
        clip(node.name.length === 0 ? '​' : node.name, FIELD_NAME_MAX),
        clip(renderSafeMarkdown(node.md) || '​', FIELD_VALUE_MAX),
      );
      return Ok(undefined);
    case 'table':
      sink.push(renderTable(node.head, node.rows));
      return Ok(undefined);
    case 'divider':
      sink.push('─'.repeat(20));
      return Ok(undefined);
    case 'buttons': {
      const built: ButtonBuilder[] = [];
      for (const b of node.buttons) {
        const r = renderButton(b);
        if (!r.ok) return r;
        built.push(r.value);
      }
      for (const l of node.links) {
        const r = renderLink(l);
        if (!r.ok) return r;
        built.push(r.value);
      }
      for (let i = 0; i < built.length; i += MAX_BUTTONS_PER_ROW) {
        sink.row({
          type: ComponentType.ActionRow,
          components: built.slice(i, i + MAX_BUTTONS_PER_ROW).map((b) => b.toJSON()),
        });
      }
      return Ok(undefined);
    }
    case 'select': {
      const r = renderSelect(node.select);
      if (!r.ok) return r;
      sink.row(r.value);
      return Ok(undefined);
    }
    default: {
      const exhaustive: never = node;
      void exhaustive;
      return Err(viewError('unknown view node'));
    }
  }
}

// ---------------------------------------------------------------------------------------
// Transport shapes
// ---------------------------------------------------------------------------------------

/** The channel-scoped body: what goes over raw REST, minutes or hours after the click. */
export function toRestBody(m: RenderedMessage): RestMessageBody {
  return {
    content: mentionContent(m),
    embeds: m.embeds,
    components: m.components,
    allowed_mentions: allowedMentions(m),
  };
}

/**
 * The body for EDITING an interaction reply.
 *
 * WHY it is a different function from `toReplyBody` rather than a flag: `flags` may be set
 * when a reply is CREATED and never when it is edited - discord.js's own
 * `InteractionEditReplyOptions` does not even accept `Ephemeral` - and discovering that from
 * an `editReply` in production is the sort of thing that only ever happens on the ephemeral
 * path, i.e. in front of one user with no logs to look at.
 */
export function toEditBody(m: RenderedMessage): InteractionEditBody {
  return {
    content: mentionContent(m),
    embeds: [...m.embeds],
    components: [...m.components],
    allowedMentions: allowedMentionsCamel(m),
  };
}

/** The body for CREATING an interaction reply, where ephemeral is still decidable. */
export function toReplyBody(m: RenderedMessage): InteractionReplyBody {
  const base = toEditBody(m);
  return m.ephemeral ? { ...base, flags: MessageFlags.Ephemeral } : base;
}

// ---------------------------------------------------------------------------------------
// Resolving a card
// ---------------------------------------------------------------------------------------

function isRecord(v: unknown): v is Readonly<Record<string, unknown>> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function disableOne(component: unknown): unknown {
  if (!isRecord(component)) return component;
  // A link button has no `custom_id`, so disabling it only takes away a working link - which
  // on a resolved build card is the link to the pull request.
  if (component['type'] === ComponentType.Button && component['style'] === ButtonStyle.Link) return component;
  return { ...component, disabled: true };
}

/**
 * The same components, with every control disabled.
 *
 * WHY it takes `unknown`: `DiscordPort.disableComponents` reads the message back from Discord
 * and hands the SAME components straight back with `disabled: true`. Re-rendering an empty row
 * instead would silently delete the history of what the card offered, and re-rendering the
 * view would need state the adapter does not have. Anything it does not recognise is passed
 * through untouched, so a component type added by Discord next year degrades to "still there"
 * rather than "deleted".
 */
export function disableComponentsJson(raw: unknown): unknown[] {
  if (!Array.isArray(raw)) return [];
  const rows: readonly unknown[] = raw;
  return rows.map((row) => {
    if (!isRecord(row)) return row;
    const inner = row['components'];
    if (!Array.isArray(inner)) return row;
    const components: readonly unknown[] = inner;
    return { ...row, components: components.map(disableOne) };
  });
}

// ---------------------------------------------------------------------------------------
// Modals
// ---------------------------------------------------------------------------------------

/**
 * Compile a `FormSpec` into a modal.
 *
 * DISCORD DEPRECATED ACTION-ROW-WRAPPED TEXT INPUTS, and `TextInputBuilder#setLabel` with
 * them. The supported shape in discord.js 14.27 is a `LabelBuilder` per field, carrying the
 * label, the optional description and the input itself - which is what this builds.
 */
export function renderForm(form: FormSpec): Result<APIModalInteractionResponseCallbackData, AppError> {
  if (form.customId.length > CUSTOM_ID_MAX) {
    return Err(viewError(`modal custom_id is ${form.customId.length} chars; Discord allows ${CUSTOM_ID_MAX}`));
  }
  if (form.fields.length === 0) return Err(viewError('a modal must have at least one field'));
  // The intro is a top-level component too, so it spends one of Discord's five slots.
  const components = form.fields.length + (form.intro === null ? 0 : 1);
  if (components > MODAL_FIELDS_MAX) {
    return Err(viewError(`${components} modal components (fields plus intro); Discord allows ${MODAL_FIELDS_MAX}`));
  }

  const modal = new ModalBuilder().setCustomId(form.customId).setTitle(clip(form.title, MODAL_TITLE_MAX));
  try {
    if (form.intro !== null) {
      modal.addTextDisplayComponents(new TextDisplayBuilder().setContent(clip(renderSafeMarkdown(sanitizeStored(form.intro)), TEXT_DISPLAY_MAX)));
    }
    for (const f of form.fields) {
      if (f.name.length === 0 || f.name.length > CUSTOM_ID_MAX) {
        return Err(viewError(`modal field name ${JSON.stringify(f.name)} must be 1..${CUSTOM_ID_MAX} characters`));
      }
      const label = new LabelBuilder().setLabel(clip(f.label.length === 0 ? f.name : f.label, MODAL_LABEL_MAX));
      if (f.description !== null && f.description.length > 0) {
        label.setDescription(clip(f.description, MODAL_DESCRIPTION_MAX));
      }
      if (f.kind === 'select') {
        if (f.options.length === 0 || f.options.length > SELECT_OPTIONS_MAX) {
          return Err(viewError(`modal dropdown ${JSON.stringify(f.name)} has ${f.options.length} options; Discord allows 1..${SELECT_OPTIONS_MAX}`));
        }
        const select = new StringSelectMenuBuilder()
          .setCustomId(f.name)
          .setRequired(f.required)
          .setMinValues(f.required ? 1 : 0)
          .setMaxValues(1)
          .addOptions(
            f.options.map((o) => {
              const opt = new StringSelectMenuOptionBuilder()
                .setLabel(clip(o.label.length === 0 ? o.value : o.label, SELECT_OPTION_MAX))
                .setValue(clip(o.value, SELECT_OPTION_MAX));
              if (o.description !== null) opt.setDescription(clip(o.description, SELECT_OPTION_MAX));
              return opt;
            }),
          );
        if (f.placeholder.length > 0) select.setPlaceholder(clip(f.placeholder, SELECT_OPTION_MAX));
        modal.addLabelComponents(label.setStringSelectMenuComponent(select));
        continue;
      }
      const input = new TextInputBuilder()
        .setCustomId(f.name)
        .setStyle(f.style === 'paragraph' ? TextInputStyle.Paragraph : TextInputStyle.Short)
        .setRequired(f.required)
        .setMaxLength(Math.max(1, Math.min(f.maxLength, TEXT_INPUT_MAX)));
      if (f.placeholder.length > 0) input.setPlaceholder(clip(f.placeholder, SELECT_OPTION_MAX));
      modal.addLabelComponents(label.setTextInputComponent(input));
    }
    return Ok(modal.toJSON());
  } catch (cause: unknown) {
    return Err(viewError(`discord.js rejected the modal: ${cause instanceof Error ? cause.message : 'unknown'}`));
  }
}
