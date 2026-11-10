/**
 * The renderer is the only part of the Discord adapter that is worth unit-testing, because it
 * is the only part that is pure - and it is also where every "discord.js threw at render time"
 * incident happened. Each test below is one of those incidents.
 */

import { deepStrictEqual, ok, strictEqual } from 'node:assert/strict';
import { test } from 'node:test';
import { ComponentType, MessageFlags } from 'discord.js';
import { assertActionRef, newCardNonce, newRequestId } from '#core/ids';
import { md, parseHttpsUrl, sanitizeStored } from '#core/text';
import type { ButtonSpec, FormSpec, View } from '#core/view';
import {
  BUTTON_LABEL_MAX,
  ICON_EMOJI,
  clip,
  disableComponentsJson,
  renderForm,
  renderView,
  toEditBody,
  toReplyBody,
  toRestBody,
} from '#adapters/discord/render';

/** A high or low surrogate with no partner - exactly what a naive `slice` produces. */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u;

function customId(action: string): ButtonSpec['customId'] {
  return assertActionRef({ moduleId: 'builder', action, entityId: newRequestId(0), nonce: newCardNonce() });
}

function button(action: string, label: string, disabled = false): ButtonSpec {
  return { customId: customId(action), label, style: 'primary', disabled };
}

function isRecord(v: unknown): v is Readonly<Record<string, unknown>> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

test('a heading becomes the embed title and the accent becomes the colour', () => {
  const view: View = {
    accent: 'pending',
    nodes: [
      { kind: 'heading', text: 'Build request', icon: 'build' },
      { kind: 'text', md: md`An approver must approve this.` },
      { kind: 'field', name: 'Issue', md: md`#42` },
    ],
  };
  const r = renderView(view);
  ok(r.ok);
  const embed = r.value.embeds[0];
  ok(embed !== undefined);
  strictEqual(embed.color, 0x9b_59_b6);
  strictEqual(embed.title, '🔨 Build request');
  strictEqual(embed.description, 'An approver must approve this.');
  deepStrictEqual(embed.fields, [{ name: 'Issue', value: '#42' }]);
});

test('buttons past the fifth start a second action row instead of throwing', () => {
  const view: View = {
    accent: 'info',
    nodes: [
      {
        kind: 'buttons',
        links: [],
        buttons: ['a', 'b', 'c', 'd', 'e', 'f'].map((n) => button(n, n)),
      },
    ],
  };
  const r = renderView(view);
  ok(r.ok);
  strictEqual(r.value.components.length, 2);
  strictEqual(r.value.components[0]?.components.length, 5);
  strictEqual(r.value.components[1]?.components.length, 1);
});

test('a view Discord would reject comes back as an AppError, not an exception', () => {
  const options = Array.from({ length: 26 }, (_, i) => ({ label: `o${i}`, value: `v${i}`, description: null }));
  const view: View = {
    accent: 'info',
    nodes: [
      {
        kind: 'select',
        select: {
          customId: customId('pick'),
          placeholder: 'Pick one',
          options,
          minValues: 1,
          maxValues: 1,
          disabled: false,
        },
      },
    ],
  };
  const r = renderView(view);
  ok(!r.ok);
  strictEqual(r.error.kind, 'config');
  ok(r.error.internal?.includes('too-many-options'));
  // The user-facing sentence still carries a next step - a dead end is a bug (errors.ts).
  ok(r.error.nextStep.length > 0);
});

test('an over-long button label is clipped rather than rejected by Discord', () => {
  const view: View = {
    accent: 'ok',
    nodes: [{ kind: 'buttons', links: [], buttons: [button('go', '\u{1F642}'.repeat(200))] }],
  };
  const r = renderView(view);
  ok(r.ok);
  const first = r.value.components[0]?.components[0];
  ok(first !== undefined && first.type === ComponentType.Button && 'label' in first);
  const label = first.label ?? '';
  // discord.js validates with String#length, so the UTF-16 bound is the one that throws.
  ok(label.length <= BUTTON_LABEL_MAX, `label was ${label.length} UTF-16 units`);
  ok(!LONE_SURROGATE.test(label), 'a lone surrogate is a 400 from Discord');
});

test('a table cell cannot close the code fence it is rendered inside', () => {
  const view: View = {
    accent: 'info',
    nodes: [{ kind: 'table', head: ['name'], rows: [['```\n@everyone']] }],
  };
  const r = renderView(view);
  ok(r.ok);
  const description = r.value.embeds[0]?.description ?? '';
  strictEqual(description.split('```').length - 1, 2, 'exactly the opening and closing fence');
  ok(!description.includes('@everyone'));
});

