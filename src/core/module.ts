/**
 * THE MODULE CONTRACT.
 *
 * This is the file a contributor - human or agent - reads instead of the rest of the repo,
 * together with `src/modules/tags/`. Everything a module can do is declared in one object
 * literal, and the declaration is what produces the types it then gets to use:
 *
 *   capabilities: ['db','audit','clock']  ->  ctx.ports is EXACTLY {db, audit, clock}
 *   permissions:  { read, write }         ->  ctx.perms is EXACTLY {read, write}
 *   config:       z.object({...})         ->  ctx.config is that schema's output
 *   publishes:    { 'tags.x': schema }    ->  ctx.emit accepts exactly 'tags.x'
 *
 * so the manifest is not documentation that can drift - it IS the type of the context.
 *
 * POSTMORTEMS THIS FILE CLOSES:
 *  (1) "A module used a port it never declared." `ctx.ports` is `PortsFor<C>`, AND the bag is
 *      built from the same list, so an undeclared port is TS2339 and `undefined`.
 *  (2) "Someone annotated the capability list and the module got every port." The manifest
 *      field is `C & LiteralCaps<C>`, so the widened form is a named compile error.
 *  (3) "A module threw in `setup()` and the whole bot failed to boot." `install()` catches and
 *      returns `Err`; the registry quarantines that module and every other one still starts.
 *  (4) "A module emitted another module's event." `ctx.emit` is narrowed to `keyof publishes`,
 *      and `ctx.bus` cannot emit at all.
 *  (5) "The job ran with every port in the bot." `jobs` is `JobSpec<C, PK>[]`, so the capability
 *      tuple binds the long path too.
 */

import type { z } from 'zod';
import type { Result } from '#core/result';
import { Err, Ok } from '#core/result';
import type { AppError } from '#core/errors';
import { errors } from '#core/errors';
import type { JsonObject } from '#core/json';
import type { PermissionDecls, PermissionRef, PermsFor } from '#core/policy';
import { permissionRef } from '#core/policy';
import type { AppEvents, EventBus, EventName, EventSource, Unsubscribe } from '#core/events';
import type { Backoff, Capability, HealthReport, LiteralCaps, LoggerPort, PortRegistry, PortsFor } from '#core/ports';
import { portsFor } from '#core/ports';
import type { DiscordPermission } from '#core/permissions';
import { tablePrefixFor } from '#core/sql';
import type {
  ActionSpec,
  CommandSpec,
  FormHandlerSpec,
  HookSpec,
  JobOutcome,
  JobSpec,
  SelectActionSpec,
} from '#core/command';
import type { View } from '#core/view';

/**
 * WHY re-exported here: AGENTS.md tells a contributor to read exactly two things, and one of
 * them is this file. Everything a module writes down should be reachable from `#core/module`.
 */
export type {
  ActionSpec,
  AckStrategy,
  Actor,
  AutocompleteChoice,
  AutocompleteRequest,
  ClickInvocation,
  CommandOption,
  CommandSpec,
  CommandSurface,
  FormHandlerSpec,
  FormSubmission,
  HealthCheck,
  HookSpec,
  IdempotencyPolicy,
  Invocation,
  JobContext,
  JobOutcome,
  JobSpec,
  MessageHookEvent,
  Outcome,
  ProgressHandle,
  SelectActionSpec,
  SelectInvocation,
  Space,
} from '#core/command';
export { MAX_AUTOCOMPLETE_CHOICES, readSurface, SURFACE_KEY } from '#core/command';

/** Module ids are folder names, SQL table prefixes and half of every `custom_id`, so the
 *  shape is enforced at boot rather than hoped for. */
export const MODULE_ID_RE = /^[a-z][a-z0-9-]{1,30}$/u;

/**
 * The shape of a `publishes` map.
 *
 * WHY the keys are constrained to `EventName` rather than being free strings: a typo like
 * `'buidler.pr_opened'` is then a compile error AT THE MANIFEST, where the author is looking.
 *
 * WHY it is NOT `Required<...>` over this module's namespace: an earlier design required a
 * schema for every event whose name starts with the module id, which sounds strictly better
 * and is not - it makes adding an event declaration produce errors in OTHER modules' files,
 * and it makes a generic module factory uncompilable. The guarantee it was buying is already
 * bought by `emit`, which is narrowed to `keyof Pub`: an event with no schema here simply
 * cannot be emitted, and the error lands on the emit call.
 */
export type PublishMap = { readonly [K in EventName]?: z.ZodType };

