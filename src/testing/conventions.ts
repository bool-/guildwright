/**
 * THE ARCHITECTURE RULES, ENFORCED - as a helper any repo can call.
 *
 * AGENTS.md states six hard rules and several source comments cite lint rules by name -
 * `no-ambient-clock`, `no-component-collectors`, `no-usertext-interpolation`. `npm run lint` is
 * bare oxlint with no config, so none of those rules exist as lint; these source-level checks make
 * the claims true. They run in `npm run check`, fail with a message naming the file and the rule,
 * and cannot drift from the documentation because the documentation is what they assert.
 *
 * WHY A HELPER (RFC-001 section 4.4). The engine will be published as a package and each group
 * keeps its modules in a separate repository, which must run the SAME checks with the SAME failure
 * sentences: an agent reading a failure in a module repo must read the sentence AGENTS.md promised.
 * So the assertions live here, parameterised by where the repo's files are, and both the engine's
 * `src/conventions.test.ts` and a module repo's two-line test call `registerConventionTests`.
 *
 * WHEN YOU HIT ONE OF THESE: the rule is the product. Do not add an exception here to make your
 * change compile - see "If you are blocked" in AGENTS.md.
 *
 * NOTE ON THE PATTERNS BELOW. This file is itself scanned by the repo-wide rules, so the banned
 * identifiers are assembled from fragments (`word('create', ...)`): a rule that fires on its own
 * definition is a rule that gets suppressed.
 */

import { strict as assert } from 'node:assert';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { test } from 'node:test';

export interface ConventionOptions {
  /** Repo root; AGENTS.md and .github are read from here. */
  readonly root: string;
  /** Relative to root. Default `['src/modules']`. */
  readonly modulesDirs?: readonly string[];
  /** `'src/core'` in the engine; undefined in a module repo (the hexagon tests are not registered). */
  readonly coreDir?: string;
  /** Files allowed to contain `as never`. Engine: the octokit dispatch file; module repo: `[]`. */
  readonly allowedAsNever?: readonly string[];
}

/** Directories never walked: dependencies, build output, VCS metadata, runtime data. */
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', 'data']);

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    // Dot-directories (`.claude/worktrees`, `.agent`) hold copies or scratch, never this repo's source.
    if (SKIP_DIRS.has(entry) || entry.startsWith('.')) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (entry.endsWith('.ts')) out.push(full);
  }
  return out;
}

/**
 * Comments are stripped before any pattern check.
 *
 * A rule that fires on prose describing the rule, or on a correct use of an unrelated field, is
 * worse than no rule - it gets suppressed, and then it protects nothing.
 */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//gu, ' ').replace(/(^|[^:])\/\/[^\n]*/gu, '$1 ');
}

/** Import specifiers, from both `import ... from 'x'` and `import('x')`. */
function importsOf(text: string): string[] {
  return [
    ...[...text.matchAll(/from\s+['"]([^'"]+)['"]/gu)].map((m) => m[1] ?? ''),
    ...[...text.matchAll(/import\(\s*['"]([^'"]+)['"]\s*\)/gu)].map((m) => m[1] ?? ''),
  ];
}

/** Banned identifiers, assembled so this file does not match its own rules. */
function word(...parts: string[]): string {
  return parts.join('');
}

const AS_NEVER = word('as ', 'never');

const DISCLOSURE_SECTION = 'Operator action required';
const DISCLOSURE_HEADING = `## ${DISCLOSURE_SECTION}`;

/**
 * The `run:` script of one named workflow step, with shell comment lines removed.
 *
 * The comment strip matters: without it, `# remember to mention the operator section` would
 * satisfy every assertion below while telling the agent nothing at all.
 */
function runScriptOf(yaml: string, stepName: string): string {
  const start = yaml.indexOf(`- name: ${stepName}`);
  assert.notEqual(start, -1, `the workflow no longer has a step named "${stepName}"`);
  const rest = yaml.slice(start + 1);
  const end = rest.indexOf('- name: ');
  const step = end === -1 ? rest : rest.slice(0, end);
  const runAt = step.indexOf('run: |');
  assert.notEqual(runAt, -1, `the "${stepName}" step no longer has a block-scalar run: script`);
  return step
    .slice(runAt)
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('#'))
    .join('\n');
}

