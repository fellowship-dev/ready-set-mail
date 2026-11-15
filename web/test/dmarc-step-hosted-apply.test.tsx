// Hosted setup step 4: the record Apply writes carries the report address, has nothing to copy, and is "live" only once public DNS shows it.
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router';
import { describe, expect, it } from 'vitest';
import { PublicDnsLive, sameRecord } from '../src/components/domain/PublicDnsLive';
import { DoneStep } from '../src/pages/wizards/cloudflare/DoneStep';
import { SetupWizardPage } from '../src/pages/wizards/SetupWizardPage';
import { renderApp } from './render';

const now = Math.floor(Date.now() / 1000);
const ADDR = 'rua@intake.example.net';
const RECORD = `v=DMARC1; p=none; rua=mailto:${ADDR}`;
const SUM = {
	domain_id: 1, domain: 'example.com', dmarc_policy: null, spf_record: 'v=spf1 -all', dns_checked_at: now - 60, dns_check_attempted_at: now - 60, dns_check_status: 'ok', dmarc_issue: null, dmarc_inherited_from: null, dns_last_good_status: 'ok',
	total_messages: 0, pass_messages: 0, fail_messages: 0, dkim_total: 0, dkim_pass: 0, spf_total: 0, spf_pass: 0, mta_sts_enabled: 0, mta_sts_mode: null, spf_lookup_count: 2, dmarc_pct: 100, dmarc_p: null, dmarc_sp: null, dmarc_rua: 0, report_connect: { can_connect: true, refusal: null, refusal_kind: null },
} as never;
// What the server sends for a hosted domain whose reports are not connected: the stored address is empty; the connectable one is offered apart,
// and only where Apply via Cloudflare can write and connect it.
const onboarding = (cf = true, found = false) => ({
	domain_id: 1, domain: 'example.com', rua_address: '', offered_rua_address: cf ? ADDR : null, cf_available: cf,
	dmarc: { found, has_our_rua: false, current_record: found ? RECORD : null, effective: { policy: found ? 'none' : null, inherited_from: null, issue: null, record: found ? RECORD : null } }, spf: { record: 'v=spf1 -all', lookup_count: 2, flattening_active: false },
	dkim: { selectors: [{ name: 'g._domainkey.example.com', record: 'v=DKIM1; k=rsa; p=AAA' }], source: 'doh' }, routing: { mx_found: true, destination_verified: true, reports_domain: null, admin_email: null },
});
const base = (over: Record<string, unknown> = {}) => ({
	'GET /api/domains': { domains: [{ id: 1, domain: 'example.com', dmarc_policy: null, rua_address: '', parent_id: null, created_at: 1700000000, alerts_enabled: 1, is_default: 0 }] },
	'GET /api/domains/1/check-summary': SUM,
	'GET /api/domains/1/wizard-state': { domain: 'complete', spf: 'complete', dkim: 'complete', dmarc: 'pending', routing: 'pending' },
	'PUT /api/domains/1/wizard-state': {},
	'GET /api/hosted/config': { enabled: true, reports: true, records: false },
	'GET /api/domains/1/hosted': { enabled: false },
	'GET /api/domains/1/onboarding-status': onboarding(),
	...over,
});
const step4 = (routes: Record<string, unknown>) =>
	renderApp(<Routes><Route path="/domains/:id/setup/:step" element={<SetupWizardPage />} /></Routes>, { route: '/domains/1/setup/4', status: { mode: 'saas', has_domain: true } as never, routes: routes as never });
const copyButtons = () => screen.queryAllByRole('button', { name: /^Copy/ });
const text = () => (document.body.textContent ?? '').replace(/\s+/g, ' ');

