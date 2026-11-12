/**
 * EVERY SURFACE THIS MODULE DRAWS, and the one rule that governs all of them:
 * **a terminal outcome names the person who is waiting for it.**
 *
 * THE DEFECT THIS FILE IS ORGANISED AROUND. A requester submitted, waited twenty minutes, and
 * the outcome arrived as an EDIT to a message that had already scrolled away. Discord does not
 * notify anybody about an edit. So the product's entire payoff - "your pull request is open" -
 * was delivered to a surface nobody was looking at, and the honest instruction to a user was
 * "go back and check". Every ending below therefore carries `mentionUserId`, the shared `View`
 * field whose only consumer is the renderer's `allowed_mentions.users` allow-list.
 *
 * WHY THAT IS SAFE, and why it is not a hole in the "no pings" rule: `parse: []` STAYS. The
 * renderer keeps mass-mention parsing off, so `@everyone`, `@here` and role pings remain
 * structurally impossible no matter what a user types. The only thing that can be pinged is one
 * user id THE BOT CHOSE, and every call site below derives it from the persisted
 * `requesterId` snowflake through `toUserId` - a `Result`, so an unparseable column value costs
 * the ping and nothing else. No path exists from user text to this field.
 *
 * The second rule: a card is a pure function of persisted values, because the frame that
 * RENDERS an outcome runs half an hour after the frame that learned it, in a different process
 * if the bot restarted.
 */

import { readSurface, SURFACE_KEY } from '#core/module';
import { errors, type AppError } from '#core/errors';
import { isJsonObject, readString, type JsonObject } from '#core/json';
import {
  joinSafe,
  md,
  mdInlineCode,
  mdLink,
  mdMention,
  parseHttpsUrl,
  sanitizeStored,
  type HttpsUrl,
  type SafeMarkdown,
} from '#core/text';
import { assertActionRef, toUserId, type CardNonce, type RequestId } from '#core/ids';
import type { ButtonSpec, LinkSpec, SurfaceRef, View, ViewNode } from '#core/view';
import type { ActiveCounts, BuildRow, BuildState } from '#modules/builder/rows';
import { kindLabel, type RequestKind } from '#modules/builder/kinds';

/** Action names, shared with the manifest so a button and its handler cannot drift. */
export const REQUEST_FORM = 'request';
export const APPROVE = 'approve';
export const REJECT = 'reject';

// ---------------------------------------------------------------------------------------
// The ping
// ---------------------------------------------------------------------------------------

/**
 * The optional `View.mentionUserId`, as a spreadable fragment.
 *
 * WHY A FRAGMENT AND NOT `mentionUserId: string | undefined`: `exactOptionalPropertyTypes` is
 * on, so an explicit `undefined` is a DIFFERENT type from an absent property and would not be
 * assignable. Spreading `{}` is the only way to express "no ping" without widening the field on
 * the shared `View` for everybody else.
 */
export type Mention = { readonly mentionUserId?: string };

/** No ping: a card nobody is waiting on, or one the reader is already looking at. */
export const NO_PING: Mention = {};

/**
 * Ping the requester, from the PERSISTED SNOWFLAKE and nothing else.
 *
 * `toUserId` is a `Result`, and that is the whole guarantee: the value has to prove it is a
 * snowflake before it can be mentioned, so a corrupt column, an empty string or - the case that
 * matters - anything that ever came from user text cannot reach the allow-list. A row that
 * fails simply does not ping; an unnotified card is a much smaller failure than a card that
 * mentions an arbitrary id.
 */
export function pingRequester(requesterId: string): Mention {
  const id = toUserId(requesterId);
  return id.ok ? { mentionUserId: id.value } : NO_PING;
}

/** Ping the requester unless they are the one who just acted - self-notification is noise. */
export function pingRequesterUnless(requesterId: string, actorId: string): Mention {
  return requesterId === actorId ? NO_PING : pingRequester(requesterId);
}

// ---------------------------------------------------------------------------------------
// Buttons and links
// ---------------------------------------------------------------------------------------

/**
 * WHY `assertActionRef` (which throws) rather than the `Result` form: the registry
 * budget-checks every declared action name at boot against a worst-case 26-character entity
 * id, and every preview below is rendered at boot, so a throw here is unreachable in a bot
 * that started. Failing the deploy beats failing a card a user is looking at.
 */
export function approveButton(id: RequestId, nonce: CardNonce, disabled: boolean): ButtonSpec {
  return {
    customId: assertActionRef({ moduleId: 'builder', action: APPROVE, entityId: id, nonce }),
    label: 'Approve',
    style: 'success',
    disabled,
  };
}

export function rejectButton(id: RequestId, nonce: CardNonce, disabled: boolean): ButtonSpec {
  return {
    customId: assertActionRef({ moduleId: 'builder', action: REJECT, entityId: id, nonce }),
    label: 'Reject',
    style: 'danger',
    disabled,
  };
}

/**
 * A link row entry, or none.
 *
 * `HttpsUrl` is what `LinkSpec.url` demands, which is why a stored URL is re-proven by
 * `parseHttpsUrl` on the way back out rather than re-blessed - and why an unparseable one
 * silently costs a button instead of throwing on a card somebody is looking at.
 */
