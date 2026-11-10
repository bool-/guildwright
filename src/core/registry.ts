/**
 * The boot-time registry.
 *
 * POSTMORTEMS THIS FILE CLOSES:
 *  (1) "Two modules both registered `/status`; whichever loaded last won, and for three weeks
 *      half the team was looking at the wrong output." Every collision is FATAL and names BOTH
 *      owners. There is no last-wins path here: a map is written only when the key is absent.
 *  (2) "A broken module took the whole bot down at boot." An `install()` failure QUARANTINES
 *      that module; every other module still starts, and `/status` shows the quarantine.
 *  (3) "A button's custom_id was 104 characters and threw at render time in production." Every
 *      declared action is budget-checked against a worst-case entity id, and every declared
 *      preview is run through `validateView`.
 *  (4) "A module gated a command on another module's permission key and nothing objected."
 *      Every `PermissionRef` on every command, action, select, form and hook is cross-checked
 *      against the DECLARING module's own `permissions` map.
 *  (5) "Two modules both claimed `$request`, both handlers fired, and one message produced two
 *      GitHub issues and two paid builds." Prefixes are unique, and a prefix that shadows
 *      another (`$req` vs `$request`) is refused too.
 *  (6) "The starter module declared `autocomplete: true` and had nowhere to answer." A
 *      declared autocomplete option without a handler is a boot failure.
 *
 * WHY problems are DATA and not thrown: boot must report ALL of them at once. An operator
 * fixing one collision per restart is a worse outcome than a wall of text.
 */

import type { Result } from '#core/result';
import { Err, Ok } from '#core/result';
import type { AppError } from '#core/errors';
import { operatorMessage } from '#core/errors';
import type {
  ActionSpec,
  CommandSpec,
  FormHandlerSpec,
  HookSpec,
  SelectActionSpec,
} from '#core/command';
import type { ErasedJob, InstalledModule, ModuleDescriptor, ModuleManifest } from '#core/module';
import { MODULE_ID_RE } from '#core/module';
import { actionRefFits, CUSTOM_ID_MAX } from '#core/ids';
import type { PermissionDecl, PermissionRef } from '#core/policy';
import { isPublic, permissionKey } from '#core/policy';
import type { EventBus } from '#core/events';
import type {
  Capability,
  CatalogCommand,
  CatalogHealth,
  CatalogModule,
  CatalogPermission,
  CatalogPort,
  LoggerPort,
  PortRegistry,
} from '#core/ports';
import { ALL_CAPABILITIES } from '#core/ports';
import type { View } from '#core/view';
import { validateView } from '#core/view';

/** Everything that can be wrong at boot, as data. */
export type RegistryProblem =
  /** Two module folders claim the same id. */
  | { readonly kind: 'duplicate-module'; readonly id: string; readonly sources: readonly [string, string] }
  /** Id does not match `MODULE_ID_RE`, so its table prefix would be unenforceable. */
  | { readonly kind: 'bad-module-id'; readonly id: string; readonly source: string }
  /** A declared capability is not a port. */
  | { readonly kind: 'unknown-capability'; readonly moduleId: string; readonly capability: string }
  /** THE silent-shadowing bug. Both owners are named so nobody has to bisect. */
  | { readonly kind: 'duplicate-command'; readonly name: string; readonly owners: readonly [string, string] }
  /** Two handlers with the same name inside one module: its custom_ids would be ambiguous. */
  | { readonly kind: 'duplicate-handler'; readonly moduleId: string; readonly surface: string; readonly name: string }
  /** Two permission keys with the same name inside one module. */
  | { readonly kind: 'duplicate-permission'; readonly moduleId: string; readonly key: string }
  /** Two job types with the same name inside one module: the runner could not dispatch. */
  | { readonly kind: 'duplicate-job'; readonly moduleId: string; readonly type: string }
  /** Two hooks claim the same message prefix, e.g. both want `$request`. */
  | { readonly kind: 'duplicate-prefix'; readonly prefix: string; readonly owners: readonly [string, string] }
  /** One prefix shadows another, e.g. `$req` and `$request`. Both would fire, or neither. */
  | { readonly kind: 'shadowing-prefix'; readonly shorter: string; readonly longer: string; readonly owners: readonly [string, string] }
  /** A published event name is not namespaced under the publishing module. */
  | { readonly kind: 'unnamespaced-event'; readonly moduleId: string; readonly event: string }
  /** Two modules publish the same event name. An event has exactly one publisher. */
  | { readonly kind: 'duplicate-publisher'; readonly event: string; readonly owners: readonly [string, string] }
  /** A spec used a permission its own module does not declare. */
  | { readonly kind: 'undeclared-permission'; readonly moduleId: string; readonly where: string; readonly permKey: string }
  /** An option declares `autocomplete: true` and the command has no `autocomplete` handler. */
  | { readonly kind: 'missing-autocomplete'; readonly moduleId: string; readonly command: string; readonly option: string }
  /** A live card for this action could not fit in 100 characters. */
  | { readonly kind: 'custom-id-budget'; readonly moduleId: string; readonly name: string }
  /** A preview would be rejected by Discord at render time. */
  | { readonly kind: 'bad-preview'; readonly moduleId: string; readonly preview: string; readonly detail: string }
  /** `install()` failed. NOT fatal: this module is quarantined and the bot boots without it. */
  | { readonly kind: 'setup-failed'; readonly moduleId: string; readonly cause: AppError };

