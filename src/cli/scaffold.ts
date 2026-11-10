/**
 * Generate a new module that compiles, lints and passes its own test immediately.
 *
 * WHY THIS EXISTS RATHER THAN "copy src/modules/tags/": the flagship feature of this repo is an
 * AI agent adding modules to it. An agent that starts from a blank folder has to rediscover a
 * dozen mandatory fields, and the ones it forgets are the ones nobody notices — a missing
 * `permission` is a command anybody can run. Starting from a skeleton that is already green
 * means the agent's first `npm run check` measures ITS change, not its boilerplate.
 *
 * The generated module is deliberately minimal but COMPLETE: every mandatory field is present
 * and explicit (`PUBLIC`, `NO_LIMIT`, `needs: []` are written out, never omitted), so the
 * decisions are visible in review rather than defaulted in silence.
 *
 *   npm run scaffold -- <module-id> [--summary "..."] [--db] [--force]
 *   npx <bin> scaffold <module-id> [--summary "..."] [--db] [--force]
 *
 * MOVED from `scripts/scaffold-module.ts` into the CLI (RFC-001 9.2) with byte-identical output,
 * so a module repo, which has no `scripts/`, gets the same generator from the installed engine.
 * It writes into `<cwd>/src/modules/<id>/`: the working directory is the repository being
 * extended, never the engine's own tree.
 */

import { mkdirSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { MODULE_ID_RE } from '#core/module';

import { EXIT_OK, EXIT_PROBLEM, EXIT_USAGE, type CliIo } from './io.ts';

/**
 * THE registry's own boot assertion, imported rather than restated: lowercase, starts with a
 * letter, 2..31 chars. A scaffolded id the registry would refuse is the one failure this
 * generator exists to make impossible.
 */
const ID_RE = MODULE_ID_RE;

export const SCAFFOLD_USAGE = 'usage: npm run scaffold -- <module-id> [--summary "..."] [--db] [--force]';

interface Options {
  readonly id: string;
  readonly summary: string;
  readonly withDb: boolean;
  readonly force: boolean;
}

function parseArgs(argv: readonly string[]): Options | string {
  const args = [...argv];
  const id = args.shift();
  if (id === undefined || id.startsWith('-')) {
    return SCAFFOLD_USAGE;
  }
  if (!ID_RE.test(id)) {
    return `"${id}" is not a valid module id.\nIt must match ${String(ID_RE)} — it is also the folder name, the SQL table prefix and half of every custom_id.`;
  }

  let summary = `TODO: describe what ${id} does.`;
  let withDb = false;
  let force = false;

  while (args.length > 0) {
    const flag = args.shift();
    if (flag === '--db') withDb = true;
    else if (flag === '--force') force = true;
    else if (flag === '--summary') {
      const next = args.shift();
      if (next === undefined) return '--summary needs a value';
      summary = next;
    } else return `unknown option: ${String(flag)}`;
  }
  return { id, summary, withDb, force };
}

/** `my-module` -> `MyModule`, for type names. */
function pascal(id: string): string {
  return id
    .split('-')
    .map((part) => (part.length === 0 ? '' : (part[0] ?? '').toUpperCase() + part.slice(1)))
    .join('');
}

function moduleFile(o: Options): string {
  const Name = pascal(o.id);
  const caps = o.withDb ? "['db', 'audit', 'clock']" : "['clock']";
  const service = o.withDb
    ? `new ${Name}Service(${o.id.replace(/-/gu, '')}Repo(ctx.ports.db), ctx.ports.audit)`
    : `new ${Name}Service()`;
  const repoImport = o.withDb
    ? `\nimport { ${o.id.replace(/-/gu, '')}Repo } from '#modules/${o.id}/repo';`
    : '';

  return `import { z } from 'zod';
import { defineModule } from '#core/module';
import { ${Name}Service } from '#modules/${o.id}/domain';${repoImport}
import { plainNameLiteral } from '#core/text';
import { ${o.id.replace(/-/gu, '')}Commands, present } from '#modules/${o.id}/present';

/**
 * ${o.summary}
 *
 * The manifest IS the type of everything below it: \`capabilities\` decides what \`ctx.ports\`
 * contains, \`permissions\` decides what \`ctx.perms\` contains, and \`config\` decides the shape of
 * \`ctx.config\`. Reaching for anything not declared here is a compile error at the line you
 * reached, not a runtime surprise.
 */
export default defineModule({
  id: '${o.id}', // MUST equal the folder name
  summary: ${JSON.stringify(o.summary)},

  // The whole blast radius, on one reviewable line. Add a capability only when the module
  // genuinely needs it — this line is what a reviewer reads first.
  capabilities: ${caps},

  // Operator-supplied settings. Every field needs a default, or the bot cannot start without
  // MODULES_JSON naming this module.
  config: z.object({
    enabled: z.coerce.boolean().default(true),
  }),

  // Declare a key per distinct privilege. Separate keys mean separate allowlists: "may use it"
  // and "may change it" should almost never be the same permission.
  permissions: {
    use: { summary: 'Use ${o.id}', fallback: 'everyone' },
  },

  // Events other modules may subscribe to. Declare one in events.d.ts and it becomes REQUIRED
  // here (TS2741), so an event can never ship without a validating schema.
  publishes: {},

  migrations: ${o.withDb ? 'true' : 'false'},

  setup(ctx) {
    const svc = ${service};
    return {
      // The closure over \`svc\` IS the dependency injection. No container, no decorators.
      commands: ${o.id.replace(/-/gu, '')}Commands(svc, ctx.perms),

      // Rendered at BOOT, so a card that cannot render is a failed deploy rather than a
      // broken message somebody sees in production.
      previews: { hello: present.hello(plainNameLiteral('world')) },

      async health() {
        return { status: 'ok', detail: '${o.id} ready' };
      },
    };
  },
});
`;
}

function domainFile(o: Options): string {
  const Name = pascal(o.id);
  const repoArg = o.withDb
    ? `\n  private readonly repo: ${Name}Repo;\n  private readonly audit: AuditPort;\n`
    : '';
  const ctor = o.withDb
    ? `  constructor(repo: ${Name}Repo, audit: AuditPort) {
    // NOTE: parameter properties (\`constructor(private repo: T)\`) do NOT compile here —
    // Node strips types rather than transforming them, so the assignment must be explicit.
    this.repo = repo;
    this.audit = audit;
  }

`
    : '';
  const extra = o.withDb
    ? `import type { AuditPort } from '#core/ports';
import type { ${Name}Repo } from '#modules/${o.id}/repo';
`
    : '';

  return `import type { Result } from '#core/result';
import type { AppError } from '#core/errors';
import { toPlainName, type PlainName, type UserText } from '#core/text';
${extra}
/**
 * Pure logic. No Discord, no SQL strings, no clock, no network.
 *
 * WHY THAT MATTERS: everything in this file is testable with plain values and no fakes, which
 * is where the cheap tests live. If you find yourself wanting the current time here, take
 * \`ClockPort\` as a constructor argument instead of reaching for \`Date.now()\`.
 */
export class ${Name}Service {${repoArg}${ctor ? '\n' + ctor : ''}  /**
   * Replace me — but keep the SHAPE.
   *
   * The argument is \`UserText\`, which is an OBJECT, not a string: anything a human typed
   * arrives wrapped so it cannot be concatenated into markdown, SQL, a shell or a GitHub
   * issue by accident. \`toPlainName\` is the named door out of it, and it can FAIL — which is
   * why this returns a \`Result\` rather than throwing.
   */
  greet(who: UserText): Result<PlainName, AppError> {
    return toPlainName(who, { maxLength: 64 });
  }
}
`;
}

function presentFile(o: Options): string {
  const Name = pascal(o.id);
  const fn = o.id.replace(/-/gu, '');
  return `import type { CommandSpec } from '#core/module';
import { md, mdInlineCode, renderPlainName, type PlainName } from '#core/text';
import { NO_LIMIT } from '#core/ratelimit';
import type { PermissionRef } from '#core/policy';
import type { View } from '#core/view';
import type { ${Name}Service } from '#modules/${o.id}/domain';

/** Rendering only. Keeping it separate is what lets \`previews\` render at boot with no service. */
export const present = {
  /**
   * Takes a \`PlainName\` — already validated — rather than a raw string, so an unsanitised
   * value cannot reach a rendered card without passing a named door in \`#core/text\` first.
   */
  hello: (who: PlainName): View => ({
    accent: 'ok',
    nodes: [{ kind: 'text', md: md\`Hello, \${mdInlineCode(renderPlainName(who))}.\` }],
  }),
};

/**
 * Every field below is REQUIRED. There are no defaults, on purpose: an omitted \`permission\` is
 * a command anybody can run, and that is not a mistake worth making silently.
 */
export function ${fn}Commands(
  svc: ${Name}Service,
  perms: Readonly<Record<'use', PermissionRef>>,
): readonly CommandSpec[] {
  return [
    {
      name: '${o.id} hello',
      description: 'Say hello',
      surface: 'guild',
      options: [{ name: 'who', description: 'who to greet', type: 'text', required: true }],
      permission: perms.use, // omitting this is TS2741
      limit: NO_LIMIT, // say it explicitly; [] is legal but reads like an oversight
      needs: ['SendMessages'], // the bot's own Discord permissions, preflighted by the router
      ack: 'instant', // must answer inside 3 seconds; use 'defer' if you do any I/O
      async handle(inv) {
        // \`textRequired\` hands back UserText. The service owns the conversion, so a handler
        // can never be the place that forgets to sanitise.
        const r = svc.greet(inv.args.textRequired('who'));
        return r.ok ? { kind: 'view', view: present.hello(r.value) } : { kind: 'fail', error: r.error };
      },
    },
  ];
}
`;
}

function repoFile(o: Options): string {
  const Name = pascal(o.id);
  const fn = o.id.replace(/-/gu, '');
  return `import { sql, type Db } from '#core/ports/db';

/** One row. The repo is the only file in the module that knows the columns. */
export interface ${Name}Row {
  readonly id: string;
  readonly value: string;
}

export interface ${Name}Repo {
  get(id: string): ${Name}Row | undefined;
  put(row: ${Name}Row, at: number): void;
}

/**
 * \`db.table('items')\` yields \`m_${o.id.replace(/-/gu, '_')}_items\`. You cannot name another module's table —
 * the port simply will not mint the identifier, so isolation is structural rather than a rule.
 */
export const ${fn}Repo = (db: Db): ${Name}Repo => {
  const t = db.table('items');
  return {
    get: (id) => db.queryOne<${Name}Row>(sql\`SELECT id, value FROM \${t} WHERE id = \${id}\`),
    put: (row, at) => {
      db.execute(sql\`
        INSERT INTO \${t} (id, value, updated_at) VALUES (\${row.id}, \${row.value}, \${at})
        ON CONFLICT(id) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at\`);
    },
  };
};
`;
}

function testFile(o: Options): string {
  const Name = pascal(o.id);
  const args = o.withDb ? `fake${Name}Repo(), fakeAudit()` : '';
  const imports = o.withDb
    ? `import { fakeAudit, fakeDb } from '#testing/fakes';\nimport { tablePrefixFor } from '#core/sql';\nimport { ${o.id.replace(/-/gu, '')}Repo } from '#modules/${o.id}/repo';\n`
    : '';
  // Derive the prefix exactly as core does. Building "m_<id>_" by hand looks identical until
  // the id contains a hyphen, and "m_my-mod_items" is not a legal SQL identifier.
  const helper = o.withDb
    ? `\nconst fake${Name}Repo = () => ${o.id.replace(/-/gu, '')}Repo(fakeDb(tablePrefixFor('${o.id}')));\n`
    : '';

  return `import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { renderPlainName, userTextForTest } from '#core/text';
import { ${Name}Service } from '#modules/${o.id}/domain';
${imports}
/**
 * Test BEHAVIOUR, not shape. "greet returns a string" is worthless; "greet includes the name it
 * was given" is the thing that would actually break.
 */${helper}
test('greet accepts a normal name and keeps it', () => {
  const svc = new ${Name}Service(${args});
  const r = svc.greet(userTextForTest('world'));

  assert.ok(r.ok, 'a normal name should convert cleanly');
  if (!r.ok) return;
  assert.equal(renderPlainName(r.value), 'world');
});

test('greet REFUSES text it cannot make safe, instead of passing it through', () => {
  const svc = new ${Name}Service(${args});
  // Zero-width joiners and bidi overrides are an invisible-instruction vector; a name made
  // only of them has nothing left after scrubbing, so conversion must fail rather than
  // silently yield an empty label.
  const r = svc.greet(userTextForTest('\u200b\u202e'));

  assert.ok(!r.ok, 'unsafe input must produce an Err, not a best-effort string');
});
`;
}

function migrationFile(o: Options): string {
  // Same normalisation core applies: a hyphen in the id becomes an underscore, because
  // "m_my-mod_items" is not a legal SQL identifier.
  const prefix = `m_${o.id.replace(/-/gu, '_')}_`;
  return `-- Every object this module creates MUST be named ${prefix}*.
-- Boot asserts it, so a stray table name fails the deploy rather than colliding later.
-- Derive this prefix with tablePrefixFor() in code; never rebuild it by hand.
CREATE TABLE IF NOT EXISTS ${prefix}items (
  id         TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
`;
}

/** `<bin> scaffold ...`: write `<cwd>/src/modules/<id>/`. Returns the exit code. */
export function scaffold(argv: readonly string[], io: CliIo): number {
  const parsed = parseArgs(argv);
  if (typeof parsed === 'string') {
    io.err(`${parsed}\n`);
    return parsed === SCAFFOLD_USAGE || parsed.startsWith('unknown option') || parsed.startsWith('--summary') ? EXIT_USAGE : EXIT_PROBLEM;
  }

  const dir = join(resolve(io.cwd, 'src', 'modules'), parsed.id);
  if (existsSync(dir) && !parsed.force) {
    const contents = readdirSync(dir);
    if (contents.length > 0) {
      io.err(
        `src/modules/${parsed.id}/ already exists and is not empty.\n` +
          `Pass --force to overwrite, or pick another id.\n`,
      );
      return EXIT_PROBLEM;
    }
  }

  const files: Array<readonly [string, string]> = [
    ['module.ts', moduleFile(parsed)],
    ['domain.ts', domainFile(parsed)],
    ['present.ts', presentFile(parsed)],
    ['module.test.ts', testFile(parsed)],
  ];
  if (parsed.withDb) {
    files.push(['repo.ts', repoFile(parsed)]);
  }

  mkdirSync(dir, { recursive: true });
  for (const [name, body] of files) {
    writeFileSync(join(dir, name), body, 'utf8');
  }
  if (parsed.withDb) {
    const migrations = join(dir, 'migrations');
    mkdirSync(migrations, { recursive: true });
    writeFileSync(join(migrations, '0001_init.sql'), migrationFile(parsed), 'utf8');
  }

  const written = files.map(([n]) => `  src/modules/${parsed.id}/${n}`).join('\n');
  io.out(
    `\nCreated src/modules/${parsed.id}/\n${written}\n` +
      (parsed.withDb ? `  src/modules/${parsed.id}/migrations/0001_init.sql\n` : '') +
      `\nIt already compiles and its test passes. Verify, then make it do something:\n` +
      `  npm run check\n\n` +
      `Nothing else needs editing — the loader finds the folder on the next boot.\n` +
      `Read AGENTS.md in this repository before changing the manifest.\n\n`,
  );
  return EXIT_OK;
}
