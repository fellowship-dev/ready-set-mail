// A domain whose proof lapsed says so FIRST, on the overview and on its own page, with the way back ("Prove again") on the same row.
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router';
import { describe, expect, it } from 'vitest';
import { DomainDetailPage } from '../src/pages/domains/DomainDetailPage';
import { OverviewPage } from '../src/pages/domains/OverviewPage';
import { fail, renderApp } from './render';

const now = Math.floor(Date.now() / 1000);
const TITLE = 'Proof lost: prove it is still yours';
const LOST = { id: 1, domain: 'sold.com', dmarc_policy: null, rua_address: '', parent_id: null, created_at: 1700000000, alerts_enabled: 1, is_default: 0, verified_via: 'legacy', proof_lost_at: now - 3600 };
const OK = { id: 2, domain: 'fine.org', dmarc_policy: 'none', rua_address: 'rua@x.io', parent_id: null, created_at: 1700000000, alerts_enabled: 1, is_default: 0, verified_via: 'cloudflare', proof_lost_at: null };
const SUM = (id: number, name: string) => ({
	domain_id: id, domain: name, dmarc_policy: 'none', spf_record: 'v=spf1 -all', dns_checked_at: now - 60, dns_check_attempted_at: now - 60, dns_check_status: 'ok', dmarc_issue: null, dmarc_inherited_from: null, dns_last_good_status: 'ok',
	total_messages: 0, pass_messages: 0, fail_messages: 0, dkim_total: 0, dkim_pass: 0, spf_total: 0, spf_pass: 0, mta_sts_enabled: 0, mta_sts_mode: null, spf_lookup_count: 2, dmarc_pct: 100, dmarc_p: 'none', dmarc_sp: null, dmarc_rua: 1, report_connect: null,
});
/** A summary that would read "Verified" for a proven domain: p=reject on all mail, SPF in limits, a current check. */
const REJECT = (id: number, name: string) => ({ ...SUM(id, name), dmarc_policy: 'reject', dmarc_p: 'reject', spf_record: 'v=spf1 include:_spf.google.com -all', dmarc_rua: 1 });
const CLAIM = { id: 9, domain: 'sold.com', status: 'pending', txt_name: '_readysetmail.sold.com', txt_value: 'readysetmail-verify=abc', created_at: now, last_checked_at: null, last_error: null };
const text = () => (document.body.textContent ?? '').replace(/\s+/g, ' ');

const overview = (routes: Record<string, unknown>, role?: 'owner' | 'member') =>
	renderApp(<OverviewPage />, {
		...(role ? { role } : {}),
		routes: {
			'GET /api/domains/summaries': { summaries: [SUM(1, 'sold.com'), SUM(2, 'fine.org')], next_after: null, window_days: 30 },
			'GET /api/cloudflare/connections': { connections: [], encryption_configured: true, oauth: { available: false }, token_paste: true },
			'GET /api/domains/1/dns-host': { provider: null },
			...routes,
		} as never,
	});

