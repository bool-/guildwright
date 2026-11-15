/**
 * LIVE PROGRESS ON THE "BUILDING" CARD.
 *
 * The card used to say "Approved. This usually takes five to thirty minutes." and nothing else
 * until the build ended - twenty minutes in which a working build and a hung one looked the same.
 * The poller already asks GitHub about the run every `pollIntervalMs`; one more read
 * (`BuildsPort.runProgress`) says which step is running, and this file turns the workflow's step
 * names into something a requester can read.
 *
 * THE CARD IS EDITED ONLY WHEN THE STEP CHANGES (`progressKey`), not on every poll: a build has
 * about twenty steps, so a run costs about twenty edits instead of a hundred, and the elapsed time
 * is a Discord timestamp the client keeps counting by itself.
 */

import type { RunProgress } from '#core/ports';

/**
 * Workflow step name -> what the requester reads. Step names are the workflow's own (a
 * gate-verified file), plus the ones GitHub adds around every job.
 */
const STEP_LABELS: readonly (readonly [RegExp, string])[] = [
  [/^Set up job$/u, 'Starting the build machine'],
  [/^Validate dispatch inputs$/u, 'Checking the request'],
  [/^Checkout base branch$/u, 'Checking out the code'],
  [/^(Verify the Discord approval|Consume the approval)$/u, 'Checking the approval'],
  [/^Check the build credentials exist$/u, 'Checking the build credentials'],
  [/^Enforce daily agent-run cap$/u, "Checking today's build cap"],
  [/^(Set up the Node toolchain|Install dependencies)/u, 'Installing dependencies'],
  [/^Read the approved request$/u, 'Reading the request'],
  [/^Create the working branch$/u, 'Preparing the branch'],
  [/^(Stage the verified issue content|Compose the delimited prompt file)$/u, "Writing the agent's instructions"],
  [/^Install bubblewrap/u, "Preparing the agent's sandbox"],
  [/^Implement with Claude Code$/u, 'Agent is writing code'],
  [/^(Show the agent's final message|Reject forbidden path changes)$/u, 'Checking what the agent changed'],
  [/^(Resolve the PR URL|Post the run report)$/u, 'Reporting back'],
  [/^(Post |Complete job$)/u, 'Finishing up'],
];

/** The label the card shows for a workflow step. An unknown step is shown as "Working". */
export function stepLabel(stepName: string): string {
  for (const [pattern, label] of STEP_LABELS) {
    if (pattern.test(stepName)) return label;
  }
  return 'Working';
}

/** True while the agent itself is running: the window in which its pull request can appear. */
export function isAgentStep(stepName: string): boolean {
  return stepLabel(stepName) === 'Agent is writing code';
}

/** What the card is redrawn on. Two polls with the same key draw nothing. */
export function progressKey(progress: RunProgress, prUrl: string | null): string {
  return `${String(progress.stepNumber)}/${String(progress.totalSteps)}:${stepLabel(progress.stepName)}:${prUrl ?? ''}`;
}

/**
 * Whether the pull request may exist by now: the agent opens it during its own step, so the
 * poller looks for it from that step on (once per poll while the agent runs, then on change).
 */
export function mayHavePr(stepName: string): boolean {
  const label = stepLabel(stepName);
  return label === 'Agent is writing code' || label === 'Checking what the agent changed' || label === 'Reporting back' || label === 'Finishing up';
}
