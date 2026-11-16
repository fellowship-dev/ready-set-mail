// scripts/posthog-setup.mjs against a fake of the PostHog endpoints it uses (never the real project): it touches only what it created
// (marked in the description), updates its own objects when their definition changes, leaves foreign objects alone (a name clash gets a
// suffixed name), never deletes, needs --project <numeric id>, writes nothing in --dry-run, and keeps the key in the Authorization header.
import { describe, expect, it } from 'vitest';
import { ACTIONS, DASHBOARDS, MARKER, SUFFIX, isManaged, projectArg, run } from '../../scripts/posthog-setup.mjs';
import { EVENTS } from '../../src/product-analytics/events';

const KEY = 'phx_personal_secret_key_0123456789';
const HOST = 'https://ph-app.fake.test';
const ENV = { POSTHOG_PERSONAL_API_KEY: KEY, POSTHOG_APP_HOST: HOST };
const PROJECT = '736391';

/** The fake: /api/projects/736391/{actions,dashboards,insights}/ with list (paginated), create and patch; other projects 403. */
function fakePostHog(seed: Partial<Record<'actions' | 'dashboards' | 'insights', any[]>> = {}) {
  const store: Record<string, any[]> = { actions: [...(seed.actions ?? [])], dashboards: [...(seed.dashboards ?? [])], insights: [...(seed.insights ?? [])] };
  const calls: { method: string; path: string; auth: string | null; body: any }[] = [];
  let id = 1000;
  const fetchImpl = async (url: string, init: RequestInit = {}) => {
    const u = new URL(url);
    const method = init.method ?? 'GET';
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, path: u.pathname + u.search, auth: new Headers(init.headers as HeadersInit).get('authorization'), body });
    if (u.origin !== HOST) return new Response('wrong host', { status: 400 });
    if (new Headers(init.headers as HeadersInit).get('authorization') !== `Bearer ${KEY}`) return new Response('{"detail":"Invalid Personal API key."}', { status: 401 });
    if (!u.pathname.startsWith(`/api/projects/${PROJECT}/`)) return new Response('{"detail":"forbidden"}', { status: 403 }); // project-scoped key
    const m = u.pathname.match(/^\/api\/projects\/\d+\/(actions|dashboards|insights)\/(?:(\d+)\/)?$/);
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

const nInsights = DASHBOARDS.reduce((n, d) => n + d.insights.length, 0);
const total = ACTIONS.length + DASHBOARDS.length + nInsights;
const tally = (plan: { verb: string; kind: string }[]) => plan.reduce((a: Record<string, number>, p) => ({ ...a, [`${p.verb} ${p.kind}`]: (a[`${p.verb} ${p.kind}`] ?? 0) + 1 }), {});

/** The real project's shape: 9 insights and 1 dashboard someone else made, one of them named like ours. */
const foreign = () => ({
  dashboards: [{ id: 50, name: 'Max dashboard', description: 'mine' }],
  insights: [
    ...Array.from({ length: 8 }, (_, i) => ({ id: i + 1, name: `Max insight ${i}`, description: '', dashboards: [50] })),
    { id: 77, name: 'RSM Apply results', description: 'made by hand', dashboards: [50], query: { kind: 'hand-made' } },
  ],
});

