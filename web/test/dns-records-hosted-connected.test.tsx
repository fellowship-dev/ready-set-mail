// Hosted with report intake, a connected domain whose record does not list our address yet: the DNS records row does not offer to write it
// (that would add our address through the policy route, which refuses): it points to Connect reports, the one function that writes it (ADR 0020).
import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { DnsRecords } from '../src/components/domain/DnsRecords';
import { renderApp } from './render';

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
const routes = (cf: boolean) => ({
	'GET /api/hosted/config': { enabled: true, reports: true, records: false },
	'GET /api/domains/7/dns-check': { found: true, has_rua: false, current_record: current, cf_managed: cf },
	'GET /api/domains/7/onboarding-status': { ...onboarding, cf_available: cf },
	'GET /api/domains/7/check-summary': { domain_id: 7, domain: 'example.com', dmarc_policy: 'reject', dns_check_status: 'ok', dmarc_rua: 0 },
});

describe('DNS records row on hosted, connected, record lacks our address', () => {
	it('with Cloudflare: no Apply to Cloudflare and no record to apply, a pointer to Connect reports', async () => {
		renderApp(<DnsRecords domain={domain as never} />, { status: { mode: 'saas', configured: true, base_domain: null } as never, routes: routes(true) });
		expect(await screen.findByText(/Use Connect reports on this page: it shows the record as it is now and what it becomes, and writes it\./)).toBeInTheDocument();
		expect(screen.queryByRole('button', { name: /Apply to Cloudflare/ })).not.toBeInTheDocument();
		expect(screen.queryByText('Recommended record')).not.toBeInTheDocument();
	});

	it('without Cloudflare: the record to paste is still shown', async () => {
		renderApp(<DnsRecords domain={domain as never} />, { status: { mode: 'saas', configured: true, base_domain: null } as never, routes: routes(false) });
		expect(await screen.findByText('Recommended record')).toBeInTheDocument();
		expect(screen.queryByText(/Use Connect reports on this page/)).not.toBeInTheDocument();
	});
});
