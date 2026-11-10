import type { SelectOption } from '#core/view';

/**
 * What kind of change a request is. Chosen from the form's dropdown, re-validated on submit
 * by `FormValues.choice`, shown on the approval card, and filed as an issue label so the
 * issue list can be sorted.
 *
 * WHY a closed list: the value is echoed back by the client, so it is an allow-list the
 * server checks, never free text. The label names are fixed strings this file owns.
 */
export const REQUEST_KINDS = ['new-command', 'change', 'fix'] as const;
export type RequestKind = (typeof REQUEST_KINDS)[number];

const KIND_TEXT: Readonly<Record<RequestKind, { readonly label: string; readonly description: string }>> = {
  'new-command': { label: 'New command or feature', description: 'Something the bot cannot do yet.' },
  change: { label: 'Change something', description: 'Make an existing command behave differently.' },
  fix: { label: 'Fix a bug', description: 'Something is broken or wrong.' },
};

export const KIND_OPTIONS: readonly SelectOption[] = REQUEST_KINDS.map((k) => ({
  label: KIND_TEXT[k].label,
  value: k,
  description: KIND_TEXT[k].description,
}));

export function kindLabel(kind: RequestKind): string {
  return KIND_TEXT[kind].label;
}

/** The GitHub issue label for a kind, e.g. `kind:fix`. */
export function kindIssueLabel(kind: RequestKind): string {
  return `kind:${kind}`;
}
