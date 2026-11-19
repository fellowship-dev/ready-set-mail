// PR 181 round 3, BLOCKER 2 on the domain page: the next step ("Do this next"), the note and the names panel say the same thing about whose failures
// they are (packages/dns-checks classifySource, fed by the server as failed_not_yours / failed_service and the names' failed_service / failed_not_yours).
import { screen } from '@testing-library/react';
import { Route, Routes } from 'react-router';
import { describe, expect, it } from 'vitest';
import { namesSummary } from '../src/components/domain/SubdomainNames';
import { DomainDetailPage } from '../src/pages/domains/DomainDetailPage';
import type { NameSeen } from '../src/lib/types';
import { renderApp } from './render';

const now = Math.floor(Date.now() / 1000);
const domain = { id: 1, domain: 'example.com', dmarc_policy: 'reject', rua_address: 'rua@reports.example.net', parent_id: null, created_at: 1700000000, alerts_enabled: 1, is_default: 1, verified_via: 'txt' };
const summary = (over: Record<string, unknown>) => ({
	domain_id: 1, domain: 'example.com', dmarc_policy: 'reject', spf_record: 'v=spf1 -all', dns_checked_at: now - 60, dns_check_attempted_at: now - 60, dns_check_status: 'ok', dmarc_issue: null, dmarc_inherited_from: null, dns_last_good_status: 'ok',
	total_messages: 100, pass_messages: 92, fail_messages: 8, dkim_total: 100, dkim_pass: 92, spf_total: 100, spf_pass: 92, mta_sts_enabled: 0, mta_sts_mode: null, spf_lookup_count: 2, dmarc_pct: 100, dmarc_p: 'reject', dmarc_sp: null, dmarc_rua: 1,
	failed_not_yours: 0, failed_service: 0, failed_unrecorded: 0, ...over,
}) as never;
const SERVICE = 'A service sending as rua.example.com that is not set up for it: if it is yours, set up its custom return-path and DKIM for rua.example.com; if not, nothing to do (2 messages).';
const nameRow = (over: Partial<NameSeen>): NameSeen => ({
	name: 'rua.example.com', roles: ['from'], messages: 8, passed: 0, failed: 8, failed_service: 0, failed_not_yours: 0,
	effective: { status: 'applies', policy: 'reject', tag: 'p', at: 'example.com', source: 'organizational', exists: true, pct: 100 }, source: 'rua.example.com has no DMARC record of its own, so p=reject on example.com\'s record applies to it.', fix: null, look: null, ...over,
});
const page = (sum: unknown, names: NameSeen[]) => renderApp(<Routes><Route path="/domains/:id" element={<DomainDetailPage />} /></Routes>, {
	route: '/domains/1',
	routes: {
		'GET /api/domains': { domains: [domain] }, 'GET /api/domains/1/check-summary': sum, 'GET /api/domains/1/names': { days: 30, domain: 'example.com', names },
		'GET /api/domains/1/stats': { domain: 'example.com', days: 7, stats: [] },
		'GET /api/domains/1/sources': { sources: [], one_check: { sources: 0, messages: 0 }, not_recorded: { sources: 0, messages: 0 } },
		'GET /api/domains/1/dns-check': { found: true, has_rua: true, current_record: 'v=DMARC1; p=reject; rua=mailto:rua@reports.example.net', cf_managed: false },
		'GET /api/domains/1/wizard-state': { domain: 'complete', spf: 'complete', dkim: 'complete', dmarc: 'complete', routing: 'complete' },
	},
});
const text = () => (document.body.textContent ?? '').replace(/\s+/g, ' ');

describe('namesSummary: only the owner\'s names are "to fix"', () => {
	it('counts fix and look apart, and says nothing when neither', () => {
		const spoof = nameRow({ name: 'a.example.com', failed_not_yours: 8 });
		const svc = nameRow({ failed_service: 2, look: SERVICE });
		const own = nameRow({ name: 'b.example.com', fix: '3 messages sent as b.example.com failed DMARC because neither SPF nor DKIM aligned with it: open the failing senders for the identifier that did not align and the fix.' });
		expect(namesSummary([spoof], 'example.com')).toBe('1 subdomain in the reports of the last 30 days. They are part of example.com.');
		expect(namesSummary([spoof, svc], 'example.com')).toBe('2 subdomains in the reports of the last 30 days, 1 to look at. They are part of example.com.');
		expect(namesSummary([spoof, svc, own], 'example.com')).toBe('3 subdomains in the reports of the last 30 days, 1 name to fix, 1 to look at. They are part of example.com.');
	});
});

describe('the domain page, case 1: only spoofers', () => {
	it('"Nothing to fix" in the note and the names panel, no name to fix or to look at', async () => {
		page(summary({ failed_not_yours: 8 }), [nameRow({ failed_not_yours: 8 })]);
		expect(await screen.findByText(/1 subdomain in the reports of the last 30 days\. They are part of example\.com\./)).toBeInTheDocument();
		expect(text()).toContain('Nothing to fix');
		expect(text()).not.toMatch(/to look at|names? to fix|Check the service sending/);
	});
});

describe('the domain page, case 2: one unaligned real service', () => {
	it('one thing to look at in the next step and the names panel; no "Nothing to fix", no "to fix"', async () => {
		page(summary({ failed_service: 8, failed_service_names: ['rua.example.com'] }), [nameRow({ failed_service: 8, look: SERVICE.replace('(2 messages)', '(8 messages)') })]);
		expect(await screen.findByText(/1 subdomain in the reports of the last 30 days, 1 to look at\./)).toBeInTheDocument();
		expect(text()).toContain('Check the service sending as rua.example.com that is not set up for it');
		expect(text()).toContain('a service sending as rua.example.com that is not set up for it: if it is yours, set up its custom return-path and DKIM for rua.example.com; if not, nothing to do');
		expect(text()).not.toMatch(/Nothing to fix|Nothing to do|names? to fix|likely mail pretending/);
	});
});

describe('the domain page, case 3: a spoofer and a service', () => {
	it('the owner\'s page: one thing to look at everywhere, never "Nothing to fix" beside "N names to fix"', async () => {
		page(summary({ failed_not_yours: 6, failed_service: 2, failed_service_names: ['rua.example.com'] }), [nameRow({ failed: 8, failed_not_yours: 6, failed_service: 2, look: SERVICE })]);
		expect(await screen.findByText(/1 subdomain in the reports of the last 30 days, 1 to look at\./)).toBeInTheDocument();
		expect(text()).toContain('Check the service sending as rua.example.com that is not set up for it');
		expect(text()).toContain('Of the 8 messages that failed, 6 came from servers that are not a known sending service');
		expect(text()).not.toMatch(/Nothing to fix|Nothing to do|names? to fix/);
	});
});