export function linkTo(label: string, url: HttpsUrl | null): readonly LinkSpec[] {
  return url === null ? [] : [{ label, url }];
}

// ---------------------------------------------------------------------------------------
// What is being approved
// ---------------------------------------------------------------------------------------

/**
 * A bounded, already-sanitised quotation of what the requester actually wrote.
 *
 * WHY IT IS A TYPE AND NOT A `string`: it is minted by `toMarkdown`, one of the named doors out
 * of `UserText`, and carrying the `truncated` flag with it is what lets the card say "cut off"
 * instead of quietly presenting a half sentence as the whole request.
 */
export interface RequestExcerpt {
  readonly md: SafeMarkdown;
  readonly truncated: boolean;
}

/**
 * THE CARD AN APPROVER SPENDS MONEY FROM.
 *
 * WHAT IT USED TO SAY, in full: "Build request. Issue `#42`. An approver must approve this
 * before anything is built." That is the entire basis on which somebody was asked to authorise
 * an Anthropic bill and a write to the repository. The title was already a parameter of this
 * function and was never rendered; the body was never even passed.
 *
 * Both are here now, and both are UNTRUSTED. The title arrives as a `PlainName` (minted by
 * `toPlainName`: NFKC, invisibles stripped, mentions defanged, markup neutralised, collapsed to
 * one line) and is re-scrubbed by `sanitizeStored` on the way out, because a `PlainName` that
 * has been through a database column is a plain string again. The excerpt arrives as
 * `SafeMarkdown` from `toMarkdown`, which is the same wall. Neither is a new door: the fence
 * discipline that governs the ISSUE BODY is untouched, because nothing here writes an issue.
 */
export function approvalCard(input: {
  readonly id: RequestId;
  readonly nonce: CardNonce;
  readonly title: SafeMarkdown;
  readonly excerpt: RequestExcerpt | null;
  /** From the form's dropdown; `null` for a request filed before the dropdown existed. */
  readonly kind: RequestKind | null;
  /** "How will we know it worked?" - optional on the form, so `null` when left blank. */
  readonly success: SafeMarkdown | null;
  readonly requesterId: string;
  readonly issueNumber: number;
  readonly issueUrl: HttpsUrl | null;
  readonly retryCount: number;
}): View {
  return {
    accent: 'pending',
    nodes: [
      { kind: 'heading', text: 'Build request', icon: 'build' },
      { kind: 'field', name: 'Request', md: input.title },
      ...(input.kind === null ? [] : [{ kind: 'field' as const, name: 'Kind', md: sanitizeStored(kindLabel(input.kind)) }]),
      ...excerptNode(input.excerpt),
      ...(input.success === null ? [] : [{ kind: 'field' as const, name: 'How we will know it worked', md: input.success }]),
      // A recorded snowflake, so a real mention: it renders as the name, and the renderer's
      // `allowed_mentions: { parse: [] }` means it can never ping.
      { kind: 'field', name: 'Asked by', md: mdMention('user', input.requesterId) },
      { kind: 'field', name: 'Issue', md: issueRef(input.issueNumber, input.issueUrl) },
      ...(input.retryCount === 0
        ? []
        : [
            {
              kind: 'text' as const,
              md: md`This request expired without a decision and was put back by ${mdInlineCode('/request retry')}. Nothing has been built and nothing has been charged.`,
            },
          ]),
      { kind: 'text', md: md`An approver must approve this before anything is built.` },
      {
        kind: 'buttons',
        links: linkTo('Issue', input.issueUrl),
        buttons: [approveButton(input.id, input.nonce, false), rejectButton(input.id, input.nonce, false)],
      },
    ],
  };
}

/**
 * The issue number as a link to the issue, or as plain `#21` when the url is unknown. A
 * clickable number beats a number plus a separate button you have to hunt for.
 */
export function issueRef(issueNumber: number, issueUrl: HttpsUrl | null): SafeMarkdown {
  const label = `#${String(issueNumber)}`;
  return issueUrl === null ? mdInlineCode(label) : mdLink(label, issueUrl);
}

/** WHY a helper: the "cut off" sentence must appear wherever an excerpt does, or nowhere. */
function excerptNode(excerpt: RequestExcerpt | null): readonly ViewNode[] {
  if (excerpt === null) return [];
  return [
    { kind: 'field', name: excerpt.truncated ? 'What it should do (shortened)' : 'What it should do', md: excerpt.md },
  ];
}

/**
 * The card for the 5-30 minutes that matter most.
 *
 * Drawn twice: at the Approve click, before any run exists (`runUrl: null`), and again by the
 * build job the moment it learns the run, so the person waiting can click through and watch.
 * It keeps the title, because "Building #21" alone does not say what is being built.
 */
