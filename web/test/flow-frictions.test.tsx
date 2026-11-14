// The path from sign-up to a first verified domain, as walked before launch (2026-11-13): what each screen now says and asks.
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ClaimCard, NOT_VISIBLE_YET } from '../src/components/domain/ClaimCard';
import { previewAssessment, type ClaimPreviewData } from '../src/lib/claim-preview';
import { assessDomain } from '../src/lib/levels';
import type { AuthStatus } from '../src/lib/types';
import { AuthPage } from '../src/pages/auth/AuthPage';
import { InvitePage } from '../src/pages/auth/InvitePage';
import { WelcomePage } from '../src/pages/auth/WelcomePage';
import { DomainStep } from '../src/pages/wizards/setup/DomainStep';
import { fail, me, renderApp } from './render';

const HOSTED: Partial<AuthStatus> = { mode: 'saas', signup_open: true, configured: true, base_domain: null };

beforeEach(() => {
	localStorage.clear();
	sessionStorage.clear();
});

describe('1. one password, typed once, confirmed by an emailed code', () => {
	it('hosted sign-up asks for the email and one password, then the code', async () => {
		const { calls } = renderApp(<AuthPage initialMode="signup" />, {
			role: null,
			status: HOSTED,
			routes: { 'POST /api/auth/signup': { code_required: true, purpose: 'signup', email: 'new@example.com', expires_in: 600 } },
		});
		const user = userEvent.setup();
		await user.type(await screen.findByLabelText('Email'), 'new@example.com');
		await user.type(screen.getByLabelText('Password'), 'long-enough-1');
		expect(screen.queryByLabelText('Confirm password')).not.toBeInTheDocument();
		expect(screen.queryByLabelText('Your name (optional)')).not.toBeInTheDocument(); // Settings has it, after the address is proven
		expect(screen.getByText("We'll email you a 6-digit code to confirm it.")).toBeInTheDocument();
		await user.click(screen.getByRole('button', { name: 'Create account' }));
		expect(await screen.findByRole('heading', { name: 'Enter the 6-digit code we sent to new@example.com' })).toBeInTheDocument();
		expect(calls.find((c) => c.path === '/api/auth/signup')?.body).toEqual({ email: 'new@example.com', password: 'long-enough-1' });
		expect(screen.getByText(/This confirms your email address\./)).toBeInTheDocument();
	});

	it('an old confirmation link changes nothing and says what to do instead', async () => {
		const { calls } = renderApp(
			<Routes>
				<Route path="/welcome/:token" element={<WelcomePage />} />
			</Routes>,
			{ role: null, status: HOSTED, route: '/welcome/eyJhbGciOiJIUzI1NiJ9.eyJlbWFpbCI6ImFAYi5jIn0.sig' },
		);
		expect(await screen.findByRole('heading', { name: 'This link is no longer used' })).toBeInTheDocument();
		expect(screen.getByText("If you already chose a password, sign in. If you didn't, create your account again with the same email and we'll send you a code.")).toBeInTheDocument();
		expect(calls.some((c) => c.method === 'POST')).toBe(false);
	});

	it('hosted with sign-up closed: the sign-in form, and a plain sentence instead of "Create an account"', async () => {
		renderApp(<AuthPage />, { role: null, status: { ...HOSTED, signup_open: false, signin_available: true } });
		expect(await screen.findByRole('button', { name: 'Sign in' })).toBeInTheDocument();
		expect(screen.getByText("New accounts can't be created here right now. If you already have one, sign in.")).toBeInTheDocument();
		expect(screen.queryByRole('button', { name: 'Create an account' })).toBeNull();
		expect(screen.queryByText(/Ask an owner for an invite link/)).toBeNull();
	});

	it('a hosted invitee chooses a password, then confirms with the code', async () => {
		const { calls } = renderApp(
			<Routes>
				<Route path="/invite/:token" element={<InvitePage />} />
			</Routes>,
			{
				role: null,
				status: HOSTED,
				route: '/invite/t1',
				routes: {
					'GET /api/invites/t1': { email: 'new@example.com', invited_by: 'boss@example.com', role: 'member', workspace_name: 'Acme', user_exists: false },
					'POST /api/invites/t1': { code_required: true, purpose: 'invite', email: 'new@example.com', expires_in: 600 },
				},
			},
		);
		const user = userEvent.setup();
		await screen.findByRole('button', { name: 'Accept invite' });
		// no name before the address is proven
		expect(screen.queryByLabelText('Your name')).not.toBeInTheDocument();
		await user.type(screen.getByLabelText('Choose a password'), 'long-enough-1');
		await user.click(screen.getByRole('button', { name: 'Accept invite' }));
		expect(await screen.findByRole('heading', { name: 'Enter the 6-digit code we sent to new@example.com' })).toBeInTheDocument();
		expect(calls.find((c) => c.method === 'POST' && c.path === '/api/invites/t1')?.body).toEqual({ password: 'long-enough-1' });
	});
});

