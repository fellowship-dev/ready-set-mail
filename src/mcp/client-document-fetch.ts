// A client ID metadata document (CIMD) is fetched from the address in the client_id. The draft (draft-ietf-oauth-client-id-metadata-document) says the
// authorization server MUST NOT follow redirects when it fetches one: a redirect would let a document at one address be answered from another, and
// would send this server's request to wherever that points. The OAuth library fetches with the platform default (follow), so every request the library
// makes (recognised by its User-Agent) is made with redirect "manual", and a redirect answer is treated as a failed fetch. Private and local addresses
// stay blocked by the `global_fetch_strictly_public` compatibility flag (wrangler.jsonc); size and time limits are the library's (5 KB, 10 s).
const LIBRARY_AGENT = 'workers-oauth-provider/';

/** Marks the wrapped fetch, so it is wrapped once however often this module is loaded. */
const WRAPPED = Symbol.for('ready-set-mail.client-document-fetch');

/** Wrap the global fetch once. Anything that is not the OAuth library's own request passes through untouched. */
export function refuseClientDocumentRedirects(): void {
  if ((globalThis.fetch as unknown as Record<symbol, boolean>)[WRAPPED]) return;
  const real = globalThis.fetch.bind(globalThis);
  const wrapped = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const agent = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined)).get('user-agent');
    if (!agent?.startsWith(LIBRARY_AGENT)) return real(input, init);
    const response = await real(input, { ...init, redirect: 'manual' });
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel().catch(() => undefined);
      return new Response('Redirects are not followed', { status: 502 });
    }
    return response;
  }) as typeof fetch;
  (wrapped as unknown as Record<symbol, boolean>)[WRAPPED] = true;
  globalThis.fetch = wrapped;
}