test('every payload is unpingable, on both delivery paths', () => {
  const view: View = { accent: 'warn', nodes: [{ kind: 'text', md: sanitizeStored('@everyone hi') }] };
  const r = renderView(view);
  ok(r.ok);
  deepStrictEqual(toRestBody(r.value).allowed_mentions, { parse: [] });
  deepStrictEqual(toReplyBody(r.value).allowedMentions, { parse: [] });
  deepStrictEqual(toEditBody(r.value).allowedMentions, { parse: [] });
  ok(!(r.value.embeds[0]?.description ?? '').includes('@everyone'));
});

test('ephemeral is a flag on create and never on edit', () => {
  const view: View = { accent: 'info', ephemeral: true, nodes: [{ kind: 'text', md: md`only you` }] };
  const r = renderView(view);
  ok(r.ok);
  strictEqual(r.value.ephemeral, true);
  strictEqual(toReplyBody(r.value).flags, MessageFlags.Ephemeral);
  // Discord rejects a flag change on an existing message, so the edit body cannot carry one.
  strictEqual('flags' in toEditBody(r.value), false);
});

test('a view with only buttons still carries something Discord will accept as a message', () => {
  const view: View = { accent: 'ok', nodes: [{ kind: 'buttons', links: [], buttons: [button('go', 'Go')] }] };
  const r = renderView(view);
  ok(r.ok);
  ok((r.value.embeds[0]?.description ?? '').length > 0, 'an empty message is rejected by Discord');
});

test('disabling a card disables its controls and leaves link buttons alone', () => {
  const url = parseHttpsUrl('https://github.com/o/r/pull/7');
  ok(url.ok);
  const view: View = {
    accent: 'ok',
    nodes: [{ kind: 'buttons', buttons: [button('go', 'Go')], links: [{ label: 'PR', url: url.value }] }],
  };
  const r = renderView(view);
  ok(r.ok);
  // The port hands this the raw JSON Discord echoed back, so the test does too.
  const disabled = disableComponentsJson(r.value.components);
  const row = disabled[0];
  ok(isRecord(row));
  const inner = row['components'];
  ok(Array.isArray(inner));
  const [first, second] = inner as readonly unknown[];
  ok(isRecord(first));
  strictEqual(first['disabled'], true);
  ok(isRecord(second));
  strictEqual(second['disabled'], undefined, 'a link button keeps working - it is the PR link');
});

test('a modal is built from LabelBuilder, not the deprecated action-row wrapper', () => {
  const form: FormSpec = {
    customId: customId('details'),
    title: 'Describe the change',
    intro: null,
    fields: [
      {
        kind: 'text',
        name: 'problem',
        description: null,
        label: 'What is wrong?',
        style: 'paragraph',
        required: true,
        maxLength: 2000,
        placeholder: 'It crashes when...',
      },
      { kind: 'text', name: 'priority', label: 'Priority', description: null, style: 'short', required: false, maxLength: 20, placeholder: '' },
    ],
  };
  const r = renderForm(form);
  ok(r.ok);
  strictEqual(r.value.components.length, 2);
  for (const c of r.value.components) {
    strictEqual(c.type, ComponentType.Label, 'Discord deprecated ActionRow-wrapped TextInputs');
  }
  const label = r.value.components[0];
  ok(label !== undefined && label.type === ComponentType.Label);
  strictEqual(label.component.type, ComponentType.TextInput);
  strictEqual(label.component.custom_id, 'problem');
});

test('a modal Discord would reject is an AppError, not a throw', () => {
  const fields = Array.from({ length: 6 }, (_, i) => ({
    kind: 'text' as const,
    description: null,
    name: `f${i}`,
    label: `Field ${i}`,
    style: 'short' as const,
    required: false,
    maxLength: 100,
    placeholder: '',
  }));
  const r = renderForm({ customId: customId('big'), title: 'Too many', intro: null, fields });
  ok(!r.ok);
  ok(r.error.internal?.includes('Discord allows 5'));
});

test('clip never splits a surrogate pair', () => {
  const clipped = clip('\u{1F642}\u{1F642}\u{1F642}', 4);
  ok(!LONE_SURROGATE.test(clipped));
  ok(clipped.length <= 4);
  strictEqual(clip('abc', 10), 'abc');
});

