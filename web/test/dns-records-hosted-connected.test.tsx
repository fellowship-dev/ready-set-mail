// Hosted with report intake, a connected domain whose record does not list our address yet: the DNS records row does not offer to write it
// (that would add our address through the policy route, which refuses): it points to Connect reports, the one function that writes it (ADR 0020).
import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { DnsRecords } from '../src/components/domain/DnsRecords';
import { renderApp } from './render';
import { noReach } from './reach';

const ADDR = 'rua@rua.example.net';
const domain = { id: 7, domain: 'example.com', dmarc_policy: 'reject', rua_address: ADDR, parent_id: null, created_at: 1700000000, alerts_enabled: 1, is_default: 0 };
const current = 'v=DMARC1; p=reject;';
const onboarding = {
	domain_id: 7, domain: 'example.com', rua_address: ADDR, cf_available: true,
	dmarc: { found: true, has_our_rua: false, current_record: current, effective: { policy: 'reject', inherited_from: null, issue: null, record: current } },
	spf: { record: 'v=spf1 -all', lookup_count: 1, flattening_active: false },
	dkim: { selectors: [{ name: 'g._domainkey.example.com', record: 'v=DKIM1; k=rsa; p=AAA' }], source: 'doh' },
	routing: { mx_found: true, destination_verified: true, reports_domain: null, admin_email: null },
};
const connectedView = { available: true, reach: noReach, domain_id: 7, domain: 'example.com', managed_by: null, can_connect: true, refusal: null, address: ADDR, connected_at: 1, last_report_at: null, counted_since_connect: 0, reports_since_connect: 0, reports_before_connect: 0, visibility: null, state: 'not_published', dns: null, apply_via_cloudflare: true, review: null, parent: null };
const routes = (cf: boolean) => ({
	'GET /api/domains/7/report-address': connectedView,
	'GET /api/hosted/config': { enabled: true, reports: true, records: false },
	'GET /api/domains/7/dns-check': { found: true, has_rua: false, current_record: current, cf_managed: cf },
	'GET /api/domains/7/onboarding-status': { ...onboarding, cf_available: cf },
	'GET /api/domains/7/check-summary': { domain_id: 7, domain: 'example.com', dmarc_policy: 'reject', dns_check_status: 'ok', dmarc_rua: 0 },
});

describe('DNS records row on hosted, connected, record lacks our address', () => {
	it('with Cloudflare: no Apply to Cloudflare and no record to apply, a pointer to the panel\'s Apply (there is no Connect button once connected)', async () => {
		renderApp(<DnsRecords domain={domain as never} />, { status: { mode: 'saas', configured: true, base_domain: null } as never, routes: routes(true) });
		expect(await screen.findByText(/The record does not list the report address yet\. Review the change in the DMARC reports panel on this page and press Apply\./)).toBeInTheDocument();
		expect(screen.queryByText(/Use Connect reports on this page/)).not.toBeInTheDocument();
		expect(screen.queryByRole('button', { name: /Apply to Cloudflare/ })).not.toBeInTheDocument();
		expect(screen.queryByText('Recommended record')).not.toBeInTheDocument();
	});

	it('without Cloudflare: the record to paste is still shown', async () => {
		renderApp(<DnsRecords domain={domain as never} />, { status: { mode: 'saas', configured: true, base_domain: null } as never, routes: routes(false) });
		expect(await screen.findByText('Recommended record')).toBeInTheDocument();
		expect(screen.queryByText(/Use Connect reports on this page/)).not.toBeInTheDocument();
	});

	it('not connected and the Connect reports button is on the page: the pointer shows', async () => {
		const notConnected = { ...connectedView, address: null, connected_at: null, state: 'not_connected' };
		renderApp(<DnsRecords domain={{ ...domain, rua_address: ADDR } as never} />, { status: { mode: 'saas', configured: true, base_domain: null } as never, routes: { ...routes(true), 'GET /api/domains/7/report-address': notConnected } });
		expect(await screen.findByText(/Use Connect reports on this page/)).toBeInTheDocument();
	});
});
