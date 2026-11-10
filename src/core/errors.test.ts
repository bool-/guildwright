import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CONFIG_USER_TEXT, describeWait, errors, humanizePermission, userMessage } from '#core/errors';
import { mdMention, renderSafeMarkdown } from '#core/text';

test('a config error never shows its developer hint to a user', () => {
  const e = errors.config('db.table', 'a module touched table x', 'Fix ./migrations/*.sql in the module.');
  assert.equal(userMessage(e), CONFIG_USER_TEXT);
  assert.ok(!userMessage(e).includes('migrations'));
});

test('an internal error body is only the id to report, in code', () => {
  const e = errors.internal('rq_1', 'secret detail');
  assert.equal(userMessage(e), 'Report this id to an admin: `rq_1`');
});

test('forbidden says what is needed; self-approval has its own text', () => {
  const f = errors.forbidden('demo.approve', 'a server manager', 'Ask a server manager to run `/access grant demo.approve`.');
  assert.equal(f.userDetail, 'You need `demo.approve`.');
  const s = errors.forbiddenSelfApproval('builder.approve');
  assert.equal(userMessage(s), "You can't approve your own request. Ask another approver.");
});

test('a rate limit carries its own detail, and an upstream limit blames the service', () => {
  const r = errors.rateLimited('github', 30_000, 'Nothing was lost. Try again in 30 seconds.', 'GitHub is rate-limiting the bot.');
  assert.equal(userMessage(r), 'GitHub is rate-limiting the bot. Nothing was lost. Try again in 30 seconds.');
  assert.equal(describeWait(90_000), '2 minutes');
});

test('upstream detail names the service; permission flags are humanised', () => {
  assert.equal(errors.upstream('github', 422, 'Try again.').userDetail, 'GitHub rejected that request.');
  assert.equal(errors.upstream('discord', 500, 'Try again.').userDetail, 'Discord rejected that request.');
  assert.equal(humanizePermission('SendMessages'), 'Send Messages');
  assert.equal(
    errors.missingBotPermission(['SendMessages', 'EmbedLinks'], 1n, 'x').userDetail,
    "I can't post here: missing Send Messages, Embed Links.",
  );
});

test('mdMention renders a real mention for a snowflake and code for anything else', () => {
  assert.equal(renderSafeMarkdown(mdMention('user', '200000000000000001')), '<@200000000000000001>');
  assert.equal(renderSafeMarkdown(mdMention('role', '300000000000000001')), '<@&300000000000000001>');
  assert.equal(renderSafeMarkdown(mdMention('user', 'x')), '`x`');
});
