// Review round 2, items 9-15 and the S2 fit: each with the behaviour the reviewer walked into.
import { act, renderHook, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes, useLocation } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ClaimCard } from '../src/components/domain/ClaimCard';
import { FirstDayCard } from '../src/components/FirstDay';
import { POLL_FAST_FOR_MS, POLL_FAST_MS, POLL_SLOW_MS, pollDelay, useDnsPoll } from '../src/lib/poll';
import { AuthPage } from '../src/pages/auth/AuthPage';
import { OverviewPage } from '../src/pages/domains/OverviewPage';
import { SetupDomain } from '../src/pages/setup/SetupDomain';
import { CloudflareWizardPage } from '../src/pages/wizards/cloudflare/CloudflareWizardPage';
import { fail, renderApp } from './render';

beforeEach(() => {
	localStorage.clear();
	sessionStorage.clear();
	window.history.replaceState(null, '', '/');
});
afterEach(() => vi.useRealTimers());

const HOSTED = { mode: 'saas' as const, signup_open: true, configured: true, has_domain: true };
const now = () => Math.floor(Date.now() / 1000);
const claim = (domain = 'brightwave-mail.com', id = 5) => ({ id, domain, status: 'pending' as const, txt_name: `_readysetmail.${domain}`, txt_value: 'readysetmail-verify=abc', created_at: 1, last_checked_at: null, last_error: null });
const conns = { connections: [], oauth: { available: true, scopes: [], via_relay: false }, token_paste: true, encryption_configured: true };
const host = (id: string, name: string) => ({ provider: { id, name }, nameservers: [`ns1.${id}.example`], status: 'known' });
function Where() {
	const l = useLocation();
	return <output data-testid="where">{l.pathname}</output>;
}

describe('15: the useful action is on the first screen of the first-day card', () => {
	const order = (a: HTMLElement, b: HTMLElement) => Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
	it('live: "Open <domain>" comes right after the sentence, before the timeline and the email test', () => {
		renderApp(<FirstDayCard state={{ kind: 'live', domain: 'example.com', domainId: 3, readAt: now() }} email="a@b.co" emailCheck workspaceId="w" />);
		return screen.findByTestId('first-day').then((card) => {
			const open = within(card).getByRole('link', { name: 'Open example.com' });
			expect(open).toHaveAttribute('href', '/domains/3');
			expect(order(open, within(card).getByRole('list', { name: 'Where things stand' }))).toBe(true);
			expect(order(open, within(card).getByRole('link', { name: 'Test a real email' }))).toBe(true);
		});
	});
	it('written to Cloudflare, waiting: the same, before the email test', async () => {
		renderApp(<FirstDayCard state={{ kind: 'records', domain: 'example.com', domainId: 3, viaCloudflare: true, applied: true }} emailCheck workspaceId="w" />);
		const card = await screen.findByTestId('first-day');
		expect(order(within(card).getByRole('link', { name: 'Open example.com' }), within(card).getByRole('link', { name: 'Test a real email' }))).toBe(true);
	});
});

describe('9: while a teammate finishes a domain, the hand-off card replaces the proof block', () => {
	const summary = { domain_id: 7, domain: 'brightwave-mail.com', dmarc_policy: null, spf_record: null, total_messages: 0, pass_messages: 0, fail_messages: 0, dkim_total: 0, dkim_pass: 0, spf_total: 0, spf_pass: 0, mta_sts_enabled: 0, mta_sts_mode: null, dmarc_rua: 0, dns_checked_at: now() - 60, dns_check_attempted_at: now() - 60, dns_check_status: 'ok', report_connect: { can_connect: true, refusal: null, refusal_kind: null } };
	const handoff = { id: 'abc123', email: 'sam@brightwave-mail.com', domain: 'brightwave-mail.com', sent_at: now() - 3600, expires_at: now() + 6 * 86400, joined_at: null };
	it('no "Waiting for verification" block and no filled Connect button for that domain; the card is there', async () => {
		renderApp(<OverviewPage />, {
			status: HOSTED,
			routes: {
				'GET /api/domains': { domains: [], pending_claims: [claim()] },
				'GET /api/domains/summaries': { summaries: [], next_after: null, window_days: 30 },
				'GET /api/team/handoffs': { handoffs: [handoff] },
				'GET /api/domains/claims/5/preview': fail(502),
				'GET /api/domains/dns-host': host('cloudflare', 'Cloudflare'),
				'GET /api/cloudflare/connections': conns,
			},
		});
		expect(await screen.findByTestId('handoff-card')).toBeInTheDocument();
		expect(screen.queryByRole('region', { name: 'Waiting for verification' })).toBeNull();
		expect(screen.queryByRole('button', { name: 'Connect Cloudflare' })).toBeNull();
	});
	it('another claim, not handed off, is still shown', async () => {
		renderApp(<OverviewPage />, {
			status: HOSTED,
			routes: {
				'GET /api/domains': { domains: [], pending_claims: [claim(), claim('harbor-lane.org', 6)] },
				'GET /api/domains/summaries': { summaries: [], next_after: null, window_days: 30 },
				'GET /api/team/handoffs': { handoffs: [handoff] },
				'GET /api/domains/claims/6/preview': fail(502),
				'GET /api/domains/dns-host': host('godaddy', 'GoDaddy'),
				'GET /api/cloudflare/connections': conns,
			},
		});
		await screen.findByTestId('handoff-card');
		const region = await screen.findByRole('region', { name: 'Waiting for verification' });
		expect(within(region).getByText('harbor-lane.org')).toBeInTheDocument();
		expect(within(region).queryByText('brightwave-mail.com')).toBeNull();
	});
});