describe('overview', () => {
	it(`says "${TITLE}" first, above everything else, with a Prove again that re-proves the same domain`, async () => {
		const { calls } = overview({ 'GET /api/domains': { domains: [LOST, OK] }, 'POST /api/domains/1/prove': { domain: LOST, restored: true, resumed: true } });
		expect(await screen.findByText(TITLE)).toBeInTheDocument();
		const alert = screen.getByTestId('proof-lost-1');
		// first in the page: nothing but the title block, the answer and the notices come before it
		const heading = screen.getByRole('heading', { name: 'Domains' });
		expect(heading.compareDocumentPosition(alert) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
		const list = await screen.findByRole('heading', { name: 'Your domains', hidden: true });
		expect(alert.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
		expect(alert.textContent).toContain('sold.com');
		expect(alert.textContent).toContain('Your report history stays');
		expect(alert.textContent).not.toMatch(/remove it|add it again/i); // no advice to remove first
		expect(screen.queryByTestId('proof-lost-2')).toBeNull(); // a proven domain says nothing
		// the workspace answer and the first-day card do not claim every domain is proven
		expect(screen.getByTestId('am-i-done').textContent).toMatch(/waiting for proof/);
		expect(text()).not.toContain('Ownership is proven for every domain you added');
		// step 2 does not promise a record that is not shown: it says to prove again
		expect(screen.getByTestId('first-day')).toHaveTextContent(/Prove sold\.com is still yours.*Its proof lapsed/);
		expect(text()).not.toContain('waiting for the DNS record shown below');
		await userEvent.click(screen.getByRole('button', { name: 'Prove again' }));
		await waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.path === '/api/domains/1/prove')).toBe(true));
	});

	it('when the zone cannot prove it, the TXT record to publish takes the place of the button, on the same domain', async () => {
		let claims: unknown[] = [];
		const { calls } = overview({
			'GET /api/domains': () => ({ domains: [LOST, OK], pending_claims: claims }),
			'POST /api/domains/1/prove': () => { claims = [CLAIM]; return { __status: 202, body: { pending: true, claim: CLAIM, domain: null } }; },
		});
		await userEvent.click(await screen.findByRole('button', { name: 'Prove again' }));
		await waitFor(() => expect(text()).toContain('_readysetmail.sold.com'));
		expect(text()).toContain(TITLE);
		expect(screen.queryByText('Waiting for verification', { selector: 'h2' })).toBeNull(); // not listed twice
		expect(calls.filter((c) => c.path === '/api/domains/1/prove')).toHaveLength(1);
	});

	it('when a rival kept the name, the refusal says so', async () => {
		overview({
			'GET /api/domains': { domains: [LOST, OK] },
			'POST /api/domains/1/prove': fail(409, 'sold.com now belongs to another workspace that proved it controls it, and it keeps it. Your report history for sold.com stays here, read-only and available to export, until 2026-12-15, then it is deleted.'),
		});
		await userEvent.click(await screen.findByRole('button', { name: 'Prove again' }));
		await waitFor(() => expect(within(screen.getByTestId('proof-lost-1')).getAllByRole('alert').map((a) => a.textContent).join(' ')).toMatch(/keeps it/));
	});

	it('a read-only member sees the state but cannot act', async () => {
		overview({ 'GET /api/domains': { domains: [LOST, OK] } }, 'member');
		expect(await screen.findByText(TITLE)).toBeInTheDocument();
		expect(screen.getByRole('button', { name: 'Prove again' })).toBeDisabled();
	});

	it('a read-only member is told why, and the row says an owner or admin proves it, not "you"', async () => {
		overview({
			'GET /api/domains/summaries': { summaries: [REJECT(1, 'sold.com'), REJECT(2, 'fine.org')], next_after: null, window_days: 30 },
			'GET /api/domains': { domains: [LOST, OK] },
		}, 'member');
		await screen.findByText(TITLE);
		const button = screen.getByRole('button', { name: 'Prove again' });
		expect(button).toBeDisabled();
		expect(button).toHaveAccessibleDescription('Your role is member, which is read-only. Ask an owner or admin to make this change.');
		const alert = screen.getByTestId('proof-lost-1');
		expect(alert.textContent).toContain('Your role is member, which is read-only. Ask an owner or admin to make this change.'); // in words, not only in a tooltip
		const sold = (await screen.findAllByRole('listitem')).find((r) => r.getAttribute('data-status') !== null && r.textContent?.includes('sold.com'))!;
		expect(sold.textContent).toContain('Next, an owner or admin:');
		expect(sold.textContent).not.toContain('Next, you:');
	});

	it('an owner is still told "you"', async () => {
		overview({
			'GET /api/domains/summaries': { summaries: [REJECT(1, 'sold.com')], next_after: null, window_days: 30 },
			'GET /api/domains': { domains: [LOST] },
		}, 'owner');
		await screen.findByText(TITLE);
		const sold = (await screen.findAllByRole('listitem')).find((r) => r.getAttribute('data-status') !== null && r.textContent?.includes('sold.com'))!;
		expect(sold.textContent).toContain('Next, you:');
	});
});

