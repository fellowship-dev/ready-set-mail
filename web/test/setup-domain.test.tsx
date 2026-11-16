// S4, the one screen after sign-up: the domain, one line of public DNS, and the setup choice by who hosts DNS (hosted).
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes, useLocation } from 'react-router';
import { beforeEach, describe, expect, it } from 'vitest';
import { HAND_OFF_ENABLED, dnsFromPreview, dnsFromStatus, resultLine, setupChoice, type PublicDns } from '../src/lib/first-run';
import { rememberSignupDomain } from '../src/lib/signup-intent';
import { SetupWizardPage } from '../src/pages/wizards/SetupWizardPage';
import { fail, me, renderApp } from './render';

beforeEach(() => {
	localStorage.clear();
	sessionStorage.clear();
});

const HOSTED = { mode: 'saas' as const, signup_open: true, configured: true, has_domain: false, base_domain: null };
const claim = (domain: string, id = 5) => ({ id, domain, status: 'pending', txt_name: `_readysetmail.${domain}`, txt_value: 'readysetmail-verify=abc', created_at: 1, last_checked_at: null, last_error: null });
const preview = (domain: string, over: Record<string, unknown> = {}) => ({
	domain, checked_at: new Date().toISOString(), source: 'public_dns', cached: false, nxdomain: false,
	spf: { status: 'missing', record: null, lookup_count: null, over_limit: false },
	dmarc: { status: 'found', policy: 'quarantine', issue: null, inherited_from: null, record: 'v=DMARC1; p=quarantine; pct=50', pct: 50 },
	dkim: { status: 'not_found', selectors: [], scanned: 20, failed: 0 }, mx: { status: 'found' }, lookup_failed: [], ...over,
});
const host = (id: string | null, name = id ?? '') => (id ? { provider: { id, name }, nameservers: [`ns1.${id}.example`], status: 'known' } : { provider: null, nameservers: ['ns1.example-host.net'], status: 'unknown' });
const conns = (over: Record<string, unknown> = {}) => ({ connections: [], oauth: { available: true, scopes: [], via_relay: false }, token_paste: true, encryption_configured: true, ...over });
const held = { id: 'c1', label: 'Brightwave Studio', auth_type: 'oauth', status: 'active', status_detail: null, cf_account_id: 'acc1', cf_account_name: 'Brightwave Studio', scopes: [], zones: [{ id: 'z1', name: 'brightwave-mail.com' }] };
const domainRow = { id: 7, domain: 'brightwave-mail.com', dmarc_policy: null, rua_address: '', parent_id: null, created_at: 1700000000, alerts_enabled: 1, is_default: 0, cf_account_id: 'acc1', verified_via: 'cloudflare' };