const claim = (over: Record<string, unknown> = {}) => ({ id: 5, domain: 'acme.io', status: 'pending' as const, txt_name: '_readysetmail.acme.io', txt_value: 'readysetmail-verify=abc', created_at: 1, last_checked_at: null, last_error: null, ...over });
const preview: ClaimPreviewData = {
	domain: 'acme.io',
	checked_at: new Date().toISOString(),
	source: 'public_dns',
	cached: false,
	nxdomain: false,
	spf: { status: 'found', record: 'v=spf1 include:_spf.google.com ~all', lookup_count: 3, over_limit: false },
	dmarc: { status: 'found', policy: 'reject', issue: null, inherited_from: null, record: 'v=DMARC1; p=reject', pct: 100 },
	dkim: { status: 'found', selectors: ['google._domainkey.acme.io'], scanned: 36, failed: 0 },
	mx: { status: 'found' },
	lookup_failed: [],
};

describe('3. coming back with a pending claim', () => {
	it('lands on the claim (public DNS and the record to publish), not an empty "Which domain" field', async () => {
		renderApp(<DomainStep onDomainSet={vi.fn()} />, {
			status: HOSTED,
			routes: { 'GET /api/domains': { domains: [], pending_claims: [claim()] }, 'GET /api/domains/claims/5/preview': preview, 'GET /api/zones': fail(400) },
		});
		expect(await screen.findByRole('heading', { name: 'Verify you own this domain' })).toBeInTheDocument();
		expect(screen.getByText('You added this domain earlier. It is waiting for the DNS record that proves it is yours.')).toBeInTheDocument();
		expect(await screen.findByRole('heading', { name: 'Public DNS for acme.io' })).toBeInTheDocument();
		expect(screen.getByText('readysetmail-verify=abc')).toBeInTheDocument();
		expect(screen.queryByLabelText('Domain')).not.toBeInTheDocument();
	});

	it('"Add a different domain" opens the field', async () => {
		renderApp(<DomainStep onDomainSet={vi.fn()} />, {
			status: HOSTED,
			routes: { 'GET /api/domains': { domains: [], pending_claims: [claim()] }, 'GET /api/domains/claims/5/preview': preview, 'GET /api/zones': fail(400) },
		});
		await userEvent.setup().click(await screen.findByRole('button', { name: 'Add a different domain' }));
		expect(screen.getByRole('heading', { name: 'Which domain do you send email from?' })).toBeInTheDocument();
		expect(screen.getByLabelText('Domain')).toBeInTheDocument();
	});

	it('a claim another workspace won is not offered for proof: the field shows', async () => {
		renderApp(<DomainStep onDomainSet={vi.fn()} />, {
			status: HOSTED,
			routes: { 'GET /api/domains': { domains: [], pending_claims: [claim({ status: 'lost' })] }, 'GET /api/zones': fail(400) },
		});
		expect(await screen.findByRole('heading', { name: 'Which domain do you send email from?' })).toBeInTheDocument();
	});
});

describe('7. Verify before the record is visible', () => {
	it('says plainly that DNS takes a few minutes and offers to check again', async () => {
		renderApp(<ClaimCard claim={claim()} />, {
			status: HOSTED,
			routes: { 'POST /api/domains/claims/5/verify': { __status: 422, body: { verified: false, code: 'not_found_yet', error: 'TXT record _readysetmail.acme.io = "readysetmail-verify=abc" not found yet (DNS changes can take a few minutes)', claim: claim() } } },
		});
		const user = userEvent.setup();
		await user.click(await screen.findByRole('button', { name: 'Verify' }));
		expect(await screen.findByRole('alert')).toHaveTextContent(NOT_VISIBLE_YET);
		expect(NOT_VISIBLE_YET).toBe("We don't see the record yet. DNS changes can take a few minutes to show up. Verify again in a minute.");
		const again = screen.getByRole('button', { name: 'Verify again' });
		expect(again).toBeEnabled();
		await user.click(again);
		await waitFor(() => expect(screen.getByRole('button', { name: 'Verify again' })).toBeEnabled());
	});

	it('the last check, on a later visit, is a sentence, not the raw record', async () => {
		renderApp(<ClaimCard claim={claim({ last_error: 'TXT record _readysetmail.acme.io = "readysetmail-verify=abc" not found yet (DNS changes can take a few minutes)' })} />, { status: HOSTED });
		expect(await screen.findByText('Last check: the record was not visible yet.')).toBeInTheDocument();
	});
});

