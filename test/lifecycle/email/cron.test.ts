// The cron branches (src/cron.ts) and what the lifecycle job shares between workspaces: one budget for the invocation, the workspace that was read longest ago first.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('cloudflare:email', () => ({ EmailMessage: class {} }));
vi.mock('../../../src/digest/weekly', async (orig) => {
  const real = await orig<typeof import('../../../src/digest/weekly')>();
  return { ...real, sendWeeklyDigests: vi.fn(real.sendWeeklyDigests) };
});

import { lifecycleReadOrder } from '@ready-set-mail/db';
import { runCronForWorkspaces } from '../../../src/cron';
import { sendWeeklyDigests } from '../../../src/digest/weekly';
import { MAX_LIVE_READS_PER_RUN, MAX_LIVE_READS_PER_WORKSPACE } from '../../../src/lifecycle/email/kinds';
import { newBudget, runLifecycleForWorkspace } from '../../../src/lifecycle/email/run';
import { DAY, MON_16_NOV, WEEK_9_NOV, WS, lifecycleWorld, recordNamingUs, type RecordSpec, type World } from './world';

const D = 'brightwave-mail.com';
const ok = (count = 100): RecordSpec => ({ ip: '192.0.2.10', count, spf: ['pass', D], dkim: ['pass', D], org: 'Google Workspace' });
const DAILY = { cron: '0 11 * * *' } as ScheduledController;
const MONDAY = { cron: '0 9 * * 1' } as ScheduledController;

beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.mocked(sendWeeklyDigests).mockClear(); });

/** The names asked for `_dmarc.<name>` over DNS-over-HTTPS: the answer is "no such name" for every one. */
function stubDns(answer: (name: string) => string | null = () => null) {
  const asked: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const q = new URL(url).searchParams;
    const name = q.get('name')!;
    if (name.startsWith('_dmarc.')) asked.push(name.slice(7));
    const txt = name.startsWith('_dmarc.') ? answer(name.slice(7)) : null;
    return Response.json(txt ? { Status: 0, Answer: [{ name, type: 16, TTL: 60, data: `"${txt}"` }] } : { Status: 3 });
  }));
  return asked;
}

/** The Worker's send_email binding as the lifecycle job reaches it from the cron: `world.env` carries it, the cron builds its own deps. */
function bindMail(w: World) {
  const out: Array<{ to: string[]; subject: string }> = [];
  (w.env as unknown as Record<string, unknown>).SEND_EMAIL = { send: async (m: { to: string[]; subject: string }) => { out.push(m); return { messageId: `m${out.length}` }; } };
  return out;
}
const setNow = (w: World, t: number) => { w.clock.now = t; vi.setSystemTime(t * 1000); };
const cron = (w: World, event: ScheduledController, workspaces = [WS]) =>
  runCronForWorkspaces(event, w.env, w.ctx, { workspaces, load: async (_env, ws) => w.tenant(ws.workspaceId) });

