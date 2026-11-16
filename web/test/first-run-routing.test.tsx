// A returning person lands on the screen the server's state names: S2 (an attempt waits, no answers), S3 (answers saved),
// S4 (an account with no domain), C2 (a Cloudflare connection whose domain still lacks our report address), D1 (anything else).
import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it } from 'vitest';
import { App } from '../src/app';
import { createQueryClient } from '../src/lib/query';
import { markReviewDone, rememberFocusDomain } from '../src/lib/first-run';
import { fail, me, mockApi, STATUS } from './render';

beforeEach(() => {
	localStorage.clear();
	sessionStorage.clear();
});

const at = (route: string) => ({ children }: { children: ReactNode }) => <MemoryRouter initialEntries={[route]}>{children}</MemoryRouter>;
const HOSTED = { ...STATUS, mode: 'saas', signup_open: true, configured: true, base_domain: null };
const PROFILE = { name: 'Dana', organization: 'Brightwave Studio', whose_email: 'company' };
const row = (extra = {}) => ({ id: 7, domain: 'brightwave-mail.com', dmarc_policy: null, rua_address: 'rua@reports.readysetmail.com', parent_id: null, created_at: Math.floor(Date.now() / 1000) - 600, alerts_enabled: 1, is_default: 0, cf_account_id: 'acc1', verified_via: 'cloudflare', ...extra });
const summary = (extra = {}) => ({ domain_id: 7, domain: 'brightwave-mail.com', dmarc_policy: 'none', dmarc_p: 'none', dmarc_rua: 0, spf_record: null, dns_checked_at: Math.floor(Date.now() / 1000) - 60, dns_check_attempted_at: Math.floor(Date.now() / 1000) - 60, dns_check_status: 'ok', total_messages: 0, pass_messages: 0, fail_messages: 0, dkim_total: 0, dkim_pass: 0, spf_total: 0, spf_pass: 0, mta_sts_enabled: 0, mta_sts_mode: null, report_connect: { can_connect: true, refusal: null, refusal_kind: null }, ...extra });
const conns = (connections: unknown[]) => ({ connections, oauth: { available: true, scopes: [], via_relay: false }, token_paste: true, encryption_configured: true });
const active = { id: 'c1', label: 'Brightwave Studio', auth_type: 'oauth', status: 'active', status_detail: null, cf_account_id: 'acc1', cf_account_name: 'Brightwave Studio', scopes: [], zones: [{ id: 'z1', name: 'brightwave-mail.com' }] };

function boot(route: string, routes: Record<string, unknown>) {
	const api = mockApi({
		'GET /api/auth/status': { ...HOSTED },
		'GET /api/version': { current: '2.0.0', latest: '2.0.0', update_available: false, release_url: '' },
		'GET /api/workspaces': { workspaces: [{ id: 'ws_default', name: 'Brightwave Studio', role: 'owner', member_count: 1 }] },
		'GET /api/cloudflare/connections': conns([]),
		'GET /api/cloudflare/suggestions': { suggestions: [] },
		'GET /api/domains/summaries': { summaries: [], next_after: null, window_days: 30 },
		'POST /api/onboarding/dns-plan': { plan_id: 'p', steps: [{ key: 'dmarc', writes: [], satisfied: true }], not_written: [] },
		...routes,
	});
	render(<App queryClient={createQueryClient()} Router={at(route)} />);
	return api;
}
const signedIn = { 'GET /api/me': { ...me('owner'), whose_email: 'company' } };
const signedOut = { 'GET /api/me': fail(401) };

