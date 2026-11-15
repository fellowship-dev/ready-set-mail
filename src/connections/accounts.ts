// Cloudflare accounts as the workspace sees them. A connection (one grant or pasted token) can reach several Cloudflare accounts, and an account can
// be reached through several connections, so the account is what Settings lists: its name as Cloudflare returned it (GET /accounts, and the account
// object on each zone), how many of the workspace's domains were verified through it, and whether some connection to it works.
import type { TenantContext } from '../tenancy/context';

export interface CfAccountView {
  id: string;
  name: string | null;
  /** Domains of the workspace verified through this account's zones. */
  domains: number;
  state: 'working' | 'needs_reconnect';
  /** The working connection (any, the earliest) that reaches it: who connected it and when. */
  connected_by: string | null;
  connected_at: number | null;
  /** Every connection that reaches it, so the page can say "2 connections". */
  connections: { id: string; label: string; status: string }[];
}

export async function accountViews(tenant: TenantContext): Promise<CfAccountView[]> {
  const q = tenant.scope.connections;
  const conns = await q.list();
  if (conns.length === 0) return [];
  const members = new Map((await tenant.scope.team.list()).map(m => [m.id, m.email] as const));
  const domains = await tenant.scope.domains.list();
  const byAccount = new Map<string, { name: string | null; conns: typeof conns }>();
  const reach = new Map<string, Set<string>>(); // connection id -> account ids
  const add = (accountId: string, name: string | null | undefined, c: (typeof conns)[number]) => {
    const e = byAccount.get(accountId) ?? { name: null, conns: [] };
    e.name = e.name ?? name ?? null;
    if (!e.conns.some(x => x.id === c.id)) e.conns.push(c);
    byAccount.set(accountId, e);
    reach.set(c.id, (reach.get(c.id) ?? new Set()).add(accountId));
  };
  for (const c of conns) {
    for (const z of await q.zones(c.id)) if (z.cf_account_id) add(z.cf_account_id, z.cf_account_name, c);
    if (c.cf_account_id) add(c.cf_account_id, c.cf_account_name, c);
  }
  const counts = new Map<string, number>();
  for (const d of domains) {
    // Verified through a zone: the account is on the row. Older rows: the account of the (only) account their connection reaches.
    const acct = d.cf_account_id ?? (d.cf_connection_id && reach.get(d.cf_connection_id)?.size === 1 ? [...reach.get(d.cf_connection_id)!][0] : null);
    if (acct) counts.set(acct, (counts.get(acct) ?? 0) + 1);
  }
  return [...byAccount.entries()].map(([id, e]): CfAccountView => {
    const sorted = [...e.conns].sort((a, b) => a.created_at - b.created_at);
    const working = sorted.find(c => c.status === 'active');
    const shown = working ?? sorted[0]!;
    return {
      id, name: e.name, domains: counts.get(id) ?? 0,
      state: working ? 'working' : 'needs_reconnect',
      connected_by: shown.created_by ? (members.get(shown.created_by) ?? null) : null,
      connected_at: shown.created_at,
      connections: sorted.map(c => ({ id: c.id, label: c.label, status: c.status })),
    };
  }).sort((a, b) => (a.name ?? a.id).localeCompare(b.name ?? b.id));
}
