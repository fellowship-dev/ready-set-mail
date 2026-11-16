import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';

beforeEach(() => localStorage.clear());
import { OverviewPage } from '../src/pages/domains/OverviewPage';
import { fail, renderApp, type Handler } from './render';

const hoursAgo = (h: number) => Math.floor(Date.now() / 1000) - h * 3600;
const domain = (id: number, name: string, extra = {}) => ({ id, domain: name, dmarc_policy: 'reject', rua_address: 'r@x.io', parent_id: null, created_at: 1700000000, alerts_enabled: 1, is_default: 0, ...extra });
const checked = { dns_checked_at: hoursAgo(3), dns_check_attempted_at: hoursAgo(3), dns_check_status: 'ok' };
/** A stored summary as a DNS read leaves it (0012): the governing record's p= follows the policy, it sends reports here. */
const summary = (id: number, name: string, extra: Record<string, unknown> = {}) => ({ domain_id: id, domain: name, dmarc_policy: 'reject', spf_record: 'v=spf1 -all', total_messages: 0, pass_messages: 0, fail_messages: 0, dkim_total: 0, dkim_pass: 0, spf_total: 0, spf_pass: 0, mta_sts_enabled: 0, mta_sts_mode: null, spf_lookup_count: 3, dmarc_pct: 100, dmarc_p: 'dmarc_policy' in extra ? extra.dmarc_policy : 'reject', dmarc_sp: null, dmarc_rua: 1, ...checked, ...extra });
const stats = (passed: number, total = 100) => ({ domain: 'x', days: 30, stats: total ? [{ day: '2026-10-20', total, passed, failed: total - passed }] : [] });
const noReports = stats(0, 0);

/**
 * The overview reads every summary in one request (GET /api/domains/summaries). Tests describe each domain with a
 * per-domain summary and 30-day stats; this folds them into the one batched answer, as the server would.
 */
function toBatch(routes: Record<string, unknown | Handler>): Record<string, unknown | Handler> {
	const out: Record<string, unknown | Handler> = {};
	const sums = new Map<number, any>();
	const st = new Map<number, any>();
	for (const [k, v] of Object.entries(routes)) {
		const m = /^GET \/api\/domains\/(\d+)\/(check-summary|stats)$/.exec(k);
		if (!m) out[k] = v;
		else if (m[2] === 'check-summary') sums.set(Number(m[1]), v);
		else st.set(Number(m[1]), v);
	}
	if (sums.size > 0 && !out['GET /api/domains/summaries']) {
		const summaries = [...sums.entries()].sort(([a], [b]) => a - b).map(([id, s]) => {
			const days = (st.get(id)?.stats ?? []) as Array<{ total: number; passed: number; failed: number }>;
			const t = days.reduce((a, d) => ({ total: a.total + d.total, passed: a.passed + d.passed, failed: a.failed + d.failed }), { total: 0, passed: 0, failed: 0 });
			return { ...s, total_messages: t.total, pass_messages: t.passed, fail_messages: t.failed };
		});
		out['GET /api/domains/summaries'] = { summaries, next_after: null, window_days: 30 };
	}
	return out;
}
const renderOverview = (opts: Parameters<typeof renderApp>[1] = {}): ReturnType<typeof renderApp> => renderApp(<OverviewPage />, { ...opts, routes: toBatch(opts.routes ?? {}) });

/** The row for one domain: a list item named by its domain. */
// A settled row (not the loading one, which is aria-busy): its verdict is known.
const row = (name: string | RegExp) => screen.findByRole('listitem', { name, busy: false });

