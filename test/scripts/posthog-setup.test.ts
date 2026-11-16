// scripts/posthog-setup.mjs against a fake of the PostHog endpoints it uses (never the real project): the plan, idempotency by name,
// --dry-run writing nothing, the key going only into the Authorization header, and every funnel step naming a real event.
import { describe, expect, it } from 'vitest';
import { ACTIONS, DASHBOARDS, run } from '../../scripts/posthog-setup.mjs';
import { EVENTS } from '../../src/product-analytics/events';

const KEY = 'phx_personal_secret_key_0123456789';
const HOST = 'https://ph-app.fake.test';
const ENV = { POSTHOG_PERSONAL_API_KEY: KEY, POSTHOG_PROJECT_ID: '4242', POSTHOG_APP_HOST: HOST };

/** The fake: /api/projects/4242/{actions,dashboards,insights}/ with list (paginated), create and patch. */
function fakePostHog() {
  const store: Record<string, any[]> = { actions: [], dashboards: [], insights: [] };
  const calls: { method: string; path: string; auth: string | null; body: any }[] = [];
  let id = 100;
  const fetchImpl = async (url: string, init: RequestInit = {}) => {
    const u = new URL(url);
    const method = init.method ?? 'GET';
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, path: u.pathname + u.search, auth: new Headers(init.headers as HeadersInit).get('authorization'), body });
    if (u.origin !== HOST) return new Response('wrong host', { status: 400 });
    if (new Headers(init.headers as HeadersInit).get('authorization') !== `Bearer ${KEY}`) return new Response('{"detail":"Invalid Personal API key."}', { status: 401 });
    const m = u.pathname.match(/^\/api\/projects\/4242\/(actions|dashboards|insights)\/(?:(\d+)\/)?$/);
    if (!m) return new Response('not found', { status: 404 });
    const list = store[m[1]!]!;
    if (method === 'GET') {
      const offset = Number(u.searchParams.get('offset') ?? 0);
      const page = list.slice(offset, offset + 2); // small pages: the script must follow `next`
      const next = offset + 2 < list.length ? `${HOST}${u.pathname}?limit=200&offset=${offset + 2}` : null;
      return Response.json({ results: page, next });
    }
    if (method === 'POST') { const row = { id: id++, ...body }; list.push(row); return Response.json(row, { status: 201 }); }
    if (method === 'PATCH') { const row = list.find((r) => r.id === Number(m[2])); Object.assign(row, body); return Response.json(row); }
    return new Response('', { status: 405 });
  };
  return { store, calls, fetchImpl };
}

const total = ACTIONS.length + DASHBOARDS.length + DASHBOARDS.reduce((n, d) => n + d.insights.length, 0);