export function buildingCard(input: {
  readonly issueNumber: number;
  readonly issueUrl: HttpsUrl | null;
  readonly runUrl: HttpsUrl | null;
  /** The persisted title; `null` only for a row from before titles were stored. */
  readonly title: string | null;
  /** Who clicked Approve; `null` when a job re-draws a card enqueued before this was recorded. */
  readonly approverId: string | null;
}): View {
  return {
    accent: 'pending',
    nodes: [
      { kind: 'heading', text: 'Building', icon: 'clock' },
      ...(input.title === null ? [] : [{ kind: 'field' as const, name: 'Request', md: sanitizeStored(input.title) }]),
      { kind: 'field', name: 'Issue', md: issueRef(input.issueNumber, input.issueUrl) },
      {
        kind: 'text',
        md:
          input.approverId === null
            ? md`Approved. This usually takes five to thirty minutes.`
            : md`Approved by ${mdMention('user', input.approverId)}. This usually takes five to thirty minutes.`,
      },
      { kind: 'buttons', links: [...linkTo('Run log', input.runUrl), ...linkTo('Issue', input.issueUrl)], buttons: [] },
    ],
  };
}

/** The same wait, said honestly the second time round. */
export function retryingCard(issueNumber: number, attempt: number, issueUrl: HttpsUrl | null): View {
  return {
    accent: 'pending',
    nodes: [
      { kind: 'heading', text: 'Building again', icon: 'clock' },
      { kind: 'field', name: 'Issue', md: issueRef(issueNumber, issueUrl) },
      { kind: 'field', name: 'Attempt', md: mdInlineCode(`#${String(attempt + 1)}`) },
      {
        kind: 'text',
        md: md`The previous run failed, so this was re-dispatched against the same issue. Five to thirty minutes.`,
      },
      { kind: 'buttons', links: linkTo('Issue', issueUrl), buttons: [] },
    ],
  };
}

/**
 * THE CAP, SAID OUT LOUD, at the only moment it can still be acted on.
 *
 * The workflow refuses to run more than `AGENT_DAILY_RUN_CAP` agent runs in a UTC day, and it
 * refuses at a STEP - so an over-cap request dispatched happily, consumed a run, failed inside
 * the runner, and reached Discord as "Build failed. The build ran and failed." with a link to a
 * log whose only content is "daily agent run cap reached". Nothing in that chain told the
 * requester the truth, which is that they did nothing wrong and the answer is to wait.
 */
export function capWaitingCard(input: {
  readonly issueNumber: number;
  readonly used: number;
  readonly cap: number;
  readonly waitMs: number;
  readonly issueUrl: HttpsUrl | null;
}): View {
  return {
    accent: 'warn',
    nodes: [
      { kind: 'heading', text: 'Queued - the daily build cap is full', icon: 'clock' },
      { kind: 'field', name: 'Issue', md: issueRef(input.issueNumber, input.issueUrl) },
      {
        kind: 'field',
        name: 'Runs used today',
        md: mdInlineCode(`${String(input.used)} of ${String(input.cap)}`),
      },
      {
        kind: 'text',
        md: sanitizeStored(
          `This repository allows ${String(input.cap)} agent runs per UTC day and today's are spent, so nothing was dispatched - ` +
            `no Actions minutes and no Anthropic tokens were used. The bot is holding this request and will start it in about ${plainHours(input.waitMs)}, when the cap resets.`,
        ),
      },
      { kind: 'text', md: md`You do not need to do anything. Cancel it with ${mdInlineCode('/request cancel')} if you would rather not wait.` },
      { kind: 'buttons', links: linkTo('Issue', input.issueUrl), buttons: [] },
    ],
  };
}

/**
 * ENDING 1 of 3: the agent finished, and opened an ordinary pull request.
 *
 * THE PING LIVES HERE, above all the other endings, because this is the one the requester has
 * been waiting twenty minutes for. It reached them as a silent edit to a message that had
 * scrolled off screen.
 */
export function openedCard(prUrl: HttpsUrl, issueUrl: HttpsUrl | null, mention: Mention, summary: string | null = null): View {
  return {
    ...mention,
    accent: 'ok',
    nodes: [
      { kind: 'heading', text: 'Pull request ready', icon: 'ok' },
      // The agent's own one-line account. Model-written, so it is re-scrubbed like any stored text.
      ...(summary === null ? [] : [{ kind: 'field' as const, name: 'What changed', md: sanitizeStored(summary) }]),
      // The URL came off the GitHub API, so it is a plain string here; `sanitizeStored`
      // re-scrubs it rather than re-blessing it. It is kept as TEXT as well as a link button
      // because a link button is a component, and components are what `disableComponents`
      // strips - the address itself must survive that.
      { kind: 'text', md: sanitizeStored(prUrl) },
      { kind: 'text', md: OPERATOR_NUDGE },
      { kind: 'buttons', links: [...linkTo('Pull request', prUrl), ...linkTo('Issue', issueUrl)], buttons: [] },
    ],
  };
}

/**
 * THE OPERATOR NUDGE, at the last moment before merge when somebody is actually looking.
 *
 * `.github/workflows/ci.yml` fails any pull request whose body has no
 * `## Operator action required` section, so the section is guaranteed to EXIST. Nothing
 * guarantees anybody reads it, and the things it lists - a privileged gateway intent to tick, a
 * re-invite with a new permissions integer, an environment variable that stops the bot at config
 * parse - are discovered otherwise by a merged bot that will not boot.
 */