describe('OverviewPage: one row per domain that answers "am I done?"', () => {
	const routes = {
		'GET /api/domains': {
			domains: [domain(1, 'example.com'), domain(2, 'mail.example.com', { parent_id: 1, dmarc_policy: 'none' }), domain(3, 'bare.org', { dmarc_policy: null }), domain(4, 'ready.net', { dmarc_policy: 'none' })],
		},
		'GET /api/domains/1/check-summary': summary(1, 'example.com'),
		'GET /api/domains/2/check-summary': summary(2, 'mail.example.com', { dmarc_policy: 'none' }),
		'GET /api/domains/3/check-summary': summary(3, 'bare.org', { dmarc_policy: null, spf_record: null }),
		'GET /api/domains/4/check-summary': summary(4, 'ready.net', { dmarc_policy: 'none' }),
		'GET /api/domains/1/stats': stats(99),
		'GET /api/domains/2/stats': stats(80),
		'GET /api/domains/3/stats': noReports,
		'GET /api/domains/4/stats': stats(97),
	};

	it('answers for the whole workspace in one sentence, counting each state', async () => {
		renderOverview({ routes });
		expect(await screen.findByText('Not yet. Of 4 domains, 1 needs attention, 1 is awaiting your approval, 1 is worth fixing and 1 is verified.')).toBeInTheDocument();
		expect(screen.queryByLabelText('Summary')).not.toBeInTheDocument(); // no KPI strip
	});

	it('sorts what needs a person first, keeps a subdomain under its parent, and shows level, state, evidence and the next action', async () => {
		renderOverview({ routes });
		await screen.findByText(/^Not yet\./);
		const names = within(screen.getByRole('region', { name: 'Your domains' })).getAllByRole('listitem').map((li) => li.querySelector('h3')?.textContent);
		// bare.org needs attention; ready.net awaits approval; example.com (verified) carries its subdomain (worth fixing), so its group ranks by the child.
		expect(names).toEqual(['bare.org', 'ready.net', 'example.com', 'mail.example.com']);

		const bare = await row('bare.org');
		expect(within(bare).getByText('Needs attention')).toBeInTheDocument();
		expect(within(bare).getByText('Public DNS shows no SPF record at bare.org and no DMARC record, so receivers get no instruction for mail from bare.org that fails.')).toBeInTheDocument();
		expect(within(bare).getByRole('progressbar')).toHaveAttribute('aria-valuetext', 'Level 0 of 2: Delivering');
		expect(within(bare).getByRole('link', { name: 'Publish an SPF record for bare.org' })).toHaveAttribute('href', '/domains/3/setup/2');
		expect(within(bare).getByText('you or your DNS manager:')).toBeInTheDocument();
		expect(within(bare).getByText('Checked 3 hours ago')).toBeInTheDocument();

		const ready = await row('ready.net');
		expect(within(ready).getByText('Awaiting your approval')).toBeInTheDocument();
		expect(within(ready).getByText('97% of 100 reported messages passed DMARC in the last 30 days.')).toBeInTheDocument();
		expect(within(ready).getByRole('link', { name: /Approve moving DMARC to p=quarantine/ })).toHaveAttribute('href', '/domains/4/dmarc-wizard');

		const done = await row('example.com');
		expect(within(done).getByText('Verified')).toBeInTheDocument();
		expect(within(done).getByRole('progressbar')).toHaveAttribute('aria-valuetext', 'Level 2 of 2: Protected');
		expect(within(done).getByText('Next: nothing to do.')).toBeInTheDocument();

		const sub = await row('mail.example.com');
		expect(within(sub).getByText('Subdomain of example.com')).toBeInTheDocument();
		expect(within(sub).getByText('Worth fixing')).toBeInTheDocument();
	});

	it('every state is a word and an icon, never colour alone', async () => {
		renderOverview({ routes });
		await screen.findByText(/^Not yet\./);
		for (const li of within(screen.getByRole('region', { name: 'Your domains' })).getAllByRole('listitem')) {
			const label = li.querySelector('[data-status]:not(li)');
			expect(label?.textContent).toMatch(/Needs attention|Awaiting your approval|Worth fixing|Verified/);
			expect(label?.querySelector('svg')).not.toBeNull();
		}
	});

	it('read-only members are sent to the domain page, not into a wizard', async () => {
		renderOverview({ role: 'member', routes });
		const bare = await row('bare.org');
		await waitFor(() => expect(within(bare).getByRole('link', { name: 'Publish an SPF record for bare.org' })).toHaveAttribute('href', '/domains/3'));
		expect(screen.queryByTestId('first-day')).not.toBeInTheDocument();
	});

	it('says done, with its scope, only when every domain is verified', async () => {
		renderOverview({
			routes: { 'GET /api/domains': { domains: [domain(1, 'example.com')] }, 'GET /api/domains/1/check-summary': summary(1, 'example.com'), 'GET /api/domains/1/stats': noReports },
		});
		expect(await screen.findByText('Done, from public DNS only: example.com is verified.')).toBeInTheDocument();
		expect(screen.getByText('No DMARC reports in the last 30 days, so nobody has confirmed that every sender passes.')).toBeInTheDocument();
	});
});