describe('posthog-setup', () => {
  it('creates the actions, the four dashboards and every insight on its dashboard, with the key only in the Authorization header', async () => {
    const f = fakePostHog();
    const lines: string[] = [];
    const plan = await run({ env: ENV, fetchImpl: f.fetchImpl as never, log: (l: string) => lines.push(l) });
    expect(plan.filter((p) => p.verb === 'create')).toHaveLength(total);
    expect(f.store.actions.map((a) => a.name)).toEqual(ACTIONS.map((a) => a.name));
    expect(f.store.dashboards.map((d) => d.name)).toEqual(['RSM: Onboarding, sign-up to first report', 'RSM: Domain configuration', 'RSM: Path to purchase', 'RSM: Value moments per week']);
    for (const d of DASHBOARDS) {
      const dash = f.store.dashboards.find((x) => x.name === d.name)!;
      for (const i of d.insights) expect(f.store.insights.find((x) => x.name === i.name)?.dashboards, i.name).toEqual([dash.id]);
    }
    // The onboarding funnel, step by step, with the setup action resolved to its id.
    const onboarding = f.store.insights.find((x) => x.name === 'RSM onboarding funnel (14 days)')!;
    expect(onboarding.query.kind).toBe('InsightVizNode');
    expect(onboarding.query.source.kind).toBe('FunnelsQuery');
    expect(onboarding.query.source.series.map((s: any) => s.event ?? s.name)).toEqual(['Signup Started', 'Signup Code Sent', 'Code Verified', 'Dashboard First Viewed', 'RSM Setup Started', 'Ownership Verified', 'Apply Done', 'Records Live', 'First Report Received']);
    expect(onboarding.query.source.series[4]).toMatchObject({ kind: 'ActionsNode', id: f.store.actions[0].id });
    // The key: in every request's Authorization header, in no URL, body or log line.
    for (const c of f.calls) {
      expect(c.auth).toBe(`Bearer ${KEY}`);
      expect(c.path).not.toContain(KEY);
      expect(JSON.stringify(c.body ?? null)).not.toContain(KEY);
    }
    expect(lines.join('\n')).not.toContain(KEY);
  });

  it('is idempotent by name: a second run creates nothing, and an insight taken off its dashboard is put back', async () => {
    const f = fakePostHog();
    await run({ env: ENV, fetchImpl: f.fetchImpl as never, log: () => {} });
    f.store.insights[0].dashboards = [];
    f.calls.length = 0;
    const again = await run({ env: ENV, fetchImpl: f.fetchImpl as never, log: () => {} });
    expect(again.filter((p) => p.verb === 'create')).toEqual([]);
    expect(again.filter((p) => p.verb === 'add to dashboard')).toHaveLength(1);
    expect(f.calls.filter((c) => c.method === 'POST')).toEqual([]);
    expect(f.calls.filter((c) => c.method === 'PATCH')).toHaveLength(1);
    expect(f.store.insights).toHaveLength(total - ACTIONS.length - DASHBOARDS.length);
  });

  it('--dry-run reads but writes nothing; without a key it prints the whole plan and contacts nobody', async () => {
    const f = fakePostHog();
    const plan = await run({ env: ENV, dryRun: true, fetchImpl: f.fetchImpl as never, log: () => {} });
    expect(plan.filter((p) => p.verb === 'create')).toHaveLength(total);
    expect(f.calls.every((c) => c.method === 'GET')).toBe(true);
    const offline = fakePostHog();
    const lines: string[] = [];
    const offlinePlan = await run({ env: {}, dryRun: true, fetchImpl: offline.fetchImpl as never, log: (l: string) => lines.push(l) });
    expect(offline.calls).toEqual([]);
    expect(offlinePlan).toHaveLength(total);
    expect(lines.filter((l) => l.startsWith('would create'))).toHaveLength(total);
  });

  it('refuses to run without its configuration, with a project key, or against a non-https host; errors carry no key', async () => {
    await expect(run({ env: {}, log: () => {} })).rejects.toMatchObject({ exit: 2 });
    await expect(run({ env: { ...ENV, POSTHOG_PERSONAL_API_KEY: 'phc_projectkey0123456789' }, log: () => {} })).rejects.toMatchObject({ exit: 2 });
    await expect(run({ env: { ...ENV, POSTHOG_APP_HOST: 'http://us.posthog.com' }, log: () => {} })).rejects.toMatchObject({ exit: 2 });
    const f = fakePostHog();
    const err = await run({ env: { ...ENV, POSTHOG_PROJECT_ID: '9999' }, fetchImpl: f.fetchImpl as never, log: () => {} }).catch((e: Error) => e);
    expect(String((err as Error).message)).toMatch(/GET \/api\/projects\/9999\/actions\/\?limit=200 answered 404/);
    expect(String((err as Error).message)).not.toContain(KEY);
  });

  it('every step and every trend series names an event the Worker sends', () => {
    const names = new Set(Object.keys(EVENTS));
    const actionNames = new Set(ACTIONS.map((a) => a.name));
    for (const a of ACTIONS) for (const s of a.steps) expect(names, a.name).toContain(s.event);
    for (const d of DASHBOARDS) for (const i of d.insights) for (const s of i.query.series as any[]) {
      if (s.action !== undefined) expect(actionNames, i.name).toContain(s.action);
      else expect(names, `${i.name}: ${s.event}`).toContain(s.event);
      if (i.query.breakdownFilter) expect(Object.keys((EVENTS as any)[s.event] ?? {}), `${i.name} breakdown`).toContain(i.query.breakdownFilter.breakdown);
    }
  });
});