const OPERATOR_NUDGE = md`Before merging, read its "Operator action required" section.`;

/**
 * ENDING 2 of 3: the agent could not finish, so it opened a DRAFT pull request describing what
 * remains - exactly as the composed prompt instructs it to.
 *
 * WHY THIS IS ITS OWN CARD: "here is your feature" and "here is a half-finished attempt" ask
 * completely different things of the requester, and reporting the second as the first is how
 * somebody merges an unfinished branch believing it was reviewed and complete.
 */
export function draftPrCard(
  prUrl: HttpsUrl,
  issueUrl: HttpsUrl | null,
  mention: Mention,
  why = 'The agent opened it as a draft because it could not finish.',
  remaining: string | null = null,
): View {
  return {
    ...mention,
    accent: 'warn',
    nodes: [
      { kind: 'heading', text: 'Pull request opened - unfinished', icon: 'warn' },
      { kind: 'text', md: sanitizeStored(prUrl) },
      { kind: 'text', md: sanitizeStored(why) },
      ...(remaining === null ? [] : [{ kind: 'field' as const, name: 'Left to do', md: sanitizeStored(remaining) }]),
      { kind: 'text', md: md`Review it before merging - it may not pass its checks.` },
      { kind: 'buttons', links: [...linkTo('Pull request', prUrl), ...linkTo('Issue', issueUrl)], buttons: [] },
    ],
  };
}

/**
 * The agent changed a path the workflow forbids (`.github`, `.env`, ...). The run is failed on
 * purpose and any pull request it opened must not be merged, so this says so in the title.
 */
export function blockedCard(prUrl: HttpsUrl | null, issueUrl: HttpsUrl | null, runUrl: HttpsUrl | null, mention: Mention): View {
  return {
    ...mention,
    accent: 'error',
    nodes: [
      { kind: 'heading', text: 'Blocked - do not merge', icon: 'error' },
      { kind: 'text', md: md`The agent changed a protected file (${mdInlineCode('.github')}, ${mdInlineCode('.env')} or similar), so the build was stopped.` },
      { kind: 'text', md: md`Close its pull request, then rephrase the request.` },
      { kind: 'buttons', links: [...linkTo('Pull request', prUrl), ...linkTo('Run log', runUrl), ...linkTo('Issue', issueUrl)], buttons: [] },
    ],
  };
}

/**
 * ENDING 3 of 3: a DELIBERATE REFUSAL. The run succeeded and there is no pull request, because
 * the request asked for something the security boundary forbids - reading secrets, editing
 * anything under `.github`, weakening authentication - and the agent is instructed to make NO
 * changes and comment on the issue instead.
 *
 * WHY IT IS NOT A FAILURE: "it broke" and "it refused on purpose" demand opposite reactions.
 * The first is worth retrying and worth an operator looking at a run log. The second is a policy
 * answer, and retrying it is exactly the wrong move - which is why `/request retry` refuses this
 * state, and says so.
 */
export function refusedCard(issueNumber: number, issueUrl: HttpsUrl | null, mention: Mention, reason: string | null = null): View {
  return {
    ...mention,
    accent: 'warn',
    nodes: [
      { kind: 'heading', text: 'Refused - nothing changed', icon: 'warn' },
      { kind: 'field', name: 'Issue', md: issueRef(issueNumber, issueUrl) },
      // The agent's own explanation, model-written and re-scrubbed.
      { kind: 'field', name: 'Why', md: reason === null ? md`The agent did not say. The GitHub issue has its report.` : sanitizeStored(reason) },
      { kind: 'text', md: md`The same request will be refused again, so change it before asking again.` },
      { kind: 'buttons', links: linkTo('Issue', issueUrl), buttons: [] },
    ],
  };
}

/**
 * Nobody clicked, for `ttlHours` hours, so the request released its slot on its own.
 *
 * WHY THE BUTTONS STAY, DISABLED: a resolved card that keeps its (inert) controls reads as
 * history rather than as a message that mysteriously lost its buttons, and it makes the outcome
 * visible at a glance in a scrollback. A click on one is refused anyway.
 */
export function expiredCard(input: {
  readonly issueNumber: number | null;
  readonly issueUrl: HttpsUrl | null;
  readonly ttlHours: number;
  readonly issueClosed: boolean;
  readonly buttons: readonly ButtonSpec[];
  readonly mention: Mention;
}): View {
  return {
    ...input.mention,
    accent: 'warn',
    nodes: [
      { kind: 'heading', text: 'Expired - nobody approved this', icon: 'clock' },
      ...(input.issueNumber === null
        ? []
        : [{ kind: 'field' as const, name: 'Issue', md: issueRef(input.issueNumber, input.issueUrl) }]),
      {
        kind: 'text',
        md: sanitizeStored(
          `No approver clicked Approve or Reject within ${String(input.ttlHours)} hours, so this request expired. ` +
            (input.issueClosed
              ? 'Nothing was built, nothing was charged, and the GitHub issue is closed.'
              : 'Nothing was built and nothing was charged, but the GitHub issue could not be closed - close it by hand.'),
        ),
      },
      {
        kind: 'text',
        md: md`Put it back in front of an approver with ${mdInlineCode('/request retry')} - you do not have to type it again.`,
      },
      { kind: 'buttons', links: linkTo('Issue', input.issueUrl), buttons: input.buttons },
    ],
  };
}