describe('which cron runs what', () => {
  /** A workspace with a summary due (reports in the week of 9 Nov), a domain going live and a failing known service that a tip is about. */
  async function due(extra: Record<string, unknown> = {}) {
    const w = await lifecycleWorld({ LIFECYCLE_EMAILS_ON: 'tips', ...extra });
    w.pref(w.dana, 'tips', true);
    w.addDomain({ domain: D });
    for (let i = 0; i < 7; i++) w.addReport({ domain: D, day: WEEK_9_NOV + i * DAY, storedAt: WEEK_9_NOV + i * DAY + 3600, records: [ok(100), { ip: '198.51.100.7', count: 3, spf: ['pass', 'sendgrid.net'], dkim: ['pass', 'sendgrid.net'], org: 'SendGrid' }] });
    w.addDomain({ domain: 'new.example' });
    return w;
  }

  it('0 11 * * *: the milestones, the summary and (enabled) the tips, all in the one run', async () => {
    const w = await due();
    const sent = bindMail(w);
    stubDns((d) => (d === 'new.example' ? recordNamingUs() : null));
    setNow(w, MON_16_NOV);
    await cron(w, DAILY);
    const subjects = sent.map((m) => m.subject);
    expect(subjects).toHaveLength(3);
    expect(subjects).toContain('One service sending as brightwave-mail.com needs SPF or DKIM');
    expect(subjects).toContain('new.example is set up: reports are on their way');
    expect(subjects.filter((x) => /^Week of 9–15 Nov: /.test(x))).toHaveLength(1);
    expect(w.rows('SELECT kind FROM lifecycle_sends ORDER BY kind').map((r) => r.kind)).toEqual(['records_live', 'summary', 'tip_fix']);
  });

  it('0 11 * * *: tips stay off unless the instance names them (a person opting in is not enough)', async () => {
    const w = await due({ LIFECYCLE_EMAILS_ON: undefined });
    const sent = bindMail(w);
    stubDns();
    setNow(w, MON_16_NOV);
    await cron(w, DAILY);
    expect(sent.map((m) => m.subject).some((s) => /needs SPF or DKIM/.test(s))).toBe(false);
    expect(sent.some((m) => m.subject.startsWith('Week of'))).toBe(true);
  });

  it('0 9 * * 1 sends no lifecycle email at all, reads no DNS and claims nothing; the digest is called but hosted has none', async () => {
    const w = await due();
    const sent = bindMail(w);
    const asked = stubDns((d) => (d === 'new.example' ? recordNamingUs() : null));
    setNow(w, MON_16_NOV - 2 * 3600);
    await cron(w, MONDAY);
    expect(sent).toEqual([]);
    expect(asked).toEqual([]);
    expect(w.rows('SELECT * FROM lifecycle_sends')).toEqual([]);
    expect(w.rows('SELECT * FROM domain_milestones')).toEqual([]);
    expect(sendWeeklyDigests).toHaveBeenCalledTimes(1);
  });

  it('0 9 * * 1 on self-host still runs the weekly digest, and still no lifecycle email', async () => {
    const w = await due({ MODE: 'selfhost', SAAS_ENABLED: undefined });
    const sent = bindMail(w);
    stubDns();
    setNow(w, MON_16_NOV - 2 * 3600);
    await cron(w, MONDAY);
    expect(sendWeeklyDigests).toHaveBeenCalledTimes(1);
    expect(sent.filter((m) => !/digest/i.test(m.subject))).toEqual([]);
    expect(w.rows('SELECT * FROM lifecycle_sends')).toEqual([]);
  });

  it('0 11 * * * on self-host runs no lifecycle email either (hosted only)', async () => {
    const w = await due({ MODE: 'selfhost', SAAS_ENABLED: undefined });
    const sent = bindMail(w);
    stubDns();
    setNow(w, MON_16_NOV);
    await cron(w, DAILY);
    expect(sent).toEqual([]);
    expect(w.rows('SELECT * FROM lifecycle_sends')).toEqual([]);
  });
});