/** A command plus the module that owns it. Ownership is needed for audit and for `/help`. */
export interface CommandOwner {
  readonly moduleId: string;
  readonly spec: CommandSpec;
}
/** An action plus its owner. The routing key is `<moduleId>:<action.name>`. */
export interface ActionOwner {
  readonly moduleId: string;
  readonly spec: ActionSpec;
}
/** A select handler plus its owner. */
export interface SelectOwner {
  readonly moduleId: string;
  readonly spec: SelectActionSpec;
}
/** A modal-submit handler plus its owner. */
export interface FormOwner {
  readonly moduleId: string;
  readonly spec: FormHandlerSpec;
}
/** A message hook plus its owner. */
export interface HookOwner {
  readonly moduleId: string;
  readonly spec: HookSpec;
}
/** A permission declaration plus its owner, for `/access` autocomplete. */
export interface PermissionOwner {
  readonly moduleId: string;
  readonly key: string;
  readonly decl: PermissionDecl;
}

/**
 * The immutable result of a successful boot.
 * WHY `/help` reads this rather than a hand-written list: a generated help cannot go stale.
 */
export interface Registry {
  readonly modules: ReadonlyMap<string, ModuleManifest>;
  /** Keyed by the full command name, e.g. `tag get`. */
  readonly commands: ReadonlyMap<string, CommandOwner>;
  /** Keyed by `<moduleId>:<action>`, which is exactly what a `custom_id` decodes to. */
  readonly actions: ReadonlyMap<string, ActionOwner>;
  readonly selects: ReadonlyMap<string, SelectOwner>;
  readonly forms: ReadonlyMap<string, FormOwner>;
  /** Keyed by `<moduleId>:<type>`. */
  readonly jobs: ReadonlyMap<string, ErasedJob>;
  /** Keyed by literal message prefix. */
  readonly hooks: ReadonlyMap<string, HookOwner>;
  /** Keyed by `<moduleId>.<key>`. */
  readonly permissions: ReadonlyMap<string, PermissionOwner>;
  /** Installed modules, for health, reconcile and shutdown. */
  readonly installed: ReadonlyMap<string, InstalledModule>;
  /** The union of every declared capability - what `composition.ts` must actually wire. */
  readonly capabilitiesUsed: ReadonlySet<Capability>;
}

/** A module that failed to install. Its subscriptions have already been unwound. */
export interface QuarantinedModule {
  readonly moduleId: string;
  readonly cause: AppError;
}

/** What a successful boot produces. */
export interface LoadReport {
  readonly registry: Registry;
  /** Empty in a healthy boot. Rendered by `/status`, so a quarantine is never invisible. */
  readonly quarantined: readonly QuarantinedModule[];
}