describe('posthog-setup', () => {
  it('creates the actions, dashboards and insights, each marked, each insight on its dashboard; the key only in the Authorization header', async () => {
    const f = fakePostHog();
    const lines: string[] = [];
    const plan = await run({ env: ENV, project: PROJECT, fetchImpl: f.fetchImpl as never, log: (l: string) => lines.push(l) });
    expect(plan.filter((p) => p.verb === 'create')).toHaveLength(total);
    for (const kind of ['actions', 'dashboards', 'insights']) for (const x of f.store[kind]!) expect(x.description, x.name).toContain(MARKER);
    expect(f.store.dashboards.map((d) => d.name)).toEqual(DASHBOARDS.map((d) => d.name));
    for (const d of DASHBOARDS) {
      const dash = f.store.dashboards.find((x) => x.name === d.name)!;
      for (const i of d.insights) expect(f.store.insights.find((x) => x.name === i.name)?.dashboards, i.name).toEqual([dash.id]);
    }
    const onboarding = f.store.insights.find((x) => x.name === 'RSM onboarding funnel (14 days)')!;
    expect(onboarding.query.source.kind).toBe('FunnelsQuery');
    expect(onboarding.query.source.series.map((s: any) => s.event ?? s.name)).toEqual(['Signup Started', 'Workspace Created', 'Dashboard First Viewed', 'RSM Setup Started', 'Ownership Verified', 'Records Live', 'First Report Received']);
    expect(onboarding.query.source.series[3]).toMatchObject({ kind: 'ActionsNode', id: f.store.actions[0].id });
    for (const c of f.calls) {
      expect(c.auth).toBe(`Bearer ${KEY}`);
      expect(c.path).not.toContain(KEY);
      expect(c.path.startsWith(`/api/projects/${PROJECT}/`)).toBe(true); // project endpoints only
      expect(JSON.stringify(c.body ?? null)).not.toContain(KEY);
    }
    expect(lines.join('\n')).not.toContain(KEY);
  });

  it('in a project with foreign objects: never PATCHes or deletes them, creates its own under a suffixed name on a clash, and reports it', async () => {
    const f = fakePostHog(foreign());
    const before = JSON.parse(JSON.stringify({ d: f.store.dashboards, i: f.store.insights }));
    const lines: string[] = [];
    const dry = await run({ env: ENV, project: PROJECT, dryRun: true, fetchImpl: f.fetchImpl as never, log: (l: string) => lines.push(l) });
    expect(f.calls.filter((c) => c.method !== 'GET')).toEqual([]);
    expect(tally(dry)).toEqual({ 'create action': 2, 'create dashboard': 4, 'create insight': nInsights });
    expect(lines).toContain(`would create insight: RSM Apply results${SUFFIX} ("RSM Apply results" is taken by an object this script did not create; that one is left as it is)`);

    const plan = await run({ env: ENV, project: PROJECT, fetchImpl: f.fetchImpl as never, log: () => {} });
    expect(tally(plan)).toEqual(tally(dry));
    const writes = f.calls.filter((c) => c.method !== 'GET');
    expect(writes.filter((c) => c.method !== 'POST')).toEqual([]); // no PATCH, no DELETE
    // Every foreign object exactly as it was.
    expect(f.store.dashboards.filter((d) => !isManaged(d))).toEqual(before.d);
    expect(f.store.insights.filter((i) => !isManaged(i))).toEqual(before.i);
    expect(f.store.insights.filter((i) => i.name === `RSM Apply results${SUFFIX}`)).toHaveLength(1);

    // Run again: everything of ours is unchanged, nothing written, the suffixed one is recognised as ours.
    f.calls.length = 0;
    const again = await run({ env: ENV, project: PROJECT, fetchImpl: f.fetchImpl as never, log: () => {} });
    expect(again.every((p) => p.verb === 'unchanged')).toBe(true);
    expect(f.calls.filter((c) => c.method !== 'GET')).toEqual([]);
  });

  it('updates its own objects when their definition changes (dry run shows it first), and puts its insight back on its dashboard', async () => {
    const f = fakePostHog();
    await run({ env: ENV, project: PROJECT, fetchImpl: f.fetchImpl as never, log: () => {} });
    const funnel = f.store.insights.find((x) => x.name === 'RSM manual path funnel (7 days)')!;
    funnel.description = funnel.description.replace(/def:[0-9a-f]{12}/, 'def:000000000000'); // an older definition
    const moved = f.store.insights.find((x) => x.name === 'RSM Apply results')!;
    moved.dashboards = [];
    f.calls.length = 0;
    const dry = await run({ env: ENV, project: PROJECT, dryRun: true, fetchImpl: f.fetchImpl as never, log: () => {} });
    expect(dry.filter((p) => p.verb !== 'unchanged').map((p) => `${p.verb} ${p.name}`).sort()).toEqual(['update RSM Apply results', 'update RSM manual path funnel (7 days)']);
    expect(f.calls.filter((c) => c.method !== 'GET')).toEqual([]);
    await run({ env: ENV, project: PROJECT, fetchImpl: f.fetchImpl as never, log: () => {} });
    const patches = f.calls.filter((c) => c.method === 'PATCH').map((c) => c.path);
    expect(patches.sort()).toEqual([`/api/projects/${PROJECT}/insights/${funnel.id}/`, `/api/projects/${PROJECT}/insights/${moved.id}/`].sort());
    expect(funnel.description).not.toContain('def:000000000000');
    expect(moved.dashboards).toHaveLength(1);
    expect(f.calls.filter((c) => c.method === 'POST')).toEqual([]);
  });

  it('needs --project <numeric id> (no @current, no env var); refuses a project key or a non-https host; a 403 says the key is project-scoped', async () => {
    for (const project of [undefined, '', '@current', '%40current', '12a']) await expect(run({ env: ENV, project, log: () => {} } as never)).rejects.toMatchObject({ exit: 2 });
    await expect(run({ env: { ...ENV, POSTHOG_PROJECT_ID: PROJECT }, log: () => {} } as never)).rejects.toMatchObject({ exit: 2 });
    await expect(run({ env: {}, project: PROJECT, log: () => {} })).rejects.toMatchObject({ exit: 2 });
    await expect(run({ env: { ...ENV, POSTHOG_PERSONAL_API_KEY: 'phc_projectkey0123456789' }, project: PROJECT, log: () => {} })).rejects.toMatchObject({ exit: 2 });
    await expect(run({ env: { ...ENV, POSTHOG_APP_HOST: 'http://us.posthog.com' }, project: PROJECT, log: () => {} })).rejects.toMatchObject({ exit: 2 });
    const f = fakePostHog();
    const err = await run({ env: ENV, project: '9999', fetchImpl: f.fetchImpl as never, log: () => {} }).catch((e: Error) => e);
    expect(String((err as Error).message)).toMatch(/GET \/api\/projects\/9999\/actions\/\?limit=200 answered 403 \(the personal API key is scoped to one project/);
    expect(String((err as Error).message)).not.toContain(KEY);
    expect(projectArg(['node', 's', '--project', '42', '--dry-run'])).toBe('42');
    expect(projectArg(['node', 's', '--project=42'])).toBe('42');
  });

  it('--dry-run without a key prints the whole plan and contacts nobody', async () => {
    const offline = fakePostHog();
    const lines: string[] = [];
    const plan = await run({ env: {}, project: PROJECT, dryRun: true, fetchImpl: offline.fetchImpl as never, log: (l: string) => lines.push(l) });
    expect(offline.calls).toEqual([]);
    expect(plan).toHaveLength(total);
    expect(lines.filter((l) => l.startsWith('would create'))).toHaveLength(total);
  });

  it('every step, filter and breakdown names an event and property the Worker sends', () => {
    const names = new Set(Object.keys(EVENTS));
    const actionNames = new Set(ACTIONS.map((a) => a.name));
    for (const a of ACTIONS) for (const s of a.steps) expect(names, a.name).toContain(s.event);
    for (const d of DASHBOARDS) for (const i of d.insights) for (const s of i.query.series as any[]) {
      if (s.action !== undefined) { expect(actionNames, i.name).toContain(s.action); continue; }
      expect(names, `${i.name}: ${s.event}`).toContain(s.event);
      const shape = (EVENTS as any)[s.event] ?? {};
      for (const p of s.properties ?? []) {
        expect(Object.keys(shape), `${i.name}: ${s.event}.${p.key}`).toContain(p.key);
        for (const v of p.value) expect(shape[p.key], `${i.name}: ${s.event}.${p.key}=${v}`).toContain(v);
      }
      if (i.query.breakdownFilter) expect(Object.keys(shape), `${i.name} breakdown`).toContain(i.query.breakdownFilter.breakdown);
    }
  });

  it('the onboarding funnel has no Apply step (both paths reach it); Apply steps are only in the Cloudflare-path funnel', () => {
    const steps = (name: string) => DASHBOARDS.flatMap((d) => d.insights).find((i) => i.name === name)!.query.series.map((s: any) => s.event ?? s.action);
    expect(steps('RSM onboarding funnel (14 days)')).not.toEqual(expect.arrayContaining(['Apply Clicked']));
    expect(steps('RSM onboarding funnel (14 days)')).not.toEqual(expect.arrayContaining(['Apply Done']));
    expect(steps('RSM manual path funnel (7 days)')).toEqual(['Domain Added', 'Ownership Verified', 'Records Live']);
    expect(steps('RSM Cloudflare path funnel (7 days)')).toEqual(['Cloudflare Connect Started', 'Cloudflare Connect Returned', 'Ownership Verified', 'Apply Clicked', 'Apply Done', 'Records Live']);
  });

  it('`path` means how ownership was proven: no funnel filters Domain Added on path; the path funnels key off Ownership Verified and Records Live', () => {
    const insights = DASHBOARDS.flatMap((d) => d.insights);
    const filters = (name: string) => insights.find((i) => i.name === name)!.query.series.map((s: any) => [s.event ?? s.action, (s.properties ?? []).map((p: any) => `${p.key} ${p.operator} ${p.value.join(',')}`)]);
    for (const i of insights) for (const s of i.query.series as any[]) {
      if (s.event === 'Domain Added') expect((s.properties ?? []).map((p: any) => p.key), i.name).not.toContain('path');
    }
    expect(filters('RSM Cloudflare path funnel (7 days)')).toEqual([
      ['Cloudflare Connect Started', []], ['Cloudflare Connect Returned', ['result exact connected']], ['Ownership Verified', ['path exact cloudflare']],
      ['Apply Clicked', []], ['Apply Done', []], ['Records Live', ['path exact cloudflare']],
    ]);
    expect(filters('RSM manual path funnel (7 days)')).toEqual([
      ['Domain Added', ['source is_not cloudflare_import']], ['Ownership Verified', ['path exact manual']], ['Records Live', ['path exact manual']],
    ]);
    expect(filters('RSM onboarding funnel (14 days)').filter(([e]: [string, string[]]) => e === 'RSM Setup Started' || e === 'Ownership Verified')).toEqual([['RSM Setup Started', []], ['Ownership Verified', []]]);
    expect(insights.find((i) => i.name === 'RSM records live: who wrote them')!.query.breakdownFilter.breakdown).toBe('records_by');
  });

  it('objects it made with the earlier path definition (Domain Added filtered on path) are updated to the new one, nothing else is touched', async () => {
    const f = fakePostHog();
    await run({ env: ENV, project: PROJECT, fetchImpl: f.fetchImpl as never, log: () => {} });
    const mine = (name: string) => f.store.insights.find((x) => x.name === name)!;
    for (const name of ['RSM manual path funnel (7 days)', 'RSM Cloudflare path funnel (7 days)']) {
      const old = mine(name);
      old.description = old.description.replace(/def:[0-9a-f]{12}/, 'def:0123456789ab');
      const earlier = (x: any): void => { // the earlier definition: Domain Added and Ownership Verified filtered on `path`
        if (x && typeof x === 'object' && (x.event === 'Domain Added' || x.event === 'Ownership Verified')) x.properties = [{ key: 'path', value: ['manual'], operator: 'exact', type: 'event' }];
        for (const v of Object.values(x ?? {})) if (v && typeof v === 'object') earlier(v);
      };
      earlier(old.query);
    }
    f.calls.length = 0;
    const plan = await run({ env: ENV, project: PROJECT, fetchImpl: f.fetchImpl as never, log: () => {} });
    expect(plan.filter((p) => p.verb !== 'unchanged').map((p) => `${p.verb} ${p.name}`).sort()).toEqual(['update RSM Cloudflare path funnel (7 days)', 'update RSM manual path funnel (7 days)']);
    expect(f.calls.filter((c) => c.method !== 'GET').map((c) => c.method)).toEqual(['PATCH', 'PATCH']);
    const found: any[] = [];
    const collect = (x: any): void => { if (x?.event === 'Domain Added') found.push(x); for (const v of Object.values(x ?? {})) if (v && typeof v === 'object') collect(v); };
    collect(mine('RSM manual path funnel (7 days)').query);
    const domainAdded = found[0];
    expect(domainAdded.properties).toEqual([{ key: 'source', value: ['cloudflare_import'], operator: 'is_not', type: 'event' }]);
    f.calls.length = 0;
    expect((await run({ env: ENV, project: PROJECT, fetchImpl: f.fetchImpl as never, log: () => {} })).every((p) => p.verb === 'unchanged')).toBe(true);
    expect(f.calls.filter((c) => c.method !== 'GET')).toEqual([]);
  });
});