/**
 * The disclosures both documents must still demand, written once and asserted against BOTH.
 *
 * One rule, two audiences. If the human guide and the agent prompt list different triggers, then
 * a human PR and an agent PR are being reviewed against different contracts.
 *
 * Needles are matched case-insensitively because the prompt shouts (`REFUSES TO START`) where the
 * prose does not, and they are deliberately short: this is a check against deletion, not a style
 * guide for the wording around them.
 */
const DISCLOSURES: readonly { readonly what: string; readonly needles: readonly string[] }[] = [
  { what: 'names all three privileged gateway intents', needles: ['message_content', 'guild_members', 'guild_presences'] },
  { what: 'gives the Developer Portal path that toggles them', needles: ['privileged gateway intents'] },
  { what: 'ties MESSAGE_CONTENT to the DISCORD_MESSAGE_CONTENT flag', needles: ['discord_message_content'] },
  { what: 'warns that the bot REFUSES TO START without that flag', needles: ['refuses to start'] },
  { what: 'covers a bot permission added to a `needs: [...]` array', needles: ['needs: [...]'] },
  { what: 'says the operator must re-invite, and demands the new integer', needles: ['re-invite', 'permissions integer'] },
  { what: 'covers a new required environment variable in EnvSchema', needles: ['envschema'] },
  { what: 'routes a new dependency through CORE-CHANGE-NEEDED', needles: ['core-change-needed'] },
  // `modules.builder.requireOwnCredentials` defaults to true, so every requester funds their own
  // build. A change that flips it, or adds a fallback inside `resolveBuildPayer`, moves real money
  // onto the operator and is invisible in a diff.
  { what: 'covers a change to who pays for a build', needles: ['requireowncredentials', 'resolvebuildpayer', '/credentials set'] },
  { what: 'demands an explicit "None." instead of an absent section', needles: ['none.'] },
];

interface SourceFile {
  readonly path: string;
  readonly code: string;
}

/**
 * Register the convention tests with node:test. Call it at the top level of a `*.test.ts` file.
 *
 * Throws (so the test file fails loudly) when `root` has no AGENTS.md or a modules directory holds
 * no files: a convention suite that passes because it looked in the wrong place proves nothing.
 */
