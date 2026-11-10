export {};

/** Events published by the tags module. See builder/events.d.ts for the rationale. */
declare module '#core/events' {
  interface AppEvents {
    'tags.saved': { readonly guildId: string; readonly name: string };
  }
}
