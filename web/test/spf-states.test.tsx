// Round 2 (phase 2): what the person sees when a removal waits, when flattening has stopped, when the add-on went away, before turning on, when deleting a domain or
// a workspace that has a flattened record, and "Do this next" on self-host and hosted (admitted or not).
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DnsTools } from '../src/components/domain/DnsTools';
import { SpfStatusLine } from '../src/components/domain/SpfStatusLine';
import { statusLine, pendingSentence, utcClock, heldCount } from '../src/lib/spf-flatten';
import { byHandTips } from '../src/lib/spf-breakdown';
import { DomainDetailPage } from '../src/pages/domains/DomainDetailPage';
import { DomainSettingsPage } from '../src/pages/domains/DomainSettingsPage';
import { SpfLookupsPage } from '../src/pages/domains/SpfLookupsPage';
import { DeleteButton } from '../src/pages/settings/WorkspaceSection';
import { SpfFlattenPage } from '../src/pages/wizards/SpfFlattenPage';
import { me, renderApp, type Handler } from './render';

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
const now = () => Math.floor(Date.now() / 1000);
const ORIGINAL = 'v=spf1 include:a.example include:b.example ~all';
const FLAT = 'v=spf1 ip4:192.0.2.1 ip4:192.0.2.2 ~all';
const AT = Date.UTC(2026, 10, 16, 15, 20) / 1000;
const pending = (over: Record<string, unknown> = {}) => ({ removed: { '_spf.foxtrot-help.net': ['ip4:198.51.100.0/28', 'ip4:198.51.100.64/28'] }, providers: ['_spf.foxtrot-help.net'], since: AT - 4 * 3600, confirm_after: AT, additions_written: true, ...over });
const config = (over: Record<string, unknown> = {}) => ({ enabled: true, original_record: ORIGINAL, flattened_record: FLAT, previous_record: null, ip_count: 2, lookups_before: 14, lookups_after: 3, last_changed_at: now() - 7200, last_refreshed_at: now() - 7200, problem: null, pending: null, ...over });
const status = (cfg: unknown, over: Record<string, unknown> = {}) => ({ available: true, access: { allowed: true }, config: cfg, lookup_count: 14, ...over });
const preview = (over: Record<string, unknown> = {}) => ({ original: ORIGINAL, within_limits: false, live: null, problem: null, flat: { record: FLAT, bytes: 38, ip_count: 2, inlined: ['a.example', 'b.example'], kept_includes: [], lookups_before: 14, lookups_after: 3 }, ...over });
const wizardUi = (<Routes><Route path="/domains/:id/spf-flatten" element={<SpfFlattenPage />} /></Routes>);
const card = (spf: unknown, extra: Record<string, unknown | Handler> = {}) => renderApp(<DnsTools domainId={3} />, { route: '/domains/3', routes: { 'GET /api/domains/3/spf-flatten': spf, 'GET /api/domains/3/mta-sts': { available: false, config: null, summary: null }, ...extra } });
const page = (spf: unknown, extra: Record<string, unknown | Handler> = {}, route = '/domains/3/spf-flatten') => renderApp(wizardUi, { route, routes: { 'GET /api/domains/3/spf-flatten': spf, 'GET /api/domains/3/spf-flatten/preview': preview(), ...extra } });

