export {};

/**
 * Events published by the builder module.
 *
 * WHY this file exists rather than a shared registry: a subscriber gets full type inference
 * without importing this module, so cross-module reaction never becomes cross-module coupling.
 * Declaring an event here and forgetting its zod schema under `publishes` is a missing
 * property (TS2741), not an unvalidated payload in production.
 */
declare module '#core/events' {
  interface AppEvents {
    /** Emitted when an approver clicks Approve and the compare-and-set wins. */
    'builder.request_approved': {
      readonly requestId: string;
      readonly issueNumber: number;
      readonly approverId: string;
    };
    /** Emitted when the poller finds the PR. A notifications module subscribes to this. */
    'builder.pr_opened': {
      readonly requestId: string;
      readonly issueNumber: number;
      readonly prUrl: string;
    };
  }
}