/** A discovered module file. `source` is the path, used to name both sides of a collision. */
export interface ModuleSource {
  readonly source: string;
  readonly descriptor: ModuleDescriptor;
}

function claimPermission(
  problems: RegistryProblem[],
  moduleId: string,
  where: string,
  ref: PermissionRef,
  declared: ReadonlySet<string>,
): void {
  if (isPublic(ref)) return;
  if (ref.moduleId !== moduleId || !declared.has(ref.key)) {
    problems.push({ kind: 'undeclared-permission', moduleId, where, permKey: permissionKey(ref) });
  }
}

/**
 * Index installed modules, refusing every collision.
 * Returns EVERY problem found, not the first: an operator should need one restart, not six.
 */
export function buildRegistry(installed: readonly InstalledModule[]): Result<Registry, readonly RegistryProblem[]> {
  const problems: RegistryProblem[] = [];

  const modules = new Map<string, ModuleManifest>();
  const commands = new Map<string, CommandOwner>();
  const actions = new Map<string, ActionOwner>();
  const selects = new Map<string, SelectOwner>();
  const forms = new Map<string, FormOwner>();
  const jobs = new Map<string, ErasedJob>();
  const hooks = new Map<string, HookOwner>();
  const permissions = new Map<string, PermissionOwner>();
  const installedById = new Map<string, InstalledModule>();
  const capabilitiesUsed = new Set<Capability>();
  const publisherOf = new Map<string, string>();

  for (const m of installed) {
    const id = m.manifest.id;

    if (!MODULE_ID_RE.test(id)) {
      problems.push({ kind: 'bad-module-id', id, source: id });
      continue;
    }
    if (modules.has(id)) {
      problems.push({ kind: 'duplicate-module', id, sources: [id, id] });
      continue;
    }
    modules.set(id, m.manifest);
    installedById.set(id, m);

    for (const cap of m.manifest.capabilities) {
      if (!ALL_CAPABILITIES.some((known) => known === cap)) {
        problems.push({ kind: 'unknown-capability', moduleId: id, capability: cap });
        continue;
      }
      capabilitiesUsed.add(cap);
    }

    // Permissions first: every later cross-check reads this set.
    const declaredKeys = new Set<string>();
    for (const key of Object.keys(m.manifest.permissions)) {
      const decl = m.manifest.permissions[key];
      if (decl === undefined) continue;
      if (declaredKeys.has(key)) {
        problems.push({ kind: 'duplicate-permission', moduleId: id, key });
        continue;
      }
      declaredKeys.add(key);
      permissions.set(`${id}.${key}`, { moduleId: id, key, decl });
    }

    // Published events must be namespaced, and owned by exactly one module.
    for (const event of Object.keys(m.manifest.publishes)) {
      if (!event.startsWith(`${id}.`)) {
        problems.push({ kind: 'unnamespaced-event', moduleId: id, event });
        continue;
      }
      const owner = publisherOf.get(event);
      if (owner !== undefined) {
        problems.push({ kind: 'duplicate-publisher', event, owners: [owner, id] });
        continue;
      }
      publisherOf.set(event, id);
    }

    // Commands: the collision that used to be silent.
    for (const spec of m.commands) {
      claimPermission(problems, id, `command "${spec.name}"`, spec.permission, declaredKeys);
      for (const opt of spec.options) {
        if (opt.autocomplete === true && spec.autocomplete === undefined) {
          problems.push({ kind: 'missing-autocomplete', moduleId: id, command: spec.name, option: opt.name });
        }
      }
      const prior = commands.get(spec.name);
      if (prior !== undefined) {
        problems.push({ kind: 'duplicate-command', name: spec.name, owners: [prior.moduleId, id] });
        continue;
      }
      commands.set(spec.name, { moduleId: id, spec });
    }

    // Component handlers: every one is addressed through a 100-character custom_id.
    for (const spec of m.actions) {
      claimPermission(problems, id, `action "${spec.name}"`, spec.permission, declaredKeys);
      if (!actionRefFits(id, spec.name)) problems.push({ kind: 'custom-id-budget', moduleId: id, name: spec.name });
      const key = `${id}:${spec.name}`;
      if (actions.has(key)) {
        problems.push({ kind: 'duplicate-handler', moduleId: id, surface: 'action', name: spec.name });
        continue;
      }
      actions.set(key, { moduleId: id, spec });
    }

    for (const spec of m.selects) {
      claimPermission(problems, id, `select "${spec.name}"`, spec.permission, declaredKeys);
      if (!actionRefFits(id, spec.name)) problems.push({ kind: 'custom-id-budget', moduleId: id, name: spec.name });
      const key = `${id}:${spec.name}`;
      if (selects.has(key)) {
        problems.push({ kind: 'duplicate-handler', moduleId: id, surface: 'select', name: spec.name });
        continue;
      }
      selects.set(key, { moduleId: id, spec });
    }

    for (const spec of m.forms) {
      claimPermission(problems, id, `form "${spec.name}"`, spec.permission, declaredKeys);
      if (!actionRefFits(id, spec.name)) problems.push({ kind: 'custom-id-budget', moduleId: id, name: spec.name });
      const key = `${id}:${spec.name}`;
      if (forms.has(key)) {
        problems.push({ kind: 'duplicate-handler', moduleId: id, surface: 'form', name: spec.name });
        continue;
      }
      forms.set(key, { moduleId: id, spec });
    }

    for (const job of m.jobs) {
      const key = `${id}:${job.type}`;
      if (jobs.has(key)) {
        problems.push({ kind: 'duplicate-job', moduleId: id, type: job.type });
        continue;
      }
      jobs.set(key, job);
    }

    // Message hooks: only one module may own `$request`, and no prefix may shadow another.
    for (const spec of m.hooks) {
      claimPermission(problems, id, `hook "${spec.prefix}"`, spec.permission, declaredKeys);
      const prior = hooks.get(spec.prefix);
      if (prior !== undefined) {
        problems.push({ kind: 'duplicate-prefix', prefix: spec.prefix, owners: [prior.moduleId, id] });
        continue;
      }
      for (const [existing, owner] of hooks) {
        if (existing.startsWith(spec.prefix) || spec.prefix.startsWith(existing)) {
          const [shorter, longer] =
            existing.length < spec.prefix.length ? [existing, spec.prefix] : [spec.prefix, existing];
          problems.push({ kind: 'shadowing-prefix', shorter, longer, owners: [owner.moduleId, id] });
        }
      }
      hooks.set(spec.prefix, { moduleId: id, spec });
    }

    // Previews: prove every card would survive discord.js at render time.
    for (const name of Object.keys(m.previews)) {
      const view: View | undefined = m.previews[name];
      if (view === undefined) continue;
      for (const p of validateView(view)) {
        problems.push({ kind: 'bad-preview', moduleId: id, preview: name, detail: `${p.code}: ${p.detail}` });
      }
    }
  }

  if (problems.length > 0) return Err(problems);
  return Ok({ modules, commands, actions, selects, forms, jobs, hooks, permissions, installed: installedById, capabilitiesUsed });
}