describe('OverviewPage: unknown is never "not found"', () => {
	const page = (sum: Record<string, unknown>, name = 'example.org', stat: object = noReports) =>
		renderOverview({
			routes: {
				'GET /api/domains': { domains: [domain(3, name, { dmarc_policy: null })] },
				'GET /api/domains/3/check-summary': summary(3, name, sum),
				'GET /api/domains/3/stats': stat,
			},
		});

	it('a domain never read from DNS is Unknown, with no level and no "No ... record"', async () => {
		page({ dmarc_policy: null, spf_record: null, dns_checked_at: null, dns_check_attempted_at: null, dns_check_status: null });
		const r = await row('example.org');
		expect(within(r).getByText('Unknown')).toBeInTheDocument();
		expect(within(r).getByText('Nothing has been read from DNS for this domain yet.')).toBeInTheDocument();
		expect(within(r).getByText('Not checked yet')).toBeInTheDocument();
		expect(within(r).getByRole('progressbar')).toHaveAttribute('aria-valuetext', 'Level not known yet');
		expect(within(r).getByText('Level not known yet')).toBeInTheDocument();
		expect(within(r).getByRole('link', { name: /Open the domain to read its records from DNS/ })).toHaveAttribute('href', '/domains/3');
		expect(within(r).queryByText(/No (SPF|DMARC)/)).not.toBeInTheDocument();
	});

	it('a failed check with no good one yet says so, and counts nothing as known', async () => {
		page({ dmarc_policy: null, spf_record: null, dns_checked_at: null, dns_check_attempted_at: hoursAgo(1), dns_check_status: 'failed' });
		const r = await row('example.org');
		expect(within(r).getByText('The last DNS check failed, so nothing is confirmed yet.')).toBeInTheDocument();
		expect(within(r).getByText('Last check failed 1 hour ago. No successful check yet.')).toBeInTheDocument();
		expect(within(r).getByText('Unknown')).toBeInTheDocument();
	});

	it('a failed attempt after a good check keeps what was read, with the failure line', async () => {
		page({ dmarc_policy: 'reject', dns_checked_at: hoursAgo(72), dns_check_attempted_at: hoursAgo(1), dns_check_status: 'failed', dns_last_good_status: 'ok' });
		const r = await row('example.org');
		expect(within(r).getByText('Last check failed 1 hour ago. Last good check 3 days ago.')).toBeInTheDocument();
		expect(within(r).getByRole('progressbar')).toHaveAttribute('aria-valuetext', 'Level 2 of 2: Protected');
		// The latest check failed: what is shown is the last good check, and it is never Verified.
		expect(within(r).getByText('Unknown')).toBeInTheDocument();
		expect(within(r).queryByText('Verified')).not.toBeInTheDocument();
		expect(within(r).getByText(/^The latest DNS check failed\. From the last good check: public DNS shows/)).toBeInTheDocument();
	});

	it('once checked, a missing record is called missing', async () => {
		page({ dmarc_policy: null, spf_record: 'v=spf1 -all' });
		const r = await row('example.org');
		expect(within(r).getByText('Public DNS shows SPF but no DMARC record, so receivers get no instruction for mail that fails.')).toBeInTheDocument();
		expect(within(r).getByRole('link', { name: /Publish a DMARC record at p=none/ })).toHaveAttribute('href', '/domains/3/setup/4');
	});

	it('an inherited policy says where it comes from, and is not "no DMARC"', async () => {
		page({ dmarc_policy: 'reject', dmarc_inherited_from: 'example.org' }, 'mail.example.org');
		const r = await row('mail.example.org');
		expect(within(r).getByText('Public DNS shows SPF. mail.example.org has no DMARC record of its own and follows p=reject from example.org, so mail from mail.example.org that fails DMARC is rejected.')).toBeInTheDocument();
		// It names the record that governs it; never "no DMARC record" as a finding.
		expect(within(r).queryByText(/but no DMARC record|No DMARC record covers/)).not.toBeInTheDocument();
	});

	it('several DMARC records: receivers ignore them; this is a finding, not "not checked"', async () => {
		page({ dmarc_policy: null, dmarc_issue: 'multiple' });
		const r = await row('example.org');
		expect(within(r).getByText('There are several DMARC records at _dmarc.example.org, so receivers ignore all of them. Keep one and delete the others.')).toBeInTheDocument();
		expect(within(r).getByText('Keep one DMARC record at _dmarc.example.org and delete the others')).toBeInTheDocument();
		expect(within(r).getByRole('progressbar')).toHaveAttribute('aria-valuetext', 'Level 0 of 2: Delivering');
	});

	it('an invalid DMARC record is called invalid even if SPF was never read', async () => {
		page({ dmarc_policy: null, dmarc_issue: 'invalid', spf_record: null, dns_checked_at: null, dns_check_status: 'failed' });
		const r = await row('example.org');
		// Stored before the record's tags were kept (dmarc_p null): the RFC outcome without a valid rua=.
		expect(within(r).getByText('At _dmarc.example.org, the DMARC record has no valid p= policy (none, quarantine or reject) and no valid rua=, so receivers ignore it. Set p= to none, quarantine or reject.')).toBeInTheDocument();
	});

	it('a domain that does not exist says so, with no level and never "Delivering"', async () => {
		page({ dmarc_policy: null, spf_record: null, dns_check_status: 'nxdomain' }, 'no-such-host.example');
		const r = await row('no-such-host.example');
		expect(within(r).getByText('DNS says no-such-host.example does not exist, so it has no SPF or DMARC records to check.')).toBeInTheDocument();
		expect(within(r).getByText('Needs attention')).toBeInTheDocument();
		// No level is claimed: nothing on the ladder is reached, so it never reads as "Delivering".
		expect(within(r).getByRole('progressbar')).toHaveAttribute('aria-valuetext', 'Level not known yet');
		expect(within(r).getByRole('progressbar')).not.toHaveAttribute('aria-valuenow');
	});

	it('when the last good check found no such domain and the latest failed, it is Unknown and may have changed', async () => {
		page({ dmarc_policy: null, spf_record: null, dns_checked_at: hoursAgo(30), dns_check_attempted_at: hoursAgo(1), dns_check_status: 'failed', dns_last_good_status: 'nxdomain' }, 'no-such-host.example');
		const r = await row('no-such-host.example');
		expect(within(r).getByText('Unknown')).toBeInTheDocument();
		expect(within(r).getByText(/may have changed/)).toBeInTheDocument();
		expect(within(r).getByText('Last check failed 1 hour ago. At the last good check (1 day ago) this domain did not resolve.')).toBeInTheDocument();
	});

	it('summaries that fail to load make every row Unknown with a retry, never a guessed level', async () => {
		const { calls } = renderOverview({
			routes: {
				'GET /api/domains': { domains: [domain(1, 'ok.com'), domain(2, 'broken.com')] },
				'GET /api/domains/summaries': fail(404, 'summaries unavailable'),
			},
		});
		const broken = await row('broken.com');
		expect(within(broken).getByText(/summaries unavailable/)).toBeInTheDocument();
		expect(within(broken).getByText('Unknown')).toBeInTheDocument();
		expect(within(broken).getByRole('progressbar')).toHaveAttribute('aria-valuetext', 'Level not known yet');
		expect(screen.getByTestId('am-i-done')).not.toHaveTextContent(/^Done/);
		const before = calls.filter((c) => c.path.startsWith('/api/domains/summaries')).length;
		await userEvent.click(within(broken).getByRole('button', { name: 'Try again' }));
		await waitFor(() => expect(calls.filter((c) => c.path.startsWith('/api/domains/summaries')).length).toBeGreaterThan(before));
	});

	it('makes one request for every summary, not one per domain', async () => {
		const many = Array.from({ length: 12 }, (_, i) => domain(i + 1, `d${i + 1}.com`));
		const routes: Record<string, unknown> = { 'GET /api/domains': { domains: many } };
		many.forEach((d) => (routes[`GET /api/domains/${d.id}/check-summary`] = summary(d.id, d.domain)));
		const { calls } = renderOverview({ routes });
		await screen.findByText(/^Not yet|^Done/);
		expect(calls.filter((c) => c.path.startsWith('/api/domains/summaries'))).toHaveLength(1);
		expect(calls.filter((c) => /\/api\/domains\/\d+\//.test(c.path))).toEqual([]);
	});

	it('reports that are not connected are said to be not connected, not zero', async () => {
		renderOverview({
			routes: {
				'GET /api/domains': { domains: [domain(1, 'example.com', { rua_address: '' })] },
				'GET /api/domains/1/check-summary': summary(1, 'example.com', { dmarc_policy: 'none' }),
				'GET /api/domains/1/stats': noReports,
			},
		});
		const r = await row('example.com');
		expect(within(r).getByText('Reports are not connected for this domain, so nobody has confirmed that every sender passes.')).toBeInTheDocument();
	});
});

const justNow = () => Math.floor(Date.now() / 1000) - 600;
const daysAgo = (n: number) => Math.floor(Date.now() / 1000) - n * 86400;
const dayCard = () => screen.findByTestId('first-day');
const before = (a: HTMLElement, b: HTMLElement) => Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);

describe('OverviewPage: no red on day one', () => {
	const newDomain = (extra = {}) => domain(1, 'example.com', { created_at: justNow(), dmarc_policy: null, rua_address: 'r@x.io', ...extra });
	const bare = { dmarc_policy: null, spf_record: null, dmarc_rua: 0, ...checked };
	const routes = (d: Record<string, unknown>, sum: Record<string, unknown>, st: object = noReports) => ({ 'GET /api/domains': { domains: [d] }, 'GET /api/domains/1/check-summary': summary(1, 'example.com', sum), 'GET /api/domains/1/stats': st });

	it('a new domain with nothing published is "waiting for reports": neutral state, what is missing is "to fix after reports", no red, no "Not yet."', async () => {
		renderOverview({ routes: routes(newDomain(), bare) });
		const r = await row('example.com');
		expect(r).toHaveAttribute('data-status', 'gathering');
		expect(within(r).queryByText('Needs attention')).toBeNull();
		expect(within(r).getByText('Waiting for reports. To fix after reports: SPF is not published and DMARC is not published.')).toBeInTheDocument();
		expect(within(r).getByText('Next: nothing to do.')).toBeInTheDocument();
		expect(r.querySelector('.text-danger')).toBeNull();
		const answer = screen.getByTestId('am-i-done');
		expect(answer).toHaveTextContent('Waiting for the first reports on example.com.');
		expect(answer.textContent).not.toMatch(/^Not yet/);
		expect(screen.queryByText('Needs attention')).toBeNull();
	});

	it('a new domain whose reports are not connected is not "waiting for reports": the row and the workspace sentence say none can arrive', async () => {
		renderOverview({ routes: routes(newDomain({ rua_address: '' }), bare) });
		const r = await row('example.com');
		expect(within(r).getByText('Reports are not connected, so none will arrive. SPF is not published and DMARC is not published.')).toBeInTheDocument();
		expect(screen.getByTestId('am-i-done')).toHaveTextContent('No reports can arrive for example.com yet: reports are not connected.');
		expect(screen.queryByText(/Waiting for (the first )?reports/)).toBeNull();
	});

	it('the same domain after its first 72 hours, still with no report, says what it said before (the domain page and the row agree again)', async () => {
		renderOverview({ routes: routes(domain(1, 'example.com', { dmarc_policy: null }), bare) });
		const r = await row('example.com');
		expect(within(r).getByText('Needs attention')).toBeInTheDocument();
		expect(screen.getByTestId('am-i-done').textContent).toMatch(/^Not yet/);
	});

	it('once a report has arrived the real verdict is back, whatever the age', async () => {
		renderOverview({ routes: routes(newDomain(), { ...bare, dmarc_policy: 'none', spf_record: null }, stats(40)) });
		const r = await row('example.com');
		expect(within(r).queryByText('Waiting for reports. To fix after reports', { exact: false })).toBeNull();
	});

	it('real failures keep their words on day one: a name that does not resolve, DNS checks that fail', async () => {
		renderOverview({ routes: routes(newDomain(), { ...bare, dns_check_status: 'nxdomain', dns_last_good_status: 'nxdomain' }) });
		const r = await row('example.com');
		expect(r).not.toHaveAttribute('data-status', 'gathering');
		expect(within(r).queryByText(/Waiting for reports/)).toBeNull();
	});

	it('a proof that lapsed is not day-one neutral', async () => {
		renderOverview({ routes: routes(newDomain({ verified_via: 'legacy', proof_lost_at: justNow() }), bare) });
		await screen.findByTestId('proof-lost-1');
		expect(screen.queryByText(/Waiting for the first reports/)).toBeNull();
	});

	it('the first-day card is neutral too', async () => {
		renderOverview({ routes: routes(newDomain(), bare) });
		const card = await dayCard();
		expect(card.querySelector('.text-danger, [role="alert"]')).toBeNull();
	});
});

describe('OverviewPage: the first day (D1), where the stepper used to be', () => {
	it('the old "Get to your first answer" stepper is gone', async () => {
		renderOverview({ routes: { 'GET /api/domains': { domains: [] } } });
		await screen.findByText('Nothing to check yet: this workspace has no domains.');
		expect(screen.queryByRole('region', { name: 'Get to your first answer' })).not.toBeInTheDocument();
	});

	it('an empty workspace: one action, no Cloudflare detour', async () => {
		renderOverview({ routes: { 'GET /api/domains': { domains: [] } } });
		const card = await dayCard();
		expect(within(card).getByRole('heading', { name: 'Add the domain you send email from' })).toBeInTheDocument();
		expect(within(card).getByText(/Adding it changes nothing in its DNS/)).toBeInTheDocument();
		expect(within(card).getByRole('link', { name: 'Add a domain' })).toHaveAttribute('href', '/setup');
		expect(screen.queryByRole('link', { name: 'Connect Cloudflare' })).not.toBeInTheDocument();
	});

	const routesFor = (dom: Record<string, unknown>, sum: Record<string, unknown>, st: object = noReports) => ({
		'GET /api/domains': { domains: [domain(1, 'example.com', dom)] },
		'GET /api/domains/1/check-summary': summary(1, 'example.com', sum),
		'GET /api/domains/1/stats': st,
	});

	describe('a real blocker is one line inside the first-day card (item 1 follow-up)', () => {
		const broken = { id: 'c1', label: 'Brightwave Studio', auth_type: 'oauth', status: 'revoked', status_detail: null, cf_account_id: 'a1', cf_account_name: 'Brightwave Studio', scopes: [], zones: [] };
		const offer = (connections: unknown[]) => ({ connections, oauth: { available: true, scopes: [], via_relay: false }, token_paste: true, encryption_configured: true });
		const liveRoutes = (extra: Record<string, unknown> = {}) => ({ ...routesFor({ created_at: justNow(), dmarc_policy: 'none' }, { dmarc_policy: 'none', dmarc_rua: 1 }), ...extra });

		it('a stopped Cloudflare connection: said under the card\'s first line, once, with the way to reconnect; the full alert is not repeated below', async () => {
			renderOverview({ routes: liveRoutes({ 'GET /api/cloudflare/connections': offer([broken]) }) });
			const card = await dayCard();
			const line = await within(card).findByTestId('first-day-blocker');
			expect(line).toHaveTextContent('Brightwave Studio can no longer reach Cloudflare, so nothing can be written until it is reconnected. Reconnect in Settings');
			expect(within(line).getByRole('link', { name: 'Reconnect in Settings' })).toHaveAttribute('href', '/settings');
			// right under the card's first line: before the card's own paragraph
			const heading = within(card).getByRole('heading', { name: 'Your first reports are on their way' });
			expect(before(heading, line)).toBe(true);
			expect(before(line, within(card).getByText(/about once a day/))).toBe(true);
			expect(screen.queryByText('Cloudflare needs to be reconnected')).toBeNull();
			expect(card.querySelector('.text-danger, [role="alert"]')).toBeNull();
		});

		it('a lapsed proof on another domain: one line, with the way to prove it again; the block below stays', async () => {
			renderOverview({ routes: { ...liveRoutes(), 'GET /api/domains': { domains: [domain(1, 'example.com', { created_at: justNow(), dmarc_policy: 'none' }), domain(2, 'lapsed.org', { verified_via: 'legacy', proof_lost_at: justNow() })] }, 'GET /api/domains/2/check-summary': summary(2, 'lapsed.org'), 'GET /api/domains/2/stats': noReports } });
			const card = await dayCard();
			expect(await within(card).findByTestId('first-day-blocker')).toHaveTextContent('Proof lost for lapsed.org: reports are not accepted until it is proven again. Prove it again');
			expect(await screen.findByTestId('proof-lost-2')).toBeInTheDocument();
		});

		it('nothing broken: no line', async () => {
			renderOverview({ routes: liveRoutes({ 'GET /api/cloudflare/connections': offer([{ ...broken, status: 'active' }]) }) });
			const card = await dayCard();
			expect(within(card).queryByTestId('first-day-blocker')).toBeNull();
		});
	});

	it('records live, no report yet: "Your first reports are on their way", with the timeline and Test a real email', async () => {
		renderOverview({ routes: routesFor({ created_at: justNow(), dmarc_policy: 'none' }, { dmarc_policy: 'none', dmarc_rua: 1 }) });
		const card = await dayCard();
		expect(within(card).getByRole('heading', { name: 'Your first reports are on their way' })).toBeInTheDocument();
		expect(within(card).getByText(/about once a day\. We'll email owner@example\.com when the first one arrives\./)).toBeInTheDocument();
		const items = within(card).getAllByRole('listitem');
		expect(items).toHaveLength(3);
		expect(items[0]).toHaveTextContent('Done: Report address in DMARC');
		expect(items[1]).toHaveTextContent('Waiting: First report · usually within 24 to 48 hours');
		expect(items[2]).toHaveTextContent('Later: See every service that sends as example.com, then fix SPF and DKIM');
		expect(within(card).getByRole('link', { name: 'Test a real email' })).toHaveAttribute('href', '/check');
		expect(card.querySelector('.text-danger, [role="alert"]')).toBeNull(); // nothing has failed on day one
	});

	it('the card is the first thing said: no "Not yet." headline above it while nothing blocks, and the headline is back once the card is gone', async () => {
		renderOverview({ routes: routesFor({ created_at: justNow(), dmarc_policy: 'none' }, { dmarc_policy: 'none', dmarc_rua: 1, dns_check_status: 'ok' }) });
		await dayCard();
		const answer = screen.getByTestId('am-i-done');
		expect(answer).toHaveTextContent('Getting example.com set up.');
		expect(answer.textContent).not.toMatch(/Not yet/);
	});

	it('a real blocker keeps the headline and goes first (the card follows the list)', async () => {
		renderOverview({ routes: routesFor({ dmarc_policy: null }, { dmarc_policy: null, spf_record: null, ...checked, dmarc_rua: 0 }) });
		await row('example.com');
		expect(screen.getByTestId('am-i-done').textContent).toMatch(/^Not yet/);
	});

	it('waiting for records: the DMARC record does not name our address yet, with the way to add it', async () => {
		renderOverview({ routes: routesFor({ created_at: justNow(), dmarc_policy: 'none' }, { dmarc_policy: 'none', dmarc_rua: 0 }) });
		const card = await dayCard();
		expect(within(card).getByRole('heading', { name: "Waiting for the report address in example.com's DMARC record" })).toBeInTheDocument();
		expect(within(card).getByRole('link', { name: 'See what to add' })).toHaveAttribute('href', '/domains/1');
		// What the domain page really shows first: the Connect reports panel, and the record once the domain is connected (not "the exact record" at once).
		expect(within(card).getByText(/The domain page has Connect reports, which shows the exact record to add once the domain is connected/)).toBeInTheDocument();
		expect(within(card).queryByText(/The domain page shows the exact record/)).toBeNull();
		expect(within(card).queryByText('Your first reports are on their way')).toBeNull();
	});

	it('waiting for records, no report address yet: the card says it once; the long "Reports not connected yet" block does not repeat it', async () => {
		renderOverview({ routes: routesFor({ created_at: justNow(), dmarc_policy: 'none', rua_address: '' }, { dmarc_policy: 'none', dmarc_rua: 0, report_connect: { can_connect: true, refusal: null, refusal_kind: null } }) });
		const card = await dayCard();
		expect(within(card).getByRole('heading', { name: "Waiting for the report address in example.com's DMARC record" })).toBeInTheDocument();
		await row('example.com');
		expect(screen.queryByText('Reports not connected yet')).toBeNull();
	});

	it('the change was applied but public DNS does not show it yet: says so, no review link, no promise of reports', async () => {
		localStorage.setItem('rsm_review_done:ws_default', 'applied');
		renderOverview({ routes: routesFor({ created_at: justNow(), cf_account_id: 'acc1' }, { dmarc_rua: 0 }) });
		const card = await dayCard();
		expect(within(card).getByRole('heading', { name: "Written to Cloudflare: waiting for public DNS to show example.com's new record" })).toBeInTheDocument();
		expect(within(card).queryByRole('link', { name: 'Review the change' })).toBeNull();
		expect(within(card).getByRole('link', { name: 'Open example.com' })).toHaveAttribute('href', '/domains/1');
		expect(within(card).queryByText(/first reports are on their way/i)).toBeNull();
	});

	it('waiting for records, Cloudflare connected: the action is the review', async () => {
		renderOverview({ routes: routesFor({ created_at: justNow(), cf_account_id: 'acc1', rua_address: '' }, { dmarc_rua: 0, report_connect: { can_connect: true, refusal: null, refusal_kind: null } }) });
		const card = await dayCard();
		expect(within(card).getByRole('link', { name: 'Review the change' })).toHaveAttribute('href', '/setup/review');
	});

	it('first report arrived: said once, then the card goes away', async () => {
		renderOverview({ routes: routesFor({ created_at: justNow() }, { dmarc_policy: 'reject' }, stats(14, 14)) });
		const card = await dayCard();
		expect(within(card).getByRole('heading', { name: 'First reports for example.com' })).toBeInTheDocument();
		expect(within(card).getByText(/14 messages reported, 100% passed DMARC/)).toBeInTheDocument();
		await userEvent.setup().click(within(card).getByRole('button', { name: 'Got it' }));
		expect(screen.queryByTestId('first-day')).toBeNull();
		expect(localStorage.getItem('rsm_first_report_seen:ws_default')).toBe('1');
	});

	it('nothing after 3 days: says why reports may not have come and what to check', async () => {
		renderOverview({ routes: routesFor({ created_at: daysAgo(5) }, { dmarc_policy: 'none', dmarc_rua: 1 }) });
		const card = await dayCard();
		expect(within(card).getByRole('heading', { name: 'No reports yet for example.com' })).toBeInTheDocument();
		expect(within(card).getByText(/Reports only come when mail has been sent from the domain\. If it has, check that _dmarc still names our address\./)).toBeInTheDocument();
		expect(within(card).getByRole('link', { name: 'Test a real email' })).toBeInTheDocument();
	});

	it('hosted, reports not allowed for this workspace (HOSTED_CONNECT_REPORTS): no "reports on their way", the server\'s own reason, DNS checks only', async () => {
		const refusal = 'Reports are only connected for the workspaces of the person who runs this service.';
		renderOverview({ routes: routesFor({ created_at: justNow(), rua_address: '' }, { dmarc_rua: 0, report_connect: { can_connect: false, refusal, refusal_kind: 'operator_only' } }) });
		const card = await dayCard();
		expect(within(card).getByRole('heading', { name: 'example.com is checked from public DNS' })).toBeInTheDocument();
		expect(within(card).getByText(new RegExp(`DMARC reports can't reach this workspace yet.*${refusal}`))).toBeInTheDocument();
		expect(within(card).queryByText(/first reports are on their way/i)).toBeNull();
		expect(within(card).queryByText(/We'll email/)).toBeNull();
		expect(within(card).getByRole('link', { name: 'Test a real email' })).toBeInTheDocument();
	});

	it('hosted, reports allowed (HOSTED_CONNECT_REPORTS=all or the owner): the same domain waits for its record, not for reports', async () => {
		renderOverview({ routes: routesFor({ created_at: justNow(), rua_address: '' }, { dmarc_rua: 0, report_connect: { can_connect: true, refusal: null, refusal_kind: null } }) });
		const card = await dayCard();
		expect(within(card).getByRole('heading', { name: /Waiting for the report address/ })).toBeInTheDocument();
	});

	describe('an existing account is not given the first-day card (only the setup just finished is)', () => {
		const connected = { 'GET /api/cloudflare/connections': { connections: [{ id: 'c1', label: 'Harbor', auth_type: 'oauth', status: 'active', status_detail: null, cf_account_id: 'acc1', cf_account_name: 'Harbor', scopes: [], zones: [{ id: 'z1', name: 'example.com' }] }], oauth: { available: true, scopes: [], via_relay: false }, token_paste: true, encryption_configured: true } };
		it('a connected domain that already receives reports: no first-day card, no "First reports" card, whatever the age of the browser\'s memory', async () => {
			renderOverview({ routes: { ...routesFor({ created_at: daysAgo(30), cf_account_id: 'acc1', verified_via: 'cloudflare' }, { dmarc_policy: 'reject', dmarc_rua: 1 }, stats(90, 100)), ...connected } });
			await row('example.com');
			expect(screen.queryByTestId('first-day')).toBeNull();
			expect(screen.queryByRole('heading', { name: /First reports for/ })).toBeNull();
		});
		it('an older domain with no reports yet keeps main\'s overview: no card saying this server receives no DMARC reports', async () => {
			const refusal = 'Reports are only connected for the workspaces of the person who runs this service.';
			renderOverview({ routes: routesFor({ created_at: daysAgo(30), rua_address: '' }, { dmarc_rua: 0, report_connect: { can_connect: false, refusal, refusal_kind: 'operator_only' } }) });
			await row('example.com');
			expect(screen.queryByTestId('first-day')).toBeNull();
			expect(screen.queryByText(/is checked from public DNS/)).toBeNull();
		});
		it('the same domain in its first days does get the card', async () => {
			renderOverview({ routes: routesFor({ created_at: daysAgo(2), rua_address: '' }, { dmarc_rua: 0, report_connect: { can_connect: false, refusal: 'x', refusal_kind: 'operator_only' } }) });
			expect(await dayCard()).toBeInTheDocument();
		});
	});

	it('Test a real email is not offered where the Email check cannot work', async () => {
		renderOverview({ status: { email_check: false }, routes: routesFor({ created_at: justNow(), dmarc_policy: 'none' }, { dmarc_policy: 'none', dmarc_rua: 1 }) });
		const card = await dayCard();
		expect(within(card).queryByRole('link', { name: 'Test a real email' })).toBeNull();
	});

	it('members never see the first-day card', async () => {
		renderOverview({ role: 'member', routes: routesFor({ created_at: justNow() }, {}) });
		await screen.findByText(/^Done|^Not yet/);
		expect(screen.queryByTestId('first-day')).toBeNull();
	});

	// One rule for the order: while a domain is in its first-day state the card is the first thing on the page, whatever else is there.
	it('the card comes first even when a domain needs attention (an older domain keeps its "Not yet" headline)', async () => {
		renderOverview({ routes: routesFor({ dmarc_policy: null, created_at: daysAgo(5) }, { dmarc_policy: null, spf_record: null, ...checked, dmarc_rua: 0 }) });
		const r = await row('example.com');
		expect(within(r).getByText('Needs attention')).toBeInTheDocument();
		const card = await dayCard();
		expect(before(card, screen.getByRole('region', { name: 'Your domains' }))).toBe(true);
		expect(before(card, screen.getByTestId('am-i-done'))).toBe(true);
	});

	it('day one with a row that needs attention: the card first, no "Not yet." headline, no level ladder', async () => {
		renderOverview({ routes: routesFor({ created_at: justNow(), dmarc_policy: null }, { dmarc_policy: null, spf_record: null, ...checked, dmarc_rua: 0, dns_check_status: 'failed' }) });
		const r = await row('example.com');
		const card = await dayCard();
		expect(before(card, r)).toBe(true);
		expect(screen.getByTestId('am-i-done').textContent).not.toMatch(/Not yet/);
		expect(within(r).queryByLabelText('example.com: protection level')).toBeNull();
	});

	it('levels appear with the first report; before it, on the first day, there is no ladder', async () => {
		renderOverview({ routes: routesFor({ created_at: justNow(), dmarc_policy: 'none' }, { dmarc_policy: 'none', dmarc_rua: 1, dns_check_status: 'ok' }) });
		await dayCard();
		expect(screen.queryByLabelText('example.com: protection level')).toBeNull();
	});

	it('the card stays first, ahead of a domain waiting for proof and the list', async () => {
		const claim = { id: 5, domain: 'acme.io', status: 'pending', txt_name: '_readysetmail.acme.io', txt_value: 'readysetmail-verify=abc', created_at: 1, last_checked_at: null, last_error: null };
		renderOverview({
			routes: {
				'GET /api/domains': { domains: [domain(1, 'example.com', { dmarc_policy: 'none', created_at: justNow() })], pending_claims: [claim] },
				'GET /api/domains/1/check-summary': summary(1, 'example.com', { dmarc_policy: 'none' }),
				'GET /api/domains/1/stats': noReports,
				'GET /api/domains/claims/5/preview': fail(502),
			},
		});
		const card = await dayCard();
		expect(before(card, screen.getByRole('region', { name: 'Waiting for verification' }))).toBe(true);
		expect(before(card, screen.getByRole('region', { name: 'Your domains' }))).toBe(true);
	});

	it('a member in an empty workspace is told who adds domains, with no action', async () => {
		renderOverview({ role: 'member', routes: { 'GET /api/domains': { domains: [] } } });
		expect(await screen.findByText('This workspace has no domains yet')).toBeInTheDocument();
		expect(screen.getByText(/An owner or admin adds them/)).toBeInTheDocument();
		expect(screen.queryByRole('link', { name: 'Add a domain' })).not.toBeInTheDocument();
	});

	it('members see the read-only notice and a disabled Add domain', async () => {
		renderOverview({ role: 'member', routes: { 'GET /api/domains': { domains: [] } } });
		expect(await screen.findByTestId('read-only-notice')).toBeInTheDocument();
		await waitFor(() => expect(screen.getByRole('button', { name: /Add domain/ })).toBeDisabled());
	});

	it('list failure offers a retry', async () => {
		renderOverview({ routes: { 'GET /api/domains': fail(404, 'nope') } });
		expect(await screen.findByText('Could not load your domains')).toBeInTheDocument();
		expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument();
	});
});

describe('OverviewPage: pending ownership claims keep the lazy DNS preview', () => {
	const claim = { id: 5, domain: 'acme.com', status: 'pending', txt_name: '_readysetmail-challenge.acme.com', txt_value: 'ia-verify=abc123', created_at: 1700000000, last_checked_at: null, last_error: null };

	it('shows "Check public DNS" on the claim, requests nothing until pressed, and the proof step says the level is visible first', async () => {
		const { calls } = renderOverview({ routes: { 'GET /api/domains': { domains: [], pending_claims: [claim] } } });
		const section = await screen.findByRole('region', { name: 'Waiting for verification' });
		expect(within(section).getByRole('button', { name: 'Check public DNS' })).toBeInTheDocument();
		expect(calls.some((c) => c.path.includes('/claims/5/preview'))).toBe(false);
		expect(screen.getByText('Not yet: 1 domain is waiting for proof that it is yours.')).toBeInTheDocument();
		const card = await dayCard();
		expect(within(card).getByRole('heading', { name: 'Waiting for the DNS record that proves acme.com' })).toBeInTheDocument();
		expect(within(card).getByText(/Its live DNS result is visible before then/)).toBeInTheDocument();
	});
});

describe('OverviewPage: every counted domain has a row, at any depth', () => {
	it('lists a sub-subdomain under its nearest listed ancestor (three levels), and the count matches the rows', async () => {
		const ds = [domain(1, 'stripe.com'), domain(2, 'mail.stripe.com', { parent_id: 1 }), domain(3, 't2.mail.stripe.com', { parent_id: 2 }), domain(4, 'x.orphan.com', { parent_id: 99 })];
		const routes: Record<string, unknown> = { 'GET /api/domains': { domains: ds } };
		ds.forEach((d) => (routes[`GET /api/domains/${d.id}/check-summary`] = summary(d.id, d.domain)));
		renderOverview({ routes });
		expect(await screen.findByText(/^Done, from public DNS only: all 4 domains are verified\.$/)).toBeInTheDocument();
		const items = within(screen.getByRole('region', { name: 'Your domains' })).getAllByRole('listitem');
		expect(items.map((li) => li.querySelector('h3')?.textContent)).toEqual(['stripe.com', 'mail.stripe.com', 't2.mail.stripe.com', 'x.orphan.com']);
		expect(within(items[2]!).getByText('Subdomain of mail.stripe.com')).toBeInTheDocument();
		expect(items[2]!.className).toMatch(/sm:pl-16/);
	});
});

describe('OverviewPage: verified domains first, then the ones waiting', () => {
	it('puts "Waiting for verification" above the domains (the first-day card, when there is one, is above both)', async () => {
		const claim = { id: 5, domain: 'acme.com', status: 'pending', txt_name: '_readysetmail.acme.com', txt_value: 'v=1', created_at: 1700000000, last_checked_at: null, last_error: null };
		renderOverview({ routes: { 'GET /api/domains': { domains: [domain(1, 'example.com')], pending_claims: [claim] }, 'GET /api/domains/1/check-summary': summary(1, 'example.com'), 'GET /api/domains/1/stats': stats(99) } });
		const verified = await screen.findByRole('region', { name: 'Your domains' });
		const waiting = await screen.findByRole('region', { name: 'Waiting for verification' });
		expect(waiting.compareDocumentPosition(verified) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
		const card = screen.queryByTestId('first-day');
		if (card) expect(card.compareDocumentPosition(waiting) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
	});
});
