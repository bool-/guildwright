/**
 * Authorization vocabulary (SC-7, SC-8).
 *
 * POSTMORTEM THIS FILE CLOSES: "the Approve button was gated on
 * `interaction.user.id === requester.id`, so anyone who could see the card could approve
 * someone else's build."
 *
 * THREE MECHANISMS, and the third is the one the previous designs were missing:
 *  (1) `permission` is a REQUIRED field of every `CommandSpec`, `ActionSpec`, `HookSpec` and
 *      `JobSpec`. Omitting it is TS2741, so an unguarded entry point is not expressible.
 *  (2) `PermissionRef` is an opaque object carrying a module-private symbol, so an object
 *      literal cannot forge one (TS2741) and it carries NO `fallback` - a forger must not be
 *      able to pick its own L2 answer, so the resolver looks the declaration up in the
 *      registry instead.
 *  (3) The registry CROSS-CHECKS at boot that every ref a module used is either `PUBLIC` or a
 *      key that module itself declared, over commands AND actions AND hooks AND jobs. The
 *      minting function below is loader-only by convention; this check is what makes it true.
 */

const REF = Symbol('core.policy.permissionRef');

/**
 * A resolved permission key, tied to the module that declared it.
 * WHY no `fallback` field: an authorization answer travelling as data on the thing being
 * authorized is how a forged ref picks `everyone`. The resolver reads the DECLARATION.
 */
export interface PermissionRef {
  readonly [REF]: true;
  /** Declaring module. Written to `core_audit.module_id` on every decision. */
  readonly moduleId: string;
  /** Key within that module, e.g. `approve`. */
  readonly key: string;
}

/** What happens when a guild has configured no explicit allow-list for a key (SC-7 layer L2). */
export type Fallback =
  /** Anyone in the guild. */
  | 'everyone'
  /** `(permissions & ManageGuild) === ManageGuild`, with NO Administrator expansion. */
  | 'guild-admin'
  /** Only the configured application owner. */
  | 'app-owner'
  /** Nobody until explicitly granted - the correct default for anything that spends money. */
  | 'nobody';

/** One entry in a module's `permissions` map. Both fields exist so `/access` is generated. */
export interface PermissionDecl {
  /** Human sentence shown in `/access` autocomplete. An undocumented key is ungrantable. */
  readonly summary: string;
  /** The L2 default, read from the registry by the resolver - never from a `PermissionRef`. */
  readonly fallback: Fallback;
}

/** The manifest shape. `defineModule` infers `ctx.perms` from it. */
export type PermissionDecls = Readonly<Record<string, PermissionDecl>>;

/** WHY recorded: "who let this through?" is unanswerable after the fact otherwise. */
export type DecisionLayer = 'L0-owner' | 'L1-allowlist' | 'L2-fallback' | 'L3-deny';

/** The result of an authorization check. `grantableBy` is what makes a denial actionable. */
export type AccessDecision =
  | { readonly allowed: true; readonly layer: DecisionLayer }
  | { readonly allowed: false; readonly layer: 'L3-deny'; readonly grantableBy: string };

/**
 * Mint a ref.
 *
 * LOADER ONLY. `defineModule` calls it once per declared key to build `ctx.perms`; a module
 * that imports it to fabricate another module's key is caught at boot by the registry's
 * permission cross-check, which is where the guarantee actually lives.
 */
export function permissionRef(moduleId: string, key: string): PermissionRef {
  return { [REF]: true, moduleId, key };
}

/**
 * The explicit "anyone may run this" sentinel.
 * WHY a sentinel rather than an omittable field: `PUBLIC` greps and shows up in review as a
 * decision somebody made; an omitted field shows up as nothing at all.
 */
export const PUBLIC: PermissionRef = { [REF]: true, moduleId: '@core', key: 'public' };

/** Canonical `module.key`, matching `core_access.perm_key` and `/access` autocomplete. */
export function permissionKey(ref: PermissionRef): string {
  return `${ref.moduleId}.${ref.key}`;
}

/** WHY the router needs it: `PUBLIC` skips the allow-list lookup entirely. */
export function isPublic(ref: PermissionRef): boolean {
  return ref.moduleId === '@core' && ref.key === 'public';
}

/** WHY: the mapped type behind `ctx.perms`. Each key keeps its literal name, so a typo is
 *  TS2551 with a "Did you mean" suggestion. */
export type PermsFor<P extends PermissionDecls> = { readonly [K in keyof P]: PermissionRef };
