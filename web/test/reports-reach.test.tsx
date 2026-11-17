// PR 181 round 3, BLOCKER 1: every surface says the SAME thing about how reports reach a name, from the server's one answer (`reach`): wizard step 4,
// step 5, the domain page (and the Connect reports panel, web/test/connect-reports.test.tsx). A name whose reports arrive through its parent was told
// "Reports not connected yet" / "No reports reach Ready Set Mail for this name" / offered "Connect reports"; a name that inherits a record that already
// lists our address was told the record "does not list the report address yet".
import { screen } from '@testing-library/react';
import { Route, Routes } from 'react-router';
import { describe, expect, it } from 'vitest';
import { DomainDetailPage } from '../src/pages/domains/DomainDetailPage';
import { SetupWizardPage } from '../src/pages/wizards/SetupWizardPage';
import { renderApp } from './render';
import { inheritedReach, viaParentReach } from './reach';

const now = Math.floor(Date.now() / 1000);
const FIXED = 'rua@rua.example.net';
const REC = `v=DMARC1; p=reject; rua=mailto:${FIXED}`;
const PARENT = { domain_id: 9, domain: 'example.net' };

const view = (domain: string, reach: unknown) => ({
	available: true, reach, domain_id: 1, domain, managed_by: null, can_connect: true, refusal: null, address: null, connected_at: null, last_report_at: null, counted_since_connect: 0,
	reports_since_connect: 0, reports_before_connect: 0, visibility: null, state: 'not_connected', dns: null, apply_via_cloudflare: false, review: null, parent: null, via_parent: null,
});
const SUM = (domain: string) => ({
	domain_id: 1, domain, dmarc_policy: 'reject', spf_record: 'v=spf1 -all', dns_checked_at: now - 60, dns_check_attempted_at: now - 60, dns_check_status: 'ok', dmarc_issue: null, dmarc_inherited_from: null, dns_last_good_status: 'ok',
	total_messages: 49, pass_messages: 40, fail_messages: 9, dkim_total: 49, dkim_pass: 40, spf_total: 49, spf_pass: 40, mta_sts_enabled: 0, mta_sts_mode: null, spf_lookup_count: 2, dmarc_pct: 100, dmarc_p: 'reject', dmarc_sp: null, dmarc_rua: 1,
	report_connect: { can_connect: true, refusal: null, refusal_kind: null },
}) as never;
const onboarding = (domain: string, own: boolean) => ({
	domain_id: 1, domain, rua_address: FIXED, cf_available: false,
	dmarc: { found: own, has_our_rua: true, current_record: own ? REC : null, effective: { policy: 'reject', inherited_from: own ? null : 'example.net', issue: null, record: REC } },
	spf: { record: 'v=spf1 -all', lookup_count: 2, flattening_active: false },
	dkim: { selectors: [{ name: 'g._domainkey.' + domain, record: 'v=DKIM1; k=rsa; p=AAA' }], source: 'doh' }, routing: { mx_found: true, destination_verified: true, reports_domain: null, admin_email: null },
});
const routes = (domain: string, reach: unknown, own: boolean) => ({
	'GET /api/domains/1/report-address': view(domain, reach),
	// the list carries the address the reports arrive at (src/hosted/report-address.ts withReportsVia)
	'GET /api/domains': { domains: [{ id: 1, domain, dmarc_policy: 'reject', rua_address: FIXED, parent_id: 9, created_at: 1700000000, alerts_enabled: 1, is_default: 0 }, { id: 9, domain: 'example.net', dmarc_policy: 'reject', rua_address: FIXED, parent_id: null, created_at: 1700000000, alerts_enabled: 1, is_default: 0 }] },
	'GET /api/domains/1/check-summary': SUM(domain),
	'GET /api/domains/1/wizard-state': { domain: 'complete', spf: 'complete', dkim: 'complete', dmarc: 'pending', routing: 'pending' },
	'PUT /api/domains/1/wizard-state': {},
	'GET /api/hosted/config': { enabled: true, reports: true, records: false },
	'GET /api/domains/1/hosted': { enabled: false },
	'GET /api/domains/1/onboarding-status': onboarding(domain, own),
	'GET /api/domains/1/stats': { domain, days: 7, stats: [] },
	'GET /api/domains/1/sources': { sources: [], one_check: { sources: 0, messages: 0 }, not_recorded: { sources: 0, messages: 0 } },
	'GET /api/domains/1/names': { names: [] },
	'GET /api/domains/1/dns-check': { found: own, has_rua: true, current_record: own ? REC : null, cf_managed: false },
});
const wizard = (step: number, r: Record<string, unknown>) =>
	renderApp(<Routes><Route path="/domains/:id/setup/:step" element={<SetupWizardPage />} /></Routes>, { route: `/domains/1/setup/${step}`, status: { mode: 'saas', has_domain: true } as never, routes: r as never });
