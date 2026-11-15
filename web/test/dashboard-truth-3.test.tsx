// Round three: a DMARC record receivers do not apply as written (an invalid sp=, an invalid p=) is told ONE way on every
// surface (overview row, "Where it stands", "Do this next", the header badge, Rollout, the DNS records row, the DMARC
// wizard, the PDF), self-host and hosted, from the one sentence in packages/dns-checks/src/dmarc-problem.ts.
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router';
import { describe, expect, it } from 'vitest';
import { assessDomain } from '../src/lib/levels';
import { dmarcPolicyLabel } from '../src/lib/pdf/report';
import { getRecommendations } from '../src/lib/pdf/recommendations';
import { dmarcStepsFor, domainVerdict, totalsFromSummary } from '../src/lib/verdict';
import { DomainDetailPage } from '../src/pages/domains/DomainDetailPage';
import { DmarcWizardPage } from '../src/pages/wizards/DmarcWizardPage';
import { renderApp } from './render';

const now = Math.floor(Date.now() / 1000);
const RUA = 'r@reports.test';
const HOSTED = { mode: 'saas', signup_open: true, configured: true, base_domain: null };
const AT = '_dmarc.example.com';

// Each record with what the daily refresh stores for it (src/email/dns-snapshot.ts; test/email/dns-snapshot-broken.test.ts
// checks the same rows from the real lookup) and the one sentence every surface must say.
const CASES = [
	{
		name: 'p=reject; sp=bogus with a valid rua=',
		record: `v=DMARC1; p=reject; sp=bogus; rua=mailto:${RUA}`,
		stored: { dmarc_policy: null, dmarc_issue: 'invalid_sp', dmarc_p: 'none', dmarc_sp: 'bogus', dmarc_pct: 100, dmarc_rua: 1 },
		sentence: `At ${AT}, sp=bogus is not a valid policy, so receivers treat the whole record as p=none. Fix sp= or remove it.`,
		step: `Fix sp= at ${AT}`,
		badge: 'DMARC record has an invalid sp=',
		pdf: 'Invalid sp=',
	},
	{
		name: 'p=reject; sp=bogus without rua=',
		record: 'v=DMARC1; p=reject; sp=bogus',
		stored: { dmarc_policy: null, dmarc_issue: 'invalid_sp', dmarc_p: null, dmarc_sp: 'bogus', dmarc_pct: 100, dmarc_rua: 0 },
		sentence: `At ${AT}, sp=bogus is not a valid policy and the record has no valid rua=, so receivers ignore the whole record. Fix sp= or remove it.`,
		step: `Fix sp= at ${AT}`,
		badge: 'DMARC record has an invalid sp=',
		pdf: 'Invalid sp=',
	},
	{
		name: 'p=rejected with a valid rua=',
		record: `v=DMARC1; p=rejected; rua=mailto:${RUA}`,
		stored: { dmarc_policy: null, dmarc_issue: 'invalid', dmarc_p: 'none', dmarc_sp: null, dmarc_pct: 100, dmarc_rua: 1 },
		sentence: `At ${AT}, the DMARC record has no valid p= policy (none, quarantine or reject), so receivers treat the whole record as p=none. Set p= to none, quarantine or reject.`,
		step: `Fix the DMARC record at ${AT} so it has a valid p= policy`,
		badge: 'DMARC record is invalid',
		pdf: 'Invalid record',
	},
] as const;

const SUM = (o: Record<string, unknown> = {}) =>
	({
		domain_id: 1, domain: 'example.com', dmarc_policy: 'none', spf_record: 'v=spf1 -all', dns_checked_at: now - 60, dns_check_attempted_at: now - 60, dns_check_status: 'ok', dmarc_issue: null, dmarc_inherited_from: null, dns_last_good_status: 'ok',
		total_messages: 0, pass_messages: 0, fail_messages: 0, dkim_total: 0, dkim_pass: 0, spf_total: 0, spf_pass: 0, mta_sts_enabled: 1, mta_sts_mode: 'enforce', spf_lookup_count: 2, dmarc_pct: 100, dmarc_p: 'none', dmarc_sp: null, dmarc_rua: 1, report_connect: null, ...o,
	}) as never;
