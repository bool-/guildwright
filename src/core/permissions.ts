/**
 * Discord bot permissions (SC-12).
 *
 * WHY the names live in core as a union rather than as discord.js's `PermissionFlagsBits`:
 * core may not import discord.js, and more importantly a command declares
 * `needs: ['SendMessages']` so the router PREFLIGHTS against the interaction's
 * `app_permissions` field - zero API calls, always fresh - instead of discovering a 403.
 * Provoked 403s count toward Discord's 10,000-invalid-requests-per-10-minutes Cloudflare ban
 * threshold, so discovering them is not free.
 *
 * WHY the BIT VALUES live here too: the "missing permissions" card offers a one-click
 * re-invite link containing the exact integer, and computing that integer in an adapter would
 * put the numbers two files away from the names. `permissions.test.ts` asserts every entry
 * against `discord-api-types`, because a hand-maintained bit table is exactly the sort of
 * thing that ships with `CreatePublicThreads` set to ManageThreads' bit.
 */

/** WHY a union and not an `enum`: `erasableSyntaxOnly` bans `enum` (TS1294), and a union
 *  gives a typo TS2322 at the declaration site anyway. */
export type DiscordPermission =
  | 'ViewChannel'
  | 'SendMessages'
  | 'SendMessagesInThreads'
  | 'CreatePublicThreads'
  | 'CreatePrivateThreads'
  | 'EmbedLinks'
  | 'AttachFiles'
  | 'ReadMessageHistory'
  | 'AddReactions'
  | 'UseExternalEmojis'
  | 'UseApplicationCommands'
  | 'ManageMessages'
  | 'ManageThreads'
  | 'MentionEveryone'
  | 'ManageGuild'
  | 'ManageRoles';

/** WHY `bigint`: several flags are above 2^53, so `number` silently loses them. */
export const PERMISSION_BITS: Readonly<Record<DiscordPermission, bigint>> = {
  ViewChannel: 1n << 10n,
  SendMessages: 1n << 11n,
  SendMessagesInThreads: 1n << 38n,
  // 35, not 34. 34 is ManageThreads, and getting this wrong makes the re-invite link grant
  // the wrong permission for the exact flow that opens a build-log thread.
  CreatePublicThreads: 1n << 35n,
  CreatePrivateThreads: 1n << 36n,
  EmbedLinks: 1n << 14n,
  AttachFiles: 1n << 15n,
  ReadMessageHistory: 1n << 16n,
  AddReactions: 1n << 6n,
  UseExternalEmojis: 1n << 18n,
  UseApplicationCommands: 1n << 31n,
  ManageMessages: 1n << 13n,
  ManageThreads: 1n << 34n,
  MentionEveryone: 1n << 17n,
  ManageGuild: 1n << 5n,
  ManageRoles: 1n << 28n,
};

/**
 * WHY there is deliberately no `checkAdmin` short-circuit anywhere in this repo:
 * `guild-admin` is `(permissions & ManageGuild) === ManageGuild` with NO Administrator
 * expansion. Anything shaped like `PermissionsBitField#missing()` is banned - its admin
 * short-circuit is the mechanism behind the known framework DM-context bypass (SC-7).
 */
export function missingPermissions(
  appPermissions: bigint,
  needed: readonly DiscordPermission[],
): readonly DiscordPermission[] {
  return needed.filter((n) => (appPermissions & PERMISSION_BITS[n]) !== PERMISSION_BITS[n]);
}

/** WHY one function: the re-invite link needs one integer and only this file knows the bits. */
export function permissionInteger(names: readonly DiscordPermission[]): bigint {
  let bits = 0n;
  for (const n of names) bits |= PERMISSION_BITS[n];
  return bits;
}

/** WHY here and not in the policy resolver: it is a bit test, and the bits live here. */
export function hasManageGuild(appPermissions: bigint): boolean {
  return (appPermissions & PERMISSION_BITS.ManageGuild) === PERMISSION_BITS.ManageGuild;
}
