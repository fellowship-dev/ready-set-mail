// Shared setup for the lifecycle email tests: a hosted workspace "Brightwave Studio" with its owner Dana Reyes, a clock, a fake mail provider and a fake DNS.
// Example data throughout: brightwave-mail.com (and news.brightwave-mail.com), Google as the reporter, RFC 5737 addresses only.
import { vi } from 'vitest';
import { createMigratedD1 } from '@ready-set-mail/db/testing';
import { parseDmarcRecord, type DmarcLookup } from '@ready-set-mail/dns-checks';
import type { BoundEnv } from '../../../src/index';
import { TenantContext } from '../../../src/tenancy/context';
import { newBudget, runLifecycleForWorkspace, sendFirstReportNow, type Budget, type LifecycleDeps } from '../../../src/lifecycle/email/run';
import { fakeMailer, type FakeMailer } from '../../funnel/world';
import { HOSTED_ENV } from '../../hosted/world';

export const DAY = 86400;
/** Monday 16 Nov 2026, 11:00 UTC: the first daily run of the week of 16 Nov. */
export const MON_16_NOV = Date.UTC(2026, 10, 16, 11, 0, 0) / 1000;
/** Monday 00:00 UTC of the week of 9 Nov (the week the first summary is about). */
export const WEEK_9_NOV = Date.UTC(2026, 10, 9) / 1000;
export const WS = 'ws_brightwave';
export const SENDER = 'noreply@app.readysetmail.com';
export const REPLY_TO = 'max@readysetmail.com';
export const BASE = 'https://app.readysetmail.com';
export const RUA = 'rua@rua.readysetmail.com';

export const LIFECYCLE_ENV = {
  ...HOSTED_ENV,
  BETTER_AUTH_SECRET: 'test-secret-for-lifecycle',
  PUBLIC_BASE_URL: BASE,
  POSTAL_ADDRESS: '1 Example Street\nWilmington, DE 19801, USA',
  MAIL_REPLY_TO: REPLY_TO,
} as const;

export interface RecordSpec { ip: string; count: number; spf?: [string, string | null]; dkim?: [string, string | null]; org?: string | null; rdns?: string | null; base?: string | null; from?: string }
export interface ReportSpec {
  domain: string;
  /** Unix seconds of the report's first day (00:00 UTC). */
  day: number;
  total?: number;
  passed?: number;
  tier?: 'counted' | 'unknown' | 'unauthenticated';
  org?: string;
  knownAs?: string | null;
  /** When it was stored; default the clock now. */
  storedAt?: number;
  records?: RecordSpec[];
}