/** Events a module of id `Id` may legitimately own. Used by the boot-time namespacing check. */
export type PublishedEventsOf<Id extends string> = Extract<EventName, `${Id}.${string}`>;

/**
 * What `setup(ctx)` is handed. Five type parameters, each erasing a class of mistake:
 *   `C`   declared capability tuple  -> `ports`
 *   `Cfg` parsed config              -> `config`
 *   `P`   declared permission map    -> `perms`
 *   `Pub` declared published events   -> `emit`
 */
export interface ModuleContext<
  C extends readonly Capability[],
  Cfg,
  P extends PermissionDecls,
  Pub extends PublishMap,
> {
  /** Own id. Also the audit `module_id` and half of every `custom_id`. */
  readonly moduleId: string;
  /** `m_<id>_`. Every table this module may touch starts with it; the db port enforces it. */
  readonly tablePrefix: string;
  /** Parsed output of this module's own zod schema, defaults applied. */
  readonly config: Cfg;
  /** EXACTLY the declared capabilities. Nothing else exists here, at type or at runtime. */
  readonly ports: PortsFor<C>;
  /** This module's permission refs. `ctx.perms.wirte` is TS2551 with a suggestion. */
  readonly perms: PermsFor<P>;
  /** Subscribe to other modules' events. SUBSCRIBE ONLY - publishing is `emit`. */
  readonly bus: EventSource;
  /** Pre-bound to `{ module: id }`. WHY not a capability: everything logs. */
  readonly logger: LoggerPort;
  /** Publish. Narrowed to this module's own `publishes` keys, and fails safe under widening. */
  emit<K extends Extract<keyof Pub & string, EventName>>(name: K, payload: AppEvents[K]): void;
}

/**
 * What `setup(ctx)` returns.
 *
 * `commands` and `health` are required; a module with no commands writes `[]`, and a module
 * that cannot say whether it is healthy has no business being loaded.
 */
export interface ModuleHandle<C extends readonly Capability[], PK extends string = never> {
  readonly commands: readonly CommandSpec[];
  /** Button handlers, keyed by name so they survive restarts. */
  readonly actions?: readonly ActionSpec[];
  /** Select-menu handlers. */
  readonly selects?: readonly SelectActionSpec[];
  /** Modal-submit handlers. Without these a module can open a form it can never read. */
  readonly forms?: readonly FormHandlerSpec[];
  /** Gateway hooks, e.g. the `$request` message prefix. */
  readonly hooks?: readonly HookSpec[];
  /** Durable work. Typed against the declared capabilities, same as `setup`. */
  readonly jobs?: readonly JobSpec<C, PK>[];
  /** Unsubscribes returned by `ctx.bus.on`, unwound if the module is quarantined. */
  readonly subscriptions?: readonly Unsubscribe[];
  /** Sample views, compiled through the real renderer at BOOT. A broken card fails the deploy. */
  readonly previews?: Readonly<Record<string, View>>;
  /**
   * Run once after migrations on every boot.
   * WHY it is part of the contract: `dispatch()` is async while `enqueue` is synchronous, so
   * nothing can bracket "the workflow was dispatched" and "a poller exists" in one
   * transaction. A crash in that window executes a paid run that nothing ever polls, and the
   * card says "building..." forever with no `onDead`, because no job exists. Sweeping
   * non-terminal rows at boot is the only thing that recovers it.
   */
  reconcile?(): Promise<void>;
  /**
   * Bounded shutdown. WHY: `core_jobs` carries `lease_until`/`lease_owner`, and a SIGTERM with
   * no counterpart leaves a live lease nothing releases until it expires.
   */
  onShutdown?(): Promise<void>;
  health(): Promise<HealthReport>;
}

/** The literal object a contributor writes. Every field is required. */
export interface ModuleDefinition<
  Id extends string,
  C extends readonly Capability[],
  Cfg,
  P extends PermissionDecls,
  Pub extends PublishMap,
> {
  /** MUST equal the folder name; boot asserts it against `MODULE_ID_RE`. */
  readonly id: Id;
  /** One sentence, rendered by the generated `/help`, so it cannot go stale. */
  readonly summary: string;
  /**
   * THE BLAST RADIUS, in one reviewable line.
   *
   * WHY the `LiteralCaps` intersection: an inline tuple resolves it to `unknown` and nothing
   * changes; a widened `readonly Capability[]`, a `[...preset]` spread, or a misspelled port
   * name all fail with a message that PRINTS the fix. See `#core/ports`.
   */
  readonly capabilities: C & LiteralCaps<C>;
  /** zod schema for `config.modules.<id>`. Use `.default()` freely; there is no other default. */
  readonly config: z.ZodType<Cfg>;
  /** Permission keys this module gates on. They appear in `/access` automatically. */
  readonly permissions: P;
  /** Events this module publishes, name -> payload schema. `{}` if none. */
  readonly publishes: Pub;
  /** Whether `./migrations/*.sql` should be applied. Objects must be named `m_<id>_*`. */
  readonly migrations: boolean;
  setup(ctx: ModuleContext<C, Cfg, P, Pub>): ModuleHandle<C, keyof Pub & string>;
}