export function failedCard(e: AppError, issueUrl: HttpsUrl | null, runUrl: HttpsUrl | null, mention: Mention): View {
  return {
    ...mention,
    accent: 'error',
    nodes: [
      { kind: 'heading', text: 'Build failed', icon: 'error' },
      // `userMessage` is the only renderer; `e.internal` is structurally unreachable from it.
      { kind: 'text', md: sanitizeStored(e.userDetail) },
      // Every failure ends at the same way back. Said once: most next steps already name it.
      {
        kind: 'text',
        md: sanitizeStored(e.nextStep.includes('/request retry') ? e.nextStep : `${e.nextStep} Then run /request retry.`),
      },
      // THE LINK THAT TURNS THREE MANUAL HOPS INTO ONE CLICK.
      { kind: 'buttons', links: [...linkTo('Run log', runUrl), ...linkTo('Issue', issueUrl)], buttons: [] },
    ],
  };
}

/** An approver said no. WHY it is a card and not an inline literal: it pings, like every other
 *  ending, and a ping that only some endings carry is the bug this file exists to close. */
export function rejectedCard(issueClosed: boolean, mention: Mention): View {
  return {
    ...mention,
    accent: 'warn',
    nodes: [
      { kind: 'heading', text: 'Rejected', icon: 'warn' },
      {
        kind: 'text',
        md: issueClosed
          ? md`An approver rejected this. Nothing was built and nothing was charged.`
          : md`An approver rejected this. Nothing was built, but the GitHub issue could not be closed - close it by hand.`,
      },
    ],
  };
}

/**
 * WITHDRAWN, and the honest sentence about what withdrawal can and cannot reach.
 *
 * `wasRunning` is the whole point of the wording. Cancelling a request that nobody has approved
 * costs nothing and stops everything. Cancelling one that is already EXECUTING stops the bot -
 * the poller is cancelled, the row is terminal, the slot comes back - and does NOT stop GitHub:
 * this module dispatches a workflow run and has no port that cancels one. Saying "cancelled"
 * without that distinction would leave somebody believing a paid run had been stopped while it
 * kept running for another twenty minutes and opened a pull request nobody expected.
 */
export type CancelledRun =
  /** Nothing had been dispatched, so there was no run to stop. */
  | { readonly kind: 'never-started' }
  /** Approved, but no run was recorded for it - GitHub refused the dispatch, or one has not been matched yet. */
  | { readonly kind: 'no-run' }
  /** GitHub accepted the cancellation (202). It is stopping; a running step may still finish. */
  | { readonly kind: 'stop-requested' }
  /** GitHub refused the cancellation because the run was already over (409). */
  | { readonly kind: 'already-finished' }
  /** We could not stop it: no run id yet, the call failed, or this build cannot ask. */
  | { readonly kind: 'still-running' }
  /** The run was cancelled INSIDE GitHub. Nobody here withdrew anything. */
  | { readonly kind: 'stopped-in-github' };

/** Who ended it. `github` is the arm where nobody in Discord did - see `stopped-in-github`. */
export type CancelledBy = 'requester' | 'approver' | 'github';

/**
 * WHAT ACTUALLY HAPPENED TO THE RUN, in one sentence per outcome.
 *
 * THIS IS THE FIX. The card had two sentences for five situations, so it said "the GitHub
 * Actions run itself keeps going" about a run GitHub had already cancelled, and about a run the
 * bot had just successfully asked GitHub to stop. Each arm below is a different fact and a
 * different next step, and the exhaustive switch is what stops a sixth situation from silently
 * reusing somebody else's sentence.
 *
 * NOTHING HERE PROMISES MORE THAN A CANCEL CAN DELIVER. `stop-requested` is a REQUEST that
 * GitHub accepted, not a stopped run: a step already executing runs to its end, and the branch
 * it pushed does not un-push itself. Saying "cancelled, and the run stopped" would be the same
 * class of lie as the sentence this replaces, pointed the other way.
 */
function runOutcomeLine(run: CancelledRun): SafeMarkdown {
  switch (run.kind) {
    case 'never-started':
      return md`Nothing had been built and nothing was charged.`;
    case 'no-run':
      return md`It was approved, but the bot hadn't found a GitHub run for it yet. If one shows up in the Actions tab, cancel it there.`;
    case 'stop-requested':
      return md`The build had started. **GitHub is stopping the run** - it usually takes a minute, and a branch may be left behind.`;
    case 'already-finished':
      return md`The build had already **finished**, so nothing was saved. It may have opened a pull request - check the run log.`;
    case 'still-running':
      return md`The build had started and **the bot could not stop the run**. Cancel it in the Actions tab to save the minutes.`;
    case 'stopped-in-github':
      return md`The run was cancelled in GitHub, not from here. No pull request is coming from it.`;
    default: {
      // A sixth outcome must appear HERE, at compile time, rather than inherit a sentence that
      // happens to be about something else.
      const exhaustive: never = run;
      void exhaustive;
      return md`The run's final state is unknown. Open the run log.`;
    }
  }
}