/** What the composition root hands the loader. Per-module config is resolved lazily. */
export interface LoaderIO {
  /** Every port that was wired. Each module is narrowed to the ones it declared. */
  readonly ports: Readonly<Partial<PortRegistry>>;
  readonly bus: EventBus;
  readonly logger: LoggerPort;
  /** The raw `config.modules.<id>` slice; the module's own schema validates it. */
  configFor(moduleId: string): unknown;
  /** Module ids the operator disabled, so a bad module can be skipped without deleting it. */
  readonly disabled: ReadonlySet<string>;
}

/**
 * Install every discovered module, then index them.
 *
 * TWO DIFFERENT SEVERITIES, on purpose:
 *  - a module whose `install` fails is QUARANTINED: reported, excluded, and every other module
 *    still boots. A broken `tags` must not stop `builder`.
 *  - a COLLISION is fatal. Shipping with two `/status` commands, one silently shadowing the
 *    other, is worse than not shipping.
 */
export function loadModules(sources: readonly ModuleSource[], io: LoaderIO): Result<LoadReport, readonly RegistryProblem[]> {
  const installed: InstalledModule[] = [];
  const quarantined: QuarantinedModule[] = [];
  const fatal: RegistryProblem[] = [];
  const seen = new Map<string, string>();

  for (const src of sources) {
    const id = src.descriptor.manifest.id;

    if (!MODULE_ID_RE.test(id)) {
      fatal.push({ kind: 'bad-module-id', id, source: src.source });
      continue;
    }
    if (io.disabled.has(id)) continue;

    const prior = seen.get(id);
    if (prior !== undefined) {
      fatal.push({ kind: 'duplicate-module', id, sources: [prior, src.source] });
      continue;
    }
    seen.set(id, src.source);

    const r = src.descriptor.install({
      ports: io.ports,
      rawConfig: io.configFor(id),
      bus: io.bus,
      logger: io.logger,
    });
    if (!r.ok) {
      // Quarantine, do not abort. `install` already caught anything `setup` threw.
      quarantined.push({ moduleId: id, cause: r.error });
      continue;
    }
    installed.push(r.value);
  }

  const built = buildRegistry(installed);
  if (!built.ok) return Err([...fatal, ...built.error]);
  if (fatal.length > 0) return Err(fatal);

  return Ok({ registry: built.value, quarantined });
}