/** The type-erased manifest the loader, `/help` and `/status` read. */
export interface ModuleManifest {
  readonly id: string;
  readonly summary: string;
  readonly capabilities: readonly Capability[];
  readonly configSchema: z.ZodType;
  readonly permissions: PermissionDecls;
  readonly publishes: Readonly<Record<string, z.ZodType>>;
  readonly migrations: boolean;
}

/**
 * A job with its context already bound.
 *
 * WHY erased: the job runner holds jobs from every module at once and must not be generic over
 * each module's capability tuple. Binding the context inside `install` - where `C` is still
 * known - discharges the generic with no cast and no `any`.
 */
export interface ErasedJob {
  readonly moduleId: string;
  readonly type: string;
  readonly maxAttempts: number;
  readonly deadlineMs: number;
  readonly backoff: Backoff;
  readonly needs: readonly DiscordPermission[];
  readonly schedule: { readonly everyMs: number } | null;
  run(payload: JsonObject, runtime: JobRuntime): Promise<JobOutcome>;
  onDead(payload: JsonObject, last: AppError, runtime: JobRuntime): Promise<void>;
  onUnparseable(payload: JsonObject, runtime: JobRuntime): Promise<void>;
}

/** What the runner supplies per attempt. The ports and the emitter are already bound. */
export interface JobRuntime {
  readonly attempt: number;
  readonly deadlineAtMs: number;
  readonly signal: AbortSignal;
  heartbeat(): void;
  sleep(ms: number): Promise<void>;
}

/** A module that has successfully run `setup`. */
export interface InstalledModule {
  readonly manifest: ModuleManifest;
  readonly perms: Readonly<Record<string, PermissionRef>>;
  readonly commands: readonly CommandSpec[];
  readonly actions: readonly ActionSpec[];
  readonly selects: readonly SelectActionSpec[];
  readonly forms: readonly FormHandlerSpec[];
  readonly hooks: readonly HookSpec[];
  readonly jobs: readonly ErasedJob[];
  readonly subscriptions: readonly Unsubscribe[];
  readonly previews: Readonly<Record<string, View>>;
  readonly reconcile: (() => Promise<void>) | null;
  readonly onShutdown: (() => Promise<void>) | null;
  health(): Promise<HealthReport>;
}

/** What the composition root hands `install`. */
export interface InstallIO {
  /** Every port that was wired. `portsFor` narrows it to what this module declared. */
  readonly ports: Readonly<Partial<PortRegistry>>;
  /** Raw `config.modules.<id>` slice, still unvalidated. */
  readonly rawConfig: unknown;
  readonly bus: EventBus;
  readonly logger: LoggerPort;
}

/**
 * What `defineModule` returns and what the loader collects.
 * Non-generic on purpose: a heterogeneous array of modules is otherwise unrepresentable
 * without `any`.
 */
export interface ModuleDescriptor {
  readonly manifest: ModuleManifest;
  /** Never throws. A module that explodes in `setup` is quarantined, not fatal. */
  install(io: InstallIO): Result<InstalledModule, AppError>;
}

/** Runtime proof that every declared permission key produced a ref, without a cast. */
function isPermsFor<P extends PermissionDecls>(
  built: Record<string, PermissionRef>,
  decls: P,
): built is Record<string, PermissionRef> & PermsFor<P> {
  for (const key of Object.keys(decls)) if (built[key] === undefined) return false;
  return true;
}

function buildPerms<P extends PermissionDecls>(moduleId: string, decls: P): PermsFor<P> {
  const built: Record<string, PermissionRef> = {};
  for (const key of Object.keys(decls)) built[key] = permissionRef(moduleId, key);
  if (!isPermsFor(built, decls)) throw new Error(`buildPerms: missing ref for ${moduleId}; this is a bug`);
  return built;
}