function Where() {
	return <output data-testid="where">{useLocation().pathname}</output>;
}
function open(opts: { whose?: 'company' | 'clients' | 'looking'; routes?: Record<string, unknown>; status?: Record<string, unknown>; role?: 'owner' | 'member' } = {}) {
	return renderApp(
		<>
			<Routes>
				<Route path="/setup" element={<SetupWizardPage />} />
				<Route path="/" element={<p>home</p>} />
				<Route path="/setup/review" element={<p>review screen</p>} />
				<Route path="/setup/cloudflare" element={<p>cloudflare wizard</p>} />
				<Route path="/bulk-import" element={<p>bulk</p>} />
			</Routes>
			<Where />
		</>,
		{
			route: '/setup',
			role: opts.role ?? 'owner',
			status: { ...HOSTED, ...opts.status },
			routes: {
				'GET /api/me': { ...me(opts.role ?? 'owner'), whose_email: opts.whose ?? 'company', ...(opts.whose === 'clients' ? { agency_name: 'Northside IT' } : {}) },
				'GET /api/domains': { domains: [], pending_claims: [] },
				'GET /api/cloudflare/connections': conns(),
				...opts.routes,
			},
		},
	);
}
async function enter(domain: string) {
	const user = userEvent.setup();
	await user.type(await screen.findByLabelText(/^(Domain|Client's domain)$/), domain);
	await user.click(screen.getByRole('button', { name: `Check ${domain}` }));
}
const where = () => screen.getByTestId('where').textContent;

describe('S4 variants', () => {
	it('cold, company: asks the question, says looking it up changes nothing, and shows nothing else yet', async () => {
		open();
		expect(await screen.findByRole('heading', { name: 'Which domain do you send email from?' })).toBeInTheDocument();
		expect(screen.queryByText(/Step \d of \d/)).toBeNull();
		expect(screen.getByLabelText('Domain')).toBeInTheDocument();
		expect(screen.getByText('Looking it up changes nothing in its DNS.')).toBeInTheDocument();
		expect(screen.queryByRole('button', { name: /Connect Cloudflare/ })).toBeNull();
		expect(screen.queryByText(/Not now, show me the dashboard/)).toBeNull();
		expect(screen.queryByText(/Several clients at once/)).toBeNull();
		expect(screen.queryByText(/can't be connected/i)).toBeNull();
		expect(screen.queryByText(/Hand setup to a teammate/)).toBeNull();
	});

	it('the hand-off link is on (H1, H2 and I1 exist), and not before a domain is entered', () => {
		expect(HAND_OFF_ENABLED).toBe(true);
	});

	it('the button names the domain, lower-cased and trimmed', async () => {
		open();
		await userEvent.setup().type(await screen.findByLabelText('Domain'), ' BrightWave-Mail.com ');
		expect(screen.getByRole('button', { name: 'Check brightwave-mail.com' })).toBeInTheDocument();
	});

	it('agency: "Add your first client\'s domain", the workspace-naming hint and the bulk-import link', async () => {
		open({ whose: 'clients' });
		expect(await screen.findByRole('heading', { name: "Add your first client's domain" })).toBeInTheDocument();
		expect(screen.getByLabelText("Client's domain")).toBeInTheDocument();
		expect(screen.getByText('Each client gets its own workspace, named after its domain. You can rename it.')).toBeInTheDocument();
		await userEvent.setup().click(screen.getByRole('link', { name: 'Several clients at once? Paste a list of domains' }));
		expect(where()).toBe('/bulk-import');
	});

	it('just looking around: the quiet link goes to the dashboard and the redirect does not bring them back this tab', async () => {
		open({ whose: 'looking' });
		await userEvent.setup().click(await screen.findByRole('button', { name: 'Not now, show me the dashboard' }));
		expect(where()).toBe('/');
		expect(sessionStorage.getItem('ia_setup_redirected:ws_default')).toBe('1');
	});

	it('from the checker: the domain is checked on arrival (no field, no Check click), named with "Not this domain?", and the result is shown', async () => {
		rememberSignupDomain('brightwave-mail.com');
		const { calls } = open({ routes: { 'POST /api/domains': { __status: 202, body: { pending: true, claim: claim('brightwave-mail.com'), domain: null } }, 'GET /api/domains/claims/5/preview': preview('brightwave-mail.com'), 'GET /api/domains/dns-host': host('cloudflare', 'Cloudflare') } });
		await waitFor(() => expect(screen.getByTestId('dns-result')).toHaveTextContent('brightwave-mail.com:'));
		expect(screen.getByText(/Domain:/)).toHaveTextContent('Domain: brightwave-mail.com · Not this domain?');
		expect(calls.filter((c) => c.method === 'POST' && c.path === '/api/domains')).toHaveLength(1);
		expect(screen.queryByLabelText('Domain')).toBeNull();
		expect(screen.queryByRole('button', { name: /^Check/ })).toBeNull();
	});

	it('a typo\'d domain can be corrected without a reload: "Not this domain?" removes the claim, and the field comes back empty (the typo does not return)', async () => {
		let claims: ReturnType<typeof claim>[] = [];
		const { calls } = open({
			routes: {
				'GET /api/domains': () => ({ domains: [], pending_claims: claims }),
				'POST /api/domains': () => { claims = [claim('brightwave-mial.com')]; return { __status: 202, body: { pending: true, claim: claims[0], domain: null } }; },
				'DELETE /api/domains/claims/5': () => { claims = []; return { ok: true }; },
				'GET /api/domains/claims/5/preview': preview('brightwave-mial.com', { nxdomain: true }),
				'GET /api/domains/dns-host': host(null),
			},
		});
		await enter('brightwave-mial.com');
		await userEvent.setup().click(await screen.findByRole('button', { name: 'Use a different domain' }));
		const field = await screen.findByLabelText('Domain');
		expect(field).toHaveValue('');
		expect(calls.filter((c) => c.method === 'DELETE').map((c) => c.path)).toEqual(['/api/domains/claims/5']);
		// still the field a moment later: the old claim is not read back in from a stale cache
		await new Promise((r) => setTimeout(r, 50));
		expect(screen.getByLabelText('Domain')).toHaveValue('');
		expect(screen.queryByText(/Domain: brightwave-mial.com/)).toBeNull();
	});

	it('if the claim cannot be removed, the screen says so and keeps it (no silent leftover)', async () => {
		open({
			routes: {
				'POST /api/domains': { __status: 202, body: { pending: true, claim: claim('brightwave-mial.com'), domain: null } },
				'DELETE /api/domains/claims/5': fail(500, 'boom'),
				'GET /api/domains/claims/5/preview': preview('brightwave-mial.com', { nxdomain: true }),
				'GET /api/domains/dns-host': host(null),
			},
		});
		await enter('brightwave-mial.com');
		await userEvent.setup().click(await screen.findByRole('button', { name: 'Use a different domain' }));
		expect(await screen.findByText(/still waiting here/)).toBeInTheDocument();
	});

	it('the checker domain that is refused comes back in the field with the reason', async () => {
		rememberSignupDomain('brightwave-mail.com');
		open({ routes: { 'POST /api/domains': fail(409, 'domain already registered in another workspace') } });
		expect(await screen.findByLabelText('Domain')).toHaveValue('brightwave-mail.com');
		expect(await screen.findByRole('alert')).toHaveTextContent(/another workspace/i);
	});

	it('a wrong name is refused in words, with nothing sent', async () => {
		const { calls } = open();
		await userEvent.setup().type(await screen.findByLabelText('Domain'), 'not a domain');
		await userEvent.setup().click(screen.getByRole('button', { name: /^Check/ }));
		expect(await screen.findByRole('alert')).toHaveTextContent('Enter a domain like yourdomain.com');
		expect(calls.some((c) => c.method === 'POST')).toBe(false);
	});

	it('a domain another workspace holds says so', async () => {
		open({ routes: { 'POST /api/domains': fail(409, 'domain already registered in another workspace') } });
		await enter('brightwave-mail.com');
		expect(await screen.findByRole('alert')).toHaveTextContent(/already in another workspace|another workspace/i);
	});

	it('a read-only member does not get S4 (the home-base setup form as before)', async () => {
		open({ role: 'member' });
		expect(await screen.findByRole('heading', { name: "Let's set up Ready Set Mail" })).toBeInTheDocument();
		expect(screen.queryByTestId('setup-domain')).toBeNull();
	});

	it('self-host never shows S4: its first run is the home-base setup', async () => {
		open({ status: { mode: 'self-host', has_domain: false } });
		expect(await screen.findByRole('heading', { name: "Let's set up Ready Set Mail" })).toBeInTheDocument();
		expect(screen.queryByTestId('setup-domain')).toBeNull();
	});

	it('hosted with a domain already: the dashboard, not the per-domain wizard', async () => {
		open({ routes: { 'GET /api/domains': { domains: [domainRow] } } });
		expect(await screen.findByText('home')).toBeInTheDocument();
	});
});

describe('S4 by who hosts DNS', () => {
	const added = (domain: string, extra: Record<string, unknown> = {}) => ({
		'POST /api/domains': { __status: 202, body: { pending: true, claim: claim(domain), domain: null } },
		'GET /api/domains/claims/5/preview': preview(domain),
		...extra,
	});

	it('Cloudflare name servers, Cloudflare can be connected: the result line, "Connect Cloudflare" is the only primary, the records path is the quiet secondary', async () => {
		const { calls } = open({ routes: added('brightwave-mail.com', { 'GET /api/domains/dns-host': host('cloudflare', 'Cloudflare'), 'POST /api/cloudflare/oauth/start': { authorize_url: 'about:blank#cf' } }) });
		await enter('brightwave-mail.com');
		expect(await screen.findByRole('heading', { name: 'brightwave-mail.com uses Cloudflare for DNS' })).toBeInTheDocument();
		expect(await screen.findByTestId('dns-result')).toHaveTextContent('brightwave-mail.com: 2 things to fix. DMARC is published (p=quarantine) but sends its reports nowhere. No SPF record.');
		expect(screen.getByText(/Connect Cloudflare and we'll prepare the changes\. You see every record before anything is written\./)).toBeInTheDocument();
		const connect = screen.getByRole('button', { name: 'Connect Cloudflare' });
		expect(connect.className).toMatch(/\bbg-brand\b/);
		const secondary = screen.getByRole('button', { name: "I'll add the records myself" });
		expect(secondary.className).not.toMatch(/\bbg-brand\b/);
		expect(screen.queryByRole('group', { name: 'DNS record to add' })).toBeNull();
		// nothing was written anywhere
		expect(calls.filter((c) => c.method !== 'GET').map((c) => c.path)).toEqual(['/api/domains']);
		await userEvent.setup().click(connect);
		// Cloudflare's consent opens from this very button (the server's start endpoint, with the return route): no second "Connect Cloudflare" page
		await waitFor(() => expect(calls.find((c) => c.path === '/api/cloudflare/oauth/start')?.body).toEqual({ return_to: '/#/setup/cloudflare' }));
		expect(where()).toBe('/setup');
	});

	it('no sign-in offered, only a pasted token: Connect goes to the token screen', async () => {
		open({ routes: { ...added('brightwave-mail.com', { 'GET /api/domains/dns-host': host('cloudflare', 'Cloudflare') }), 'GET /api/cloudflare/connections': conns({ oauth: { available: false, scopes: [], via_relay: false } }) } });
		await enter('brightwave-mail.com');
		await userEvent.setup().click(await screen.findByRole('button', { name: 'Connect Cloudflare' }));
		expect(where()).toBe('/setup/cloudflare');
	});

	it('"I\'ll add the records myself" goes to the existing record screen, Cloudflare named, and offers no second Connect', async () => {
		open({ routes: added('brightwave-mail.com', { 'GET /api/domains/dns-host': host('cloudflare', 'Cloudflare') }) });
		await enter('brightwave-mail.com');
		await userEvent.setup().click(await screen.findByRole('button', { name: "I'll add the records myself" }));
		expect(await screen.findByRole('group', { name: 'DNS record to add' })).toBeInTheDocument();
		expect(screen.getByText(/uses Cloudflare for DNS\. Add this record there/)).toBeInTheDocument();
		expect(screen.queryByRole('button', { name: 'Connect Cloudflare' })).toBeNull();
	});

	it('a connection already holds the zone: "Continue with <account>" is the only primary and goes to the review', async () => {
		const { calls } = open({
			routes: added('brightwave-mail.com', {
				'GET /api/domains/dns-host': host('cloudflare', 'Cloudflare'),
				'GET /api/cloudflare/connections': conns({ connections: [held] }),
				'POST /api/domains/claims/5/verify': { domain: domainRow },
			}),
		});
		await enter('brightwave-mail.com');
		const go = await screen.findByRole('button', { name: 'Continue with Brightwave Studio' });
		expect(screen.queryByRole('button', { name: 'Connect Cloudflare' })).toBeNull();
		await userEvent.setup().click(go);
		expect(await screen.findByText('review screen')).toBeInTheDocument();
		expect(calls.some((c) => c.path === '/api/domains/claims/5/verify')).toBe(true);
	});

	it('already proven by its Cloudflare zone (the add answers 201): Continue goes straight to the review', async () => {
		open({
			routes: {
				'POST /api/domains': { __status: 201, body: { domain: domainRow, rua_hint: '' } },
				'GET /api/domains/7/onboarding-status': { domain_id: 7, domain: 'brightwave-mail.com', rua_address: '', cf_available: true, dmarc: { found: false, has_our_rua: false, current_record: null }, spf: { record: null, lookup_count: null, flattening_active: false }, dkim: { selectors: [], source: 'doh' }, routing: {} },
				'GET /api/domains/dns-host': host('cloudflare', 'Cloudflare'),
				'GET /api/cloudflare/connections': conns({ connections: [held] }),
			},
		});
		await enter('brightwave-mail.com');
		expect(await screen.findByTestId('dns-result')).toHaveTextContent('brightwave-mail.com: 3 things to fix. No SPF, DKIM or DMARC record found.');
		await userEvent.setup().click(await screen.findByRole('button', { name: 'Continue with Brightwave Studio' }));
		expect(await screen.findByText('review screen')).toBeInTheDocument();
	});

	it('another provider: the provider is named and the existing record path is shown in place; no Cloudflare button', async () => {
		open({ routes: added('harbor-lane.org', { 'GET /api/domains/dns-host': host('godaddy', 'GoDaddy') }) });
		await enter('harbor-lane.org');
		expect(await screen.findByRole('heading', { name: 'harbor-lane.org uses GoDaddy for DNS' })).toBeInTheDocument();
		expect(await screen.findByRole('group', { name: 'DNS record to add' })).toBeInTheDocument();
		expect(screen.getByText(/DNS is hosted at GoDaddy\. Add this record there/)).toBeInTheDocument();
		expect(screen.queryByRole('button', { name: /Connect Cloudflare/ })).toBeNull();
		expect(screen.getAllByRole('button', { name: 'Verify' })).toHaveLength(1);
	});

	it('provider unknown: says so plainly and shows the same record path', async () => {
		open({ routes: added('harbor-lane.org', { 'GET /api/domains/dns-host': host(null) }) });
		await enter('harbor-lane.org');
		expect(await screen.findByRole('heading', { name: "We couldn't tell who hosts DNS for harbor-lane.org." })).toBeInTheDocument();
		expect(await screen.findByRole('group', { name: 'DNS record to add' })).toBeInTheDocument();
	});

	it('hosted that cannot connect Cloudflare: the record path, quietly: no "can\'t be connected" message, no server command', async () => {
		open({ routes: added('brightwave-mail.com', { 'GET /api/domains/dns-host': host('cloudflare', 'Cloudflare'), 'GET /api/cloudflare/connections': conns({ encryption_configured: false, oauth: { available: false, scopes: [], via_relay: false }, token_paste: false }) }) });
		await enter('brightwave-mail.com');
		expect(await screen.findByRole('group', { name: 'DNS record to add' })).toBeInTheDocument();
		expect(screen.queryByText(/can't be connected|encryption|TOKEN_ENCRYPTION_KEY|wrangler/i)).toBeNull();
		expect(screen.queryByRole('button', { name: /Connect Cloudflare/ })).toBeNull();
	});

	it('a name that does not exist: said in words, with the way to try another', async () => {
		open({ routes: added('brigthwave.com', { 'GET /api/domains/dns-host': host(null), 'GET /api/domains/claims/5/preview': preview('brigthwave.com', { nxdomain: true }) }) });
		await enter('brigthwave.com');
		expect(await screen.findByTestId('dns-result')).toHaveTextContent("brigthwave.com doesn't exist in public DNS. Check the spelling.");
		expect(screen.getByRole('button', { name: 'Use a different domain' })).toBeInTheDocument();
		expect(screen.queryByRole('group', { name: 'DNS record to add' })).toBeNull();
	});

	it('a failing "who hosts DNS" lookup is asked once, not in a loop (the record card below asks too)', async () => {
		const { calls } = open({ routes: added('brightwave-mail.com', { 'GET /api/domains/dns-host': fail(500, 'boom') }) });
		await enter('brightwave-mail.com');
		expect(await screen.findByRole('group', { name: 'DNS record to add' })).toBeInTheDocument();
		await new Promise((r) => setTimeout(r, 300));
		expect(calls.filter((c) => c.path.startsWith('/api/domains/dns-host')).length).toBeLessThanOrEqual(3);
	});

	it('public DNS that cannot be read does not block the setup', async () => {
		open({ routes: added('brightwave-mail.com', { 'GET /api/domains/dns-host': host('cloudflare', 'Cloudflare'), 'GET /api/domains/claims/5/preview': fail(429) }) });
		await enter('brightwave-mail.com');
		expect(await screen.findByText(/couldn't read public DNS for brightwave-mail\.com just now/)).toBeInTheDocument();
		expect(await screen.findByRole('button', { name: 'Connect Cloudflare' })).toBeInTheDocument();
	});

	it('"Not this domain?" drops the claim and shows the field again', async () => {
		const { calls } = open({ routes: added('brightwave-mail.com', { 'GET /api/domains/dns-host': host('cloudflare', 'Cloudflare'), 'DELETE /api/domains/claims/5': { ok: true } }) });
		await enter('brightwave-mail.com');
		await userEvent.setup().click(await screen.findByRole('button', { name: 'Not this domain?' }));
		expect(await screen.findByLabelText('Domain')).toBeInTheDocument();
		expect(calls.some((c) => c.method === 'DELETE' && c.path === '/api/domains/claims/5')).toBe(true);
	});

	it('returning with a claim waiting: lands on S4 with the domain, its result and the choice (not the empty field)', async () => {
		open({
			routes: {
				'GET /api/domains': { domains: [], pending_claims: [claim('brightwave-mail.com')] },
				'GET /api/domains/claims/5/preview': preview('brightwave-mail.com'),
				'GET /api/domains/dns-host': host('cloudflare', 'Cloudflare'),
			},
		});
		expect(await screen.findByRole('heading', { name: 'brightwave-mail.com uses Cloudflare for DNS' })).toBeInTheDocument();
		expect(await screen.findByRole('button', { name: 'Connect Cloudflare' })).toBeInTheDocument();
		expect(screen.queryByLabelText('Domain')).toBeNull();
	});

	it('exactly one filled-blue primary at each stage', async () => {
		open({ routes: added('brightwave-mail.com', { 'GET /api/domains/dns-host': host('cloudflare', 'Cloudflare') }) });
		await screen.findByLabelText('Domain');
		const filled = () => screen.getAllByRole('button').filter((b) => b.className.split(/\s+/).includes('bg-brand'));
		expect(filled()).toHaveLength(1);
		await enter('brightwave-mail.com');
		await screen.findByRole('button', { name: 'Connect Cloudflare' });
		expect(filled()).toHaveLength(1);
	});
});

describe('the result line', () => {
	const dns = (o: Partial<PublicDns> = {}): PublicDns => ({ nxdomain: false, spf: 'found', dmarc: 'found', dmarcPolicy: 'reject', dmarcHasRua: true, dkim: 'found', ...o });

	it.each([
		[dns(), 'x.com: in good shape.'],
		[dns({ dmarcHasRua: false, dkim: 'found' }), "x.com: in good shape. Its DMARC record doesn't send reports anywhere yet."],
		[dns({ spf: 'missing', dmarc: 'missing', dmarcPolicy: null, dmarcHasRua: null, dkim: 'not_found' }), 'x.com: 3 things to fix. No SPF, DKIM or DMARC record found.'],
		[dns({ spf: 'missing', dmarcPolicy: 'quarantine', dmarcHasRua: false }), 'x.com: 2 things to fix. DMARC is published (p=quarantine) but sends its reports nowhere. No SPF record.'],
		[dns({ spf: 'missing' }), 'x.com: 1 thing to fix. No SPF record.'],
		[dns({ dkim: 'not_found' }), "x.com: in good shape. We couldn't find a DKIM key at the usual names; reports will show which service signs."],
		[dns({ spf: 'error' }), "x.com: We couldn't read SPF from public DNS just now."],
		[dns({ nxdomain: true }), "x.com doesn't exist in public DNS. Check the spelling."],
	])('%j → %s', (d, line) => {
		expect(resultLine('x.com', d)).toBe(line);
	});

	it('is read from the preview of a claim and from the status of a proven domain', () => {
		expect(dnsFromPreview(preview('x.com') as never)).toMatchObject({ spf: 'missing', dmarc: 'found', dmarcPolicy: 'quarantine', dmarcHasRua: false, dkim: 'not_found' });
		expect(dnsFromPreview(preview('x.com', { dmarc: { status: 'found', policy: 'none', issue: null, inherited_from: null, record: 'v=DMARC1; p=none; rua=mailto:a@b.c' } }) as never).dmarcHasRua).toBe(true);
		const s = { nxdomain: false, spf: { record: 'v=spf1 -all' }, dmarc: { found: true, current_record: 'v=DMARC1; p=none', effective: { policy: 'none' } }, dkim: { selectors: [{ name: 'a', record: 'b' }] }, dns_errors: [] };
		expect(dnsFromStatus(s as never)).toEqual({ nxdomain: false, spf: 'found', dmarc: 'found', dmarcPolicy: 'none', dmarcHasRua: false, dkim: 'found' });
		expect(dnsFromStatus({ ...s, dns_errors: ['dmarc: timeout'] } as never).dmarc).toBe('error');
	});
});

describe('setupChoice', () => {
	const c = (o = {}) => conns(o) as never;
	const cf = host('cloudflare', 'Cloudflare') as never;
	it('Cloudflare + a connection holding the zone (or its parent zone) → continue', () => {
		expect(setupChoice('brightwave-mail.com', cf, c({ connections: [held] }), true)).toEqual({ kind: 'continue', account: 'Brightwave Studio' });
		expect(setupChoice('mail.brightwave-mail.com', cf, c({ connections: [held] }), true).kind).toBe('continue');
		expect(setupChoice('other.com', cf, c({ connections: [held] }), true).kind).toBe('connect');
	});
	it('a broken connection does not hold anything', () => {
		expect(setupChoice('brightwave-mail.com', cf, c({ connections: [{ ...held, status: 'broken' }] }), true).kind).toBe('connect');
	});
	it('Cloudflare + can connect → connect; cannot (no key, or a member) → records, no message', () => {
		expect(setupChoice('x.com', cf, c(), true).kind).toBe('connect');
		expect(setupChoice('x.com', cf, c({ encryption_configured: false }), true)).toMatchObject({ kind: 'records', onCloudflare: true });
		expect(setupChoice('x.com', cf, c(), false)).toMatchObject({ kind: 'records', onCloudflare: true });
		expect(setupChoice('x.com', cf, undefined, true).kind).toBe('records');
	});
	it('another or unknown provider → records, the provider named when known', () => {
		expect(setupChoice('x.com', host('godaddy', 'GoDaddy') as never, c(), true)).toMatchObject({ kind: 'records', provider: { name: 'GoDaddy' }, onCloudflare: false });
		expect(setupChoice('x.com', host(null) as never, c(), true)).toMatchObject({ kind: 'records', provider: null });
		expect(setupChoice('x.com', { provider: null, nameservers: [], status: 'mixed' } as never, c(), true).kind).toBe('records');
	});
});