describe('setup step 4 on hosted', () => {
	it('shows the record that will be written, with the report address and nothing to copy', async () => {
		step4(base());
		expect(await screen.findByText('The record Ready Set Mail will write')).toBeInTheDocument();
		expect(text()).toContain(RECORD);
		expect(copyButtons()).toHaveLength(0);
		expect(screen.getByRole('button', { name: 'Apply via Cloudflare' })).toBeInTheDocument();
	});

	it('without a Cloudflare connection the record to paste has no report address: reports sent for a domain that was never connected are refused', async () => {
		step4(base({ 'GET /api/domains/1/onboarding-status': onboarding(false) }));
		expect(await screen.findByText('Recommended record')).toBeInTheDocument();
		await screen.findByText('Reports not connected yet');
		expect(text()).not.toContain(ADDR);
		expect(text()).toContain('v=DMARC1; p=none');
		expect(copyButtons().length).toBeGreaterThan(0); // the record to paste, without an address
	});

	it('with Cloudflare connected but the domain\'s zone not in it, the step names no report address anywhere, not even in "Add rua=": that Apply cannot connect reports', async () => {
		// what the server sends when a connection exists but the domain is not linked to it: Cloudflare available, nothing offered
		step4(base({ 'GET /api/domains/1/onboarding-status': { ...onboarding(true, true), offered_rua_address: null, dmarc: { found: true, has_our_rua: false, current_record: 'v=DMARC1; p=none; rua=mailto:someone@else.example', effective: { policy: 'none', inherited_from: null, issue: null, record: 'v=DMARC1; p=none; rua=mailto:someone@else.example' } } } }));
		await screen.findByText('DMARC policy');
		expect(text()).not.toContain(ADDR);
		expect(text()).not.toMatch(/Add rua=/);
		expect(text()).not.toContain(`rua=mailto:${ADDR}`);
	});

	for (const found of [false, true]) {
		it(`without Cloudflare, ${found ? 'a record that already lists our address' : 'no record'}: the step says reports are not connected, offers no record with our address and no Copy of one`, async () => {
			step4(base({ 'GET /api/domains/1/onboarding-status': onboarding(false, found) }));
			await screen.findByText('Reports not connected yet');
			await screen.findByText('DMARC policy');
			expect(text()).not.toContain('Reports are configured');
			expect(text()).not.toContain('does not send reports to Ready Set Mail');
			// the only place the address can appear is the record the person already published, shown as theirs: never a record offered to paste
			expect(text().split(`rua=mailto:${ADDR}`).length - 1).toBe(found ? 1 : 0);
		});
	}

	it('after Apply: written and waiting to show; reports connected, nothing left to connect; "live" only after public DNS shows the record', async () => {
		let publicDns: string | null = null;
		const { calls } = step4(base({
			'POST /api/domains/1/apply-dmarc': { ok: true, record: RECORD, created: true, reports: { state: 'connected', address: ADDR } },
			'GET /api/onboarding/dns-state?names=example.com': () => ({ states: [{ name: 'example.com', resolves: true, spf: 'found', dmarc: publicDns ? { state: 'found', policy: 'none', record: publicDns } : { state: 'missing' }, mx: true }] }),
		}));
		await userEvent.click(await screen.findByRole('button', { name: 'Apply via Cloudflare' }));
		expect(calls.find((c) => c.path === '/api/domains/1/apply-dmarc')?.body).toEqual({ record: RECORD });
		expect(await screen.findByText('Written to Cloudflare. Waiting to show in public DNS.')).toBeInTheDocument();
		expect(text()).toContain('Reports are connected: nothing is left to set up.');
		expect(screen.queryByText('Live in public DNS.')).toBeNull();

		publicDns = RECORD.toUpperCase().replace('V=DMARC1', 'v=DMARC1'); // letter case and spacing do not matter to DNS
		await userEvent.click(await screen.findByRole('button', { name: 'Check again' }));
		expect(await screen.findByText('Live in public DNS.')).toBeInTheDocument();
		expect(screen.queryByText('Written to Cloudflare. Waiting to show in public DNS.')).toBeNull();
	});

	it('where reports are not admitted the record is written without the address, and the reason is said plainly', async () => {
		step4(base({
			'GET /api/domains/1/onboarding-status': { ...onboarding(), offered_rua_address: null },
			'POST /api/domains/1/apply-dmarc': { ok: true, record: 'v=DMARC1; p=none', created: true, reports: { state: 'refused', reason: "On this server, only the operator's workspaces can connect reports." } },
			'GET /api/onboarding/dns-state?names=example.com': { states: [{ name: 'example.com', resolves: true, spf: 'found', dmarc: { state: 'missing' }, mx: true }] },
			'GET /api/domains/1/report-address': { available: true, domain_id: 1, domain: 'example.com', managed_by: null, can_connect: false, refusal: "On this server, only the operator's workspaces can connect reports.", address: null, state: 'not_connected' },
		}));
		expect(await screen.findByText("On this server, only the operator's workspaces can connect reports.")).toBeInTheDocument(); // before: the panel says why
		await userEvent.click(await screen.findByRole('button', { name: 'Apply via Cloudflare' }));
		await screen.findByText('Written to Cloudflare. Waiting to show in public DNS.');
		expect(text()).toContain("On this server, only the operator's workspaces can connect reports.");
		expect(text()).not.toContain('nothing is left to set up');
	});
});

describe('"live" is said only after a re-read of public DNS', () => {
	it('sameRecord ignores case and spaces, compares rua= as a set, and never matches an empty read', () => {
		expect(sameRecord('v=DMARC1; p=none; rua=mailto:a@x.example,mailto:b@y.example', 'V=DMARC1;p=NONE; rua=mailto:b@y.example, mailto:A@x.example')).toBe(true);
		expect(sameRecord('v=DMARC1; p=none', 'v=DMARC1; p=reject')).toBe(false);
		expect(sameRecord(null, 'v=DMARC1; p=none')).toBe(false);
		expect(sameRecord('v=DMARC1; p=none', 'v=DMARC1; p=none; rua=mailto:a@x.example')).toBe(false);
	});

	it('the last wizard screen lists each written DMARC record as waiting, then live', async () => {
		let publicDns: string | null = null;
		renderApp(<DoneStep domainIds={[1]} written={{ domains: 1, records: 1 }} dmarc={[{ domain: 'example.com', content: RECORD }]} notWritten={[]} />, {
			routes: {
				'POST /api/onboarding/first-check': { results: [] },
				'GET /api/onboarding/dns-state?names=example.com': () => ({ states: [{ name: 'example.com', resolves: true, spf: 'missing', dmarc: publicDns ? { state: 'found', record: publicDns } : { state: 'missing' }, mx: null }] }),
			},
		});
		expect(await screen.findByText('_dmarc.example.com: Written to Cloudflare. Waiting to show in public DNS.')).toBeInTheDocument();
		publicDns = RECORD;
		await userEvent.click(await screen.findByRole('button', { name: 'Check again' }));
		await waitFor(() => expect(screen.getByText('_dmarc.example.com: Live in public DNS.')).toBeInTheDocument());
	});

	it('PublicDnsLive keeps saying "waiting" while public DNS shows another record', async () => {
		renderApp(<PublicDnsLive domain="example.com" record={RECORD} />, { routes: { 'GET /api/onboarding/dns-state?names=example.com': { states: [{ name: 'example.com', resolves: true, spf: 'missing', dmarc: { state: 'found', record: 'v=DMARC1; p=none' }, mx: null }] } } });
		expect(await screen.findByText('Written to Cloudflare. Waiting to show in public DNS.')).toBeInTheDocument();
		await userEvent.click(await screen.findByRole('button', { name: 'Check again' }));
		expect(await screen.findByText('Written to Cloudflare. Waiting to show in public DNS.')).toBeInTheDocument();
	});
});
