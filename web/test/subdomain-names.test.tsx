import { screen, within } from '@testing-library/react';
import { Route, Routes } from 'react-router';
import { describe, expect, it } from 'vitest';
import { DomainDetailPage } from '../src/pages/domains/DomainDetailPage';
import { AnomaliesPage } from '../src/pages/reports/AnomaliesPage';
import { ReportDetailPage } from '../src/pages/reports/ReportDetailPage';
import { policyWords } from '../src/components/domain/SubdomainNames';
import type { NameSeen } from '../src/lib/types';
import { renderApp } from './render';

const name = (over: Partial<NameSeen> = {}): NameSeen => ({
	name: 'app.example.com', roles: ['from'], messages: 40, passed: 40, failed: 0, failed_service: 0, failed_not_yours: 0, fix: null, look: null,
	effective: { status: 'applies', policy: 'reject', tag: 'p', at: 'app.example.com', source: 'own', exists: true, pct: 100 },
	source: 'app.example.com publishes its own DMARC record, which sets p=reject.', ...over,
});

describe('policyWords: the policy that applies to a name and where it comes from', () => {
	it('says own record, or the tag and the record of the organizational domain', () => {
		expect(policyWords(name())).toBe('reject (its own record)');
		expect(policyWords(name({ effective: { status: 'applies', policy: 'none', tag: 'sp', at: 'example.com', source: 'organizational', exists: true, pct: 100 } }))).toBe('none (sp= on example.com)');
		expect(policyWords(name({ effective: { status: 'none', policy: null, tag: null, at: null, source: null, exists: null, pct: null } }))).toBe('No DMARC record');
		expect(policyWords(name({ roles: ['return-path'], effective: null }))).toBe('Return-path only');
		expect(policyWords(name({ effective: null }))).toBe('Not read');
	});
});

const domain = { id: 1, domain: 'example.com', dmarc_policy: 'reject', rua_address: 'rua@rua.example.net', parent_id: null, created_at: 1, alerts_enabled: 1, is_default: 1, verified_via: 'txt' };

describe('the domain page lists the names seen sending as the domain, inside it', () => {
	it('shows each subdomain with its mail, the policy that applies and the one thing to fix', async () => {
		renderApp(
			<Routes>
				<Route path="/domains/:id" element={<DomainDetailPage />} />
			</Routes>,
			{
				route: '/domains/1',
				routes: {
					'GET /api/domains': { domains: [domain] },
					'GET /api/domains/1/names': {
						days: 30, domain: 'example.com',
						names: [
							name(),
							name({ name: 'rua.example.com', messages: 2, passed: 0, failed: 2, effective: { status: 'applies', policy: 'reject', tag: 'p', at: 'example.com', source: 'organizational', exists: true, pct: 100 }, source: 'rua.example.com has no DMARC record of its own, so p=reject on example.com\'s record applies to it.', fix: '2 messages sent as rua.example.com failed DMARC because neither SPF nor DKIM aligned with it: open the failing senders for the identifier that did not align and the fix.' }),
						],
					},
				},
			},
		);
		const disclosure = await screen.findByText(/2 subdomains in the reports of the last 30 days, 1 name to fix/);
		expect(disclosure).toBeInTheDocument();
		expect(screen.getAllByText(/part of example\.com/).length).toBeGreaterThan(0);
		const rua = screen.getByText('rua.example.com').closest('tr')!;
		expect(within(rua).getByText('reject (organizational)'.replace('organizational', 'p= on example.com'))).toBeInTheDocument();
		expect(within(rua).getByText(/2 messages sent as rua\.example\.com failed DMARC/)).toBeInTheDocument();
		const app = screen.getByText('app.example.com').closest('tr')!;
		expect(within(app).getByText('reject (its own record)')).toBeInTheDocument();
		expect(within(app).getByText('Nothing to fix')).toBeInTheDocument();
	});
});

describe('the failing-source row says which identifier did not align', () => {
	it('lists a source whose SPF and DKIM passed but whose mail failed DMARC, with why', async () => {
		renderApp(
			<Routes>
				<Route path="/domains/:id/anomalies" element={<AnomaliesPage />} />
			</Routes>,
			{
				route: '/domains/1/anomalies',
				routes: {
					'GET /api/domains': { domains: [domain] },
					'GET /api/domains/1/anomalies': {
						days: 30, domain: 'example.com',
						anomalies: [{
							source_ip: '203.0.113.1', header_from: 'example.com', spf_domain: 'bounces.esp.example', dkim_domain: 'esp.example', total: 9, spf_pass: 1, dkim_pass: 1,
							spf_aligned: 0, dkim_aligned: 0, verdict: 'failed', dmarc_fail: 1, aspf: 'r', adkim: 'r', first_seen: '2026-01-01', last_seen: new Date().toISOString().slice(0, 10), base_domain: null, org: null,
						}],
					},
				},
			},
		);
		expect(await screen.findByText('Alignment fail')).toBeInTheDocument();
		expect(screen.getByText(/Sources whose mail failed DMARC: neither SPF nor DKIM passed and aligned with the From domain\./)).toBeInTheDocument();
		expect(screen.queryByText('Sources that failed SPF or DKIM.')).toBeNull();
		expect(screen.getByText(/SPF passed for the return-path \(MAIL FROM\) domain bounces\.esp\.example, which is not in the same organization as example\.com/)).toBeInTheDocument();
	});
});

describe('the report page states the true source of a subdomain\'s policy', () => {
	it('uses the policy the server read for the name: its own record, not "inherits"', async () => {
		renderApp(
			<Routes>
				<Route path="/domains/:id/reports/:date" element={<ReportDetailPage />} />
			</Routes>,
			{
				route: '/domains/1/reports/2026-10-01',
				routes: {
					'GET /api/domains': { domains: [domain] },
					'GET /api/domains/1/dns-check': { found: true, has_rua: true, current_record: 'v=DMARC1; p=reject', cf_managed: false },
					'GET /api/domains/1/check-summary': { domain_id: 1, total_messages: 5 },
					'GET /api/domains/1/names': { days: 30, domain: 'example.com', names: [name()] },
					'GET /api/domains/1/reports': {
						date: '2026-10-01', domain: 'example.com', summary: { total: 5, passed: 0, failed: 5 },
						sources: [{ source_ip: '9.9.9.9', header_from: 'app.example.com', spf_domain: null, dkim_domain: null, count: 5, spf_pass: 0, dkim_pass: 0, verdict: 'failed', disposition: 'none', reporters: 'google.com', base_domain: null, org: null }],
					},
				},
			},
		);
		const text = await screen.findByText(/app\.example\.com publishes its own DMARC record, which sets p=reject/);
		expect(text).toBeInTheDocument();
		expect(within(text.closest('p')!).queryByText(/inherits/)).toBeNull();
		expect(text.textContent).not.toMatch(/inherits/);
	});
});
