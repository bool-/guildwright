/**
 * The typed internal event bus.
 *
 * POSTMORTEM THIS FILE CLOSES: "notifications needed to know when a build finished, so it
 * imported `#modules/builder/state.ts`; six weeks later `builder` could not be deleted, and a
 * change to its repo broke a module that never mentioned it." A previous review marked the
 * absence of this bus FATAL, and it is: without it, the only way for module B to react to
 * module A is a cross-import, which is the mechanism by which a "modular" bot stops being one.
 *
 * HOW THE TYPES WORK. A publishing module declares its events by AUGMENTING `AppEvents` from
 * its own folder:
 *
 *     // src/modules/builder/events.d.ts
 *     export {};
 *     declare module '#core/events' {
 *       interface AppEvents {
 *         'builder.pr_opened': { requestId: string; prUrl: string; issueNumber: number };
 *       }
 *     }
 *
 * Subscribers then get full inference from the event NAME alone, with zero imports from the
 * publisher. The publisher additionally lists the event under `publishes` with a zod schema,
 * which is what validates the payload at runtime.
 *
 * TWO SEPARATE TYPES, AND THAT IS THE POINT: `ctx.bus` is an `EventSource` (subscribe only),
 * so a module physically cannot emit an event it did not declare. Publishing goes through
 * `ctx.emit`, narrowed to `keyof publishes`. One earlier design handed modules an
 * unrestricted bus, and a module with `publishes: {}` could emit `builder.request_approved`
 * and `core.module_quarantined` for someone else.
 */

import type { JsonObject } from '#core/json';

/**
 * The augmentation surface.
 *
 * WHY payloads must be `JsonObject`-compatible in practice: an event may be persisted for
 * replay and may cross a process boundary later, so a `UserText` or a `ProgressHandle` has no
 * business in one. That is a review rule rather than a constraint on this interface, because
 * an open interface cannot constrain its own future members.
 *
 * WHY `interface` and not a type alias: only interfaces are open to declaration merging.
 */
export interface AppEvents {
  /** Emitted once per module after `setup()` returns and migrations have been applied. */
  'core.module_ready': { readonly moduleId: string; readonly at: number };
  /** Emitted when the circuit breaker quarantines a module (SC-14). */
  'core.module_quarantined': { readonly moduleId: string; readonly reason: string; readonly until: number };
}

/** Every declared event name in the whole application, after augmentation. */
export type EventName = keyof AppEvents & string;

/** Handle returned by `on`. Put it in `handle.subscriptions` so the loader can unwind it. */
export type Unsubscribe = () => void;

/** Subscriber shape. Async handlers are allowed; the bus never awaits them - see `emit`. */
export type EventHandler<K extends EventName> = (payload: AppEvents[K]) => void | Promise<void>;

/**
 * Subscribe side. Handed to modules as `ctx.bus`.
 *
 * WHY there is no `emit` here: see the file header. WHY a subscriber cannot learn anything
 * about the publisher: an event is a past-tense fact with 0..N listeners, no ordering
 * guarantee and no return value. If you need the answer, the order, or the failure, that is a
 * port, not an event.
 */
export interface EventSource {
  /** Subscribe. Keep the returned unsubscribe in `handle.subscriptions`. */
  on<K extends EventName>(name: K, handler: EventHandler<K>): Unsubscribe;
  /** Subscribe for exactly one delivery. */
  once<K extends EventName>(name: K, handler: EventHandler<K>): Unsubscribe;
}

/** Unrestricted bus. Exists for the composition root and for tests, never for a module. */
export interface EventBus extends EventSource {
  emit<K extends EventName>(name: K, payload: AppEvents[K]): void;
}

/**
 * The narrowed emitter a module actually receives.
 *
 * WHY `Extract<PublishKeys, EventName>` and not `Extract<keyof B, EventName>`: this form FAILS
 * SAFE. If `publishes` is somehow widened to `Record<string, ZodType>`, `PublishKeys` becomes
 * `string`, `Extract<string, EventName>` collapses to `never`, and `emit` is disabled. The
 * other spelling re-opens the whole `EventName` union under exactly the same widening.
 */
export interface ModuleEmitter<PublishKeys extends string> {
  emit<K extends Extract<PublishKeys, EventName>>(name: K, payload: AppEvents[K]): void;
}

/** WHY a wrapper object: `run` is a METHOD, so parameter checking is bivariant and the bus can
 *  store heterogeneous handlers without `any` and without a cast. */
interface Slot {
  run(payload: unknown): void | Promise<void>;
}

/** What the bus does with a subscriber that throws or rejects. */
export interface BusFailure {
  readonly event: string;
  readonly cause: unknown;
}

/**
 * In-process bus.
 *
 * WHY `onFailure` is a required parameter: an unhandled rejection from a subscriber kills the
 * Node process. Every delivery is wrapped and every rejection is routed here, so the bus
 * cannot be the thing that takes the bot down. A publisher's transaction must never fail
 * because a listener did.
 */
export function createEventBus(onFailure: (f: BusFailure) => void): EventBus {
  const slots = new Map<string, Set<Slot>>();

  const add = (name: string, slot: Slot): Unsubscribe => {
    const set = slots.get(name) ?? new Set<Slot>();
    set.add(slot);
    slots.set(name, set);
    return () => {
      set.delete(slot);
    };
  };

  const deliver = (name: string, payload: unknown): void => {
    const set = slots.get(name);
    if (set === undefined) return;
    // Copy: a listener may unsubscribe itself while we are iterating, which would
    // otherwise mutate the Set mid-iteration. The spread is load-bearing, not waste.
    // oxlint-disable-next-line unicorn/no-useless-spread
    for (const slot of [...set]) {
      try {
        const r = slot.run(payload);
        if (r instanceof Promise) r.catch((cause: unknown) => onFailure({ event: name, cause }));
      } catch (cause: unknown) {
        onFailure({ event: name, cause });
      }
    }
  };

  return {
    emit(name, payload) {
      deliver(name, payload);
    },
    on(name, handler) {
      return add(name, { run: handler });
    },
    once(name, handler) {
      // `wrapped` keeps the handler's own payload type, so no cast is needed; `off` is
      // referenced from a closure that only runs after the declaration completes.
      const wrapped: EventHandler<typeof name> = (payload) => {
        off();
        return handler(payload);
      };
      const off = add(name, { run: wrapped });
      return off;
    },
  };
}

/** WHY exported: an event payload is validated against `JsonObject` at the publish boundary. */
export type EventPayloadJson = JsonObject;