/**
 * Declare a module.
 *
 * WHY a function and not a plain exported object: this is the only place where the five
 * generic parameters are still known, so it is the only place that can build a correctly typed
 * `ModuleContext` and then erase it. `const Id`, `const C` and `const P` are what keep the id,
 * the capability tuple and the permission keys LITERAL - a bare
 * `const m: ModuleDefinition = {...}` would widen `['db','audit']` to `Capability[]` and hand
 * the module every port in the bot, which is exactly the hole `LiteralCaps` also guards.
 *
 * Everything downstream - loader, router, job runner, `/help` - works against the non-generic
 * `ModuleDescriptor`.
 */
export function defineModule<
  const Id extends string,
  const C extends readonly Capability[],
  Cfg,
  const P extends PermissionDecls,
  Pub extends PublishMap,
>(def: ModuleDefinition<Id, C, Cfg, P, Pub>): ModuleDescriptor {
  // WHY a local of type `C`: the manifest field is `C & LiteralCaps<C>` (the widening
  // sentinel), and an intersection is assignable to each member, so this discharges the
  // sentinel with no cast and keeps `PortsFor<C>` exact.
  const caps: C = def.capabilities;
  const capabilities: readonly Capability[] = caps;
  const manifest: ModuleManifest = {
    id: def.id,
    summary: def.summary,
    capabilities,
    configSchema: def.config,
    permissions: def.permissions,
    publishes: def.publishes,
    migrations: def.migrations,
  };

  return {
    manifest,
    install(io: InstallIO): Result<InstalledModule, AppError> {
      const parsed = def.config.safeParse(io.rawConfig);
      if (!parsed.success) {
        return Err(
          errors.config(
            `modules.${def.id}`,
            parsed.error.message,
            `Fix config.modules.${def.id} in your config file or env.`,
          ),
        );
      }

      const ports = portsFor(io.ports, caps, def.id);
      if (!ports.ok) return ports;

      const logger = io.logger.child({ module: def.id });
      const perms = buildPerms(def.id, def.permissions);

      const emitOwn = <K extends Extract<keyof Pub & string, EventName>>(name: K, payload: AppEvents[K]): void => {
        io.bus.emit(name, payload);
      };

      const boundPorts = ports.value;
      const ctx: ModuleContext<C, Cfg, P, Pub> = {
        moduleId: def.id,
        tablePrefix: tablePrefixFor(def.id),
        config: parsed.data,
        ports: boundPorts,
        perms,
        bus: io.bus,
        logger,
        emit: emitOwn,
      };

      let handle: ModuleHandle<C, keyof Pub & string>;
      try {
        handle = def.setup(ctx);
      } catch (cause: unknown) {
        // A module that explodes at setup is quarantined by the registry; the bot still boots.
        return Err(
          errors.config(
            def.id,
            `setup() threw: ${cause instanceof Error ? cause.message : String(cause)}`,
            `Fix src/modules/${def.id}/module.ts, or start with MODULES_DISABLE=${def.id}.`,
          ),
        );
      }

      const jobs: readonly ErasedJob[] = (handle.jobs ?? []).map((j) => ({
        moduleId: def.id,
        type: j.type,
        maxAttempts: j.maxAttempts,
        deadlineMs: j.deadlineMs,
        backoff: j.backoff,
        needs: j.needs,
        schedule: j.schedule ?? null,
        run(payload, runtime) {
          return j.run({ ports: boundPorts, logger, bus: io.bus, emit: emitOwn, ...runtime }, payload);
        },
        onDead(payload, last, runtime) {
          return j.onDead({ ports: boundPorts, logger, bus: io.bus, emit: emitOwn, ...runtime }, payload, last);
        },
        onUnparseable(payload, runtime) {
          return j.onUnparseable({ ports: boundPorts, logger, bus: io.bus, emit: emitOwn, ...runtime }, payload);
        },
      }));

      return Ok({
        manifest,
        perms,
        commands: handle.commands,
        actions: handle.actions ?? [],
        selects: handle.selects ?? [],
        forms: handle.forms ?? [],
        hooks: handle.hooks ?? [],
        jobs,
        subscriptions: handle.subscriptions ?? [],
        previews: handle.previews ?? {},
        reconcile: handle.reconcile?.bind(handle) ?? null,
        onShutdown: handle.onShutdown?.bind(handle) ?? null,
        async health(): Promise<HealthReport> {
          try {
            return await handle.health();
          } catch (cause: unknown) {
            // A throwing health check must degrade /status, not crash the process.
            return { status: 'down', detail: `health check threw: ${cause instanceof Error ? cause.message : 'unknown'}` };
          }
        },
      });
    },
  };
}