describe('10: a sign-up that ended says so, keeps the email, and asks for the password again', () => {
	const open = (route: string, pending: unknown, extra: Record<string, unknown> = {}) =>
		renderApp(<><AuthPage initialMode="signup" /><Where /></>, { route, role: null, status: HOSTED, routes: { 'GET /api/auth/signup/pending': pending, ...extra } });
	it('the code expired while S2 was open: S1, the reason, the email filled in, the password field focused', async () => {
		sessionStorage.setItem('rsm_signup_email', 'dana@brightwave-mail.com');
		open('/signup/about', { pending: true, email: 'dana@brightwave-mail.com', step: 'about', expires_in: 5 }, { 'POST /api/auth/signup/profile': { __status: 410, body: { error: 'expired', code: 'code_expired' } } });
		const user = userEvent.setup();
		await user.type(await screen.findByLabelText('Your name'), 'Dana');
		await user.type(screen.getByLabelText('Organization name'), 'Brightwave');
		await user.click(screen.getByRole('radio', { name: "My company's" }));
		await user.click(screen.getByRole('button', { name: 'Continue' }));
		const note = await screen.findByTestId('signup-expired');
		expect(note).toHaveTextContent('Your sign-up for dana@brightwave-mail.com timed out, so its code no longer works. Enter your password again');
		expect(screen.getByLabelText('Work email')).toHaveValue('dana@brightwave-mail.com');
		expect(screen.getByLabelText('Password')).toHaveFocus();
		expect(screen.getByTestId('where')).toHaveTextContent('/signup');
	});
	it('the tab comes back after the attempt ended: the same explanation, not an empty form', async () => {
		sessionStorage.setItem('rsm_signup_email', 'dana@brightwave-mail.com');
		open('/signup', { pending: false });
		expect(await screen.findByTestId('signup-expired')).toBeInTheDocument();
		expect(screen.getByLabelText('Work email')).toHaveValue('dana@brightwave-mail.com');
	});
	it('a first visit has no such note, and a refused send does not leave an address behind', async () => {
		open('/signup', { pending: false }, { 'POST /api/auth/signup': fail(429, 'Too many requests') });
		const user = userEvent.setup();
		await user.type(await screen.findByLabelText('Work email'), 'dana@brightwave-mail.com');
		await user.type(screen.getByLabelText('Password'), 'long-enough-1');
		await user.click(screen.getByRole('button', { name: 'Continue' }));
		await screen.findByRole('alert');
		expect(screen.queryByTestId('signup-expired')).toBeNull();
		expect(sessionStorage.getItem('rsm_signup_email')).toBeNull();
	});
});

