/**
 * `<bin> invite-url [--client-id <id>]`: the permissions integer the bot must be invited with,
 * and the invite URL that carries it (RFC-001 section 1 step 2; AGENTS.md "Operator action
 * required", item 2).
 *
 * THE INTEGER IS THE UNION OF EVERY `needs:` THE BOT WOULD REGISTER - commands, buttons, selects,
 * forms, hooks and jobs, across the built-ins and every `MODULE_DIRS` module - through
 * `permissionInteger` (`#core/permissions`), the one place the bits live. A module that adds a
 * permission to a `needs:` array changes this number, and that is exactly what an operator has to
 * re-invite for.
 *
 * WHY IT INSTALLS THE MODULES: `needs` is declared on the specs a module's `setup()` returns, so
 * the only honest way to read them is to run `setup()`. It runs against the in-memory fakes of
 * `#testing/fakes`: no database is opened, no network is touched, no Discord login happens, and
 * a module whose setup would do any of that gets a fake that records it and nothing else.
 */

import { createEventBus } from '#core/events';
import type { AppConfig } from '#core/config';
import { loadConfig, moduleConfigSlice } from '#core/config';
import type { InstalledModule } from '#core/module';
import { PERMISSION_BITS, permissionInteger, type DiscordPermission } from '#core/permissions';
import { formatProblems } from '#core/registry';
import { fakePorts } from '#testing/fakes';
import { inviteUrl } from '#adapters/discord/router';

import { describeQuarantine, installModules } from '../loader.ts';

import { discoverForCli, discoverySettings } from './discover.ts';
import { EXIT_OK, EXIT_PROBLEM, EXIT_USAGE, describeAppError, silentLogger, type CliIo } from './io.ts';

/** Every `needs` entry of every surface one installed module registers. */
export function needsOf(m: InstalledModule): readonly DiscordPermission[] {
  return [
    ...m.commands.flatMap((c) => c.needs),
    ...m.actions.flatMap((a) => a.needs),
    ...m.selects.flatMap((s) => s.needs),
    ...m.forms.flatMap((f) => f.needs),
    ...m.hooks.flatMap((h) => h.needs),
    ...m.jobs.flatMap((j) => j.needs),
  ];
}

/** The union, in `PERMISSION_BITS` order so the printed list is stable. */
export function unionOfNeeds(modules: Iterable<InstalledModule>): readonly DiscordPermission[] {
  const seen = new Set<DiscordPermission>();
  for (const m of modules) for (const n of needsOf(m)) seen.add(n);
  const order = Object.keys(PERMISSION_BITS);
  return [...seen].sort((a, b) => order.indexOf(a) - order.indexOf(b));
}

const SNOWFLAKE = /^\d{17,20}$/u;

export async function inviteUrlCommand(io: CliIo, clientIdFlag: string | null): Promise<number> {
  const parsed = loadConfig(io.env);
  const cfg: AppConfig | null = parsed.ok ? parsed.value : null;
  const clientId = clientIdFlag ?? io.env['DISCORD_CLIENT_ID'] ?? null;
  if (clientId !== null && !SNOWFLAKE.test(clientId)) {
    io.err(`invite-url: "${clientId}" is not a Discord application id (17-20 digits). Copy it from the Developer Portal: your application -> General Information -> Application ID.\n`);
    return EXIT_USAGE;
  }

  const settings = discoverySettings(io.env, cfg);
  if (!settings.ok) {
    io.err(`invite-url: the module discovery variables do not parse:\n${settings.error}\n`);
    return EXIT_PROBLEM;
  }
  const logger = silentLogger();
  const found = await discoverForCli(io.cwd, settings.value, logger);
  if (!found.ok) {
    io.err(`invite-url: modules could not be discovered:\n  ${describeAppError(found.error)}\n`);
    return EXIT_PROBLEM;
  }
  const installed = installModules({
    discovered: found.value.discovered,
    portsFor: (moduleId) => fakePorts(`m_${moduleId}_`),
    configFor: (moduleId) => (cfg === null ? {} : moduleConfigSlice(cfg, moduleId)),
    bus: createEventBus(() => undefined),
    logger,
    disabled: settings.value.disabled,
    quarantined: found.value.quarantined,
  });
  if (!installed.ok) {
    io.err(`invite-url: the bot would refuse to start, so its permissions cannot be computed:\n${formatProblems(installed.error)}\n`);
    return EXIT_PROBLEM;
  }

  const modules = [...installed.value.registry.installed.values()];
  const needs = unionOfNeeds(modules);
  const bits = permissionInteger(needs).toString();
  io.out(`permissions integer: ${bits}\n`);
  io.out(`  the union of every needs: across ${String(modules.length)} module(s) (${modules.map((m) => m.manifest.id).join(', ') || 'none'})\n`);
  io.out(`  ${needs.length === 0 ? 'no Discord permissions are needed' : needs.join(', ')}\n`);
  if (clientId === null) {
    io.out(`invite URL: pass --client-id <application id> (or set DISCORD_CLIENT_ID) to print it.\n`);
  } else {
    io.out(`invite URL: ${inviteUrl(clientId, bits)}\n`);
  }

  // A module that did not install contributed no `needs`, so the integer may be too small.
  if (installed.value.quarantined.length > 0) {
    io.err(`\ninvite-url: ${String(installed.value.quarantined.length)} module(s) are quarantined, so their permissions are NOT in the integer above:\n`);
    for (const q of installed.value.quarantined) io.err(`  - ${describeQuarantine(q)}\n`);
    return EXIT_PROBLEM;
  }
  return EXIT_OK;
}