function cancelledByLine(by: CancelledBy): readonly ViewNode[] {
  switch (by) {
    case 'requester':
      return [{ kind: 'text', md: md`The requester withdrew this.` }];
    case 'approver':
      return [{ kind: 'text', md: md`An approver cancelled this.` }];
    case 'github':
      // NO LINE AT ALL. Attributing a GitHub-side cancellation to "an approver" - which is what
      // a boolean forced - names somebody who did not do it, in a channel they can read.
      return [];
    default: {
      const exhaustive: never = by;
      void exhaustive;
      return [];
    }
  }
}

export function cancelledCard(input: {
  readonly issueNumber: number | null;
  readonly issueUrl: HttpsUrl | null;
  readonly runUrl: HttpsUrl | null;
  readonly run: CancelledRun;
  readonly issueClosed: boolean;
  readonly by: CancelledBy;
  readonly buttons: readonly ButtonSpec[];
  readonly mention: Mention;
}): View {
  return {
    ...input.mention,
    accent: 'warn',
    nodes: [
      { kind: 'heading', text: 'Cancelled', icon: 'warn' },
      ...(input.issueNumber === null
        ? []
        : [{ kind: 'field' as const, name: 'Issue', md: issueRef(input.issueNumber, input.issueUrl) }]),
      ...cancelledByLine(input.by),
      { kind: 'text', md: runOutcomeLine(input.run) },
      {
        kind: 'text',
        md: input.issueClosed
          ? md`The GitHub issue is closed.`
          : md`The GitHub issue could not be closed - close it by hand.`,
      },
      {
        kind: 'buttons',
        links: [...linkTo('Run log', input.runUrl), ...linkTo('Issue', input.issueUrl)],
        buttons: input.buttons,
      },
    ],
  };
}

// ---------------------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------------------

/** What each state means to somebody who did not read the state machine. */
export function stateLabel(state: BuildState): string {
  switch (state) {
    case 'draft':
      return 'Filing';
    case 'awaiting_approval':
      return 'Waiting for an approver';
    case 'dispatching':
      return 'Starting';
    case 'running':
      return 'Building';
    case 'pr_open':
      return 'Pull request opened';
    case 'done':
      return 'Refused by the agent';
    case 'failed':
      return 'Failed';
    case 'rejected':
      return 'Rejected';
    case 'expired':
      return 'Expired';
    case 'cancelled':
      return 'Cancelled';
    default: {
      // A new state must show up HERE, at compile time, rather than as a blank cell in a list.
      const exhaustive: never = state;
      void exhaustive;
      return 'Unknown';
    }
  }
}

/** Which list is being shown. The two audiences want opposite things - see `waitingInGuild`. */
export type ListScope = 'mine' | 'waiting';

/**
 * THE ANSWER TO "WHAT HAPPENED TO MY REQUEST?", which had none.
 *
 * Before this, a request that scrolled away was unrecoverable from inside the product: no
 * command listed one, the card was the only record, and an approver could not discover that
 * ANYTHING was waiting for them - the pending queue was invisible, which is why requests sat
 * until the 48-hour sweep collected them.
 *
 * Every value here is re-scrubbed on the way out of the database. `title` was sanitised before
 * it was stored and is sanitised again on read, because a column is a plain string and a round
 * trip must validate rather than launder.
 */
export function listCard(rows: readonly BuildRow[], scope: ListScope, ttl: number): View {
  if (rows.length === 0) {
    return {
      accent: 'info',
      ephemeral: true,
      nodes: [
        {
          kind: 'text',
          md:
            scope === 'mine'
              ? md`You have not opened any build requests in this server. Start one with ${mdInlineCode('/request new')}.`
              : md`Nothing is waiting for an approver here. Every request has been approved, rejected, cancelled or has expired.`,
        },
      ],
    };
  }

  return {
    accent: 'info',
    ephemeral: true,
    nodes: [
      {
        kind: 'heading',
        text: scope === 'mine' ? 'Your build requests' : 'Waiting for an approver',
        icon: 'info',
      },
      ...rows.map((row) => rowField(row)),
      {
        kind: 'text',
        md:
          scope === 'mine'
            ? md`Withdraw one with ${mdInlineCode('/request cancel')}, or re-run a failed or expired one with ${mdInlineCode('/request retry')}. Both take the id shown above and offer it as you type.`
            : joinSafe([
                sanitizeStored(`Oldest first: the top one is closest to expiring, which happens ${String(ttl)} hours after it was filed.`),
                md`Approve or Reject on the original card, or clear one out with ${mdInlineCode('/request cancel')}.`,
              ]),
      },
    ],
  };
}