describe('11: a cancelled Cloudflare consent goes back to S4 with the plain sentence and the records path', () => {
	it('access_denied: no red box on a dead end; S4, the sentence, and "I\'ll add the records myself"', async () => {
		window.history.replaceState(null, '', '/?cf_error=access_denied#/setup/cloudflare');
		renderApp(
			<Routes>
				<Route path="/setup/cloudflare" element={<CloudflareWizardPage />} />
				<Route path="/setup" element={<><SetupDomain /><Where /></>} />
			</Routes>,
			{
				route: '/setup/cloudflare',
				status: { ...HOSTED, has_domain: false },
				routes: {
					'GET /api/cloudflare/connections': conns,
					'GET /api/domains': { domains: [], pending_claims: [claim()] },
					'GET /api/domains/claims/5/preview': fail(502),
					'GET /api/domains/dns-host': host('cloudflare', 'Cloudflare'),
				},
			},
		);
		const note = await screen.findByTestId('cf-did-not-connect');
		expect(note).toHaveTextContent("Cloudflare didn't connect, so nothing changed. Try again, or add the records yourself.");
		expect(screen.getByTestId('where')).toHaveTextContent('/setup');
		expect(screen.getByRole('button', { name: 'Connect Cloudflare' })).toBeInTheDocument();
		expect(screen.getByRole('button', { name: "I'll add the records myself" })).toBeInTheDocument();
		expect(screen.queryByText(/access was not granted/)).toBeNull();
	});
});

describe('12: coming back to the app root in the middle of a sign-up resumes it', () => {
	const root = (pending: unknown) =>
		renderApp(<Routes><Route path="/" element={<AuthPage />} /><Route path="*" element={<Where />} /></Routes>, { route: '/', role: null, status: HOSTED, routes: { 'GET /api/auth/signup/pending': pending } });
	it('a pending code step: the root goes to it, not to "Sign in"', async () => {
		root({ pending: true, email: 'dana@brightwave-mail.com', step: 'code', expires_in: 300 });
		await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent('/signup/code'));
	});
	it('a pending about-you step goes to S2', async () => {
		root({ pending: true, email: 'dana@brightwave-mail.com', step: 'about', expires_in: 300 });
		await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent('/signup/about'));
	});
	it('nothing pending: the sign-in form as before', async () => {
		root({ pending: false });
		expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
	});
});