describe('5. the same verdicts as the website', () => {
	const base = { spf_record: 'v=spf1 include:a include:b ~all', dmarc_policy: 'reject', dmarc_issue: null, dmarc_inherited_from: null, dns_checked_at: 1_800_000_000, dkim_total: 0, dkim_pass: 0, spf_total: 0, spf_pass: 0, mta_sts_enabled: 0, mta_sts_mode: null, spf_lookup_count: 3, dmarc_pct: 100 };
	const spf = (a: ReturnType<typeof assessDomain>) => a.findings.find((f) => String(f.label).startsWith('SPF'))!;
	const dmarc = (a: ReturnType<typeof assessDomain>) => a.findings.find((f) => String(f.label).startsWith('DMARC'))!;

	it('SPF at 10 of 10 lookups: within the limit, worth a note; the level stands', () => {
		const a = assessDomain({ ...base, spf_lookup_count: 10 });
		expect(a.level).toBe(2);
		expect(spf(a)).toMatchObject({ status: 'warn', label: 'SPF at the lookup limit: 10 of 10 DNS lookups', detail: 'At the limit, not over it, so SPF still works. One more include would make it fail for all your mail.' });
	});

	it('SPF at 8 or 9 is close to the limit (the website warns from 8)', () => {
		expect(spf(assessDomain({ ...base, spf_lookup_count: 8 }))).toMatchObject({ status: 'warn', label: 'SPF close to the lookup limit: 8 of 10 DNS lookups' });
		expect(spf(assessDomain({ ...base, spf_lookup_count: 7 }))).toMatchObject({ status: 'pass', label: 'SPF record published' });
	});

	it('SPF over 10 lookups is a permanent error: SPF fails, Level 0, and the next step says how to fix it', () => {
		const a = assessDomain({ ...base, spf_lookup_count: 11 });
		expect(a.level).toBe(0);
		expect(spf(a)).toMatchObject({ status: 'fail', label: 'SPF over the lookup limit: 11 of 10 DNS lookups' });
		expect(a.next).toBe('Bring SPF to 10 DNS lookups or fewer: remove includes you no longer use, or flatten the record.');
	});

	it('quarantine or reject under pct=100 is partly enforced: Level 1, not Protected', () => {
		const a = assessDomain({ ...base, dmarc_policy: 'quarantine', dmarc_pct: 50 });
		expect(a.level).toBe(1);
		expect(dmarc(a)).toMatchObject({ status: 'warn', label: 'DMARC partly enforced (p=quarantine, pct=50)' });
		expect(a.description).toBe('Receivers can verify your mail. DMARC blocks only part of the spoofed messages so far.');
		expect(a.next).toBe('Raise pct= to 100 to enforce DMARC on all mail.');
		expect(assessDomain({ ...base, dmarc_pct: 100 }).level).toBe(2);
	});

	it('pct= not recorded at the last check (stored before this change): the level stands, marked not re-checked yet', () => {
		const a = assessDomain({ ...base, dmarc_pct: null });
		expect(a.level).toBe(2);
		expect(dmarc(a)).toMatchObject({ status: 'pass', label: 'DMARC enforced (p=reject)' });
		expect(a.findings.find((f) => String(f.label).startsWith('Enforcement share'))).toMatchObject({ status: 'unknown', label: 'Enforcement share (pct=) not re-checked yet' });
		expect(a.next).toBeNull();
		// p=none is unaffected (fellowship.dev on staging)
		const none = assessDomain({ ...base, dmarc_policy: 'none', dmarc_pct: null });
		expect(none.level).toBe(1);
		expect(none.findings.some((f) => String(f.label).startsWith('Enforcement share'))).toBe(false);
	});

	it('the claim preview judges the same read the same way (github.com: 10 of 10 is a note, not a plain Pass)', () => {
		const p = previewAssessment({ ...preview, spf: { ...preview.spf, lookup_count: 10 } })!;
		expect(spf(p)).toMatchObject({ status: 'warn', label: 'SPF at the lookup limit: 10 of 10 DNS lookups' });
		expect(previewAssessment({ ...preview, dmarc: { ...preview.dmarc, pct: 25 } })!.level).toBe(1);
	});
});
