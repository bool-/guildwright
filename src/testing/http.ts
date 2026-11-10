/**
 * A recording `fetch` stub, so an HTTP adapter can be driven against fixtures offline.
 *
 * WHY this lives next to `fakes.ts` rather than inside one test file: the thing worth testing
 * about the GitHub client is the CLIENT the bot actually builds - its pinned API-version
 * header, its retry policy, its throttle policy. A test that constructs a bare `Octokit` of
 * its own proves nothing about any of that. Handing the real factory a transport is the only
 * way to exercise it without touching the network, and the Discord adapter needs the same
 * seam, so it belongs here.
 *
 * Nothing in here reaches the network. That is the point.
 */

/** One request the adapter made, captured verbatim. */
export interface RecordedRequest {
  readonly method: string;
  readonly url: string;
  /** Header names lower-cased, as `Headers` normalises them. */
  readonly headers: Readonly<Record<string, string>>;
  /** The request body when it was a string, which is what octokit sends. */
  readonly body: string | null;
}

/** What a responder hands back. `body` is JSON-encoded for the caller. */
export interface StubResponse {
  readonly status: number;
  readonly body?: unknown;
  readonly headers?: Readonly<Record<string, string>>;
}

/** Decide the answer for one request. Throwing here is a test bug, not a network failure. */
export type StubResponder = (request: RecordedRequest, callIndex: number) => StubResponse;

/** The stub plus the log of everything that went through it. */
export interface StubbedFetch {
  readonly fetch: typeof globalThis.fetch;
  /** Every request, in order. Assert on this rather than on call counts alone. */
  readonly requests: readonly RecordedRequest[];
}

/** WHY the derived type: `lib` is `es2024`, so the DOM `RequestInfo` alias does not exist here. */
type FetchInput = Parameters<typeof globalThis.fetch>[0];

function readUrl(input: FetchInput): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

/**
 * Build a `fetch` that answers from `responder` and records what it was asked.
 *
 * WHY a 204 gets a null body: `new Response('...', { status: 204 })` throws in undici, and a
 * 204 is a real answer from the workflow-dispatch endpoint, so the stub has to model it.
 */
export function stubFetch(responder: StubResponder): StubbedFetch {
  const requests: RecordedRequest[] = [];

  const fetchImpl: typeof globalThis.fetch = async (input: FetchInput, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    for (const [key, value] of new Headers(init?.headers).entries()) headers[key] = value;

    const recorded: RecordedRequest = {
      method: init?.method ?? 'GET',
      url: readUrl(input),
      headers,
      body: typeof init?.body === 'string' ? init.body : null,
    };
    requests.push(recorded);

    const answer = responder(recorded, requests.length - 1);
    const hasBody = answer.status !== 204 && answer.body !== undefined;
    return new Response(hasBody ? JSON.stringify(answer.body) : null, {
      status: answer.status,
      headers: { 'content-type': 'application/json; charset=utf-8', ...answer.headers },
    });
  };

  return { fetch: fetchImpl, requests };
}
