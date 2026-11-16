// Shared setup for the plan tests: the billing world (hosted, a fake Stripe wired in as fetch) with HOSTED_PLAN on, a controllable DNS, and helpers that
// add domains the way a browser does (a claim, its TXT record, then the proof).
import { vi } from 'vitest';
import { billingWorld, call, json, rows, type Person, type World } from '../billing/world';

export interface PlanWorld extends World {
  /** DNS the claims are proven against: name → TXT values. Anything else does not exist. */
  txt: Map<string, string[]>;
  prove: (domain: string, claim: { txt_name: string; txt_value: string }) => void;
  /** Add a domain through the plain add (the free path). Returns the final response (claim proven when `proven`). */
  addFree: (p: Person, domain: string) => Promise<Response>;
  /** The owner's paid add: first call makes the claim, the proof is published, the second call adds and bills. */
  addPaid: (p: Person, domain: string, extra?: Record<string, unknown>) => Promise<Response>;
  quantityOf: (workspaceId: string) => number | null;
  sub: (workspaceId: string) => any;
  ws: (workspaceId: string) => any;
  domainsOf: (workspaceId: string) => string[];
}

export async function planWorld(extraEnv: Record<string, unknown> = {}, opts: { stripe?: boolean } = {}): Promise<PlanWorld> {
  const w = await billingWorld({ HOSTED_PLAN: 'free_one_domain', ...extraEnv }, opts);
  const txt = new Map<string, string[]>();
  const stripeAwareFetch = globalThis.fetch;
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const u = new URL(String(input instanceof Request ? input.url : input));
    if (u.hostname === 'api.stripe.com') return stripeAwareFetch(input, init);
    const name = u.searchParams.get('name');
    if (name && u.searchParams.get('type') && /TXT|16/i.test(u.searchParams.get('type')!)) {
      const values = txt.get(name.toLowerCase());
      if (values) return new Response(JSON.stringify({ Status: 0, Answer: values.map((v) => ({ name, type: 16, TTL: 60, data: `"${v}"` })) }));
    }
    return new Response(JSON.stringify({ Status: 3 }), { status: 200 });
  });
  const prove = (_domain: string, c: { txt_name: string; txt_value: string }) => { txt.set(c.txt_name.toLowerCase(), [c.txt_value]); };
  const addFree = async (p: Person, domain: string) => {
    const first = await w.api(p, 'POST', '/api/domains', { domain });
    const body = await first.clone().json() as any;
    if (!body.pending) return first;
    prove(domain, body.claim);
    return w.api(p, 'POST', `/api/domains/claims/${body.claim.id}/verify`, {});
  };
  const addPaid = async (p: Person, domain: string, extra: Record<string, unknown> = {}) => {
    const send = () => w.api(p, 'POST', '/api/billing/domains', { domain, expected_amount: 500, expected_currency: 'usd', ...extra });
    const first = await send();
    const body = await first.clone().json() as any;
    if (first.status !== 201 || !body.pending?.length) return first;
    const claim = rows(w.db, 'SELECT * FROM domain_claims WHERE domain = ?', domain)[0];
    prove(domain, { txt_name: `_readysetmail.${domain}`, txt_value: `readysetmail-verify=${claim.token}` });
    return send();
  };
  const sub = (id: string) => rows(w.db, 'SELECT * FROM workspace_subscriptions WHERE workspace_id = ?', id)[0] ?? null;
  return {
    ...w, txt, prove, addFree, addPaid, sub,
    quantityOf: (id) => sub(id)?.quantity_sent ?? null,
    ws: (id) => rows(w.db, 'SELECT * FROM workspaces WHERE id = ?', id)[0],
    domainsOf: (id) => rows(w.db, 'SELECT domain FROM domains WHERE workspace_id = ? AND evicted_at IS NULL ORDER BY id', id).map((r) => r.domain),
  };
}
export { call, json, rows };