/** One row of the list. A `field`, not a `table` cell, because only `field` takes SafeMarkdown. */
function rowField(row: BuildRow): ViewNode {
  const issue = row.issueNumber === null ? 'not filed' : `#${String(row.issueNumber)}`;
  const lines: SafeMarkdown[] = [
    row.title === null ? md`_(no title recorded)_` : sanitizeStored(row.title),
    mdInlineCode(row.id),
  ];
  const issueUrl = storedUrl(row.issueUrl);
  if (issueUrl !== null) lines.push(sanitizeStored(issueUrl));
  const prUrl = storedUrl(row.prUrl);
  if (prUrl !== null) lines.push(sanitizeStored(prUrl));

  return { kind: 'field', name: `${stateLabel(row.state)} - ${issue}`, md: joinSafe(lines) };
}

// ---------------------------------------------------------------------------------------
// Reading persisted values back out
// ---------------------------------------------------------------------------------------

/**
 * A URL that has been through the database, re-proven rather than re-blessed.
 *
 * WHY `parseHttpsUrl` and not a cast: a column is a plain `string`, so the round trip would
 * otherwise launder anything into an `HttpsUrl` and onto a link button. WHY it returns `null`
 * instead of an error: a card missing one button is a much smaller failure than a card that
 * throws, and this is the only consequence.
 */
export function storedUrl(raw: string | null): HttpsUrl | null {
  if (raw === null) return null;
  const parsed = parseHttpsUrl(raw);
  return parsed.ok ? parsed.value : null;
}

/** WHY `Result`-free: a malformed persisted surface is a dropped row, not a crash. */
export function parseSurface(json: string): JsonObject | null {
  try {
    const raw: unknown = JSON.parse(json);
    return isJsonObject(raw) && readString(raw, 'channelId') !== undefined && readString(raw, 'messageId') !== undefined
      ? raw
      : null;
  } catch {
    return null;
  }
}

/**
 * The delivery surface a row was posted to, recovered from `surface_json`.
 *
 * WHY it re-uses `readSurface` rather than trusting the parse: `readSurface` is the one function
 * that knows what a `SurfaceRef` must contain, and it is already the total, `Result`-returning
 * reader used on the job path. Wrapping the stored object under `SURFACE_KEY` is what lets the
 * expiry sweep, `/request cancel` and `/request retry` - which have a ROW and not a job payload
 * - reach exactly the same code.
 */
export function surfaceOf(row: BuildRow): SurfaceRef | null {
  if (row.surfaceJson === null) return null;
  const raw = parseSurface(row.surfaceJson);
  if (raw === null) return null;
  const ref = readSurface({ [SURFACE_KEY]: raw });
  return ref.ok ? ref.value : null;
}

// ---------------------------------------------------------------------------------------
// Sentences said in more than one place, so they cannot drift
// ---------------------------------------------------------------------------------------

/** The TTL as whole hours, for the one sentence a human reads. */
export function ttlHours(approvalTtlMs: number): number {
  return Math.max(1, Math.round(approvalTtlMs / 3_600_000));
}

/** A duration a human can act on. Deliberately coarse: nobody schedules around "3h 41m". */
export function plainHours(ms: number): string {
  const hours = Math.round(ms / 3_600_000);
  if (hours >= 2) return `${String(hours)} hours`;
  const minutes = Math.max(1, Math.round(ms / 60_000));
  return minutes === 1 ? '1 minute' : `${String(minutes)} minutes`;
}

/**
 * The build ran and failed. A SETTLED fact, so the error is not retryable.
 *
 * WHY THAT MATTERS MORE THAN THE WORDING: the job runner retries a `failed` outcome whose error
 * `isRetryable`, and `errors.upstream('github', 0, ...)` is retryable - so a run that had
 * already finished as a failure was re-polled with backoff until `maxAttempts` ran out, and the
 * card said "Building. This usually takes five to thirty minutes." for hours after the build was
 * over. `conflict` is the variant for "the state has settled and asking again cannot change it".
 */
export function runFailedError(runUrl: HttpsUrl | null): AppError {
  return errors.conflict(
    'run_failed',
    'The build ran and failed.',
    runUrl === null
      ? 'Open the workflow run from the GitHub issue to see what broke, then run /request retry.'
      : 'Open the run log linked on this card to see what broke, then run /request retry.',
    'failed',
  );
}

/**
 * GitHub refused every dispatch attempt this request was allowed. A SETTLED fact, so the error
 * is not retryable - for the same reason as `runFailedError`: an `upstream` error with status 0
 * is retryable, so returning one here had the runner retry "out of attempts" up to `maxAttempts`
 * times over the build deadline, with the row stuck in `dispatching` and `/request retry`
 * refusing it as not finished.
 */
export function dispatchExhaustedError(): AppError {
  return errors.conflict(
    'dispatch_exhausted',
    'GitHub would not start the build.',
    'Ask an admin to check the bot log for "dispatch failed", then run /request retry.',
    'failed',
  );
}