describe('the screen a returning person lands on', () => {
	it('an attempt is waiting and S2 has no answers: S2 (whatever address they open)', async () => {
		boot('/signup', { ...signedOut, 'GET /api/auth/signup/pending': { pending: true, email: 'dana@brightwave-mail.com', step: 'about', expires_in: 500, lifetime_seconds: 600 } });
		expect(await screen.findByRole('heading', { name: 'Tell us about yourself' })).toBeInTheDocument();
	});

	it('answers are saved: S3, the code', async () => {
		boot('/signup', { ...signedOut, 'GET /api/auth/signup/pending': { pending: true, email: 'dana@brightwave-mail.com', step: 'code', expires_in: 500, lifetime_seconds: 600, profile: PROFILE } });
		expect(await screen.findByRole('heading', { name: 'Check your inbox' })).toBeInTheDocument();
	});

	it('signed in, no domain yet: S4 (once the dashboard is asked for)', async () => {
		boot('/', { ...signedIn, 'GET /api/auth/status': { ...HOSTED, has_domain: false }, 'GET /api/domains': { domains: [], pending_claims: [] } });
		expect(await screen.findByRole('heading', { name: 'Which domain do you send email from?' })).toBeInTheDocument();
	});

	it('signed in, no domain, an agency: S4 asks for the first client\'s domain', async () => {
		boot('/', { 'GET /api/me': { ...me('owner'), whose_email: 'clients', agency_name: 'Northside IT' }, 'GET /api/auth/status': { ...HOSTED, has_domain: false }, 'GET /api/domains': { domains: [], pending_claims: [] } });
		expect(await screen.findByRole('heading', { name: "Add your first client's domain" })).toBeInTheDocument();
	});

	it('Cloudflare is connected and the domain\'s DMARC record does not name our address yet: C2, once', async () => {
		rememberFocusDomain('ws_default', 'brightwave-mail.com');
		boot('/', {
			...signedIn,
			'GET /api/domains': { domains: [row()] },
			'GET /api/cloudflare/connections': conns([active]),
			'GET /api/domains/7/check-summary': summary({ dmarc_rua: 0 }),
		});
		expect(await screen.findByTestId('review')).toBeInTheDocument();
		expect(sessionStorage.getItem('rsm_review_redirected:ws_default')).toBe('1');
	});

	it('another browser (it did not set the domain up, so it does not know which imported domain was the first): the dashboard, not a review of a guess', async () => {
		boot('/', {
			...signedIn,
			'GET /api/domains': { domains: [row({ id: 6, domain: 'quietfield.net' }), row()] },
			'GET /api/cloudflare/connections': conns([active]),
			'GET /api/domains/7/check-summary': summary({ dmarc_rua: 0 }),
			'GET /api/domains/6/check-summary': summary({ domain_id: 6, domain: 'quietfield.net', dmarc_rua: 0 }),
			'GET /api/domains/summaries': { summaries: [summary({ dmarc_rua: 0 })], next_after: null, window_days: 30 },
			'GET /api/domains/7/stats': { domain: 'x', days: 30, stats: [] },
			'GET /api/domains/6/stats': { domain: 'x', days: 30, stats: [] },
		});
		expect(await screen.findByRole('heading', { name: 'Domains' })).toBeInTheDocument();
		expect(screen.queryByTestId('review')).toBeNull();
		expect(sessionStorage.getItem('rsm_review_redirected:ws_default')).toBeNull();
	});

	it('another browser, three imported zones, the set-up domain is not the first: the first-day card names the domain S4 was given (the server\'s record), not the first imported', async () => {
		const quiet = row({ id: 5, domain: 'quietfield.net' });
		const other = row({ id: 6, domain: 'aaa-other.org' });
		markReviewDone('ws_default');
		boot('/', {
			...signedIn,
			'GET /api/domains': { domains: [quiet, other, row()], first_run_domain: 'brightwave-mail.com' },
			'GET /api/cloudflare/connections': conns([active]),
			'GET /api/domains/summaries': { summaries: [5, 6, 7].map((id) => summary({ domain_id: id, domain: { 5: 'quietfield.net', 6: 'aaa-other.org', 7: 'brightwave-mail.com' }[id], dmarc_rua: 1 })), next_after: null, window_days: 30 },
			'GET /api/domains/7/check-summary': summary({ dmarc_rua: 1 }),
			'GET /api/domains/6/check-summary': summary({ domain_id: 6, domain: 'aaa-other.org', dmarc_rua: 1 }),
			'GET /api/domains/5/check-summary': summary({ domain_id: 5, domain: 'quietfield.net', dmarc_rua: 1 }),
			'GET /api/domains/7/stats': { domain: 'x', days: 30, stats: [] },
			'GET /api/domains/6/stats': { domain: 'x', days: 30, stats: [] },
			'GET /api/domains/5/stats': { domain: 'x', days: 30, stats: [] },
		});
		const card = await screen.findByTestId('first-day');
		expect(card).toHaveTextContent('brightwave-mail.com');
		expect(card).not.toHaveTextContent('quietfield.net');
		expect(card).not.toHaveTextContent('aaa-other.org');
	});

	it('the same state after the review was applied or skipped: the dashboard with the first-day card, not the review again', async () => {
		markReviewDone('ws_default');
		boot('/', {
			...signedIn,
			'GET /api/domains': { domains: [row()] },
			'GET /api/cloudflare/connections': conns([active]),
			'GET /api/domains/7/check-summary': summary({ dmarc_rua: 0 }),
			'GET /api/domains/summaries': { summaries: [summary({ dmarc_rua: 0 })], next_after: null, window_days: 30 },
			'GET /api/domains/7/stats': { domain: 'x', days: 30, stats: [] },
		});
		expect(await screen.findByTestId('first-day')).toBeInTheDocument();
		expect(screen.queryByTestId('review')).toBeNull();
	});

	it('records live (our address is in DMARC): D1, "Your first reports are on their way"', async () => {
		boot('/', {
			...signedIn,
			'GET /api/domains': { domains: [row()] },
			'GET /api/cloudflare/connections': conns([active]),
			'GET /api/domains/7/check-summary': summary({ dmarc_rua: 1 }),
			'GET /api/domains/summaries': { summaries: [summary({ dmarc_rua: 1 })], next_after: null, window_days: 30 },
			'GET /api/domains/7/stats': { domain: 'x', days: 30, stats: [] },
		});
		expect(await screen.findByRole('heading', { name: 'Your first reports are on their way' })).toBeInTheDocument();
		expect(screen.queryByTestId('review')).toBeNull();
	});

	it('a domain that was not connected through Cloudflare never goes to C2', async () => {
		boot('/', {
			...signedIn,
			'GET /api/domains': { domains: [row({ cf_account_id: null, verified_via: 'txt' })] },
			'GET /api/domains/summaries': { summaries: [summary({ dmarc_rua: 0 })], next_after: null, window_days: 30 },
			'GET /api/domains/7/check-summary': summary({ dmarc_rua: 0 }),
			'GET /api/domains/7/stats': { domain: 'x', days: 30, stats: [] },
		});
		expect(await screen.findByTestId('first-day')).toBeInTheDocument();
		expect(screen.queryByTestId('review')).toBeNull();
	});

	it('self-host never goes to C2 or S4: the dashboard, or its own setup', async () => {
		boot('/', {
			...signedIn,
			'GET /api/auth/status': { ...STATUS, has_domain: true },
			'GET /api/domains': { domains: [row()] },
			'GET /api/cloudflare/connections': conns([active]),
			'GET /api/domains/summaries': { summaries: [summary({ dmarc_rua: 0 })], next_after: null, window_days: 30 },
			'GET /api/domains/7/check-summary': summary({ dmarc_rua: 0 }),
			'GET /api/domains/7/stats': { domain: 'x', days: 30, stats: [] },
		});
		expect(await screen.findByRole('heading', { name: 'Domains' })).toBeInTheDocument();
		expect(screen.queryByTestId('review')).toBeNull();
	});
});
