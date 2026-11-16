#!/usr/bin/env node
// Create and keep up to date the hosted dashboard's PostHog actions, funnels and dashboards (docs/analytics.md, "Funnels").
//
//   POSTHOG_PERSONAL_API_KEY=phx_…  node scripts/posthog-setup.mjs --project 12345 --dry-run   # print create/update/unchanged, write nothing
//   POSTHOG_PERSONAL_API_KEY=phx_…  node scripts/posthog-setup.mjs --project 12345             # apply
//
// It only ever touches what it created. Every object it creates carries a marker at the end of its description
// (`managed-by: rsm-setup def:<hash of its definition>`); it updates an object only when that object carries the marker and its
// definition changed, and leaves everything else in the project alone: it never modifies, moves or deletes an object without the
// marker, never deletes anything at all, and when a name is already taken by an object it did not create it creates its own under
// `<name> (rsm-setup)` and says so.
//
// The project is given as `--project <numeric id>` (Project settings → Project ID). `@current` is not accepted: it is sent URL-encoded
// and PostHog answers 403. The key is a PERSONAL API key of the person who owns the project (Settings → User → Personal API keys),
// scoped to that one project, with project:read, insight:write, dashboard:write and action:write; organisation endpoints answer it
// 403, so the script uses project endpoints only. It is read from the environment only, never printed, never written anywhere, and
// sent only to POSTHOG_APP_HOST in the Authorization header. It is not the project key (phc_…) the Worker sends events with.
// POSTHOG_APP_HOST is the PRIVATE API host: https://us.posthog.com (default) or https://eu.posthog.com ("On US Cloud, these are
// https://us.i.posthog.com for public endpoints and https://us.posthog.com for private ones", https://posthog.com/docs/api).
// Requests use `Authorization: Bearer <key>` (https://posthog.com/docs/api/personal-api-keys) on
// /api/projects/:project_id/{actions,dashboards,insights}/; funnels are saved as InsightVizNode → FunnelsQuery with `series` of
// EventsNode / ActionsNode and `funnelsFilter` (https://posthog.com/docs/api/queries, "Funnel queries").
//
// --dry-run without a key prints the whole plan without contacting PostHog. Exit codes: 0 done (or planned), 1 a request failed,
// 2 missing or wrong configuration.
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

export const MARKER = 'managed-by: rsm-setup';
export const SUFFIX = ' (rsm-setup)';

const ev = (event, properties) => ({ kind: 'EventsNode', event, name: event, ...(properties ? { properties } : {}) });
const where = (key, value) => [{ key, value: [value], operator: 'exact', type: 'event' }];
const act = (name) => ({ action: name });
const funnel = (steps, days, extra = {}) => ({ kind: 'FunnelsQuery', series: steps, dateRange: { date_from: '-30d' }, funnelsFilter: { funnelOrderType: 'ordered', funnelWindowInterval: days, funnelWindowIntervalUnit: 'day', ...extra } });
const trends = (series, opts = {}) => ({ kind: 'TrendsQuery', series: series.map((s) => (typeof s === 'string' ? { ...ev(s), math: 'total' } : s)), interval: opts.interval ?? 'week', dateRange: { date_from: opts.from ?? '-90d' }, ...(opts.breakdown ? { breakdownFilter: { breakdown: opts.breakdown, breakdown_type: 'event' } } : {}) });

/** Actions: one name for "any of these events". */
export const ACTIONS = [
  { name: 'RSM Setup Started', description: 'The first move to configure a domain, on either path: a domain added (typed, bulk, by an agent, or imported from Cloudflare), or Cloudflare connect started (OAuth or a pasted token).', steps: [{ event: 'Domain Added' }, { event: 'Cloudflare Connect Started' }] },
  { name: 'RSM Value Reached', description: 'A value or money moment: records live, first report, or a paid fix.', steps: [{ event: 'Records Live' }, { event: 'First Report Received' }, { event: 'Fix Order Paid' }] },
];

