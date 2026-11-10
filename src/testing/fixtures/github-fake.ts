/**
 * A fake GitHub behind the `GithubRequest` seam, for the containment preflight and the gate-file
 * check (RFC-001 PR 1.7). Test-only: under `fixtures/`, which the build excludes.
 *
 * WHY A SEAM AND NOT THE STUB TRANSPORT: the arms these probes exist to get right are 429, 5xx and
 * "no network", and the real client retries a 5xx with backoff and waits out a 429 - tens of
 * seconds per test, through octokit's module-global limiters. The 200/4xx arms that do not retry
 * are also driven through the real client elsewhere (`containment.test.ts`).
 *
 * Every answer is mutable, so a test can change the repository between two checks: push a commit
 * that edits a gate file, delete a secret, recover from an outage.
 */

import { createHash } from 'node:crypto';
import type { GateFile, GithubRequest } from '#adapters/github/gates';

/** An octokit `RequestError` look-alike. Status 0 is a network failure (no status at all). */
export function githubError(status: number, headers: Readonly<Record<string, string>> = {}): Error {
  const e = new Error(`request failed ${status}`);
  if (status === 0) {
    e.name = 'TypeError';
    return e;
  }
  e.name = 'HttpError';
  return Object.assign(e, { status, response: { status, headers, data: { message: 'nope' } } });
}

/** The engine's three gate files, as the fake engine knows them. */
export const ENGINE_FILES = {
  workflow: 'name: agent\npermissions: {}\n',
  verifier: 'print("verify")\n',
  settings: '{"permissions":{"deny":["Edit(./.github/**)"]}}\n',
} as const;

export const WORKFLOW_PATH = '.github/workflows/agent-implement-request.yml';
export const VERIFIER = '.github/scripts/verify_approval.py';
export const SETTINGS = '.github/claude/agent-settings.json';

export const SHA_A = 'a'.repeat(40);
export const SHA_B = 'b'.repeat(40);
export const SHA_C = 'c'.repeat(40);

const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

/** The expected digests for `ENGINE_FILES`, compared at `workflowPath` in the repository. */
export function engineReference(workflowPath = WORKFLOW_PATH): readonly GateFile[] {
  return [
    { repoPath: workflowPath, sha256: sha256(ENGINE_FILES.workflow) },
    { repoPath: VERIFIER, sha256: sha256(ENGINE_FILES.verifier) },
    { repoPath: SETTINGS, sha256: sha256(ENGINE_FILES.settings) },
  ];
}

export type RouteKey =
  | 'repo'
  | 'secret'
  | 'secrets-list'
  | 'environments'
  | 'ai-agent-secrets'
  | 'commit'
  | 'contents';

const ROUTES: Readonly<Record<string, RouteKey>> = {
  'GET /repos/{owner}/{repo}': 'repo',
  'GET /repos/{owner}/{repo}/actions/secrets/{secret_name}': 'secret',
  'GET /repos/{owner}/{repo}/actions/secrets': 'secrets-list',
  'GET /repos/{owner}/{repo}/environments': 'environments',
  'GET /repos/{owner}/{repo}/environments/{environment_name}/secrets': 'ai-agent-secrets',
  'GET /repos/{owner}/{repo}/commits/{ref}': 'commit',
  'GET /repos/{owner}/{repo}/contents/{path}': 'contents',
};

export interface FakeGithub {
  readonly request: GithubRequest;
  readonly calls: { readonly key: RouteKey; readonly params: Readonly<Record<string, string | number | boolean>> }[];
  /** A route answers with this thrown error until cleared. */
  readonly fail: Map<RouteKey, Error>;
  readonly state: {
    isPrivate: boolean;
    /** Does the repository secret APPROVAL_HMAC_KEY exist? */
    approvalSecret: boolean;
    /** `null`: no `ai-agent` environment. Otherwise the secret names it holds. */
    aiAgent: string[] | null;
    head: string;
    readonly commits: Map<string, Record<string, string | null>>;
  };
  /** Push a commit with these file overrides (null deletes) and move the ref to it. */
  push(sha: string, overrides?: Readonly<Record<string, string | null>>): void;
  count(key: RouteKey): number;
}

export function fakeGithub(workflowPath = WORKFLOW_PATH): FakeGithub {
  const files = (overrides: Readonly<Record<string, string | null>> = {}): Record<string, string | null> => ({
    [workflowPath]: ENGINE_FILES.workflow,
    [VERIFIER]: ENGINE_FILES.verifier,
    [SETTINGS]: ENGINE_FILES.settings,
    ...overrides,
  });
  const state: FakeGithub['state'] = {
    isPrivate: true,
    approvalSecret: true,
    aiAgent: ['APPROVAL_HMAC_KEY', 'ANTHROPIC_API_KEY'],
    head: SHA_A,
    commits: new Map([[SHA_A, files()]]),
  };
  const fail = new Map<RouteKey, Error>();
  const calls: FakeGithub['calls'] = [];

  const request: GithubRequest = async (route, params) => {
    const key = ROUTES[route];
    if (key === undefined) throw new Error(`fake GitHub: unexpected route ${route}`);
    calls.push({ key, params });
    const failure = fail.get(key);
    if (failure !== undefined) throw failure;
    switch (key) {
      case 'repo':
        return { status: 200, data: { full_name: 'o/r', private: state.isPrivate } };
      case 'secret':
        if (!state.approvalSecret) throw githubError(404);
        return { status: 200, data: { name: 'APPROVAL_HMAC_KEY', created_at: 'x', updated_at: 'x' } };
      case 'secrets-list':
        return { status: 200, data: { total_count: 0, secrets: [] } };
      case 'environments':
        return { status: 200, data: { total_count: 0, environments: [] } };
      case 'ai-agent-secrets':
        if (state.aiAgent === null) throw githubError(404);
        return { status: 200, data: { total_count: state.aiAgent.length, secrets: state.aiAgent.map((name) => ({ name })) } };
      case 'commit':
        return { status: 200, data: { sha: state.head } };
      case 'contents': {
        const content = state.commits.get(String(params['ref']))?.[String(params['path'])];
        if (content === undefined || content === null) throw githubError(404);
        return { status: 200, data: { type: 'file', encoding: 'base64', content: Buffer.from(content, 'utf8').toString('base64') } };
      }
      default: {
        const exhaustive: never = key;
        throw new Error(`fake GitHub: ${String(exhaustive)}`);
      }
    }
  };

  return {
    request,
    calls,
    fail,
    state,
    push(sha, overrides = {}) {
      state.commits.set(sha, files(overrides));
      state.head = sha;
    },
    count: (key) => calls.filter((c) => c.key === key).length,
  };
}