describe('the DNS read budget', () => {
  /** `n` never-live domains named `<prefix><i>.example` in workspace `ws` (a domain that is not live is watched: one read each). */
  const never = (w: World, ws: string, prefix: string, n: number) => { for (let i = 0; i < n; i++) w.addDomain({ domain: `${prefix}${i}.example`, workspaceId: ws }); };

  it(`two workspaces share a budget: each reads ${MAX_LIVE_READS_PER_WORKSPACE} of its 30 never-live domains in a run, and the next day's run reads the other least recently read ones`, async () => {
    const w = await lifecycleWorld();
    const other = w.addWorkspace('ws_other');
    never(w, WS, 'a', 30);
    never(w, other, 'b', 30);
    const reads = new Map<string, number>();
    const day = async (d: number) => {
      w.at(d); w.reads.length = 0;
      const budget = newBudget();
      for (const ws of [WS, other]) await runLifecycleForWorkspace(w.tenant(ws), w.ctx, budget, w.deps);
      expect(budget.byWorkspace.get(WS)!.liveReads).toBe(5);
      expect(budget.byWorkspace.get(other)!.liveReads).toBe(5);
      return [...w.reads];
    };
    const first = await day(0);
    expect(first).toHaveLength(10);
    expect(first.filter((r) => r.startsWith('a'))).toHaveLength(5);
    expect(first.filter((r) => r.startsWith('b'))).toHaveLength(5);
    for (const r of first) reads.set(r, (reads.get(r) ?? 0) + 1);
    const second = await day(1);
    expect(second).toHaveLength(10);
    expect(second.filter((r) => first.includes(r))).toEqual([]); // the other 5 of each, the least recently read
    expect(second.filter((r) => r.startsWith('a'))).toHaveLength(5);
  });

  it(`${MAX_LIVE_READS_PER_RUN} reads in all per kind: twelve workspaces wanting ${MAX_LIVE_READS_PER_WORKSPACE} each read at most 50, and the ones skipped come first the next run (lifecycleReadOrder, through the cron)`, async () => {
    const w = await lifecycleWorld();
    const workspaces = [WS, ...Array.from({ length: 11 }, (_, i) => w.addWorkspace(`ws_${String(i).padStart(2, '0')}`))];
    workspaces.forEach((ws, i) => never(w, ws, `w${i}d`, 5));
    const asked = stubDns();
    const sent = bindMail(w);
    const run = async (d: number) => {
      setNow(w, MON_16_NOV + d * DAY);
      asked.length = 0;
      await cron(w, DAILY, workspaces);
      const byWorkspace = (names: string[]) => workspaces.map((_, i) => names.filter((n) => n.startsWith(`w${i}d`)).length);
      return byWorkspace([...new Set(asked)]);
    };
    const first = await run(0);
    expect(first.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(MAX_LIVE_READS_PER_RUN);
    expect(first.reduce((a, b) => a + b, 0)).toBe(MAX_LIVE_READS_PER_RUN);
    expect(Math.max(...first)).toBeLessThanOrEqual(MAX_LIVE_READS_PER_WORKSPACE);
    expect(first.filter((n) => n === 5)).toHaveLength(10); // ten workspaces were read in full, two were not read at all
    const skipped = workspaces.filter((_, i) => first[i] === 0);
    expect(skipped).toHaveLength(2);
    // The order of the next run: the skipped ones have never been read, so they come first.
    expect((await lifecycleReadOrder(w.env.DB, workspaces)).slice(0, 2).sort()).toEqual([...skipped].sort());
    const second = await run(1);
    expect(second.reduce((a, b) => a + b, 0)).toBe(MAX_LIVE_READS_PER_RUN);
    for (const ws of skipped) expect(second[workspaces.indexOf(ws)], ws).toBe(5);
    expect(sent).toEqual([]);
  });

  it('lifecycleReadOrder puts the workspace with the oldest read first (never read oldest of all), and keeps the given order for ties', async () => {
    const w = await lifecycleWorld();
    const a = w.addWorkspace('ws_a'), b = w.addWorkspace('ws_b'), c = w.addWorkspace('ws_c');
    const da = w.addDomain({ domain: 'a.example', workspaceId: a });
    const db = w.addDomain({ domain: 'b.example', workspaceId: b });
    const dc = w.addDomain({ domain: 'c.example', workspaceId: c });
    const mark = (id: number, ws: string, at: number | null) => w.sql.prepare('INSERT INTO domain_milestones (domain_id, workspace_id, dns_read_at) VALUES (?, ?, ?)').run(id, ws, at);
    mark(da, a, 300); mark(db, b, 100); mark(dc, c, 200);
    expect(await lifecycleReadOrder(w.env.DB, [a, b, c])).toEqual([b, c, a]);
    expect(await lifecycleReadOrder(w.env.DB, [a, b, c, WS])).toEqual([WS, b, c, a]); // no milestone row: never read
    // A workspace's oldest read counts, not its newest.
    w.addDomain({ domain: 'a2.example', workspaceId: a }); mark(4, a, 50);
    expect(await lifecycleReadOrder(w.env.DB, [b, c, a])).toEqual([a, b, c]);
  });
});