describe('a removal that waits (docs/adr/0024)', () => {
  const sentence = 'Waiting to confirm a change: _spf.foxtrot-help.net no longer lists 2 addresses. We kept them in your record and will take them out only if the next check, after 15:20 UTC on 16 Nov, sees the same. Anything new from your providers is already in your record.';
  it('the words: provider, how many held, when, and whether the additions were written', () => {
    expect(heldCount(['ip4:1.1.1.1', 'ip6:2001:db8::/32', 'a:v.test'])).toBe('2 addresses and 1 other term');
    expect(utcClock(AT, AT)).toBe('15:20 UTC');
    expect(pendingSentence(pending(), AT - 3600 * 30)).toBe(sentence);
    expect(pendingSentence(pending({ removed: { 'x.test': ['ip4:1.1.1.1'] }, providers: ['x.test'], additions_written: false }), AT)).toBe(
      'Waiting to confirm a change: x.test no longer lists 1 address. We kept it in your record and will take it out only if the next check, after 15:20 UTC, sees the same. New addresses are not in your record yet: with the held ones they would not fit in one record, so nothing was written.');
  });

  it('the card says it, says why four hours, and offers Check again now; the daily check is not given up', async () => {
    const { calls } = card(status(config({ pending: pending({ confirm_after: now() + 3600 }) })), { 'POST /api/domains/3/spf-flatten/refresh': { ok: true, outcome: 'pending', message: 'x', config: config() } });
    const box = await screen.findByTestId('spf-pending');
    expect(box).toHaveTextContent('Waiting to confirm a change: _spf.foxtrot-help.net no longer lists 2 addresses. We kept them in your record');
    expect(box).toHaveTextContent('We wait at least 4 hours so the second look is a fresh answer from the provider, not a copy of the first.');
    expect(screen.getByText(/^On: 2 addresses in your record/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Check again now' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.path.endsWith('/refresh'))).toBe(true));
  });

  it('Check again now before the time shows what the server answers: when it can confirm', async () => {
    const message = 'x.test no longer lists 1 address. We are keeping it in your record until a second check agrees, which can happen after 15:20 UTC.';
    page(status(config({ pending: pending({ confirm_after: now() + 3600 }) })), { 'POST /api/domains/3/spf-flatten/refresh': { ok: true, outcome: 'pending', message, config: config() } });
    await userEvent.click(await screen.findByRole('button', { name: 'Check again now' }));
    expect(await screen.findByText(message)).toBeInTheDocument();
  });

  it('after the time the same button confirms: the answer is a change, and the wait is gone', async () => {
    let on = true;
    const { calls } = page(status(config({ pending: pending({ confirm_after: now() - 60 }) })), {
      'GET /api/domains/3/spf-flatten': () => status(config({ pending: on ? pending({ confirm_after: now() - 60 }) : null })),
      'POST /api/domains/3/spf-flatten/refresh': () => { on = false; return { ok: true, outcome: 'changed', config: config() }; },
    });
    expect(await screen.findByTestId('spf-pending')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Check again now' }));
    await waitFor(() => expect(screen.queryByTestId('spf-pending')).not.toBeInTheDocument());
    expect(calls.filter((c) => c.method === 'POST' && c.path.endsWith('/refresh'))).toHaveLength(1);
  });

  it('both together did not fit: it says nothing new was written either', async () => {
    card(status(config({ pending: pending({ additions_written: false }) })));
    expect(await screen.findByTestId('spf-pending')).toHaveTextContent('New addresses are not in your record yet: with the held ones they would not fit in one record, so nothing was written.');
  });
});

describe('flattening has stopped because nothing can be written any more', () => {
  const stopped = (kind: 'connection_gone' | 'proof_lost') => status(config({ enabled: false, problem: { kind, message: 'server sentence', since: now() } }));
  it('connection gone: the card says it can no longer change the record, what is in DNS, the original to copy, that the daily check stopped', async () => {
    card(stopped('connection_gone'));
    expect(await screen.findByText(/^Ready Set Mail can no longer change this record: its Cloudflare connection is gone\. The daily check has stopped, and nothing more will be written\./)).toBeInTheDocument();
    expect(screen.getByText('In Cloudflare now (as of the last check)')).toBeInTheDocument();
    expect(screen.getByText(FLAT)).toBeInTheDocument();
    expect(screen.getByText('Your original record')).toBeInTheDocument();
    expect(screen.getByText(ORIGINAL)).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /^Copy/ }).length).toBeGreaterThan(0); // the original can be copied
    expect(screen.getByRole('link', { name: 'Reconnect Cloudflare' })).toBeInTheDocument();
    expect(screen.getByText('Stopped')).toBeInTheDocument();
  });
  it('proof lost: refreshing has stopped; what is in DNS; copy the original, or prove ownership again', async () => {
    card(stopped('proof_lost'));
    expect(await screen.findByText(/^Ready Set Mail can no longer show that you control this domain, so the daily check has stopped and nothing more will be written\./)).toBeInTheDocument();
    expect(screen.getByText(FLAT)).toBeInTheDocument();
    expect(screen.getByText(ORIGINAL)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Prove ownership again' })).toHaveAttribute('href', '/domains/3');
  });
  it('the page: the same, with the record that is in Cloudflare when it can be read, and a way to try to put the original back', async () => {
    const { calls } = page(stopped('connection_gone'), { 'GET /api/domains/3/spf-flatten/preview': preview({ live: 'v=spf1 ip4:192.0.2.1 ip4:192.0.2.77 ~all' }), 'DELETE /api/domains/3/spf-flatten': undefined });
    expect(await screen.findByRole('heading', { name: 'SPF flattening has stopped' })).toBeInTheDocument();
    expect(screen.getByText('v=spf1 ip4:192.0.2.1 ip4:192.0.2.77 ~all')).toBeInTheDocument();
    expect(screen.getByText('In Cloudflare now')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Check now' })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Try to put it back' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'DELETE')).toBe(true));
  });
});