const page = (r: Record<string, unknown>) => renderApp(<Routes><Route path="/domains/:id" element={<DomainDetailPage />} /></Routes>, { route: '/domains/1', status: { mode: 'saas' } as never, routes: r as never });
const text = () => (document.body.textContent ?? '').replace(/\s+/g, ' ');

const A = 'app.example.net';
const B = 'cf-bounce.app.example.net';
const aReach = viaParentReach(PARENT, { reports: 2, messages: 49, last_report_at: now - 3600 });
const bReach = inheritedReach(PARENT);
const A_HEAD = 'Reports arrive through example.net';
const A_FILED = '2 reports (49 messages) filed for app.example.net in the last 30 days; the last arrived';
const B_HEAD = "Reports arrive through example.net's record";
const B_SENT = "cf-bounce.app.example.net has no DMARC record of its own. example.net's record applies to it and already sends reports here; mail sent as cf-bounce.app.example.net is counted in example.net's reports.";

describe('state (a): app. has no connection of its own, its reports are filed for it through the connected parent', () => {
  it('step 4 says what step 5 says, never "Reports not connected yet", and offers nothing to connect', async () => {
    wizard(4, routes(A, aReach, true));
    expect(await screen.findByText(A_HEAD)).toBeInTheDocument();
    expect(text()).toContain(A_FILED);
    expect(text()).not.toContain('Reports not connected yet');
    expect(text()).not.toContain('No reports reach Ready Set Mail for this name');
    expect(text()).not.toContain('Reports are configured'); // "will start arriving within 24 hours" is untrue: they have
    expect(screen.queryByRole('button', { name: 'Connect reports' })).toBeNull();
  });
  it('step 5 says it with the same words and the same numbers', async () => {
    wizard(5, routes(A, aReach, true));
    expect(await screen.findByText(A_HEAD)).toBeInTheDocument();
    expect(text()).toContain(A_FILED);
    expect(text()).toContain('Connecting app.example.net would change nothing: it uses the same report address.');
    expect(screen.queryByRole('button', { name: 'Connect reports' })).toBeNull();
  });
  it('the domain page says it too and has no Connect reports', async () => {
    page(routes(A, aReach, true));
    expect(await screen.findByText(A_HEAD)).toBeInTheDocument();
    expect(text()).toContain(A_FILED);
    expect(screen.queryByRole('button', { name: 'Connect reports' })).toBeNull();
    expect(screen.queryByText('Reports not connected yet')).toBeNull();
  });
});

describe('state (b): cf-bounce.app. has no DMARC record of its own and the record that applies already sends reports here', () => {
  it('step 4 names the record that applies, and never tells it to publish one or that reports are missing', async () => {
    wizard(4, routes(B, bReach, false));
    expect(await screen.findByText(B_HEAD)).toBeInTheDocument();
    expect(text()).toContain(B_SENT);
    expect(text()).not.toContain('Reports not connected yet');
    expect(text()).not.toContain('No reports reach Ready Set Mail for this name');
    expect(text()).not.toContain('To receive reports here, publish the record below');
    expect(screen.queryByRole('button', { name: 'Connect reports' })).toBeNull();
  });
  it('step 5 says it', async () => {
    wizard(5, routes(B, bReach, false));
    expect(await screen.findByText(B_HEAD)).toBeInTheDocument();
    expect(text()).toContain(B_SENT);
    expect(screen.queryByRole('button', { name: 'Connect reports' })).toBeNull();
  });
  it('the domain page says it, and its record is never called missing the address', async () => {
    page(routes(B, bReach, false));
    expect(await screen.findByText(B_HEAD)).toBeInTheDocument();
    expect(text()).toContain(B_SENT);
    expect(text()).not.toContain('does not list the report address');
    expect(screen.queryByRole('button', { name: 'Connect reports' })).toBeNull();
  });
});