/** One line per problem, for the boot log. Exhaustive: a new kind breaks this switch. */
export function describeProblem(p: RegistryProblem): string {
  switch (p.kind) {
    case 'duplicate-module':
      return `FATAL two modules claim id "${p.id}": ${p.sources[0]} and ${p.sources[1]}`;
    case 'bad-module-id':
      return `FATAL module id "${p.id}" (${p.source}) must match ${String(MODULE_ID_RE)}`;
    case 'unknown-capability':
      return `FATAL module "${p.moduleId}" declares capability "${p.capability}", which is not a port. Known: ${ALL_CAPABILITIES.join(', ')}`;
    case 'duplicate-command':
      return `FATAL command "${p.name}" is declared by both "${p.owners[0]}" and "${p.owners[1]}" - Discord's command namespace is global; rename one`;
    case 'duplicate-handler':
      return `FATAL module "${p.moduleId}" declares ${p.surface} "${p.name}" twice; custom_ids would be ambiguous`;
    case 'duplicate-permission':
      return `FATAL module "${p.moduleId}" declares permission "${p.key}" twice`;
    case 'duplicate-job':
      return `FATAL module "${p.moduleId}" declares job type "${p.type}" twice; a queued job could not be routed`;
    case 'duplicate-prefix':
      return `FATAL message prefix "${p.prefix}" is claimed by both "${p.owners[0]}" and "${p.owners[1]}"`;
    case 'shadowing-prefix':
      return `FATAL message prefix "${p.shorter}" ("${p.owners[0]}") shadows "${p.longer}" ("${p.owners[1]}") - one message would fire both`;
    case 'unnamespaced-event':
      return `FATAL module "${p.moduleId}" publishes "${p.event}"; it must start with "${p.moduleId}."`;
    case 'duplicate-publisher':
      return `FATAL event "${p.event}" is published by both "${p.owners[0]}" and "${p.owners[1]}"; an event has one publisher`;
    case 'undeclared-permission':
      return `FATAL ${p.where} in module "${p.moduleId}" uses permission "${p.permKey}", which that module does not declare. Add it to \`permissions\` or use PUBLIC`;
    case 'missing-autocomplete':
      return `FATAL command "${p.command}" in "${p.moduleId}" sets autocomplete on option "${p.option}" but declares no autocomplete handler; Discord would time out`;
    case 'custom-id-budget':
      return `FATAL "${p.moduleId}:${p.name}" cannot fit a 26-char entity id and an 8-char nonce inside ${CUSTOM_ID_MAX} characters; shorten the name`;
    case 'bad-preview':
      return `FATAL module "${p.moduleId}" preview "${p.preview}" would be rejected by Discord: ${p.detail}`;
    case 'setup-failed':
      return `QUARANTINED module "${p.moduleId}" failed setup: ${operatorMessage(p.cause)}`;
    default: {
      const exhaustive: never = p;
      void exhaustive;
      return 'unknown registry problem';
    }
  }
}