describe('the domain card follows the ownership source: a lost proof is never Verified, never "nothing to do"', () => {
	it('overview: the card of a domain whose proof lapsed says so, with the way back, while a proven twin stays Verified', async () => {
		overview({
			'GET /api/domains/summaries': { summaries: [REJECT(1, 'sold.com'), REJECT(2, 'fine.org')], next_after: null, window_days: 30 },
			'GET /api/domains': { domains: [LOST, OK] },
		});
		await screen.findByText(TITLE);
		const rows = await screen.findAllByRole('listitem');
		const sold = rows.find((r) => r.getAttribute('data-status') !== null && r.textContent?.includes('sold.com'))!;
		const fine = rows.find((r) => r.getAttribute('data-status') !== null && r.textContent?.includes('fine.org'))!;
		await waitFor(() => expect(fine).toHaveAttribute('data-status', 'verified'));
		expect(sold).toHaveAttribute('data-status', 'attention');
		expect(sold.textContent).not.toMatch(/Verified|nothing to do/i);
		expect(sold.textContent).toMatch(/Ownership of sold\.com is no longer proven, so reports for it are not accepted until you prove it again\./);
		expect(within(sold).getByRole('link', { name: 'Prove it is still yours for sold.com' })).toHaveAttribute('href', '/domains/1');
		expect(fine.textContent).toMatch(/Nothing to do|nothing to do/);
	});

	it('a domain that was never proven says that, not that a proof lapsed', async () => {
		overview({
			'GET /api/domains/summaries': { summaries: [REJECT(1, 'sold.com')], next_after: null, window_days: 30 },
			'GET /api/domains': { domains: [{ ...LOST, proof_lost_at: null }] },
		});
		await screen.findByText(/Ownership of sold\.com has not been proven in this workspace/);
		const sold = screen.getAllByRole('listitem').find((r) => r.textContent?.includes('sold.com') && r.getAttribute('data-status'))!;
		expect(sold.textContent).toMatch(/Ownership of sold\.com has not been proven in this workspace/);
		expect(sold.textContent).not.toMatch(/Verified/);
	});
});

describe('domain page', () => {
	it(`says "${TITLE}" at the top with Prove again`, async () => {
		const { calls } = renderApp(
			<Routes><Route path="/domains/:id" element={<DomainDetailPage />} /></Routes>,
			{
				route: '/domains/1',
				routes: {
					'GET /api/domains': { domains: [LOST] },
					'GET /api/domains/summaries': { summaries: [SUM(1, 'sold.com')], next_after: null, window_days: 30 },
					'GET /api/domains/1/check-summary': REJECT(1, 'sold.com'),
					'GET /api/domains/1/stats': { domain: 'sold.com', days: 7, stats: [] },
					'GET /api/domains/1/sources': { sources: [] },
					'GET /api/domains/1/wizard-state': { domain: 'complete', spf: 'complete', dkim: 'complete', dmarc: 'complete', routing: 'complete' },
					'GET /api/domains/1/dns-check': { found: false, has_rua: false, current_record: null, cf_managed: false },
					'GET /api/domains/1/onboarding-status': { domain_id: 1, domain: 'sold.com', rua_address: '', cf_available: false, dmarc: { found: false, has_our_rua: false, current_record: null }, spf: { record: null, lookup_count: null, flattening_active: false }, dkim: { selectors: [], source: 'doh' }, routing: { mx_found: false, destination_verified: false, reports_domain: null, admin_email: null } },
					'GET /api/domains/1/rollout-next': { current_policy: null, current_pct: 100, current_testing: false, current_record: null, current_step_index: 0, total_steps: 5, next_step: null, blocked: false, block_reason: null, behind_schedule: false, dns_preview: null },
					'GET /api/domains/1/spf-flatten': { available: false, config: null, lookup_count: null },
					'GET /api/domains/1/mta-sts': { available: false, config: null, summary: null },
					'GET /api/hosted/config': { enabled: false },
					'GET /api/hosted/statuses': { statuses: {} },
					'GET /api/domains/1/hosted': { enabled: false },
					'GET /api/domains/1/report-address': { available: false },
					'GET /api/cloudflare/connections': { connections: [], encryption_configured: true, oauth: { available: false }, token_paste: true },
					'POST /api/domains/1/prove': { domain: LOST, restored: true, resumed: true },
				} as never,
			},
		);
		expect(await screen.findByText(TITLE)).toBeInTheDocument();
		const alert = screen.getByTestId('proof-lost-1');
		const title = screen.getByRole('heading', { name: 'sold.com' });
		expect(title.compareDocumentPosition(alert) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
		// its facts would read "Verified" if it were proven: unproven, it is not, and nothing says there is nothing to do
		await waitFor(() => expect(text()).toMatch(/Ownership of sold\.com is no longer proven/));
		expect(text()).not.toMatch(/Verified|nothing to do/i);
		await userEvent.click(screen.getByRole('button', { name: 'Prove again' }));
		await waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.path === '/api/domains/1/prove')).toBe(true));
	});
});
