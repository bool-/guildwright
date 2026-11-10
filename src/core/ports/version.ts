/**
 * WHICH BUILD IS RUNNING, as a port, so `/status` can say it.
 *
 * POSTMORTEM THIS FILE CLOSES: "somebody filed a bug and nobody could tell which build was
 * deployed." The boot log printed the Node version, the pid and the database path; `/status`
 * printed per-module health. Neither printed the first thing every triage needs - is this
 * machine running the code the report is about? Establishing that meant SSHing to the host and
 * running `git log`, which answers what is CHECKED OUT rather than what is running, and which
 * the person who filed the report cannot do at all.
 *
 * WHY IT IS ITS OWN CAPABILITY AND NOT A METHOD ON `catalog`. `catalog` is the natural home by
 * meaning, and it was the first attempt. It is also a port that MODULES construct by hand in
 * their own tests, so a new required method there is a compile error in files that had nothing
 * to do with the change - the contributor experience this repo works hardest to avoid. A
 * separate port costs one word in one module's `capabilities` line, and that word is honest:
 * a module that reports the deployed build is doing something worth seeing in review.
 *
 * WHY IT IS NOT ON `admin`. `admin` is the operator grant - audit rows and job counts, gated
 * behind a permission whose fallback is `guild-admin` or narrower. The build version is the one
 * number a REPORTER needs, and putting it behind the operator capability would make the field
 * every bug report should carry the field only an admin can read.
 *
 * WHY THE CAPABILITY IS `version` AND THE GITHUB ONE IS `builds`: `build` would have been the
 * obvious word and it is one letter from `builds`, which dispatches workflows and spends money.
 * Two capability words that differ by a plural, one of which is free and one of which is not,
 * is a typo waiting to be reviewed as correct.
 */

import type { BuildInfo, GithubAuthSummary } from '#core/version';

export interface VersionPort {
  /**
   * What is running: the engine package's name and version, the module repository's name,
   * version and git sha if this process can tell, and the Node version.
   *
   * SYNCHRONOUS, and CONSTANT for the life of the process. It is read once at boot and carried;
   * see `#adapters/system/version` for why re-reading `.git/HEAD` on demand would be a worse
   * answer rather than a fresher one.
   *
   * `repo.gitSha` is `string | null` and the `null` is load-bearing: a container built from a
   * tarball has no `.git`, and "this process cannot tell you" is a far better answer than a
   * plausible wrong sha. Render it through `describeBuild` in `#core/version`, which says
   * "no git sha" out loud instead of leaving a gap that reads as a formatting bug.
   *
   * None of it is secret. A version and a commit sha say nothing an operator would not put in a
   * release note, and withholding them costs more than it protects.
   */
  current(): BuildInfo;

  /**
   * How this process authenticates to GitHub: App slug, repository and installation id, or a
   * PAT and its expiry date. Render it through `describeGithubAuth` in `#core/version`.
   *
   * WHY IT RIDES ON THIS PORT rather than a new capability: it answers the same triage question
   * as `current()` ("what exactly is this deployment running as?"), it is just as free and just
   * as non-secret, and `/status` already holds `version`. A module still never sees the adapter
   * (AGENTS.md rule 1); it sees this plain data, filled in by the composition root once the boot
   * preflight has learned it, and constant after that.
   */
  githubAuth(): GithubAuthSummary;
}

/** Short alias, matching the style of every other port in `#core/ports`. */
export type Version = VersionPort;
