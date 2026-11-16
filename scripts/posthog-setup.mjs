#!/usr/bin/env node
// Create the hosted dashboard's PostHog actions, funnels and dashboards (docs/analytics.md, "Funnels" and "Setting up PostHog"),
// by name and idempotently: whatever already exists with the same name is kept; only what is missing is created (and an existing
// insight missing from its dashboard is added to it). Run it again after a change here; it never deletes or renames anything.
//
//   POSTHOG_PERSONAL_API_KEY=phx_…  POSTHOG_PROJECT_ID=12345  node scripts/posthog-setup.mjs --dry-run   # print the plan, write nothing
//   POSTHOG_PERSONAL_API_KEY=phx_…  POSTHOG_PROJECT_ID=12345  node scripts/posthog-setup.mjs             # create what is missing
//
// The key is a PERSONAL API key of the person who owns the PostHog project (Settings → User → Personal API keys), with the scopes
// project:read, insight:write, dashboard:write and action:write. It is read from the environment only, never printed, never
// written anywhere, and sent only to POSTHOG_APP_HOST. It is not the project key (phc_…) the Worker sends events with: that one
// cannot read or create anything. POSTHOG_APP_HOST is the PRIVATE API host: https://us.posthog.com (default) or https://eu.posthog.com
// ("On US Cloud, these are https://us.i.posthog.com for public endpoints and https://us.posthog.com for private ones",
// https://posthog.com/docs/api). Requests use `Authorization: Bearer <key>` (https://posthog.com/docs/api/personal-api-keys) on
// /api/projects/:project_id/{actions,dashboards,insights}/; funnels are saved as InsightVizNode → FunnelsQuery with `series` of
// EventsNode / ActionsNode and `funnelsFilter` (https://posthog.com/docs/api/queries, "Funnel queries"). Creates are rate limited at
// 480/minute (https://posthog.com/docs/api, "Rate limiting"): one run makes about 30 requests.
//
// --dry-run without a key prints the whole plan without contacting PostHog. Exit codes: 0 done (or planned), 1 a request failed,
// 2 missing configuration.
import { pathToFileURL } from 'node:url';

const ev = (event) => ({ kind: 'EventsNode', event, name: event });
const act = (name) => ({ action: name });
const funnel = (steps, days, extra = {}) => ({ kind: 'FunnelsQuery', series: steps, dateRange: { date_from: '-30d' }, funnelsFilter: { funnelOrderType: 'ordered', funnelWindowInterval: days, funnelWindowIntervalUnit: 'day', ...extra } });
const trends = (series, opts = {}) => ({ kind: 'TrendsQuery', series: series.map((s) => (typeof s === 'string' ? { ...ev(s), math: 'total' } : s)), interval: opts.interval ?? 'week', dateRange: { date_from: opts.from ?? '-90d' }, ...(opts.breakdown ? { breakdownFilter: { breakdown: opts.breakdown, breakdown_type: 'event' } } : {}) });

/** Actions: one name for "any of these events". */
export const ACTIONS = [
  { name: 'RSM Setup Started', description: 'The first move to configure a domain: a domain added by hand, by an agent or in bulk, or Cloudflare connect started.', steps: [{ event: 'Domain Added' }, { event: 'Cloudflare Connect Started' }] },
  { name: 'RSM Value Reached', description: 'A value or money moment: records live, first report, or a paid fix.', steps: [{ event: 'Records Live' }, { event: 'First Report Received' }, { event: 'Fix Order Paid' }] },
];