// ---------------------------------------------------------------------------------------
// Mentions - the one thing on a `View` that decides who gets NOTIFIED.
//
// `allowed_mentions: { parse: [] }` was hardcoded and un-overridable, which was right as a
// default and wrong as a total ban: it made an `@everyone` in user text permanently inert, and
// it also meant a build that finished twenty minutes after the click was delivered by an edit
// that notified nobody. `View.mentionUserId` adds `users: [id]` BESIDE the empty parse list.
//
// The two properties below are what make that safe, and they are properties of the SHAPE
// rather than of a check somebody has to remember to run.
// ---------------------------------------------------------------------------------------

/** A real-looking user snowflake. */
const REQUESTER = '400000000000000001';
/** A real-looking ROLE snowflake. Structurally identical to the one above - that is the point. */
const ROLE = '500000000000000002';

test('an @everyone in the TEXT still cannot ping, even on a view that mentions someone', () => {
  // The worst case: hostile text AND a legitimate mention on the same card. That combination is
  // exactly what a build-finished card is - the description carries whatever the requester
  // typed into the modal, and the card is meant to notify them.
  const view: View = {
    accent: 'ok',
    mentionUserId: REQUESTER,
    nodes: [
      { kind: 'text', md: md`${sanitizeStored('@everyone @here <@&' + ROLE + '> ship it')}` },
      { kind: 'field', name: '@everyone', md: md`${sanitizeStored('<@&' + ROLE + '>')}` },
    ],
  };
  const r = renderView(view);
  ok(r.ok);

  for (const mentions of [toRestBody(r.value).allowed_mentions, toReplyBody(r.value).allowedMentions, toEditBody(r.value).allowedMentions]) {
    // `parse: []` IS the guarantee. `@everyone`, `@here` and every role ping are resolved by
    // Discord ONLY when the corresponding word is in `parse`, so an empty parse list makes all
    // three impossible for any text in any node, whoever wrote it.
    deepStrictEqual([...mentions.parse], []);
    // And there is no `roles` key to smuggle one into. Not empty - ABSENT.
    strictEqual('roles' in mentions, false);
    strictEqual('everyone' in mentions, false);
    deepStrictEqual([...(mentions.users ?? [])], [REQUESTER]);
  }
});

test('a role id in mentionUserId pings nothing, because there is nowhere for it to go', () => {
  // A role snowflake and a user snowflake are the same shape, so no validator can tell them
  // apart. What stops a role ping is that this renderer cannot emit `allowed_mentions.roles`
  // AT ALL: a role id put in `users` is simply an id that matches no user, and Discord resolves
  // nothing. The defence is the absence of a field, not a check.
  const view: View = {
    accent: 'info',
    mentionUserId: ROLE,
    nodes: [{ kind: 'text', md: md`${sanitizeStored('<@&' + ROLE + '> deploy now')}` }],
  };
  const r = renderView(view);
  ok(r.ok);
  const body = toRestBody(r.value);
  deepStrictEqual([...body.allowed_mentions.parse], []);
  strictEqual('roles' in body.allowed_mentions, false);
  deepStrictEqual([...(body.allowed_mentions.users ?? [])], [ROLE], 'it lands in users, where it resolves to nobody');
});

test('a view that mentions nobody carries no users key at all, so the default is unchanged', () => {
  const view: View = { accent: 'info', nodes: [{ kind: 'text', md: md`nothing to see` }] };
  const r = renderView(view);
  ok(r.ok);
  strictEqual(r.value.mentionUserId, null);
  deepStrictEqual(toRestBody(r.value).allowed_mentions, { parse: [] });
  deepStrictEqual(toEditBody(r.value).allowedMentions, { parse: [] });
});

test('a mentionUserId that is not a user snowflake is an AppError, not a 400 from Discord', () => {
  // Boot runs `validateView` over every declared preview, and `renderView` runs it again on the
  // live path, so a malformed id is caught in both places - never as a rejected message in
  // front of somebody with the card half-sent.
  for (const bad of ['everyone', '@' + REQUESTER, '12', `${REQUESTER}<@&${ROLE}>`]) {
    const r = renderView({ accent: 'info', mentionUserId: bad, nodes: [{ kind: 'text', md: md`hi` }] });
    ok(!r.ok, `${bad} must not render`);
    ok(r.error.internal?.includes('bad-mention'), r.error.internal ?? '(no detail)');
  }
});