const OPERATOR = { can_connect: false, refusal: "On this server, only the operator's workspaces can connect reports.", refusal_kind: 'operator_only' };
const MODES = [
	{ mode: 'self-host', rua: RUA, connect: null, status: undefined },
	{ mode: 'hosted customer', rua: '', connect: OPERATOR, status: HOSTED },
] as const;
const text = () => (document.body.textContent ?? '').replace(/\s+/g, ' ');
const dom = (rua: string) => ({ id: 1, domain: 'example.com', dmarc_policy: null, rua_address: rua, parent_id: null, created_at: 1700000000, alerts_enabled: 1, is_default: 0 });
const ONB = (record: string, rua: string) => ({
	domain_id: 1, domain: 'example.com', rua_address: rua, cf_available: true, dmarc: { found: true, has_our_rua: record.includes(RUA), current_record: record },
	spf: { record: 'v=spf1 -all', lookup_count: 2, flattening_active: false }, dkim: { selectors: [{ name: 'g._domainkey.example.com', record: 'v=DKIM1; k=rsa; p=AAA' }], source: 'doh' },
	routing: { mx_found: true, destination_verified: true, reports_domain: null, admin_email: null },
});
const routes = (c: (typeof CASES)[number], m: (typeof MODES)[number]) => {
	const s = SUM({ ...c.stored, report_connect: m.connect });
	return {
		'GET /api/domains': { domains: [dom(m.rua)] },
		'GET /api/domains/summaries': { summaries: [s], next_after: null, window_days: 30 },
		'GET /api/domains/1/check-summary': s,
		'GET /api/domains/1/stats': { domain: 'example.com', days: 7, stats: [] },
		'GET /api/domains/1/sources': { sources: [] },
		'GET /api/domains/1/wizard-state': { domain: 'complete', spf: 'complete', dkim: 'complete', dmarc: 'complete', routing: 'complete' },
		'GET /api/domains/1/dns-check': { found: true, has_rua: c.record.includes(RUA), current_record: c.record, cf_managed: true },
		'GET /api/domains/1/onboarding-status': ONB(c.record, m.rua),
		// The rollout reads the live record's p=reject: the page must not call it enforcing or "Fully graduated".
		'GET /api/domains/1/rollout-next': { current_policy: 'reject', current_pct: 100, current_testing: false, current_record: c.record, current_step_index: 4, total_steps: 5, next_step: null, blocked: false, block_reason: null, behind_schedule: false, dns_preview: null },
		'GET /api/domains/1/spf-flatten': { available: false, config: null, lookup_count: null },
		'GET /api/domains/1/mta-sts': { available: false, config: null, summary: null },
		'GET /api/hosted/config': { enabled: true, reports: true, records: false },
		'GET /api/hosted/statuses': { statuses: {} },
		'GET /api/domains/1/hosted': { enabled: false },
		'GET /api/domains/1/report-address': { available: true, domain_id: 1, domain: 'example.com', managed_by: null, can_connect: false, refusal: OPERATOR.refusal, address: null, connected_at: null, last_report_at: null, counted_since_connect: 0, reports_since_connect: 0, reports_before_connect: 0, visibility: null, state: 'not_connected', dns: null, parent: null },
	};
};
const NEVER = ['p=reject.', 'Fully graduated', 'Fully enforced', 'Nothing more to do here', 'Wait for DMARC reports before moving', 'has no valid p= policy, so receivers ignore it', 'Published, read from public DNS'];

describe('a record receivers do not apply as written reads the same on every surface', () => {
	for (const c of CASES) {
		for (const m of MODES) {
			const d = { id: 1, domain: 'example.com', rua_address: m.rua };
			const s = SUM({ ...c.stored, report_connect: m.connect });
			const hostedMode = m.mode !== 'self-host';
			const refusal = m.connect ? { kind: 'operator_only' as const, reason: OPERATOR.refusal } : null;
			it(`${c.name}, ${m.mode}: overview row, "Where it stands", "Do this next", levels and PDF`, () => {
				const v = domainVerdict(d, s, totalsFromSummary(s), undefined, undefined, { hostedMode, reportsRefusal: refusal });
				expect(v.sentence).toBe(c.sentence);
				const steps = dmarcStepsFor(d, s, totalsFromSummary(s), null, null, null, refusal);
				expect(steps[0]?.do).toBe(c.step);
				expect(steps[0]?.why).toBe(c.sentence);
				const finding = assessDomain({ ...(s as object), domain: 'example.com' } as never).findings.find((f) => f.label === c.badge);
				expect(finding?.detail).toBe(c.sentence);
				expect(dmarcPolicyLabel(s).label).toBe(c.pdf);
				const recs = JSON.stringify(getRecommendations(s, { domain: d, hosted: null, hostedMode, reportsRefusal: refusal }));
				expect(recs).toContain(c.sentence);
				for (const n of NEVER) expect(recs).not.toContain(n);
			});
			it(`${c.name}, ${m.mode}: the domain page (header badge, Rollout, DNS records row)`, { timeout: 20000 }, async () => {
				renderApp(
					<Routes>
						<Route path="/domains/:id" element={<DomainDetailPage />} />
					</Routes>,
					{ route: '/domains/1', routes: routes(c, m) as never, ...(m.status ? { status: m.status as never } : {}) },
				);
				await waitFor(() => expect(text()).toContain(c.badge), { timeout: 8000 });
				await waitFor(() => expect(text()).toContain(c.sentence), { timeout: 8000 });
				await userEvent.click(await screen.findByRole('button', { name: /^DNS records/ }));
				await waitFor(() => expect(text()).toContain(`DMARC record: Fail${c.sentence}`), { timeout: 8000 });
				expect(screen.queryByText('Rollout')).toBeNull();
				for (const n of NEVER) expect(text()).not.toContain(n);
			});
			it(`${c.name}, ${m.mode}: the DMARC wizard says what to fix and offers nothing`, { timeout: 20000 }, async () => {
				renderApp(
					<Routes>
						<Route path="/domains/:id/dmarc-wizard" element={<DmarcWizardPage />} />
					</Routes>,
					{ route: '/domains/1/dmarc-wizard', routes: routes(c, m) as never, ...(m.status ? { status: m.status as never } : {}) },
				);
				expect(await screen.findByText('Fix the DMARC record first', {}, { timeout: 8000 })).toBeInTheDocument();
				expect(text()).toContain(c.sentence);
				expect(screen.queryByText('New record')).toBeNull();
				expect(screen.queryByRole('button', { name: /Apply via Cloudflare/ })).toBeNull();
				for (const n of NEVER) expect(text()).not.toContain(n);
			});
		}
	}
});