/** WHY a formatter: the boot failure is printed once and must be the last thing anyone needs. */
export function formatProblems(problems: readonly RegistryProblem[]): string {
  return [
    `Registry refused to start: ${problems.length} problem(s).`,
    ...problems.map((p, i) => `  ${i + 1}. ${describeProblem(p)}`),
  ].join('\n');
}

// ---------------------------------------------------------------------------------------
// Health aggregation
// ---------------------------------------------------------------------------------------

/** WHY a deadline exists at all: one module awaiting a hung HTTP call must not hang `/status`
 *  for every other module, during exactly the incident when `/status` matters. */
export const HEALTH_TIMEOUT_MS = 2_000;

async function raceHealth(m: InstalledModule, deadlineMs: number): Promise<CatalogHealth> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<CatalogHealth>((resolve) => {
    timer = setTimeout(
      () => resolve({ moduleId: m.manifest.id, status: 'down', detail: 'health check timed out' }),
      deadlineMs,
    );
  });
  try {
    const live = m.health().then(
      (r): CatalogHealth => ({ moduleId: m.manifest.id, status: r.status, detail: r.detail }),
    );
    return await Promise.race([live, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Build the read-only catalog every starter module renders from.
 *
 * WHY this exists: without it `/help`, `/status` and `/access` cannot be written as modules at
 * all, and the three files everyone reads first become core-privileged code - which makes
 * "everything user-visible is generated from the registry" true only if you edit core.
 */
const QUARANTINE_USER_TEXT = 'Disabled at startup. An admin can check the logs.';

export function buildCatalog(report: LoadReport, deadlineMs = HEALTH_TIMEOUT_MS): CatalogPort {
  const { registry, quarantined } = report;
  // WHY a fixed sentence: this reason reaches the PUBLIC `/help` and `/status`. The full cause
  // (`operatorMessage`) carries paths and module internals and is already in the boot log.
  const quarantineReason = new Map(quarantined.map((q) => [q.moduleId, QUARANTINE_USER_TEXT]));

  return {
    modules(): readonly CatalogModule[] {
      const live: CatalogModule[] = [...registry.modules.values()].map((m) => ({
        id: m.id,
        summary: m.summary,
        capabilities: m.capabilities,
        quarantineReason: null,
      }));
      const dead: CatalogModule[] = quarantined.map((q) => ({
        id: q.moduleId,
        summary: '(disabled)',
        capabilities: [],
        quarantineReason: quarantineReason.get(q.moduleId) ?? 'unknown',
      }));
      return [...live, ...dead];
    },
    commands(): readonly CatalogCommand[] {
      return [...registry.commands.values()].map((c) => ({
        moduleId: c.moduleId,
        name: c.spec.name,
        description: c.spec.description,
        surface: c.spec.surface,
        permission: permissionKey(c.spec.permission),
      }));
    },
    permissions(): readonly CatalogPermission[] {
      return [...registry.permissions.entries()].map(([permKey, p]) => ({
        moduleId: p.moduleId,
        key: p.key,
        permKey,
        summary: p.decl.summary,
        fallback: p.decl.fallback,
      }));
    },
    async health(): Promise<readonly CatalogHealth[]> {
      const live = await Promise.all([...registry.installed.values()].map((m) => raceHealth(m, deadlineMs)));
      const dead: CatalogHealth[] = quarantined.map((q) => ({
        moduleId: q.moduleId,
        status: 'down',
        detail: quarantineReason.get(q.moduleId) ?? 'quarantined',
      }));
      return [...live, ...dead];
    },
  };
}

/**
 * Job types that exist in the queue but have no handler.
 *
 * WHY it is in core: `core_jobs` rows are keyed `<moduleId>:<type>`, so after a
 * `drop:module` or a rename, live rows route to nothing - silently, forever, with a card
 * still saying "building...". The runner calls this at boot and dead-letters the orphans
 * through the normal notification path instead of dropping them on the floor.
 */
export function orphanedJobKeys(registry: Registry, queued: readonly string[]): readonly string[] {
  return [...new Set(queued)].filter((k) => !registry.jobs.has(k));
}