/** Dashboards and their insights. A step `{ action: name }` refers to an action above (resolved to its id). */
export const DASHBOARDS = [
  {
    name: 'RSM: Onboarding, sign-up to first report',
    description: 'Hosted dashboard: where each new account stops between "Create account" and the first DMARC report (docs/analytics.md, funnel 1).',
    insights: [
      { name: 'RSM onboarding funnel (14 days)', description: 'Every step of sign-up and first run, in order, per account (random analytics id).', query: funnel([ev('Signup Started'), ev('Signup Code Sent'), ev('Code Verified'), ev('Dashboard First Viewed'), act('RSM Setup Started'), ev('Ownership Verified'), ev('Apply Done'), ev('Records Live'), ev('First Report Received')], 14) },
      { name: 'RSM onboarding: time to records live', description: 'Time from the verified code to records live.', query: funnel([ev('Code Verified'), ev('Records Live')], 14, { funnelVizType: 'time_to_convert' }) },
      { name: 'RSM sign-up: code wait', description: 'Code sent to code typed, by bucket.', query: trends(['Code Verified'], { breakdown: 'wait' }) },
      { name: 'RSM sign-up: where people come from', description: 'Sign-ups by entry (checker, report, agencies, header, pricing, cold).', query: trends(['Signup Started'], { breakdown: 'entry' }) },
      { name: 'RSM first view: what people find', description: 'The dashboard\'s first view by state.', query: trends(['Dashboard First Viewed'], { breakdown: 'state' }) },
      { name: 'RSM no report after 3 days', description: 'Workspaces whose records went live 3 days ago and still have no report.', query: trends(['No Report After 3 Days']) },
    ],
  },
  {
    name: 'RSM: Domain configuration',
    description: 'From the first move on a domain to its records live in public DNS (docs/analytics.md, funnel 2).',
    insights: [
      { name: 'RSM domain configuration funnel (7 days)', description: 'Setup started, ownership proven, Apply pressed and finished, records live.', query: funnel([act('RSM Setup Started'), ev('Ownership Verified'), ev('Apply Clicked'), ev('Apply Done'), ev('Records Live')], 7) },
      { name: 'RSM Cloudflare connect funnel (1 day)', description: 'Connect started to connected.', query: funnel([ev('Cloudflare Connect Started'), ev('Cloudflare Connect Returned')], 1) },
      { name: 'RSM Cloudflare connect results', description: 'Connect returns by result.', query: trends(['Cloudflare Connect Returned'], { breakdown: 'result' }) },
      { name: 'RSM domains added by DNS host', description: 'Domain Added by DNS provider category.', query: trends(['Domain Added'], { breakdown: 'dns_provider' }) },
      { name: 'RSM ownership proofs by method', description: 'Ownership Verified by method (Cloudflare zone, TXT, parent).', query: trends(['Ownership Verified'], { breakdown: 'method' }) },
      { name: 'RSM Apply results', description: 'Apply Done by result.', query: trends(['Apply Done'], { breakdown: 'result' }) },
      { name: 'RSM Apply to public DNS', description: 'Records Live by time since the last Apply.', query: trends(['Records Live'], { breakdown: 'since_apply' }) },
    ],
  },
  {
    name: 'RSM: Path to purchase',
    description: 'From records live to a paid and delivered "Fix one domain" (docs/analytics.md, funnel 3). Amounts live in Stripe, not here.',
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

class ApiError extends Error {
  constructor(method, path, status) { super(`${method} ${path} answered ${status}`); this.status = status; }
}

/** A minimal PostHog private-API client. The key goes in one header and nowhere else. */
function client({ host, projectId, key, fetchImpl }) {
  const base = `${host.replace(/\/+$/, '')}/api/projects/${encodeURIComponent(projectId)}`;
  const req = async (method, path, body) => {
    const res = await fetchImpl(`${base}${path}`, { method, headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    if (!res.ok) throw new ApiError(method, `/api/projects/${projectId}${path}`, res.status);
    return res.status === 204 ? null : res.json();
  };
  const all = async (path) => {
    const out = [];
    let next = `${path}${path.includes('?') ? '&' : '?'}limit=200`;
    for (let page = 0; next && page < 50; page++) {
      const r = await req('GET', next);
      out.push(...(r.results ?? []));
      next = r.next ? r.next.slice(r.next.indexOf(`/api/projects/${projectId}`) + `/api/projects/${projectId}`.length) : null;
    }
    return out.filter((x) => !x.deleted);
  };
  return { req, all };
}

/**
 * Plan and (unless dryRun) apply. Returns the list of what was or would be created. `log` receives one line per item; the key is
 * never part of any line.
 */
export async function run({ env = process.env, dryRun = false, fetchImpl = globalThis.fetch, log = console.log } = {}) {
  const key = env.POSTHOG_PERSONAL_API_KEY?.trim();
  const projectId = env.POSTHOG_PROJECT_ID?.trim();
  const host = env.POSTHOG_APP_HOST?.trim() || 'https://us.posthog.com';
  if (!/^https:\/\//.test(host) && !/^http:\/\/(127\.0\.0\.1|localhost):\d+\/?$/.test(host)) throw Object.assign(new Error('POSTHOG_APP_HOST must be an https URL'), { exit: 2 });
  const offline = dryRun && (!key || !projectId);
  if (!offline && (!key || !projectId)) throw Object.assign(new Error('set POSTHOG_PERSONAL_API_KEY and POSTHOG_PROJECT_ID (or use --dry-run to only print the plan)'), { exit: 2 });
  if (key && /^phc_/.test(key)) throw Object.assign(new Error('POSTHOG_PERSONAL_API_KEY is a project key (phc_…): use a personal API key with project:read, insight:write, dashboard:write, action:write'), { exit: 2 });

  const api = offline ? null : client({ host, projectId, key, fetchImpl });
  const plan = [];
  const say = (verb, kind, name) => { plan.push({ verb, kind, name }); log(`${dryRun ? (verb === 'exists' ? 'exists' : `would ${verb}`) : verb} ${kind}: ${name}`); };
  if (offline) log('dry run without POSTHOG_PERSONAL_API_KEY / POSTHOG_PROJECT_ID: PostHog is not contacted, so everything is listed as to create.');

  // Actions first: the funnels refer to them by id.
  const actionIds = new Map();
  const existingActions = api ? await api.all('/actions/') : [];
  for (const a of ACTIONS) {
    const found = existingActions.find((x) => x.name === a.name);
    if (found) { actionIds.set(a.name, found.id); say('exists', 'action', a.name); continue; }
    say('create', 'action', a.name);
    if (!dryRun) actionIds.set(a.name, (await api.req('POST', '/actions/', { name: a.name, description: a.description, steps: a.steps })).id);
  }

  const existingDashboards = api ? await api.all('/dashboards/') : [];
  const existingInsights = api ? await api.all('/insights/?saved=true') : [];
  for (const d of DASHBOARDS) {
    let dashboard = existingDashboards.find((x) => x.name === d.name);
    if (dashboard) say('exists', 'dashboard', d.name);
    else {
      say('create', 'dashboard', d.name);
      if (!dryRun) dashboard = await api.req('POST', '/dashboards/', { name: d.name, description: d.description, pinned: true });
    }
    for (const i of d.insights) {
      const found = existingInsights.find((x) => x.name === i.name);
      if (found) {
        const on = (found.dashboards ?? []).map((x) => (typeof x === 'object' ? x.id : x));
        if (dashboard?.id !== undefined && !on.includes(dashboard.id)) {
          say('add to dashboard', 'insight', i.name);
          if (!dryRun) await api.req('PATCH', `/insights/${found.id}/`, { dashboards: [...on, dashboard.id] });
        } else say('exists', 'insight', i.name);
        continue;
      }
      say('create', 'insight', i.name);
      if (!dryRun) await api.req('POST', '/insights/', { name: i.name, description: i.description, saved: true, query: resolveActions(i.query, actionIds), dashboards: dashboard?.id !== undefined ? [dashboard.id] : [] });
    }
  }
  return plan;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const dryRun = process.argv.includes('--dry-run');
  run({ dryRun }).then((plan) => {
    const made = plan.filter((p) => p.verb !== 'exists').length;
    console.log(`${dryRun ? 'planned' : 'done'}: ${made} to ${dryRun ? 'create or attach' : 'created or attached'}, ${plan.length - made} already there`);
  }, (e) => {
    console.error(`posthog-setup: ${e.message}`); // never the key: messages carry only method, path and status
    process.exit(e.exit ?? 1);
  });
}