/** Dashboards and their insights. A step `{ action: name }` refers to an action above (resolved to its id). */
export const DASHBOARDS = [
  {
    name: 'RSM: Onboarding, sign-up to first report',
    description: 'Hosted dashboard: where each new account stops between "Create account" and the first DMARC report, on either setup path (docs/analytics.md, funnels 1 and 2).',
    insights: [
      { name: 'RSM onboarding funnel (14 days)', description: 'Every account, whichever way it signed up and set up: sign-up, workspace, first view, setup started, ownership proven, records live, first report.', query: funnel([ev('Signup Started'), ev('Workspace Created'), ev('Dashboard First Viewed'), act('RSM Setup Started'), ev('Ownership Verified'), ev('Records Live'), ev('First Report Received')], 14) },
      { name: 'RSM sign-up by email code (1 day)', description: 'The email-code sign-up only: started, code sent, code right, workspace made.', query: funnel([ev('Signup Started', where('method', 'email_code')), ev('Signup Code Sent'), ev('Code Verified'), ev('Workspace Created')], 1) },
      { name: 'RSM onboarding: time to records live', description: 'Time from the new workspace to records live.', query: funnel([ev('Workspace Created'), ev('Records Live')], 14, { funnelVizType: 'time_to_convert' }) },
      { name: 'RSM sign-up: how', description: 'Sign-ups by method (email code, Google, GitHub).', query: trends(['Signup Started'], { breakdown: 'method' }) },
      { name: 'RSM sign-up: code wait', description: 'Code sent to code typed, by bucket.', query: trends(['Code Verified'], { breakdown: 'wait' }) },
      { name: 'RSM sign-up: where people come from', description: 'Sign-ups by entry (the website page class of the sign-up link; cold = no link).', query: trends(['Signup Started'], { breakdown: 'entry' }) },
      { name: 'RSM first view: what people find', description: 'The dashboard\'s first view by state.', query: trends(['Dashboard First Viewed'], { breakdown: 'state' }) },
      { name: 'RSM no report after 3 days', description: 'Workspaces whose records went live 3 days ago and still have no report.', query: trends(['No Report After 3 Days']) },
    ],
  },
  {
    name: 'RSM: Domain configuration',
    description: 'From the first move on a domain to its records live in public DNS, one funnel per setup path (docs/analytics.md, funnels 3 and 4).',
    insights: [
      { name: 'RSM Cloudflare path funnel (7 days)', description: 'Cloudflare connected (OAuth or token), ownership proven, Apply pressed and finished, records live by our Apply.', query: funnel([ev('Cloudflare Connect Started'), ev('Cloudflare Connect Returned', where('result', 'connected')), ev('Ownership Verified'), ev('Apply Clicked'), ev('Apply Done'), ev('Records Live', where('path', 'cloudflare'))], 7) },
      { name: 'RSM manual path funnel (7 days)', description: 'A domain added by hand, proven by a TXT record, records added at its DNS host and seen live.', query: funnel([ev('Domain Added', where('path', 'manual')), ev('Ownership Verified', where('path', 'manual')), ev('Records Live', where('path', 'manual'))], 7) },
      { name: 'RSM records live by path', description: 'Records Live by setup path (cloudflare, manual).', query: trends(['Records Live'], { breakdown: 'path' }) },
      { name: 'RSM records live: who saw it', description: 'Records Live by what observed it (setup screen, domain page, daily job): the daily job means up to a day late.', query: trends(['Records Live'], { breakdown: 'seen_by' }) },
      { name: 'RSM Cloudflare connect results', description: 'Connect returns by result.', query: trends(['Cloudflare Connect Returned'], { breakdown: 'result' }) },
      { name: 'RSM domains added by DNS host', description: 'Domain Added by DNS provider category.', query: trends(['Domain Added'], { breakdown: 'dns_provider' }) },
      { name: 'RSM ownership proofs by method', description: 'Ownership Verified by method (Cloudflare zone, TXT, parent).', query: trends(['Ownership Verified'], { breakdown: 'method' }) },
      { name: 'RSM Apply results', description: 'Apply Done by result.', query: trends(['Apply Done'], { breakdown: 'result' }) },
      { name: 'RSM Apply to public DNS', description: 'Records Live by time since the last Apply.', query: trends(['Records Live'], { breakdown: 'since_apply' }) },
    ],
  },
  {
    name: 'RSM: Path to purchase',
    description: 'From records live to a paid and delivered "Fix one domain" (docs/analytics.md, funnel 5). Amounts live in Stripe, not here.',
    insights: [
      { name: 'RSM purchase funnel (30 days)', description: 'Records live, offer seen, card, order, paid, delivered.', query: funnel([ev('Records Live'), ev('Fix Offer Viewed'), ev('Card Setup Started'), ev('Card Setup Completed'), ev('Fix Order Created'), ev('Fix Order Paid'), ev('Fix Order Delivered')], 30) },
      { name: 'RSM offer to paid (30 days)', description: 'Offer seen to paid, whatever came before.', query: funnel([ev('Fix Offer Viewed'), ev('Fix Order Created'), ev('Fix Order Paid')], 30) },
      { name: 'RSM orders by outcome', description: 'Created, paid, failed, refunded, delivered per week.', query: trends(['Fix Order Created', 'Fix Order Paid', 'Fix Order Failed', 'Fix Order Refunded', 'Fix Order Delivered']) },
    ],
  },
  {
    name: 'RSM: Value moments per week',
    description: 'The value and money moments, counted per week (counts, not rates: numbers are small), and the teammate and agent hand-offs.',
    insights: [
      { name: 'RSM value moments per week', description: 'Records live, first report, teammate joined, agent first call, fix paid, fix delivered.', query: trends(['Records Live', 'First Report Received', 'Invite Accepted', 'Agent First Call', 'Fix Order Paid', 'Fix Order Delivered'], { from: '-180d' }) },
      { name: 'RSM accounts reaching value per week', description: 'Distinct accounts with any value moment.', query: trends([{ kind: 'ActionsNode', action: 'RSM Value Reached', math: 'dau' }], { from: '-180d' }) },
      { name: 'RSM teammate hand-off funnel (7 days)', description: 'Invite sent, accepted, then records live in that workspace.', query: funnel([ev('Invite Sent'), ev('Invite Accepted'), ev('Records Live')], 7) },
      { name: 'RSM agent funnel (1 day)', description: 'Agent authorized, then its first tool call.', query: funnel([ev('Agent Authorized'), ev('Agent First Call')], 1) },
      { name: 'RSM active workspaces per week', description: 'Workspaces that opened the dashboard (at most once a day each).', query: trends([{ ...ev('Workspace Active'), math: 'dau' }]) },
    ],
  },
];

