// Hand setup to a teammate: H1 (the page), the link on S4 and C2, I1 (the invitee), H2 (the inviter's dashboard card).
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes, useLocation } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HAND_OFF_ENABLED, rememberFocusDomain } from '../src/lib/first-run';
import { workspaceStore } from '../src/lib/workspace';
import { InvitePage } from '../src/pages/auth/InvitePage';
import { OverviewPage } from '../src/pages/domains/OverviewPage';
import { HandOffPage } from '../src/pages/setup/HandOffPage';
import { ReviewPage } from '../src/pages/setup/ReviewPage';
import { SetupWizardPage } from '../src/pages/wizards/SetupWizardPage';
import { fail, me, renderApp } from './render';

beforeEach(() => {
	localStorage.clear();
	sessionStorage.clear();
});

const HOSTED = { mode: 'saas' as const, signup_open: true, configured: true, has_domain: true };
const now = () => Math.floor(Date.now() / 1000);
const row = (extra = {}) => ({ id: 7, domain: 'brightwave-mail.com', dmarc_policy: null, rua_address: '', parent_id: null, created_at: now() - 600, alerts_enabled: 1, is_default: 0, cf_account_id: null, verified_via: 'txt', ...extra });
const claim = { id: 5, domain: 'brightwave-mail.com', status: 'pending', txt_name: '_readysetmail.brightwave-mail.com', txt_value: 'readysetmail-verify=abc', created_at: 1, last_checked_at: null, last_error: null };
const handoff = (extra = {}) => ({ id: 'abc123', email: 'sam@brightwave-mail.com', domain: 'brightwave-mail.com', sent_at: now() - 3600, expires_at: now() + 6 * 86400, joined_at: null, ...extra });
function S4Stub() {
	return <p>s4 for {new URLSearchParams(useLocation().search).get('domain')}</p>;
}
function Where() {
	return <output data-testid="where">{useLocation().pathname + useLocation().search}</output>;
}
const where = () => screen.getByTestId('where').textContent;

describe('the link is on, and only for an owner who has a domain', () => {
	it('is enabled', () => expect(HAND_OFF_ENABLED).toBe(true));

	const s4 = (role: 'owner' | 'admin') =>
		renderApp(
			<>
				<Routes>
					<Route path="/setup" element={<SetupWizardPage />} />
				</Routes>
				<Where />
			</>,
			{
				route: '/setup',
				role,
				status: { ...HOSTED, has_domain: false },
				routes: {
					'GET /api/domains': { domains: [], pending_claims: [claim] },
					'GET /api/domains/claims/5/preview': fail(502),
					'GET /api/domains/dns-host': { provider: { id: 'godaddy', name: 'GoDaddy' }, nameservers: [], status: 'known' },
					'GET /api/cloudflare/connections': { connections: [], oauth: { available: true, scopes: [], via_relay: false }, token_paste: true, encryption_configured: true },
				},
			},
		);

	it('S4: "Not the one setting this up? Hand setup to a teammate →" for the owner, once a domain is entered', async () => {
		s4('owner');
		const link = await screen.findByRole('link', { name: 'Hand setup to a teammate →' });
		expect(link).toHaveAttribute('href', '/setup/hand-off?domain=brightwave-mail.com');
		expect(link.closest('p')).toHaveTextContent('Not the one setting this up? Hand setup to a teammate →');
	});

	it('S4: an admin cannot invite an admin, so no link', async () => {
		s4('admin');
		await screen.findByRole('heading', { name: /GoDaddy|brightwave-mail\.com/ });
		expect(screen.queryByRole('link', { name: /Hand setup/ })).toBeNull();
	});

	it('C2 has the same link for the owner', async () => {
		rememberFocusDomain('ws_default', 'brightwave-mail.com');
		renderApp(<Routes><Route path="/setup/review" element={<ReviewPage />} /></Routes>, {
			route: '/setup/review',
			status: HOSTED,
			routes: {
				'GET /api/domains': { domains: [row({ cf_account_id: 'a1', verified_via: 'cloudflare' })], pending_claims: [] },
				'GET /api/cloudflare/connections': { connections: [], oauth: { available: true, scopes: [], via_relay: false }, token_paste: true, encryption_configured: true },
				'POST /api/onboarding/dns-plan': { plan_id: 'p', steps: [{ key: 'dmarc', writes: [], satisfied: true }], not_written: [] },
			},
		});
		expect(await screen.findByRole('link', { name: 'Hand setup to a teammate →' })).toHaveAttribute('href', '/setup/hand-off?domain=brightwave-mail.com');
	});
});

