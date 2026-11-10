/**
 * Registry introspection, as a port.
 *
 * POSTMORTEM THIS FILE CLOSES: "`/help`, `/status` and `/readyz` could not be written as
 * modules, because nothing exposed the registry to one." In both previous designs those were
 * core functions, so the three starter modules everyone reads first were core-privileged code
 * - and "everything user-visible is generated from the registry" was true only if you edited
 * core, which AGENTS.md forbids.
 *
 * The DTOs here are flat data, deliberately: a module must be able to render `/help` without
 * being able to reach into another module's specs, and this port must not import the registry
 * (which imports the module contract, which imports the ports).
 */

/** One command, as `/help` needs it. */
export interface CatalogCommand {
  readonly moduleId: string;
  /** Full name including subcommand words, e.g. `tag get`. */
  readonly name: string;
  readonly description: string;
  readonly surface: 'guild' | 'dm' | 'both';
  /** `module.key`, or `@core.public`. Lets `/help` say what a command needs. */
  readonly permission: string;
}

/** One declared permission key, as `/access` autocomplete needs it. */
export interface CatalogPermission {
  readonly moduleId: string;
  readonly key: string;
  /** `module.key`, matching `core_access.perm_key`. */
  readonly permKey: string;
  readonly summary: string;
  readonly fallback: string;
}

/** One module, as `/help` and `/status` need it. */
export interface CatalogModule {
  readonly id: string;
  readonly summary: string;
  readonly capabilities: readonly string[];
  /** Present and populated only for a module the loader quarantined. */
  readonly quarantineReason: string | null;
}

/** One module's live health, already raced against the aggregator's deadline. */
export interface CatalogHealth {
  readonly moduleId: string;
  readonly status: 'ok' | 'degraded' | 'down';
  readonly detail: string;
}

/**
 * Read-only view of the boot registry.
 * WHY read-only: `/help` must not be able to change what it lists, and a write here would be
 * a second, competing source of truth for the command index.
 */
export interface CatalogPort {
  modules(): readonly CatalogModule[];
  commands(): readonly CatalogCommand[];
  permissions(): readonly CatalogPermission[];
  /**
   * Live health for every module.
   * WHY it is async and the aggregator applies a deadline: one module whose health check
   * awaits a hung HTTP call must not hang `/status` for everyone else, during exactly the
   * incident when `/status` matters.
   */
  health(): Promise<readonly CatalogHealth[]>;
}