/** Replace `{ action: name }` steps and ActionsNode names by the action's id. */
function resolveActions(query, actionIds) {
  const fix = (s) => {
    if (s.action === undefined) return s;
    const id = actionIds.get(s.action);
    const { action: _a, ...rest } = s;
    return { ...rest, kind: 'ActionsNode', id: id ?? `<id of action "${s.action}">`, name: s.action };
  };
  return { kind: 'InsightVizNode', source: { ...query, series: query.series.map(fix) } };
}

/** A short hash of what an object should be: stored in its marker, so a changed definition is seen without comparing PostHog's own rewrite of it. */
export const definitionHash = (def) => createHash('sha256').update(JSON.stringify(def)).digest('hex').slice(0, 12);
const describe = (description, hash) => `${description}\n\n${MARKER} def:${hash}`;
export const isManaged = (x) => typeof x?.description === 'string' && x.description.includes(MARKER);
const hashOf = (x) => /def:([0-9a-f]{12})/.exec(x?.description ?? '')?.[1] ?? null;

class ApiError extends Error {
  constructor(method, path, status) { super(`${method} ${path} answered ${status}${status === 403 ? ' (the personal API key is scoped to one project: check --project and the key\'s scopes)' : ''}`); this.status = status; }
}

/** A minimal PostHog private-API client on one project. The key goes in one header and nowhere else. */
function client({ host, projectId, key, fetchImpl }) {
  const prefix = `/api/projects/${projectId}`;
  const base = `${host.replace(/\/+$/, '')}${prefix}`;
  const req = async (method, path, body) => {
    const res = await fetchImpl(`${base}${path}`, { method, headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    if (!res.ok) throw new ApiError(method, `${prefix}${path}`, res.status);
    return res.status === 204 ? null : res.json();
  };
  const all = async (path) => {
    const out = [];
    let next = `${path}${path.includes('?') ? '&' : '?'}limit=200`;
    for (let page = 0; next && page < 50; page++) {
      const r = await req('GET', next);
      out.push(...(r.results ?? []));
      next = r.next ? r.next.slice(r.next.indexOf(prefix) + prefix.length) : null;
    }
    return out.filter((x) => !x.deleted);
  };
  return { req, all };
}

/** `--project <id>` from argv: digits only. */
export function projectArg(argv) {
  const i = argv.indexOf('--project');
  const eq = argv.find((a) => a.startsWith('--project='));
  return eq ? eq.slice('--project='.length) : i >= 0 ? argv[i + 1] : undefined;
}

/**
 * Plan and (unless dryRun) apply. Returns one entry per object: create, update or unchanged (and `renamed` when its name was taken
 * by an object this script did not create). `log` receives one line per object; the key is never part of any line.
 */
export async function run({ env = process.env, project, dryRun = false, fetchImpl = globalThis.fetch, log = console.log } = {}) {
  const key = env.POSTHOG_PERSONAL_API_KEY?.trim();
  const host = env.POSTHOG_APP_HOST?.trim() || 'https://us.posthog.com';
  const projectId = typeof project === 'string' ? project.trim() : '';
  if (!/^https:\/\//.test(host) && !/^http:\/\/(127\.0\.0\.1|localhost):\d+\/?$/.test(host)) throw Object.assign(new Error('POSTHOG_APP_HOST must be an https URL'), { exit: 2 });
  if (!/^\d+$/.test(projectId)) throw Object.assign(new Error('give the project as --project <numeric id> (Project settings → Project ID); @current is not accepted'), { exit: 2 });
  const offline = dryRun && !key;
  if (!offline && !key) throw Object.assign(new Error('set POSTHOG_PERSONAL_API_KEY (or use --dry-run to only print the plan)'), { exit: 2 });
  if (key && /^phc_/.test(key)) throw Object.assign(new Error('POSTHOG_PERSONAL_API_KEY is a project key (phc_…): use a personal API key with project:read, insight:write, dashboard:write, action:write'), { exit: 2 });

  const api = offline ? null : client({ host, projectId, key, fetchImpl });
  const plan = [];
  const say = (verb, kind, name, note) => {
    plan.push({ verb, kind, name, ...(note ? { note } : {}) });
    log(`${dryRun && verb !== 'unchanged' ? `would ${verb}` : verb} ${kind}: ${name}${note ? ` (${note})` : ''}`);
  };
  if (offline) log('dry run without POSTHOG_PERSONAL_API_KEY: PostHog is not contacted, so everything is listed as to create.');

  /**
   * One object: ours (marked) under its name or the suffixed one → unchanged or update; the name taken by a foreign object → create
   * under the suffixed name; else create. Returns the object (or a stand-in in a dry run).
   */
  async function ensure(kind, path, existing, name, hash, body, extraUpToDate = () => true, extraPatch = () => ({})) {
    const mine = existing.find((x) => isManaged(x) && (x.name === name || x.name === `${name}${SUFFIX}`));
    if (mine) {
      if (hashOf(mine) === hash && extraUpToDate(mine)) { say('unchanged', kind, mine.name); return mine; }
      say('update', kind, mine.name);
      if (dryRun) return mine;
      return api.req('PATCH', `${path}${mine.id}/`, { ...body, name: mine.name, ...extraPatch(mine) });
    }
    const taken = existing.some((x) => x.name === name);
    const finalName = taken ? `${name}${SUFFIX}` : name;
    say('create', kind, finalName, taken ? `"${name}" is taken by an object this script did not create; that one is left as it is` : undefined);
    if (dryRun) return { name: finalName };
    return api.req('POST', path, { ...body, name: finalName, ...extraPatch(null) });
  }

  // Actions first: the funnels refer to them by id.
  const actionIds = new Map();
  const existingActions = api ? await api.all('/actions/') : [];
  for (const a of ACTIONS) {
    const hash = definitionHash({ description: a.description, steps: a.steps });
    const obj = await ensure('action', '/actions/', existingActions, a.name, hash, { description: describe(a.description, hash), steps: a.steps });
    if (obj?.id !== undefined) actionIds.set(a.name, obj.id);
  }

  const existingDashboards = api ? await api.all('/dashboards/') : [];
  const existingInsights = api ? await api.all('/insights/?saved=true') : [];
  for (const d of DASHBOARDS) {
    const dHash = definitionHash({ description: d.description });
    const dashboard = await ensure('dashboard', '/dashboards/', existingDashboards, d.name, dHash, { description: describe(d.description, dHash) }, () => true, (mine) => (mine ? {} : { pinned: true }));
    for (const i of d.insights) {
      const query = resolveActions(i.query, actionIds);
      const hash = definitionHash({ description: i.description, query });
      const on = (x) => (x.dashboards ?? []).map((y) => (typeof y === 'object' ? y.id : y));
      await ensure('insight', '/insights/', existingInsights, i.name, hash, { description: describe(i.description, hash), saved: true, query },
        (mine) => dashboard?.id === undefined || on(mine).includes(dashboard.id),
        (mine) => ({ dashboards: dashboard?.id === undefined ? (mine ? on(mine) : []) : [...new Set([...(mine ? on(mine) : []), dashboard.id])] }));
    }
  }
  return plan;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const dryRun = process.argv.includes('--dry-run');
  run({ dryRun, project: projectArg(process.argv) }).then((plan) => {
    const n = (v) => plan.filter((p) => p.verb === v).length;
    console.log(`${dryRun ? 'planned' : 'done'}: ${n('create')} ${dryRun ? 'to create' : 'created'}, ${n('update')} ${dryRun ? 'to update' : 'updated'}, ${n('unchanged')} unchanged; nothing else in the project is touched`);
  }, (e) => {
    console.error(`posthog-setup: ${e.message}`); // never the key: messages carry only method, path and status
    process.exit(e.exit ?? 1);
  });
}