describe('H1: the hand-off page', () => {
	const open = (opts: { role?: 'owner' | 'admin'; status?: Record<string, unknown>; routes?: Record<string, unknown>; route?: string } = {}) =>
		renderApp(
			<>
				<Routes>
					<Route path="/setup/hand-off" element={<HandOffPage />} />
					<Route path="/" element={<p>dashboard</p>} />
					<Route path="/setup" element={<p>s4</p>} />
				</Routes>
				<Where />
			</>,
			{
				route: opts.route ?? '/setup/hand-off?domain=brightwave-mail.com',
				role: opts.role ?? 'owner',
				status: { ...HOSTED, ...opts.status },
				routes: {
					'GET /api/domains': { domains: [row()], pending_claims: [] },
					'GET /api/workspaces': { workspaces: [{ id: 'ws_default', name: 'Brightwave Studio', role: 'owner', member_count: 1 }] },
					'POST /api/team/invite': { __status: 201, body: { token: 't', emailed: true } },
					...opts.routes,
				},
			},
		);

	it('names the workspace and the domain, asks one thing, and carries the spec\'s footer', async () => {
		open();
		expect(await screen.findByRole('heading', { name: 'Hand setup to a teammate' })).toBeInTheDocument();
		expect(await screen.findByText(/They join/)).toHaveTextContent('They join Brightwave Studio as an admin and pick up where you are: brightwave-mail.com. You keep full access as the owner.');
		expect(screen.getByLabelText('Their work email')).toBeInTheDocument();
		expect(screen.getAllByRole('button', { name: 'Send invitation' })).toHaveLength(1);
		expect(screen.getByText("We email them a fixed invitation when they're at your company's domain; otherwise you get a link to send. The link works for 7 days. An admin can add domains, connect Cloudflare and apply changes; only you, the owner, can add other admins, manage API keys and agents, or hand over ownership.")).toBeInTheDocument();
		expect(document.querySelectorAll('textarea')).toHaveLength(0); // no free text: nobody can put their own words in a message from us
	});

	it('sends the ordinary invite as an admin with the domain, then says it was sent', async () => {
		const { calls } = open();
		const user = userEvent.setup();
		await user.type(await screen.findByLabelText('Their work email'), 'sam@brightwave-mail.com');
		await user.click(screen.getByRole('button', { name: 'Send invitation' }));
		expect(await screen.findByRole('heading', { name: 'Invitation sent' })).toBeInTheDocument();
		expect(screen.getByText(/sam@brightwave-mail\.com/)).toBeInTheDocument();
		expect(calls.find((c) => c.path === '/api/team/invite')?.body).toEqual({ email: 'sam@brightwave-mail.com', role: 'admin', handoff_domain: 'brightwave-mail.com' });
		await user.click(screen.getByRole('button', { name: 'Go to the dashboard' }));
		expect(where()).toBe('/');
	});

	it('link only: the same screen shows the link, "Copy link" is the one primary, and one plain line says they send it themselves', async () => {
		const url = 'https://app.example/#/invite/abc';
		open({ routes: { 'POST /api/team/invite': { __status: 201, body: { token: 'abc', url, emailed: false } } } });
		const user = userEvent.setup();
		const writeText = vi.spyOn(navigator.clipboard, 'writeText');
		await user.type(await screen.findByLabelText('Their work email'), 'dev@pixelforge.dev');
		await user.click(screen.getByRole('button', { name: 'Send invitation' }));
		expect(await screen.findByRole('heading', { name: 'Send dev@pixelforge.dev this link' })).toBeInTheDocument();
		expect(screen.getByText(/Send it to them yourself\./)).toHaveTextContent('Send it to them yourself. It works once, for 7 days, and lets them join Brightwave Studio as an admin to finish brightwave-mail.com.');
		expect(screen.getByLabelText('Invitation link')).toHaveValue(url);
		expect(screen.getByLabelText('Invitation link')).toHaveAttribute('readonly');
		expect(screen.queryByRole('alert')).toBeNull(); // not an error
		expect(screen.getAllByRole('button')).toHaveLength(1); // Copy link is the only button; the way out is a link
		await user.click(screen.getByRole('button', { name: 'Copy link' }));
		expect(writeText).toHaveBeenCalledWith(url);
		expect(await screen.findByRole('button', { name: 'Copied' })).toBeInTheDocument();
		await user.click(screen.getByRole('link', { name: 'Go to the dashboard' }));
		expect(where()).toBe('/');
	});

	it('a wrong address is named, with nothing sent', async () => {
		const { calls } = open();
		const user = userEvent.setup();
		await user.type(await screen.findByLabelText('Their work email'), 'sam');
		await user.click(screen.getByRole('button', { name: 'Send invitation' }));
		expect(screen.getByLabelText('Their work email')).toHaveAccessibleDescription('Enter an email address like name@company.com');
		expect(calls.some((c) => c.path === '/api/team/invite')).toBe(false);
	});

	it('already a member, too many waiting, and a refused send are said in words', async () => {
		for (const [res, text] of [
			[fail(409, 'this person is already a member of the workspace'), /already a member of this workspace/],
			[{ __status: 429, body: { error: '5 hand-offs are already waiting. Revoke one or wait for it to be accepted.', code: 'handoff_limit' } }, /5 hand-offs are already waiting/],
			[{ __status: 503, body: { error: "We couldn't send the invitation just now. Try again in a minute.", code: 'handoff_not_sent' } }, /couldn't send the invitation just now/],
		] as const) {
			const { unmount } = open({ routes: { 'POST /api/team/invite': res } });
			const user = userEvent.setup();
			await user.type(await screen.findByLabelText('Their work email'), 'sam@brightwave-mail.com');
			await user.click(screen.getByRole('button', { name: 'Send invitation' }));
			expect((await screen.findAllByText(text)).length).toBeGreaterThan(0);
			expect(screen.queryByRole('heading', { name: 'Invitation sent' })).toBeNull();
			unmount();
		}
	});

	it('only an owner on the hosted service: an admin and self-host go back', async () => {
		const a = open({ role: 'admin' });
		expect(await screen.findByText('dashboard')).toBeInTheDocument();
		a.unmount();
		open({ status: { mode: 'self-host' } });
		expect(await screen.findByText('dashboard')).toBeInTheDocument();
	});

	it('a domain that is not in this workspace is not offered: it falls back to the workspace\'s own', async () => {
		const { calls } = open({ route: '/setup/hand-off?domain=evil.example' });
		const user = userEvent.setup();
		await user.type(await screen.findByLabelText('Their work email'), 'sam@brightwave-mail.com');
		await user.click(screen.getByRole('button', { name: 'Send invitation' }));
		await screen.findByRole('heading', { name: 'Invitation sent' });
		expect(calls.find((c) => c.path === '/api/team/invite')?.body).toMatchObject({ handoff_domain: 'brightwave-mail.com' });
	});
});

describe('I1: the invitee', () => {
	const info = (extra = {}) => ({ email: 'sam@brightwave-mail.com', invited_by: 'dana@brightwave-mail.com', inviter_name: 'Dana Whitfield', role: 'admin', workspace_id: 'ws_a', workspace_name: 'Brightwave Studio', user_exists: false, signed_in_as: null, ...extra });
	const page = (routes: Record<string, unknown>, loggedIn = () => false) => {
		// The invite's workspace is already remembered, so signing in does not re-key the session queries (and remount this test's router).
		workspaceStore.remember('ws_a');
		return renderApp(
			<>
				<Routes>
					<Route path="/invite/:token" element={<InvitePage />} />
					<Route path="/setup" element={<S4Stub />} />
					<Route path="/" element={<p>dashboard</p>} />
				</Routes>
				<Where />
			</>,
			{ role: null, route: '/invite/tok1', status: HOSTED, routes: { 'GET /api/me': () => (loggedIn() ? me('admin') : fail(401)), ...routes } },
		);
	};

	it('a hand-off: "Join <workspace> on Ready Set Mail", what to finish, who asked, admin; a password, no name, no profile', async () => {
		page({ 'GET /api/invites/tok1': info({ handoff: { domain: 'brightwave-mail.com', inviter_name: 'Dana Whitfield' } }) });
		expect(await screen.findByRole('heading', { name: 'Join Brightwave Studio on Ready Set Mail' })).toBeInTheDocument();
		expect(screen.getByText(/asked you to finish setting up email authentication for/)).toHaveTextContent("Dana Whitfield asked you to finish setting up email authentication for brightwave-mail.com. You'll join as an admin.");
		expect(screen.getByLabelText('Choose a password')).toBeInTheDocument();
		expect(screen.queryByLabelText(/name|organization/i)).toBeNull();
	});

	it('an ordinary invite keeps its words: "<name> invited you as an Admin."', async () => {
		page({ 'GET /api/invites/tok1': info() });
		expect(await screen.findByRole('heading', { name: 'You are invited' })).toBeInTheDocument();
		expect(screen.getByText(/invited you as/)).toHaveTextContent('Dana Whitfield invited you as an Admin.');
		expect(screen.queryByText(/finish setting up/)).toBeNull();
	});

	it('falls back to the inviter\'s address when they have no name, and says "a Member" for a member', async () => {
		page({ 'GET /api/invites/tok1': info({ inviter_name: null, role: 'member' }) });
		expect(await screen.findByText(/invited you as/)).toHaveTextContent('dana@brightwave-mail.com invited you as a Member.');
	});

	it('password, then the code, then that domain\'s first screen (S4), with no S2 in between', async () => {
		let done = false;
		const { calls } = page(
			{
				'GET /api/invites/tok1': info({ handoff: { domain: 'brightwave-mail.com', inviter_name: 'Dana Whitfield' } }),
				'POST /api/invites/tok1': { code_required: true, purpose: 'invite', email: 'sam@brightwave-mail.com', expires_in: 600 },
				'POST /api/auth/code': () => ((done = true), { purpose: 'invite', workspace_id: 'ws_a', handoff_domain: 'brightwave-mail.com' }),
			},
			() => done,
		);
		const user = userEvent.setup();
		await user.type(await screen.findByLabelText('Choose a password'), 'sams-password-1');
		await user.click(screen.getByRole('button', { name: 'Accept invite' }));
		await user.type(await screen.findByLabelText('6-digit code'), '482190');
		expect(await screen.findByText('s4 for brightwave-mail.com')).toBeInTheDocument();
		expect(where()).toBe('/setup?domain=brightwave-mail.com');
		expect(calls.map((c) => c.path).filter((p) => p.startsWith('/api/auth/') && p !== '/api/auth/status')).toEqual(['/api/auth/code']);
	});

	it('an ordinary invite lands on the dashboard', async () => {
		let done = false;
		page(
			{
				'GET /api/invites/tok1': info(),
				'POST /api/invites/tok1': { code_required: true, purpose: 'invite', email: 'sam@brightwave-mail.com', expires_in: 600 },
				'POST /api/auth/code': () => ((done = true), { purpose: 'invite', workspace_id: 'ws_a' }),
			},
			() => done,
		);
		const user = userEvent.setup();
		await user.type(await screen.findByLabelText('Choose a password'), 'sams-password-1');
		await user.click(screen.getByRole('button', { name: 'Accept invite' }));
		await user.type(await screen.findByLabelText('6-digit code'), '482190');
		expect(await screen.findByText('dashboard')).toBeInTheDocument();
	});

	it('someone who already has a login accepts with one click and lands on that domain', async () => {
		page({
			'GET /api/invites/tok1': info({ user_exists: true, signed_in_as: 'sam@brightwave-mail.com', handoff: { domain: 'brightwave-mail.com', inviter_name: 'Dana Whitfield' } }),
			'POST /api/invites/tok1': { ok: true, workspace_id: 'ws_a', workspace_name: 'Brightwave Studio', handoff_domain: 'brightwave-mail.com' },
			'GET /api/workspaces': { workspaces: [] },
		}, () => true);
		await userEvent.setup().click(await screen.findByRole('button', { name: 'Accept invite' }));
		await waitFor(() => expect(window.location.hash).toBe('#/w/ws_a/setup?domain=brightwave-mail.com'));
	});
});

describe('S4 opened on a named domain (the invitee, or "Finish it myself")', () => {
	it('shows that domain even though the workspace already has domains', async () => {
		renderApp(<Routes><Route path="/setup" element={<SetupWizardPage />} /></Routes>, {
			route: '/setup?domain=brightwave-mail.com',
			status: HOSTED,
			routes: {
				'GET /api/domains': { domains: [], pending_claims: [claim] },
				'GET /api/domains/claims/5/preview': fail(502),
				'GET /api/domains/dns-host': { provider: { id: 'godaddy', name: 'GoDaddy' }, nameservers: [], status: 'known' },
				'GET /api/cloudflare/connections': { connections: [], oauth: { available: true, scopes: [], via_relay: false }, token_paste: true, encryption_configured: true },
			},
		});
		expect(await screen.findByRole('heading', { name: 'brightwave-mail.com uses GoDaddy for DNS' })).toBeInTheDocument();
	});

	it('an added domain opens on its choice, not the dashboard', async () => {
		renderApp(<Routes><Route path="/setup" element={<SetupWizardPage />} /><Route path="/" element={<p>dashboard</p>} /></Routes>, {
			route: '/setup?domain=brightwave-mail.com',
			status: HOSTED,
			routes: {
				'GET /api/domains': { domains: [row()], pending_claims: [] },
				'GET /api/domains/7/onboarding-status': { domain_id: 7, domain: 'brightwave-mail.com', rua_address: '', cf_available: true, dmarc: { found: false, has_our_rua: false, current_record: null }, spf: { record: null, lookup_count: null, flattening_active: false }, dkim: { selectors: [], source: 'doh' }, routing: {} },
				'GET /api/domains/dns-host': { provider: { id: 'godaddy', name: 'GoDaddy' }, nameservers: [], status: 'known' },
				'GET /api/cloudflare/connections': { connections: [], oauth: { available: true, scopes: [], via_relay: false }, token_paste: true, encryption_configured: true },
			},
		});
		await waitFor(() => expect(screen.getByTestId('dns-result')).toHaveTextContent('brightwave-mail.com: 3 things to fix'));
		expect(screen.queryByText('dashboard')).toBeNull();
	});
});

describe('H2: the inviter\'s dashboard', () => {
	const summary = (extra = {}) => ({ domain_id: 7, domain: 'brightwave-mail.com', dmarc_policy: null, spf_record: null, total_messages: 0, pass_messages: 0, fail_messages: 0, dkim_total: 0, dkim_pass: 0, spf_total: 0, spf_pass: 0, mta_sts_enabled: 0, mta_sts_mode: null, dmarc_rua: 0, dns_checked_at: now() - 60, dns_check_attempted_at: now() - 60, dns_check_status: 'ok', report_connect: { can_connect: true, refusal: null, refusal_kind: null }, ...extra });
	const dash = (opts: { handoffs?: unknown[]; role?: 'owner' | 'member' | 'admin'; status?: Record<string, unknown>; sum?: Record<string, unknown>; dom?: Record<string, unknown>; routes?: Record<string, unknown> } = {}) =>
		renderApp(<OverviewPage />, {
			role: opts.role ?? 'owner',
			status: { ...HOSTED, ...opts.status },
			routes: {
				'GET /api/domains': { domains: [row(opts.dom)], pending_claims: [] },
				'GET /api/domains/7/check-summary': summary(opts.sum),
				'GET /api/domains/summaries': { summaries: [summary(opts.sum)], next_after: null, window_days: 30 },
				'GET /api/domains/7/stats': { domain: 'x', days: 30, stats: [] },
				'GET /api/team/handoffs': { handoffs: opts.handoffs ?? [handoff()] },
				'GET /api/cloudflare/connections': { connections: [], oauth: { available: true, scopes: [], via_relay: false }, token_paste: true, encryption_configured: true },
				...opts.routes,
			},
		});
	const card = () => screen.findByTestId('handoff-card');

	it('not joined yet: "<email> is finishing setup", the invitation, "Not yet; the link works until <date>", Resend, Finish it myself', async () => {
		dash();
		const c = await card();
		expect(within(c).getByRole('heading', { name: 'sam@brightwave-mail.com is finishing setup' })).toBeInTheDocument();
		const items = within(c).getAllByRole('listitem');
		expect(items[0]).toHaveTextContent('Done: Invitation sent to sam@brightwave-mail.com');
		expect(items[1]).toHaveTextContent(/Waiting: Not yet; the link works until /);
		expect(items[2]).toHaveTextContent('Later: Connect Cloudflare or add the records · not started');
		expect(items[3]).toHaveTextContent('First reports');
		expect(within(c).getByRole('button', { name: 'Resend invitation' })).toBeInTheDocument();
		expect(within(c).getByRole('link', { name: 'Finish it myself' })).toHaveAttribute('href', '/setup?domain=brightwave-mail.com');
		expect(screen.queryByTestId('first-day')).toBeNull(); // it replaces the first-day card
		expect(c.querySelector('.text-danger, [role="alert"]')).toBeNull();
	});

	it('the link expired: says so, and Resend is still there', async () => {
		dash({ handoffs: [handoff({ expires_at: now() - 3600, sent_at: now() - 8 * 86400 })] });
		const c = await card();
		expect(within(c).getByText(/Not yet; the link expired on /)).toBeInTheDocument();
		expect(within(c).getByRole('button', { name: 'Resend invitation' })).toBeInTheDocument();
	});

	it('Resend asks the server, says the old link is dead, and keeps the card', async () => {
		const { calls } = dash({ routes: { 'POST /api/team/handoffs/abc123/resend': { __status: 201, body: { token: 't2', emailed: true } } } });
		await userEvent.setup().click(within(await card()).getByRole('button', { name: 'Resend invitation' }));
		expect(await screen.findByText('Sent again to sam@brightwave-mail.com. The previous link no longer works.')).toBeInTheDocument();
		expect(calls.some((c) => c.method === 'POST' && c.path === '/api/team/handoffs/abc123/resend')).toBe(true);
	});

	it('a link-only hand-off says so, and "Get a new link" shows the new link', async () => {
		dash({ handoffs: [handoff({ emailed: false })], routes: { 'POST /api/team/handoffs/abc123/resend': { __status: 201, body: { token: 't2', url: 'https://app.example/#/invite/t2', emailed: false } } } });
		const c = await card();
		expect(within(c).getAllByRole('listitem')[0]).toHaveTextContent('Done: Link made for sam@brightwave-mail.com');
		await userEvent.setup().click(within(c).getByRole('button', { name: 'Get a new link' }));
		expect(await screen.findByText('Here is a new link. The previous link no longer works.')).toBeInTheDocument();
		expect(screen.getByLabelText('Invitation link')).toHaveValue('https://app.example/#/invite/t2');
	});

	it('joined, the record not proven yet: who joined and what they are waiting for; no Resend', async () => {
		dash({ handoffs: [handoff({ joined_at: now() - 120 })], routes: { 'GET /api/domains': { domains: [], pending_claims: [claim] }, 'GET /api/domains/summaries': { summaries: [], next_after: null, window_days: 30 } } });
		const c = await card();
		const items = within(c).getAllByRole('listitem');
		expect(items[1]).toHaveTextContent('Done: sam@brightwave-mail.com joined');
		expect(items[2]).toHaveTextContent('Waiting: Connect Cloudflare or add the records · waiting for the DNS record that proves brightwave-mail.com');
		expect(within(c).queryByRole('button', { name: 'Resend invitation' })).toBeNull();
	});

	it('joined, working on the DMARC record: in progress; written to Cloudflare: waiting for public DNS', async () => {
		const a = dash({ handoffs: [handoff({ joined_at: now() - 120 })] });
		expect(within(await card()).getAllByRole('listitem')[2]).toHaveTextContent('Waiting: Connect Cloudflare or add the records · in progress');
		a.unmount();
		localStorage.setItem('rsm_review_done:ws_default', 'applied');
		dash({ handoffs: [handoff({ joined_at: now() - 120 })] });
		await waitFor(async () => expect(within(await card()).getAllByRole('listitem')[2]).toHaveTextContent('written to Cloudflare, waiting for public DNS'));
	});

	it('the records are live: the card gives way to "Your first reports are on their way"', async () => {
		dash({ handoffs: [handoff({ joined_at: now() - 120 })], dom: { rua_address: 'rua@reports.readysetmail.com' }, sum: { dmarc_policy: 'none', dmarc_rua: 1 } });
		expect(await screen.findByRole('heading', { name: 'Your first reports are on their way' })).toBeInTheDocument();
		expect(screen.queryByTestId('handoff-card')).toBeNull();
	});

	it('an admin sees where it stands but cannot resend (only an owner invites an admin); a member and self-host see nothing', async () => {
		const a = dash({ role: 'admin' });
		const c = await card();
		expect(within(c).queryByRole('button', { name: 'Resend invitation' })).toBeNull();
		a.unmount();
		const m = dash({ role: 'member' });
		await screen.findByTestId('am-i-done');
		expect(screen.queryByTestId('handoff-card')).toBeNull();
		m.unmount();
		const { calls } = dash({ status: { mode: 'self-host' } });
		await screen.findByTestId('am-i-done');
		expect(screen.queryByTestId('handoff-card')).toBeNull();
		expect(calls.some((c) => c.path === '/api/team/handoffs')).toBe(false);
	});

	it('a hand-off for another domain does not take over this domain\'s card', async () => {
		dash({ handoffs: [handoff({ domain: 'other.example' })] });
		expect(await screen.findByTestId('first-day')).toBeInTheDocument();
		expect(screen.queryByTestId('handoff-card')).toBeNull();
	});
});