describe('the add-on went away while flattening was on', () => {
  it('the page shows the not-available state and only the actions that work: Turn off, Back; no Check now, nothing that would answer 404', async () => {
    const { calls } = page(status(config(), { access: { allowed: false } }));
    expect(await screen.findByRole('heading', { name: 'SPF flattening is not available here any more' })).toBeInTheDocument();
    expect(screen.getByText('Flattening is not switched on for this workspace any more, so the record is no longer refreshed. It still lists the addresses from the last check.')).toBeInTheDocument();
    expect(screen.queryByText(/Checked just now|Checked \d/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Check/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Turn off' })).toBeInTheDocument();
    expect(calls.some((c) => c.path.endsWith('/preview'))).toBe(false);
  });
});

describe('before turning on', () => {
  const risk = 'When a provider starts sending from new addresses, mail from them can fail SPF until the next daily check, up to about a day.';
  it('says what it costs, in one plain sentence, before the button', async () => {
    page(status(null));
    await userEvent.click(await screen.findByRole('button', { name: 'Continue' }));
    expect(await screen.findByTestId('spf-risk')).toHaveTextContent(risk);
  });
  it('a record within the limits: says plainly that flattening is not needed, and who it is for; "Flatten anyway" stays the quiet way on', async () => {
    page(status(null, { lookup_count: 3 }), { 'GET /api/domains/3/spf-flatten/preview': preview({ within_limits: true, flat: { ...preview().flat, lookups_before: 3 } }) });
    expect(await screen.findByText('Your record needs 3 of the 10 lookups receivers allow, so it is fine as it is. Flattening is not needed.')).toBeInTheDocument();
    expect(screen.getByText('Flattening is for records that need more than 10 lookups. Within the limit, a record with includes follows its providers as they change; a flattened one follows them once a day.')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Flatten anyway' }));
    expect(await screen.findByTestId('spf-risk')).toHaveTextContent(risk);
    expect(screen.getByRole('button', { name: 'Turn on flattening' })).toBeInTheDocument();
  });
});

describe('deleting a domain that has a flattened record', () => {
  const domain = { id: 1, domain: 'example.com', rua_address: 'r@x.test', created_at: 1700000000, is_default: 0, alerts_enabled: 1 };
  const settings = (routes: Record<string, unknown | Handler>) => renderApp(<Routes><Route path="/domains/:id/settings" element={<DomainSettingsPage />} /></Routes>, { route: '/domains/1/settings', routes: { 'GET /api/domains': { domains: [domain] }, 'GET /api/domains/1/monitor-subs': { subs: [] }, ...routes } });
  it('says exactly which record will be put back and that nothing is deleted if it cannot be', async () => {
    settings({ 'GET /api/domains/1/spf-flatten': status(config()) });
    const remove = await screen.findByRole('button', { name: /Remove domain/ });
    await waitFor(() => expect(remove).toBeEnabled());
    await userEvent.click(remove);
    const dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByTestId('spf-delete-note')).toHaveTextContent('SPF flattening is on for this domain. Before anything is deleted, this original SPF record is put back in Cloudflare. If it cannot be put back, nothing is deleted.');
    expect(within(dialog).getByText(ORIGINAL)).toBeInTheDocument();
  });
  it('without flattening the dialog is what it was', async () => {
    settings({ 'GET /api/domains/1/spf-flatten': status(null) });
    await userEvent.click(await screen.findByRole('button', { name: /Remove domain/ }));
    expect(screen.queryByTestId('spf-delete-note')).not.toBeInTheDocument();
  });
  it('when it cannot be put back the delete stops: the reason and the original to copy; "Delete anyway" says what stays, and only then leaves the record', async () => {
    const refusal = { error: 'long', reason: 'We could not put your original record back in Cloudflare. (Authentication error)', code: 'spf_restore_failed', domain: 'example.com', original: ORIGINAL, flattened_record: FLAT, leave_param: 'leave_spf_record=1' };
    let leave = false;
    const { calls } = settings({
      'GET /api/domains/1/spf-flatten': status(config()),
      'DELETE /api/domains/1': () => { throw new Error('use the query form'); },
      'DELETE /api/domains/1?leave_spf_record=1': () => { leave = true; return { ok: true, kept: [] }; },
    });
    // the first DELETE answers 409
    vi.stubGlobal('fetch', ((orig) => async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if ((init?.method ?? 'GET') === 'DELETE' && url === '/api/domains/1') return Response.json(refusal, { status: 409 });
      return orig(input, init);
    })(globalThis.fetch));
    await userEvent.click(await screen.findByRole('button', { name: /Remove domain/ }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.click(await within(dialog).findByRole('button', { name: 'Yes, remove' }));
    const stop = await within(dialog).findByTestId('spf-delete-stop');
    expect(stop).toHaveTextContent('Nothing was deleted: the flattened SPF record could not be put back. We could not put your original record back in Cloudflare. (Authentication error)');
    expect(stop).toHaveTextContent('If you delete anyway, the flattened record stays in Cloudflare and nothing will refresh it again.');
    expect(within(stop).getByText(ORIGINAL)).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Try again' })).toBeInTheDocument();
    expect(leave).toBe(false);
    await userEvent.click(within(stop).getByRole('button', { name: 'Delete anyway' }));
    await waitFor(() => expect(leave).toBe(true));
    void calls;
  });
});

describe('deleting a workspace', () => {
  it('its confirm says that flattened records are put back first and that nothing is deleted if one cannot be', async () => {
    renderApp(<DeleteButton id="ws_1" name="Acme" then={() => {}} />, { routes: { 'GET /api/domains': { domains: [{ id: 1, domain: 'a.test', rua_address: '', created_at: 1, is_default: 0, alerts_enabled: 1 }] } } });
    await userEvent.click(await screen.findByRole('button', { name: 'Delete workspace' }));
    expect(await screen.findByText(/A domain with SPF flattening on gets its original SPF record put back in Cloudflare first; if one cannot be put back, nothing is deleted\./)).toBeInTheDocument();
  });
  it('a stop shows each original to copy, and Delete anyway says what stays', async () => {
    const body = { error: 'x', code: 'spf_restore_failed', domains: [{ domain: 'a.test', reason: 'We could not put your original record back in Cloudflare.', original: ORIGINAL }], leave_param: 'leave_spf_record=1' };
    const { calls } = renderApp(<DeleteButton id="ws_1" name="Acme" then={() => {}} />, { routes: {
      'GET /api/domains': { domains: [{ id: 1, domain: 'a.test', rua_address: '', created_at: 1, is_default: 0, alerts_enabled: 1 }] },
      'DELETE /api/workspaces/ws_1?confirm=Acme': () => ({ __status: 409, body }),
      'DELETE /api/workspaces/ws_1?confirm=Acme&leave_spf_record=1': { ok: true },
    } });
    await userEvent.click(await screen.findByRole('button', { name: 'Delete workspace' }));
    await userEvent.type(await screen.findByLabelText(/Type "Acme"/), 'Acme');
    await userEvent.click(screen.getAllByRole('button', { name: 'Delete workspace' }).at(-1)!);
    const stop = await screen.findByTestId('spf-delete-stop');
    expect(stop).toHaveTextContent('Nothing was deleted: an SPF record could not be put back.');
    expect(within(stop).getByText(ORIGINAL)).toBeInTheDocument();
    expect(stop).toHaveTextContent('If you delete anyway, the flattened record stays in Cloudflare and nothing will refresh it again.');
    await userEvent.click(within(stop).getByRole('button', { name: 'Delete anyway' }));
    await waitFor(() => expect(calls.some((c) => c.path.endsWith('leave_spf_record=1'))).toBe(true));
  });
});

describe('the domain page: "Do this next" and the status line', () => {
  const domain = { id: 1, domain: 'example.com', dmarc_policy: 'quarantine', rua_address: 'r@reports.test', parent_id: null, created_at: 1700000000, alerts_enabled: 1, is_default: 0 };
  const current = 'v=DMARC1; p=quarantine; rua=mailto:r@reports.test';
  const onboarding = (spf: Record<string, unknown>) => ({
    domain_id: 1, domain: 'example.com', rua_address: 'r@reports.test', cf_available: true, dmarc: { found: true, has_our_rua: true, current_record: current },
    spf: { record: 'v=spf1 include:a.example -all', lookup_count: 11, flattening_active: false, ...spf }, dkim: { selectors: [{ name: 'g._domainkey.example.com', record: 'v=DKIM1; k=rsa; p=AAA' }], source: 'doh' },
    routing: { mx_found: true, destination_verified: true, reports_domain: null, admin_email: null },
  });
  const summary = { domain_id: 1, domain: 'example.com', dmarc_policy: 'quarantine', spf_record: 'v=spf1 include:a.example -all', dns_checked_at: now() - 60, dns_check_attempted_at: now() - 60, dns_check_status: 'ok', dmarc_issue: null, dmarc_inherited_from: null, dns_last_good_status: 'ok', total_messages: 100, pass_messages: 99, fail_messages: 1, dkim_total: 0, dkim_pass: 0, spf_total: 0, spf_pass: 0, mta_sts_enabled: 0, mta_sts_mode: null, spf_lookup_count: 11, dmarc_pct: 100, dmarc_p: 'quarantine', dmarc_sp: null, dmarc_rua: 1 };
  const routes = (over: Record<string, unknown> = {}) => ({
    'GET /api/domains': { domains: [domain] }, 'GET /api/domains/1/check-summary': summary, 'GET /api/domains/1/stats': { domain: 'example.com', days: 7, stats: [] }, 'GET /api/domains/1/sources': { sources: [] },
    'GET /api/domains/1/wizard-state': { domain: 'complete', spf: 'complete', dkim: 'complete', dmarc: 'complete', routing: 'complete' }, 'GET /api/domains/1/dns-check': { found: true, has_rua: true, current_record: current, cf_managed: true },
    'GET /api/domains/1/onboarding-status': onboarding({}), 'GET /api/domains/1/rollout-next': { current_policy: 'quarantine', current_pct: 100, current_testing: false, current_record: current, current_step_index: 1, total_steps: 5, next_step: null, next_step_note: null, dns_preview: null, pass_rate: 99, blocked: true, block_reason: 'x', has_unknown_senders: false, behind_schedule: false, recommended_policy: null, recommended_pct: null },
    'GET /api/domains/1/spf-flatten': status(null, { lookup_count: 11 }), 'GET /api/domains/1/mta-sts': { available: false, config: null, summary: null }, ...over,
  });
  const detail = (opts: Parameters<typeof renderApp>[1]) => renderApp(<Routes><Route path="/domains/:id" element={<DomainDetailPage />} /></Routes>, { route: '/domains/1', ...opts });

  it('self-host: the SPF step is offered with its link, from the count the instance stored', async () => {
    detail({ routes: routes() });
    const section = await screen.findByRole('region', { name: 'Do this next' });
    expect(await within(section).findByText('Bring SPF down to 10 DNS lookups or fewer')).toBeInTheDocument();
    expect(within(section).getByRole('link', { name: 'Open SPF flattening' })).toHaveAttribute('href', '/domains/1/spf-flatten');
  });
  it('hosted, add-on admitted: the same step and link', async () => {
    detail({ status: { mode: 'saas' }, routes: { ...routes(), 'GET /api/me': { ...me('owner'), add_ons: { spf_flattening: true } } } });
    expect(await within(await screen.findByRole('region', { name: 'Do this next' })).findByRole('link', { name: 'Open SPF flattening' })).toBeInTheDocument();
  });
  it('hosted, add-on not admitted: the step leads to where the lookups go, read-only, never a dead end; nothing about flattening is asked', async () => {
    const { calls } = detail({ status: { mode: 'saas' }, routes: { ...routes(), 'GET /api/me': { ...me('owner'), add_ons: { spf_flattening: false } } } });
    const section = await screen.findByRole('region', { name: 'Do this next' });
    expect(await within(section).findByText('Bring SPF down to 10 DNS lookups or fewer')).toBeInTheDocument();
    expect(within(section).getByRole('link', { name: 'See where the lookups go' })).toHaveAttribute('href', '/domains/1/spf-lookups');
    expect(within(section).queryByRole('link', { name: 'Open SPF flattening' })).not.toBeInTheDocument();
    expect(calls.some((c) => c.path.includes('spf-flatten'))).toBe(false);
  });
  it('flattening on: the step is gone when the flattened record needs 3, and the status line is at the top with a way to the whole state', async () => {
    detail({ routes: routes({ 'GET /api/domains/1/spf-flatten': status(config({ lookups_after: 3 }), { lookup_count: 11 }), 'GET /api/domains/1/onboarding-status': onboarding({ flattening_active: true, lookup_count: 11 }) }) });
    const line = await screen.findByTestId('spf-status-line');
    expect(line).toHaveTextContent('SPF flattening: on · 3 of 10 lookups · checked 2 hours ago');
    expect(within(line).getByRole('link', { name: 'Details' })).toHaveAttribute('href', '/domains/1/spf-flatten');
    const section = await screen.findByRole('region', { name: 'Do this next' });
    await waitFor(() => expect(within(section).queryByText(/Bring SPF down/)).not.toBeInTheDocument());
    // above "Do this next" in the page
    expect(line.compareDocumentPosition(section) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
  it('the status line says what is waiting, stopped or needs attention, in a few words', () => {
    expect(statusLine(status(config({ pending: pending({ confirm_after: AT }) })), AT)!.text).toBe('SPF flattening: waiting to confirm a change, after 15:20 UTC.');
    expect(statusLine(status(config({ enabled: false, problem: { kind: 'proof_lost', message: 'm', since: 1 } })))!.text).toBe('SPF flattening has stopped: we can no longer show you control this domain.');
    expect(statusLine(status(config({ problem: { kind: 'include_unresolved', message: 'm', since: 1 } })))!.text).toBe('SPF flattening needs attention.');
    expect(statusLine(status(null))).toBeNull();
    const { container } = renderApp(<SpfStatusLine domainId={1} status={undefined} />);
    expect(container.textContent).toBe('');
  });
});

describe('where the lookups go (by hand)', () => {
  const item = (term: string, cost: number, nested: Array<{ target: string; cost: number }> = []) => ({ term, kind: term.startsWith('include:') ? 'include' as const : 'mx' as const, target: term.startsWith('include:') ? term.slice(8) : null, cost, nested });
  const view = { ok: true as const, record: 'v=spf1 include:_spf.google.com include:spf.google.com include:mail.big.example mx -all', source: 'published' as const, total: 13, items: [item('include:_spf.google.com', 4, [{ target: '_netblocks.google.com', cost: 1 }]), item('include:spf.google.com', 3), item('include:mail.big.example', 5), item('mx', 1)] };
  it('names the costliest includes, the includes of one provider, and the terms that can be listed as addresses', () => {
    const tips = byHandTips(view);
    expect(tips[0]).toBe('include:mail.big.example costs 5 lookups (1 for the include and 4 inside it). If you no longer send mail through mail.big.example, remove it. Without it the record needs 8, within the limit.');
    expect(tips).toContain('include:_spf.google.com and include:spf.google.com both belong to google.com. Check in google.com\'s own instructions whether one of them already covers what you use.');
    expect(tips).toContain('mx costs 1 lookup each. Listing the addresses of those servers as ip4: or ip6: terms costs none.'.replace('costs 1 lookup each', 'costs 1 lookup each'));
  });
  it('the page: the record, a table of where the lookups go, what can be done, and the way to edit; for a workspace without the add-on too', async () => {
    renderApp(<Routes><Route path="/domains/:id/spf-lookups" element={<SpfLookupsPage />} /></Routes>, { route: '/domains/5/spf-lookups', status: { mode: 'saas' }, routes: { 'GET /api/domains/5/spf-lookups': view, 'GET /api/me': { ...me('owner'), add_ons: { spf_flattening: false } } } });
    expect(await screen.findByRole('heading', { name: 'Your SPF record needs 13 lookups; receivers stop at 10' })).toBeInTheDocument();
    const row = screen.getByRole('row', { name: /include:mail\.big\.example/ });
    expect(within(row).getByText('5')).toBeInTheDocument();
    expect(screen.getByText('What you can do')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Edit your SPF record' })).toHaveAttribute('href', '/domains/5/setup/2');
  });
  it('says why it could not count, in one sentence', async () => {
    renderApp(<Routes><Route path="/domains/:id/spf-lookups" element={<SpfLookupsPage />} /></Routes>, { route: '/domains/5/spf-lookups', routes: { 'GET /api/domains/5/spf-lookups': { ok: false, message: 'example.com has no SPF record.' } } });
    expect(await screen.findByText('example.com has no SPF record.')).toBeInTheDocument();
  });
});