export function registerConventionTests(opts: ConventionOptions): void {
  const root = resolve(opts.root);
  const modulesDirs = (opts.modulesDirs ?? ['src/modules']).map((d) => d.replaceAll('\\', '/').replace(/\/+$/u, ''));
  const coreDir = opts.coreDir?.replaceAll('\\', '/').replace(/\/+$/u, '');
  const allowedAsNever = [...(opts.allowedAsNever ?? [])].sort();

  const agentsPath = join(root, 'AGENTS.md');
  if (!existsSync(agentsPath)) {
    throw new Error(`AGENTS.md not found at ${agentsPath}. The convention tests need the repo root; pass \`root\` explicitly.`);
  }

  const all: SourceFile[] = walk(root).map((f) => ({
    path: relative(root, f).replaceAll('\\', '/'),
    code: stripComments(readFileSync(f, 'utf8')),
  }));
  const isTest = (f: SourceFile): boolean => f.path.endsWith('.test.ts');
  const nonTest = all.filter((f) => !isTest(f));
  const underDir = (f: SourceFile, dir: string): boolean => f.path.startsWith(`${dir}/`);
  const modules = nonTest.filter((f) => modulesDirs.some((d) => underDir(f, d)));
  const core = coreDir === undefined ? [] : nonTest.filter((f) => underDir(f, coreDir));

  for (const dir of modulesDirs) {
    if (!all.some((f) => underDir(f, dir))) {
      throw new Error(
        `no .ts files found under ${join(root, dir)}. The convention tests would pass vacuously; check \`root\` and \`modulesDirs\`.`,
      );
    }
  }
  if (coreDir !== undefined && core.length === 0) {
    throw new Error(`no .ts files found under ${join(root, coreDir)}. The core hexagon test would pass vacuously; check \`coreDir\`.`);
  }

  /** The module id of a file: the folder directly under whichever modules dir holds it. */
  const ownModule = (f: SourceFile): string => {
    const dir = modulesDirs.find((d) => underDir(f, d)) ?? '';
    return f.path.slice(dir.length + 1).split('/')[0] ?? '';
  };

  const workflowYaml = readFileSync(join(root, '.github/workflows/agent-implement-request.yml'), 'utf8');
  const ciYaml = readFileSync(join(root, '.github/workflows/ci.yml'), 'utf8');
  const agentsMd = readFileSync(agentsPath, 'utf8');

  // -------------------------------------------------------------------------------------
  // AGENTS.md hard rule 1 - the module import wall
  // -------------------------------------------------------------------------------------

  test('modules import only #core, their own folder, and zod', () => {
    const BANNED = ['discord.js', 'octokit', 'node:sqlite', 'node:fs', 'node:child_process', 'node:net', 'node:http', 'pino'];

    for (const file of modules) {
      for (const spec of importsOf(file.code)) {
        assert.ok(
          !BANNED.includes(spec),
          `${file.path} imports "${spec}". Modules reach the outside world through ctx.ports only — see AGENTS.md rule 1.`,
        );
        assert.ok(
          !spec.startsWith('#adapters/') && !spec.startsWith('#lib/'),
          `${file.path} imports "${spec}". A module may never depend on an adapter; that is what ports are for.`,
        );
      }
    }
  });

  test('no module imports another module', () => {
    for (const file of modules) {
      const own = ownModule(file);
      for (const spec of importsOf(file.code)) {
        if (!spec.startsWith('#modules/')) continue;
        const target = spec.slice('#modules/'.length).split('/')[0] ?? '';
        assert.equal(
          target,
          own,
          `${file.path} imports from module "${target}". Modules never import each other — publish an event (AGENTS.md) or use a port.`,
        );
      }
    }
  });

  // -------------------------------------------------------------------------------------
  // The hexagon: core knows nothing about the outside (engine only)
  // -------------------------------------------------------------------------------------

  if (coreDir !== undefined) {
    test('core imports no adapter, no module, and no SDK', () => {
      const BANNED = ['discord.js', 'octokit', 'node:sqlite', 'pino'];

      for (const file of core) {
        for (const spec of importsOf(file.code)) {
          assert.ok(
            !BANNED.includes(spec),
            `${file.path} imports "${spec}". Core is the domain; if it knows the SDK, the ports are decorative.`,
          );
          assert.ok(
            !spec.startsWith('#adapters/') && !spec.startsWith('#modules/'),
            `${file.path} imports "${spec}". Core must not depend on anything that depends on it.`,
          );
        }
      }
    });
  }

  // -------------------------------------------------------------------------------------
  // `no-component-collectors`
  // -------------------------------------------------------------------------------------

  test('no component collectors anywhere: routing must survive a restart', () => {
    // A collector lives in memory and dies with the process, so a card posted before a restart
    // would stop responding. Routing is a stateless custom_id decode precisely to avoid that.
    const BANNED = new RegExp(
      [word('create', 'MessageComponentCollector'), word('await', 'MessageComponent'), word('await', 'Messages')].join('|'),
      'u',
    );

    for (const file of nonTest) {
      assert.ok(
        !BANNED.test(file.code),
        `${file.path} uses a component collector. Route by decoding custom_id instead — a collector cannot survive a restart.`,
      );
    }
  });

  // -------------------------------------------------------------------------------------
  // `no-ambient-clock`
  // -------------------------------------------------------------------------------------

  test('modules take time from ctx.ports.clock, never ambiently', () => {
    // Otherwise the module is untestable without real time passing, and a deadline cannot be
    // simulated.
    const BANNED = new RegExp(
      [
        `\\b${word('Date', '\\.now')}\\(\\)`,
        `${word('new ', 'Date')}\\(\\)`,
        `\\b${word('set', 'Timeout')}\\(`,
        `\\b${word('set', 'Interval')}\\(`,
      ].join('|'),
      'u',
    );

    for (const file of modules) {
      assert.ok(
        !BANNED.test(file.code),
        `${file.path} reads the clock ambiently. Use ctx.ports.clock — see AGENTS.md "Things that will bite you".`,
      );
    }
  });

  // -------------------------------------------------------------------------------------
  // Deprecated Discord API
  // -------------------------------------------------------------------------------------

  test('no deprecated discord.js API is used', () => {
    for (const file of nonTest) {
      // `ephemeral` is a legitimate field on our OWN `View` type and on our own
      // `InteractionScopedReply.deferReply(opts)` port. The deprecated thing is passing it to a
      // discord.js INTERACTION, and in this codebase that object is always named `interaction`
      // (the port objects are named `reply`). A textual rule cannot tell those apart by type, so
      // it keys on that naming convention - a real limitation, stated rather than hidden.
      assert.ok(
        !/\binteraction\.(?:reply|deferReply|followUp|editReply)\(\s*\{[^}]*\bephemeral\s*:/su.test(file.code),
        `${file.path} passes \`ephemeral\` to a discord.js interaction. Deprecated in 14.27 — use \`flags: MessageFlags.Ephemeral\`.`,
      );
      assert.ok(
        !new RegExp(`\\b${word('fetch', 'Reply')}:\\s*true`, 'u').test(file.code),
        `${file.path} uses \`fetchReply\`, deprecated in discord.js 14.27. Use \`withResponse\`.`,
      );
    }
  });

  // -------------------------------------------------------------------------------------
  // `no-secret-unwrap-in-modules`
  // -------------------------------------------------------------------------------------

  test('no module unwraps a Secret: `.reveal(` appears zero times under src/modules', () => {
    // `#core/secret` documents `reveal()` as "the SINGLE greppable unwrap": one grep enumerates
    // every point where a credential becomes a plain string. A module has no legitimate reason to
    // hold a plaintext credential; if this rule blocks you, the function you are calling has the
    // wrong parameter type - give it a `Secret`, do not allow the unwrap here.
    const offenders = modules
      // `f.code`, not the raw text: this rule gets explained in module prose, and a check that
      // fires on its own explanation is a check that gets suppressed.
      .filter((f) => new RegExp(`\\.${word('rev', 'eal')}\\s*\\(`, 'u').test(f.code))
      .map((f) => f.path);

    assert.deepEqual(
      offenders,
      [],
      'a module unwrapped a Secret. Give the callee a `Secret` parameter instead — see #core/secret.',
    );
  });

  // -------------------------------------------------------------------------------------
  // The one sanctioned cast (engine only: a module repo has none)
  // -------------------------------------------------------------------------------------

  if (coreDir !== undefined) {
    test(`\`${AS_NEVER}\` appears only where octokit stale types force it`, () => {
      // ARCHITECTURE.md calls this the only sanctioned cast in the repo. If a second one appears,
      // either the claim is stale or somebody silenced the type system - both worth a conversation.
      const pattern = new RegExp(`\\b${AS_NEVER}\\b`, 'u');
      const offenders = nonTest
        // `f.code`, not the raw text: a comment DISCUSSING the cast is not a cast.
        .filter((f) => pattern.test(f.code))
        .map((f) => f.path);

      assert.deepEqual(
        offenders.sort(),
        allowedAsNever,
        `a new \`${AS_NEVER}\` appeared. It is documented as the single workaround for octokit typing return_run_details as 204-only.`,
      );
    });
  }

  // -------------------------------------------------------------------------------------
  // Import style - the mistake an agent makes most
  // -------------------------------------------------------------------------------------

  test('subpath imports carry no extension; relative imports carry .ts', () => {
    for (const file of all) {
      for (const spec of importsOf(file.code)) {
        if (spec.startsWith('#')) {
          assert.ok(
            !spec.endsWith('.ts'),
            `${file.path} imports "${spec}". Subpath imports resolve through package.json "imports" and take NO extension.`,
          );
        } else if (spec.startsWith('./') || spec.startsWith('../')) {
          assert.ok(
            spec.endsWith('.ts') || spec.endsWith('.json'),
            `${file.path} imports "${spec}". Node runs the real file, so relative imports MUST carry the .ts extension.`,
          );
        }
      }
    }
  });

  // -------------------------------------------------------------------------------------
  // Operator disclosure - the `## Operator action required` section
  // -------------------------------------------------------------------------------------
  //
  // THESE TESTS POLICE THE INSTRUCTION, NOT THE OUTPUT. They assert that both halves of the rule
  // are still written down and that the two documents still demand the SAME disclosures. They
  // cannot verify what a future agent wrote in a PR body: that is checked by the
  // `require-operator-disclosure` job in ci.yml, and the third test below asserts that job still
  // exists - this suite guards the instruction AND guards the guard. Whether a disclosure is TRUE
  // is a human reviewer's job.

  test('the agent prompt requires an `## Operator action required` section in the PR body', () => {
    const compose = runScriptOf(workflowYaml, 'Compose the delimited prompt file');

    // Sanity: if this step stops being the thing that writes the prompt, every assertion below is
    // checking text the agent never reads.
    assert.ok(
      compose.includes('> .agent/request.md'),
      'the compose step must still be what writes .agent/request.md, or these assertions check nothing the agent sees',
    );
    assert.ok(
      compose.includes(DISCLOSURE_HEADING),
      `the composed prompt no longer tells the agent to write a "${DISCLOSURE_HEADING}" section. Without it, a PR that needs a privileged intent, a re-invite, an environment variable or a new dependency is indistinguishable from one that needs nothing.`,
    );

    const text = compose.toLowerCase();
    for (const { what, needles } of DISCLOSURES) {
      for (const needle of needles) {
        assert.ok(text.includes(needle), `the composed prompt no longer ${what} (missing "${needle}").`);
      }
    }
  });

  test('AGENTS.md documents the same `## Operator action required` rule', () => {
    assert.match(
      agentsMd,
      /^## Operator action required$/mu,
      'AGENTS.md must carry the rule as a section of its own, or a contributor cannot find it.',
    );

    // And the definition of done must point at it, because that is the line where a contributor
    // decides they are finished. A rule documented only further down is a rule met after the PR.
    const doneAt = agentsMd.indexOf('Definition of done');
    assert.notEqual(doneAt, -1, 'AGENTS.md must still state a definition of done');
    const itemEnd = agentsMd.indexOf('\n\n', doneAt);
    const doneItem = agentsMd.slice(doneAt, itemEnd === -1 ? undefined : itemEnd);
    assert.ok(
      doneItem.includes(DISCLOSURE_SECTION),
      `the "Definition of done" must name the ${DISCLOSURE_HEADING} section, or a contributor reaches "done" without it.`,
    );

    const text = agentsMd.toLowerCase();
    for (const { what, needles } of DISCLOSURES) {
      for (const needle of needles) {
        assert.ok(text.includes(needle), `AGENTS.md no longer ${what} (missing "${needle}").`);
      }
    }
  });

  test('CI still fails a pull request whose body omits the section', () => {
    // The two tests above prove the rule is WRITTEN DOWN in both guides. Only this job proves it
    // is ENFORCED, because only it can see a pull request body. Deleting it would leave a rule that
    // two documents state, one unit test asserts, and nothing actually checks.
    assert.match(
      ciYaml,
      /^ {2}require-operator-disclosure:$/mu,
      'the ci.yml job that reads the PR body is gone. Without it the section is documented everywhere and enforced nowhere.',
    );
    assert.ok(
      ciYaml.includes(DISCLOSURE_HEADING),
      `the ci.yml gate no longer looks for "${DISCLOSURE_HEADING}"`,
    );

    const gate = runScriptOf(ciYaml, 'Require an Operator action required section in the PR body');
    assert.ok(
      !gate.includes('${{'),
      'the gate interpolates a ${{ }} expression into its script. A PR body is attacker-controlled text and an expression is substituted before the shell parses it — pass it through env: and read it as "$PR_BODY".',
    );
    assert.ok(
      gate.includes('"$PR_BODY"'),
      'the gate must read the body from the environment as "$PR_BODY", which the shell treats as data',
    );
    assert.match(
      gate,
      /exit 1/u,
      'the gate must FAIL the run on a missing section; a warning is a rule nobody has to obey',
    );
  });

  test('CI still fails a pull request that changes src/ and touches no test', () => {
    // AGENTS.md's definition of done says "you added a test that fails without your change", and
    // until `require-test-change` existed NOTHING LOOKED. An unenforced line in a guide is a line a
    // model can skip on a bad run at no cost, in a pull request that otherwise looks finished. Same
    // shape as the disclosure test above, for the same reason.
    assert.match(
      ciYaml,
      /^ {2}require-test-change:$/mu,
      'the ci.yml job that requires a test alongside a src change is gone.',
    );

    const gate = runScriptOf(ciYaml, 'Require a test change alongside any src change');
    assert.ok(
      !gate.includes('${{'),
      'the gate interpolates a ${{ }} expression into its script. A PR body is attacker-controlled text and an expression is substituted before the shell parses it - pass it through env: and read it as "$PR_BODY".',
    );
    assert.ok(
      gate.includes('"$PR_BODY"'),
      'the gate must read the body from the environment as "$PR_BODY", which the shell treats as data',
    );
    assert.ok(
      gate.includes('NO-TEST-NEEDED:'),
      'the escape hatch must exist and must be spelled NO-TEST-NEEDED:. A rule with no way around it gets deleted; a rule you can only route around IN WRITING, where a reviewer sees the reason, is the shape this repo already uses for CORE-CHANGE-NEEDED.',
    );
    assert.match(
      gate,
      /exit 1/u,
      'the gate must FAIL the run; a warning is a rule nobody has to obey',
    );
  });
}