export async function lifecycleWorld(extraEnv: Record<string, unknown> = {}) {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const db = createMigratedD1();
  const sql = db.sqlite;
  const rows = (q: string, ...p: unknown[]) => sql.prepare(q).all(...p) as any[];
  const env = { DB: db as unknown as D1Database, ...LIFECYCLE_ENV, ...extraEnv } as unknown as BoundEnv;
  sql.prepare("INSERT INTO settings (workspace_id, key, value) VALUES ('ws_default', 'from_email', ?)").run(SENDER);
  sql.prepare('INSERT INTO workspaces (id, name) VALUES (?, ?)').run(WS, 'Brightwave Studio');

  const clock = { now: MON_16_NOV };
  const mailer: FakeMailer = fakeMailer('binding', false);
  /** What each domain's DMARC TXT says right now: a record, null (none), or 'error' (the read fails). */
  const dns = new Map<string, string | null | 'error'>();
  const reads: string[] = [];
  const readDmarc = async (domain: string): Promise<DmarcLookup> => {
    reads.push(domain);
    const v = dns.get(domain);
    const base = { domain, foundAt: null, inherited: false, organizationalDomain: domain.split('.').slice(-2).join('.') };
    if (v === 'error') return { ...base, status: 'error', record: null, error: 'timeout' };
    if (v === undefined || v === null) return { ...base, status: 'none', record: null };
    return { ...base, status: 'found', record: parseDmarcRecord(v), foundAt: `_dmarc.${domain}` };
  };
  const deps: LifecycleDeps = { now: () => clock.now * 1000, mailer, readDmarc };

  const tenant = (workspaceId: string = WS) => new TenantContext({ env, workspaceId, mode: 'saas', settings: {} });
  let budget: Budget = newBudget();
  const ctxFake = { waitUntil: (p: Promise<unknown>) => { void p.catch(() => {}); } } as unknown as ExecutionContext;
  /** One run (a new invocation, so a new budget): every part, as the `0 11 * * *` cron branch runs them. */
  const run = async (opts: { budget?: Budget } = {}) => {
    budget = opts.budget ?? newBudget();
    await runLifecycleForWorkspace(tenant(), ctxFake, budget, deps);
    await new Promise((r) => setTimeout(r, 0));
  };
  /** The real-time first-report email (src/notifications/first-report.ts calls this when a counted report is stored). */
  const realtimeFirstReport = async (domainId: number, reportId: number) => { await sendFirstReportNow(tenant(), ctxFake, domainId, reportId, deps); await new Promise((r) => setTimeout(r, 0)); };
  /** Jump to a later day at 11:00 UTC. */
  const at = (days: number, hour = 11) => { clock.now = Math.floor(MON_16_NOV / DAY) * DAY + days * DAY + hour * 3600; };

  const addUser = (u: { id: string; email: string; name: string; role?: 'owner' | 'admin' | 'member'; verified?: boolean }) => {
    sql.prepare('INSERT INTO users (id, email, name, role, email_verified) VALUES (?, ?, ?, ?, ?)').run(u.id, u.email, u.name, u.role === 'member' ? 'member' : 'admin', u.verified === false ? 0 : 1);
    sql.prepare('INSERT INTO memberships (workspace_id, user_id, role) VALUES (?, ?, ?)').run(WS, u.id, u.role ?? 'member');
    return u.id;
  };
  const dana = addUser({ id: 'u_dana', email: 'dana@brightwave-mail.com', name: 'Dana Reyes', role: 'owner' });

  let nextDomain = 1;
  const addDomain = (d: { domain: string; createdAt?: number; policy?: string | null; pct?: number | null; rua?: string; via?: string; connectedAt?: number | null; dmarcRua?: number | null; addedBy?: string | null; p?: string | null; workspaceId?: string }) => {
    const ws = d.workspaceId ?? WS;
    const id = nextDomain++;
    const policy = d.policy === undefined ? 'none' : d.policy;
    sql.prepare('INSERT INTO domains (id, domain, rua_address, workspace_id, verified_via, created_at, dmarc_policy, dmarc_pct, dmarc_p, dmarc_rua, reports_connected_at, dns_checked_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, d.domain, d.rua === undefined ? RUA : d.rua, ws, d.via ?? 'txt', d.createdAt ?? clock.now - 2 * DAY, policy, policy ? (d.pct ?? 100) : null, policy ? (d.p ?? policy) : null, d.dmarcRua === undefined ? 1 : d.dmarcRua, d.connectedAt === undefined ? clock.now - 2 * DAY : d.connectedAt, clock.now - DAY);
    if (d.addedBy !== null) sql.prepare("INSERT INTO audit_log (actor_id, actor_email, actor_type, action, resource_type, resource_id, resource_name, workspace_id) VALUES (?, 'x', 'user', 'domain.add', 'domain', ?, ?, ?)").run(d.addedBy ?? dana, String(id), d.domain, ws);
    return id;
  };

  /** Another hosted workspace, owned by Dana (a verified owner), for the tests of what is shared between workspaces. */
  const addWorkspace = (id: string) => {
    sql.prepare('INSERT INTO workspaces (id, name) VALUES (?, ?)').run(id, `Workspace ${id}`);
    sql.prepare('INSERT INTO memberships (workspace_id, user_id, role) VALUES (?, ?, ?)').run(id, dana, 'owner');
    return id;
  };

  let nextReport = 1;
  const addReport = (r: ReportSpec): number => {
    const id = nextReport++;
    const domainId = (sql.prepare('SELECT id FROM domains WHERE domain = ?').get(r.domain) as { id: number }).id;
    const records = r.records ?? [{ ip: '192.0.2.10', count: r.total ?? 10, spf: ['pass', r.domain], dkim: ['pass', r.domain], org: 'Google Workspace' }];
    const total = r.total ?? records.reduce((n, x) => n + x.count, 0);
    // The reporter's own verdict, as a reporter evaluates it: a record passes when SPF or DKIM passed for the domain itself (relaxed alignment).
    const aligned = (res: [string, string | null] | undefined) => !!res && res[0] === 'pass' && !!res[1] && (res[1] === r.domain || res[1].endsWith(`.${r.domain}`) || r.domain.endsWith(`.${res[1]}`));
    const passed = r.passed ?? records.reduce((n, x) => n + (aligned(x.spf) || aligned(x.dkim) ? x.count : 0), 0);
    sql.prepare('INSERT INTO aggregate_reports (id, domain_id, org_name, report_id, date_begin, date_end, total_count, pass_count, fail_count, workspace_id, reporter_tier, reporter_known_as, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, domainId, r.org ?? 'google.com', `r-${id}`, r.day, r.day + DAY - 1, total, passed, total - passed, WS, r.tier ?? 'counted', r.knownAs === undefined ? 'Google' : r.knownAs, r.storedAt ?? clock.now);
    for (const x of records) {
      sql.prepare('INSERT INTO report_records (report_id, source_ip, count, disposition, dkim_result, dkim_domain, spf_result, spf_domain, header_from, reverse_dns, base_domain, org, workspace_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(id, x.ip, x.count, 'none', x.dkim?.[0] ?? null, x.dkim?.[1] ?? null, x.spf?.[0] ?? null, x.spf?.[1] ?? null, x.from ?? r.domain, x.rdns ?? null, x.base ?? null, x.org === undefined ? null : x.org, WS);
    }
    return id;
  };

  return {
    db, sql, env, rows, clock, mailer, dns, reads, deps, tenant, run, realtimeFirstReport, at, addUser, addDomain, addWorkspace, addReport, dana, ctx: ctxFake,
    get budget() { return budget; },
    sends: () => rows('SELECT user_id, domain_id, kind, period, state FROM lifecycle_sends ORDER BY created_at, kind, domain_id'),
    /** Everything sent so far as (day offset from Mon 16 Nov, kind-ish, subject), for the walk tests. */
    sent: () => mailer.sent.map((m) => ({ to: m.to, subject: m.subject })),
    pref: (userId: string, kind: 'summary' | 'tips', enabled: boolean) => sql.prepare("INSERT INTO email_preferences (user_id, workspace_id, kind, enabled) VALUES (?, ?, ?, ?) ON CONFLICT (user_id, workspace_id, kind) DO UPDATE SET enabled = excluded.enabled").run(userId, WS, kind, enabled ? 1 : 0),
  };
}

export type World = Awaited<ReturnType<typeof lifecycleWorld>>;
/** The live DMARC record of a domain that sends reports to Ready Set Mail. */
export const recordNamingUs = (policy = 'none', extra = '') => `v=DMARC1; p=${policy}${extra}; rua=mailto:${RUA}`;