test('the mention markup goes in CONTENT, because a mention inside an embed notifies nobody', () => {
  // THE HALF THAT IS EASY TO SHIP BROKEN. `allowed_mentions.users` is permission to RESOLVE a
  // mention, not a mention - and a `View` renders entirely into an embed, where `<@id>` is a
  // link and never a notification. Both halves, or the feature is a no-op that looks wired.
  const view: View = {
    accent: 'ok',
    mentionUserId: REQUESTER,
    nodes: [{ kind: 'heading', text: 'Pull request opened', icon: 'ok' }],
  };
  const r = renderView(view);
  ok(r.ok);
  strictEqual(toRestBody(r.value).content, `<@${REQUESTER}>`);
  strictEqual(toReplyBody(r.value).content, `<@${REQUESTER}>`);
  strictEqual(toEditBody(r.value).content, `<@${REQUESTER}>`);
});

test('a view with no mention sends an EMPTY content, so an edit cannot keep an old ping', () => {
  // `content` omitted from a PATCH means "keep what is there". A card that pinged somebody and
  // is later edited into a state that should not would otherwise carry the ping text forever.
  const r = renderView({ accent: 'info', nodes: [{ kind: 'text', md: md`quiet` }] });
  ok(r.ok);
  strictEqual(toRestBody(r.value).content, '');
  strictEqual(toEditBody(r.value).content, '');
});

test('a modal intro renders as a text display, and spends one of the five slots', () => {
  const field = (i: number) => ({
    kind: 'text' as const,
    name: `f${i}`,
    label: `Field ${i}`,
    description: null,
    style: 'short' as const,
    required: false,
    maxLength: 100,
    placeholder: '',
  });
  const four = renderForm({ customId: customId('intro'), title: 'Four plus intro', intro: 'Read this first.', fields: [0, 1, 2, 3].map(field) });
  ok(four.ok, 'an intro plus four fields is exactly the budget');
  strictEqual(four.value.components.length, 5);
  const first = four.value.components[0];
  strictEqual(first?.type, ComponentType.TextDisplay, 'the intro comes first, above the fields');
  ok(first?.type === ComponentType.TextDisplay && first.content === 'Read this first.');

  const five = renderForm({ customId: customId('intro'), title: 'Five plus intro', intro: 'Read this first.', fields: [0, 1, 2, 3, 4].map(field) });
  ok(!five.ok, 'five fields plus an intro is six components, one over the limit');
  ok(five.error.internal?.includes('Discord allows 5'));
});

test('a modal field description sits under its label, and a dropdown is a labelled string select', () => {
  const r = renderForm({
    customId: customId('kinds'),
    title: 'Pick one',
    intro: null,
    fields: [
      { kind: 'text', name: 'what', label: 'What?', description: 'Who needs it.', style: 'short', required: true, maxLength: 50, placeholder: '' },
      {
        kind: 'select',
        name: 'kind',
        label: 'Kind',
        description: null,
        required: true,
        placeholder: 'Pick one',
        options: [
          { label: 'Fix a bug', value: 'fix', description: 'Something is broken.' },
          { label: 'Change something', value: 'change', description: null },
        ],
      },
    ],
  });
  ok(r.ok);
  const [text, select] = r.value.components;
  ok(text?.type === ComponentType.Label);
  strictEqual(text.description, 'Who needs it.');
  ok(select?.type === ComponentType.Label);
  strictEqual(select.description, undefined, 'a null description is omitted, not sent empty');
  ok(select.component.type === ComponentType.StringSelect);
  strictEqual(select.component.custom_id, 'kind');
  strictEqual(select.component.max_values, 1);
  strictEqual(select.component.min_values, 1, 'required means one must be picked');
  deepStrictEqual(select.component.options.map((o) => o.value), ['fix', 'change']);
});

test('a dropdown with no options is refused before Discord sees it', () => {
  const r = renderForm({
    customId: customId('empty'),
    title: 'Empty',
    intro: null,
    fields: [{ kind: 'select', name: 'kind', label: 'Kind', description: null, required: true, placeholder: '', options: [] }],
  });
  ok(!r.ok);
  ok(r.error.internal?.includes('options'));
});

test('card icons are standard emoji, never custom ones that would need UseExternalEmojis', () => {
  for (const [name, glyph] of Object.entries(ICON_EMOJI)) {
    ok(!glyph.includes('<:') && !glyph.includes('<a:'), `${name} must not be a custom emoji`);
    ok(/\p{Extended_Pictographic}/u.test(glyph), `${name} is an emoji, not an ASCII stand-in`);
  }
});
