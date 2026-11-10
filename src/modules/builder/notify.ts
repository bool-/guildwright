/**
 * TELLING THE PERSON WHO IS WAITING - one message per request, and the ending notifies.
 *
 * DISCORD NOTIFIES ON MESSAGE CREATE, NOT ON MESSAGE EDIT. Editing a card to add `<@id>`
 * renders the mention and pings nobody, so an ending that only edits leaves the requester
 * uninformed. The first fix posted a second, shorter "notice" under the edited card, which is
 * what made every finished build show up as two messages saying the same thing.
 *
 * THE RULE NOW: an ending that has somebody to tell is POSTED as the final card, and the stale
 * card it replaces is deleted - one request, one message, at the bottom of the channel where
 * the requester will see it. An ending with nobody to tell (the requester did it themselves)
 * edits the card in place, because moving it would only shuffle the scrollback.
 *
 * WHY THE POST COMES FIRST AND FAILURES ARE SWALLOWED: by the time this runs the state change
 * has committed and the money is spent. If the post fails the old card is edited instead, and
 * if the delete fails there are two cards with the newer one below - both strictly better than
 * a finished build reported as nothing.
 */

import type { DiscordPort } from '#core/ports';
import type { SurfaceRef, View } from '#core/view';
import { toChannelId } from '#core/ids';

/** The calls this file makes. Narrow on purpose: it cannot dispatch, spend or write a row. */
export type NotifyDiscord = Pick<DiscordPort, 'post' | 'edit' | 'delete'>;

/**
 * Deliver a terminal card. Returns where the card now lives, which the caller persists so a
 * later `/request retry` or `/request cancel` edits the message that still exists.
 */
export async function deliverOutcome(discord: NotifyDiscord, surface: SurfaceRef, card: View): Promise<SurfaceRef> {
  const channel = toChannelId(surface.channelId);
  if (card.mentionUserId === undefined || !channel.ok) {
    await discord.edit(surface, card);
    return surface;
  }
  const posted = await discord.post(channel.value, card);
  if (!posted.ok) {
    await discord.edit(surface, card);
    return surface;
  }
  await discord.delete(surface);
  return posted.value;
}