/**
 * THE CAP, AS A TERMINAL REFUSAL - reached only when the reset is further away than this build
 * request is allowed to live (`buildDeadlineMs`, default six hours).
 *
 * WHY IT IS TERMINAL RATHER THAN A LONGER WAIT: a `retry` outcome scheduled past the job's
 * deadline is not a wait, it is a dead-letter with extra steps - the runner gives up at the
 * deadline and draws "Build failed", which is the unexplained message this whole feature exists
 * to abolish. Saying it now, with the number of hours in it, is the honest version.
 */
export function dailyCapExhaustedError(used: number, cap: number, waitMs: number): AppError {
  return errors.conflict(
    'daily_run_cap',
    `This repository allows ${String(cap)} agent runs per UTC day and ${String(used)} have already started, so nothing was dispatched - no Actions minutes and no Anthropic tokens were spent.`,
    `The cap resets in about ${plainHours(waitMs)}, which is longer than an approved request stays alive. Run /request retry after it resets, or ask an admin to raise the daily build cap.`,
    'capped',
  );
}

/**
 * THE REPOSITORY IS AT ITS DISPATCH CAP (RFC-001 7.5, `maxConcurrentPerRepo`).
 *
 * Said to whoever clicked Approve or ran `/request retry` when the request's REPOSITORY already
 * has as many builds dispatched as its workflow's concurrency group can hold. It names the
 * repository, because with several servers on one repository the builds holding the slots are
 * often not in the reader's server at all - "wait for yours to finish" would send them looking for
 * builds they cannot see. Nothing was approved or spent, and the card is still live.
 *
 * WHY EXPORTED: the wording is part of the fix, so a test pins it.
 */
export function repoConcurrencyError(repository: string, building: number, cap: number): AppError {
  const held = building === 1 ? '1 build' : `${String(building)} builds`;
  return errors.conflict(
    'repo_concurrency',
    `${repository} already has ${held} running or about to start, which is as many as it takes at once (${String(cap)}), so nothing was approved and nothing was spent.`,
    'Try again when one of them finishes - a build usually takes five to thirty minutes. This request is unchanged in the meantime.',
    'repo-full',
  );
}

/**
 * THE REFUSAL THAT TELLS THE READER WHICH PROBLEM THEY HAVE.
 *
 * One sentence used to cover both: "Too many builds are already in flight here. Wait for one to
 * finish." That is true when builds are running and a lie when the slots are held by requests
 * nobody has approved - and the lie is the expensive one, because "wait" is precisely the action
 * that never worked. An unapproved request does not finish; somebody has to approve it, reject
 * it, cancel it, or let it expire.
 *
 * WHY EXPORTED: the wording IS the fix, so a test pins it rather than trusting it.
 */
export function concurrencyError(active: ActiveCounts, approvalTtlMs: number): AppError {
  const hours = String(ttlHours(approvalTtlMs));
  const waiting = active.waiting === 1 ? '1 request is' : `${String(active.waiting)} requests are`;
  const running = active.running === 1 ? '1 build is' : `${String(active.running)} builds are`;

  // THE TRANSIENT ARM, which is what the atomic claim made visible.
  //
  // It covers two states that a reader cannot tell apart and should not have to: a slot held by
  // a submission still being FILED, and a slot that was held a moment ago and has since cleared
  // - the counts are read AFTER the claim was refused, so by the time this renders the row that
  // beat you may already be gone.
  //
  // It needs its own sentence because the advice in every other arm is wrong here. "Ask an
  // approver" names somebody who does not exist yet, and "wait for a build to finish" names a
  // build that is not running. The one true instruction is "try again in a moment".
  //
  // It is the ONLY arm when nothing else holds a slot; when something else does, the reader's
  // real problem is that other thing, and naming a transient row alongside it would be noise.
  if (active.waiting === 0 && active.running === 0) {
    return errors.conflict(
      'concurrency_filing',
      active.filing === 1
        ? 'Another request in this server is being filed right now, and it is holding the last slot.'
        : active.filing > 1
          ? `${String(active.filing)} requests in this server are being filed right now, and they are holding the slots.`
          : 'This server was at its build limit a moment ago.',
      'Try again in a moment. If it is still refused a minute from now, run /request list to see what is actually holding the slot.',
      'filing',
    );
  }

  if (active.running === 0) {
    return errors.conflict(
      'concurrency_waiting',
      `${waiting} still waiting for an approver here, and nothing is actually building.`,
      `Run /request list all to see them, ask an approver to approve or reject ${active.waiting === 1 ? 'it' : 'them'}, or clear one with /request cancel - an unapproved request only clears itself after ${hours} hours.`,
      'waiting',
    );
  }
  if (active.waiting === 0) {
    return errors.conflict(
      'concurrency_running',
      `${running} already building here.`,
      'Wait for one to finish; a build usually takes five to thirty minutes. /request list shows how far along yours is.',
      'running',
    );
  }
  return errors.conflict(
    'concurrency_mixed',
    `${running} building here and ${waiting} still waiting for an approver.`,
    `Wait for the build to finish, or ask an approver to clear the waiting ${active.waiting === 1 ? 'request' : 'requests'} - /request list all shows them and /request cancel withdraws one. Unapproved requests only clear themselves after ${hours} hours.`,
    'mixed',
  );
}