describe('13: the page looks for the record itself (15 s for 10 minutes, then every minute) and moves on when it is there', () => {
	it('the schedule', () => {
		expect([POLL_FAST_MS, POLL_SLOW_MS, POLL_FAST_FOR_MS]).toEqual([15_000, 60_000, 600_000]);
		expect(pollDelay(0)).toBe(15_000);
		expect(pollDelay(POLL_FAST_FOR_MS - 1)).toBe(15_000);
		expect(pollDelay(POLL_FAST_FOR_MS)).toBe(60_000);
	});

	it('the hook: 40 looks in the first 10 minutes, then one a minute; none while disabled or hidden', async () => {
		vi.useFakeTimers();
		const look = vi.fn(async () => {});
		const { rerender, unmount } = renderHook(({ on }) => useDnsPoll(look, on, 'k'), { initialProps: { on: false } });
		await vi.advanceTimersByTimeAsync(60_000);
		expect(look).not.toHaveBeenCalled();
		rerender({ on: true });
		await vi.advanceTimersByTimeAsync(14_999);
		expect(look).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(1);
		expect(look).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(POLL_FAST_FOR_MS - 15_000);
		expect(look).toHaveBeenCalledTimes(40);
		await vi.advanceTimersByTimeAsync(59_000);
		expect(look).toHaveBeenCalledTimes(40);
		await vi.advanceTimersByTimeAsync(1_000);
		expect(look).toHaveBeenCalledTimes(41);
		Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
		await vi.advanceTimersByTimeAsync(180_000);
		expect(look).toHaveBeenCalledTimes(41);
		Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
		unmount();
		await vi.advanceTimersByTimeAsync(180_000);
		expect(look).toHaveBeenCalledTimes(41);
	});

	it('a failed look is ignored and the next one is still made', async () => {
		vi.useFakeTimers();
		const look = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(undefined);
		renderHook(() => useDnsPoll(look, true, 'k'));
		await vi.advanceTimersByTimeAsync(30_000);
		expect(look).toHaveBeenCalledTimes(2);
	});

	it('the record card: silent looks at 15 s, nothing shown while it is not there, and it moves on when the record is found', async () => {
		vi.useFakeTimers({ shouldAdvanceTime: true });
		let verifies = 0;
		const onVerified = vi.fn();
		const { calls } = renderApp(<ClaimCard claim={claim()} recordsOnly canWrite onVerified={onVerified} />, {
			status: HOSTED,
			routes: {
				'GET /api/domains/dns-host': host('godaddy', 'GoDaddy'),
				'GET /api/cloudflare/connections': conns,
				'POST /api/domains/claims/5/verify': () => (++verifies < 3 ? { __status: 422, body: { error: 'not found', code: 'not_found_yet' } } : { domain: { id: 9, domain: 'brightwave-mail.com' } }),
			},
		});
		expect(await screen.findByText(/We look for it ourselves every 15 seconds while this page is open\./)).toBeInTheDocument();
		const posts = () => calls.filter((c) => c.path === '/api/domains/claims/5/verify').length;
		await act(async () => { await vi.advanceTimersByTimeAsync(14_000); });
		expect(posts()).toBe(0);
		await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
		expect(posts()).toBe(1);
		expect(screen.queryByRole('alert')).toBeNull(); // not there yet: nothing is said
		expect(onVerified).not.toHaveBeenCalled();
		await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
		expect(posts()).toBe(3);
		expect(onVerified).toHaveBeenCalledTimes(1);
		await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
		expect(posts()).toBe(3); // found: it stops looking
	});

	it('the first-day card waiting for the report address: it reads public DNS again by itself and the card changes', async () => {
		vi.useFakeTimers({ shouldAdvanceTime: true });
		const summary = (rua: number) => ({ domain_id: 7, domain: 'brightwave-mail.com', dmarc_policy: 'none', spf_record: null, total_messages: 0, pass_messages: 0, fail_messages: 0, dkim_total: 0, dkim_pass: 0, spf_total: 0, spf_pass: 0, mta_sts_enabled: 0, mta_sts_mode: null, dmarc_rua: rua, dns_checked_at: now() - 60, dns_check_attempted_at: now() - 60, dns_check_status: 'ok', report_connect: { can_connect: true, refusal: null, refusal_kind: null } });
		let rua = 0;
		const domain = { id: 7, domain: 'brightwave-mail.com', dmarc_policy: 'none', rua_address: 'rua@reports.readysetmail.com', parent_id: null, created_at: now() - 600, alerts_enabled: 1, is_default: 0, cf_account_id: null, verified_via: 'txt' };
		const { calls } = renderApp(<OverviewPage />, {
			status: HOSTED,
			routes: {
				'GET /api/domains': { domains: [domain], pending_claims: [] },
				'GET /api/domains/7/check-summary': () => summary(rua),
				'GET /api/domains/summaries': () => ({ summaries: [summary(rua)], next_after: null, window_days: 30 }),
				'GET /api/domains/7/stats': { domain: 'x', days: 30, stats: [] },
				'GET /api/team/handoffs': { handoffs: [] },
				'GET /api/cloudflare/connections': conns,
				'POST /api/onboarding/first-check': () => { rua = 1; return { results: [{ domain_id: 7, stored: true }] }; },
			},
		});
		const card = await screen.findByTestId('first-day');
		expect(within(card).getByRole('heading', { name: /Waiting for the report address/ })).toBeInTheDocument();
		await act(async () => { await vi.advanceTimersByTimeAsync(16_000); });
		expect(calls.filter((c) => c.path === '/api/onboarding/first-check').map((c) => c.body)).toEqual([{ domain_ids: [7] }]);
		expect(await screen.findByRole('heading', { name: 'Your first reports are on their way' })).toBeInTheDocument();
	});
});

describe('14: S4 uses the width of a wide screen', () => {
	const s4 = (routes: Record<string, unknown> = {}) =>
		renderApp(<SetupDomain />, { route: '/setup', status: { ...HOSTED, has_domain: false }, routes: { 'GET /api/domains': { domains: [], pending_claims: [] }, 'GET /api/cloudflare/connections': conns, ...routes } });
	it('asking for the domain: the form beside a "What happens next" panel from lg, hidden below it', async () => {
		s4();
		const aside = await screen.findByRole('complementary', { name: 'What happens next' });
		expect(aside.className).toMatch(/max-lg:hidden/);
		expect(screen.getByTestId('setup-domain').className).toMatch(/lg:max-w-5xl/);
	});
	it('after a domain: the domain and result on the left, the setup choice on the right (two columns from lg, one on a phone)', async () => {
		s4({ 'GET /api/domains': { domains: [], pending_claims: [claim()] }, 'GET /api/domains/claims/5/preview': fail(502), 'GET /api/domains/dns-host': host('cloudflare', 'Cloudflare') });
		const cols = await screen.findByTestId('s4-columns');
		expect(cols.className).toMatch(/lg:grid-cols-\[/);
		expect(await within(screen.getByTestId('s4-choice')).findByRole('button', { name: 'Connect Cloudflare' })).toBeInTheDocument();
		expect(within(cols).getByTestId('dns-result')).toBeInTheDocument();
		expect(within(screen.getByTestId('s4-choice')).queryByTestId('dns-result')).toBeNull();
	});
});
