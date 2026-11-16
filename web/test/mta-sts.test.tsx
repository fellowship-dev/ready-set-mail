import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router';
import { describe, expect, it } from 'vitest';
import { DnsTools } from '../src/components/domain/DnsTools';
import { cardState } from '../src/lib/mta-sts';
import type { MtaStsStatus } from '../src/lib/types';
import { MtaStsPage } from '../src/pages/wizards/MtaStsPage';
import { fail, renderApp } from './render';

const DOMAIN = 'example.com';
const TARGET = 'mta-sts-host.readysetmail.com';
const RUA = 'v=TLSRPTv1; rua=mailto:tls-rpt@rua.readysetmail.com';
const NOW = Math.floor(Date.now() / 1000);

const records = (o: { written?: boolean; manual?: boolean; id?: string; state?: string } = {}) => [
	{ purpose: 'policy_host', type: 'CNAME', name: `mta-sts.${DOMAIN}`, value: TARGET, proxied: false, written: !!o.written, add_now: o.manual && o.state === 'waiting_records', note: 'DNS only (grey cloud): Cloudflare issues the certificate for this name after the record resolves.' },
	{ purpose: 'tls_rpt', type: 'TXT', name: `_smtp._tls.${DOMAIN}`, value: RUA, written: !!o.written, add_now: o.manual && o.state === 'waiting_records' },
	{ purpose: 'policy_id', type: 'TXT', name: `_mta-sts.${DOMAIN}`, value: `v=STSv1; id=${o.id ?? 'YYYYMMDDHHMMSS'}`, written: false, add_now: !!o.manual && o.state === 'waiting_txt' },
];

const config = (o: Record<string, unknown> = {}) => ({
	enabled: 1, mode: 'testing', state: 'active', via: 'cloudflare', policy_host: 'saas_hostname', mx_hosts: 'mx.example.com', mx_host_list: ['mx.example.com'], policy_id: '20261116155117', max_age: 86400,
	policy_published_at: NOW - 5 * 86400, mode_changed_at: NOW - 5 * 86400, left_enforce_at: null, last_checked_at: NOW - 600, last_error: null, notice: null, notice_at: null, created_at: NOW - 5 * 86400, updated_at: NOW, domain_id: 1, ...o,
});

const base = (o: Record<string, unknown> = {}): MtaStsStatus => ({
	available: true, unavailable_reason: 'none', unavailable_message: null, via: 'cloudflare', policy_host: 'saas_hostname',
	mx_preview: { status: 'ok', hosts: ['mx.example.com'], error: null }, records: records(), records_problem: null,
	config: null, policy_host_status: null, summary: null, reports: [], enforce: null, disable: null, max_age: 86400, ...o,
} as MtaStsStatus);

const cert = (active: boolean) => ({ kind: 'saas_hostname', hostname: `mta-sts.${DOMAIN}`, route: true, certificate: { status: active ? 'active' : 'pending', ssl_status: active ? 'active' : 'pending_validation', active } });
const report = (o: Record<string, unknown> = {}) => ({ id: 1, reporter: 'Google', period_start: NOW - 2 * 86400, period_end: NOW - 86400, received_at: NOW - 86000, successful_sessions: 50, failed_sessions: 4, sts_successful_sessions: 45, sts_failed_sessions: 3, failure_types: ['certificate-expired'], ...o });

const NOT_YET = ['It has been in testing for 5 of the 7 days senders need to report: 2 more days.', 'No TLS report has arrived yet for the current policy with successful sessions: senders have not shown they can deliver with TLS.'];
const testing = (o: Record<string, unknown> = {}) => base({ config: config(), policy_host_status: cert(true), records: records({ written: true, id: '20261116155117' }), summary: { total_success: 0, total_failure: 0, report_count: 0, sts_success: 0, sts_failure: 0 }, enforce: { ready: false, allowed: false, reasons: NOT_YET }, disable: { allowed: true, after: null, reason: null }, ...o });

function page(status: MtaStsStatus | (() => unknown), extra: Record<string, unknown> = {}, role: 'owner' | 'member' = 'owner') {
	return renderApp(
		<Routes>
			<Route path="/domains/:id/mta-sts" element={<MtaStsPage />} />
			<Route path="/domains/:id" element={<p>The domain page</p>} />
		</Routes>,
		{ route: '/domains/1/mta-sts', role, routes: { 'GET /api/domains': { domains: [{ id: 1, domain: DOMAIN }] }, 'GET /api/domains/1/mta-sts': status, ...extra } },
	);
}

describe('MTA-STS page: not available', () => {
	it('says the server\'s own sentence, offers no button', async () => {
		page(base({ available: false, unavailable_reason: 'not_configured', unavailable_message: 'MTA-STS is not available on this service yet: the operator has not set up policy hosting.', via: null, records: [] }));
		expect(await screen.findByText('MTA-STS is not available on this service yet: the operator has not set up policy hosting.')).toBeInTheDocument();
		expect(screen.getByRole('heading', { name: 'MTA-STS is not available for example.com' })).toBeInTheDocument();
		expect(screen.queryByRole('button', { name: /Turn on/ })).not.toBeInTheDocument();
		expect(screen.getByRole('link', { name: 'Back to the domain' })).toHaveAttribute('href', '/domains/1');
	});

	it('needs_cloudflare links to connecting Cloudflare', async () => {
		page(base({ available: false, unavailable_reason: 'needs_cloudflare', unavailable_message: "MTA-STS needs a Cloudflare connection that reaches this domain's zone: the policy is served through Cloudflare.", via: null, records: [] }));
		expect(await screen.findByText(/needs a Cloudflare connection that reaches/)).toBeInTheDocument();
		expect(screen.getByRole('link', { name: /Connect Cloudflare/ })).toBeInTheDocument();
	});

	it('hosted records, ceiling and the rest show their sentence and nothing else', async () => {
		page(base({ available: false, unavailable_reason: 'hosted_records', unavailable_message: "This domain uses hosted records: its _smtp._tls record is already a pointer to them, so MTA-STS cannot be turned on here.", via: null, records: [] }));
		expect(await screen.findByText(/already a pointer to them/)).toBeInTheDocument();
		expect(screen.queryByRole('link', { name: /Connect Cloudflare/ })).not.toBeInTheDocument();
	});
});

describe('MTA-STS page: before it is on', () => {
	it('says what it is, the MX hosts found, the exact records it writes in Cloudflare, and one action', async () => {
		const waiting = testing({ config: config({ state: 'waiting_certificate', policy_published_at: null }), policy_host_status: cert(false), enforce: { ready: false, allowed: false, reasons: ['Setup is not finished: the policy host or one of the DNS records is not confirmed yet.'] } });
		let on = false;
		const { calls } = page(() => (on ? waiting : base()), { 'POST /api/domains/1/mta-sts': () => { on = true; return waiting; } });
		expect(await screen.findByText(/asks other mail servers to use an encrypted connection \(TLS: the lock that keeps mail private on its way\) when they deliver mail to example\.com, and to send you a report on how it went/i)).toBeInTheDocument();
		expect(screen.getByRole('list', { name: 'MX hosts' })).toHaveTextContent('mx.example.com');
		expect(screen.getByText(/MX hosts are the servers that receive your mail/)).toBeInTheDocument();
		expect(screen.getAllByText(/in your Cloudflare zone/)).toHaveLength(1); // said once
		expect(screen.getByText(/Turning it on writes these three records in your Cloudflare zone for example\.com\./)).toBeInTheDocument();
		expect(screen.getByText(/A CNAME record points one name at another; a TXT record holds a line of text/)).toBeInTheDocument();
		const list = screen.getByRole('list', { name: 'Records' });
		expect(within(list).getByText(`mta-sts.${DOMAIN}`)).toBeInTheDocument();
		expect(within(list).getByText(TARGET)).toBeInTheDocument();
		expect(within(list).getByText(`_smtp._tls.${DOMAIN}`)).toBeInTheDocument();
		expect(within(list).getByText(/v=TLSRPTv1;/)).toBeInTheDocument();
		expect(within(list).getByText(`_mta-sts.${DOMAIN}`)).toBeInTheDocument();
		expect(within(list).queryByRole('button', { name: /^Copy/ })).not.toBeInTheDocument(); // nothing to paste: it is written for you
		expect(screen.getByText(/It starts in testing mode: senders still deliver your mail as before and report problems; nothing is rejected/)).toBeInTheDocument();
		// the action comes before the records, so it is on the first screen on a phone
		expect(screen.getByRole('button', { name: 'Turn on in testing mode' }).compareDocumentPosition(screen.getByRole('list', { name: 'Records' })) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
		const buttons = screen.getAllByRole('button').filter((b) => /Turn on|Enable/.test(b.textContent ?? ''));
		expect(buttons.map((b) => b.textContent)).toEqual(['Turn on in testing mode']);

		await userEvent.click(buttons[0]!);
		expect(await screen.findByText('Waiting for the certificate for the policy server. This usually takes a few minutes; if it takes longer than an hour, Check now says which record is missing.')).toBeInTheDocument();
		expect(calls.filter((c) => c.method === 'POST').map((c) => c.path)).toEqual(['/api/domains/1/mta-sts']);
		expect(screen.getByRole('button', { name: 'Check now' })).toBeInTheDocument();
	});

	it('by hand: the records are for you to add after turning it on, each copyable', async () => {
		page(base({ via: 'manual' }));
		expect(await screen.findByText(/After you turn it on, add these three records at your DNS host for example\.com/)).toBeInTheDocument();
		const list = screen.getByRole('list', { name: 'Records' });
		expect(within(list).getAllByRole('button', { name: /^Copy/ }).length).toBeGreaterThanOrEqual(6);
	});

	it('no MX records: says so and offers no action; a failed lookup is not "none" and can be tried again', async () => {
		const first = page(base({ mx_preview: { status: 'none', hosts: [], error: null } }));
		expect(await screen.findByText(/has no MX records, so there is no mail server to protect/)).toBeInTheDocument();
		expect(screen.queryByRole('button', { name: /Turn on/ })).not.toBeInTheDocument();
		expect(screen.getByRole('button', { name: 'Look again' })).toBeInTheDocument(); // add the MX records, then look again
		first.unmount();

		let n = 0;
		page(() => (n++ === 0 ? base({ mx_preview: { status: 'error', hosts: [], error: 'DNS lookup failed' } }) : base()));
		expect(await screen.findByText(/The lookup failed just now \(DNS lookup failed\)\. This is not the same as having none\./)).toBeInTheDocument();
		expect(screen.queryByRole('button', { name: /Turn on/ })).not.toBeInTheDocument();
		await userEvent.click(screen.getByRole('button', { name: 'Look again' }));
		expect(await screen.findByRole('button', { name: 'Turn on in testing mode' })).toBeInTheDocument();
	});

	it('shows why turning it on failed, naming the record in the way', async () => {
		page(base(), { 'POST /api/domains/1/mta-sts': fail(409, '_mta-sts.example.com already has a record (v=STSv1; id=1; foo=bar). Remove it before turning MTA-STS on here.') });
		await userEvent.click(await screen.findByRole('button', { name: 'Turn on in testing mode' }));
		expect(await screen.findByText(/_mta-sts\.example\.com already has a record \(v=STSv1; id=1; foo=bar\)/)).toBeInTheDocument();
		expect(screen.getByRole('button', { name: 'Turn on in testing mode' })).toBeEnabled();
	});

	it('a member sees it but cannot press the action', async () => {
		page(base(), {}, 'member');
		const b = await screen.findByRole('button', { name: 'Turn on in testing mode' });
		expect(b).toBeDisabled();
		expect(screen.getByTestId('read-only-notice')).toBeInTheDocument();
	});
});

describe('MTA-STS page: setting up', () => {
	it('Check now shows each setup check in words', async () => {
		const verify = { ok: true, state: 'waiting_certificate', notice: null, last_error: null, checks: [
			{ key: 'policy_host', label: `mta-sts.${DOMAIN} reaches the policy host`, state: 'ok', detail: null },
			{ key: 'certificate', label: 'Certificate for the policy host', state: 'pending', detail: 'Cloudflare issues the certificate after the CNAME resolves; this takes a few minutes.' },
			{ key: 'tls_rpt', label: 'TLS reports are sent to Ready Set Mail', state: 'wrong', detail: `_smtp._tls.${DOMAIN} does not send reports to tls-rpt@rua.readysetmail.com.` },
			{ key: 'policy_id', label: 'The policy id is published', state: 'missing', detail: 'Published last, once the certificate is active.' },
		] };
		const { calls } = page(base({ config: config({ state: 'waiting_certificate', policy_published_at: null, last_checked_at: null }), policy_host_status: cert(false), records: records({ written: true }) }), { 'POST /api/domains/1/mta-sts/verify': verify });
		expect(await screen.findByText('Waiting for the certificate for the policy server. This usually takes a few minutes; if it takes longer than an hour, Check now says which record is missing.')).toBeInTheDocument();
		expect(screen.getByText('Not checked yet.')).toBeInTheDocument();
		await userEvent.click(screen.getByRole('button', { name: 'Check now' }));
		const list = await screen.findByRole('list', { name: 'Setup checks' });
		expect(within(list).getByText('In place')).toBeInTheDocument();
		expect(within(list).getByText('Waiting')).toBeInTheDocument();
		expect(within(list).getByText('Wrong')).toBeInTheDocument();
		expect(within(list).getByText('Not found yet')).toBeInTheDocument();
		expect(within(list).getByText(/does not send reports to tls-rpt@rua\.readysetmail\.com/)).toBeInTheDocument();
		expect(calls.some((c) => c.method === 'POST' && c.path === '/api/domains/1/mta-sts/verify')).toBe(true);
	});

	it('when every check is in place and it is active, one line says so and the list is kept under Details', async () => {
		const ok = (key: string, label: string) => ({ key, label, state: 'ok', detail: null });
		let checked = false;
		page(() => (checked ? testing({ config: config({ last_checked_at: NOW }) }) : base({ config: config({ state: 'waiting_certificate', policy_published_at: null }), policy_host_status: cert(false), records: records({ written: true }) })), {
			'POST /api/domains/1/mta-sts/verify': () => { checked = true; return { ok: true, state: 'active', notice: null, last_error: null, checks: [ok('policy_host', 'a'), ok('certificate', 'b'), ok('tls_rpt', 'c'), ok('policy_id', 'd')] }; },
		});
		await userEvent.click(await screen.findByRole('button', { name: 'Check now' }));
		expect(await screen.findByText('All the setup checks are in place.')).toBeInTheDocument();
		expect(screen.getByText('Testing: senders deliver as before and report problems with encryption. Nothing is rejected.')).toBeInTheDocument();
		expect(screen.getByRole('button', { name: /What was checked/ })).toBeInTheDocument();
		expect(screen.getByRole('list', { name: 'Setup checks', hidden: true })).toHaveTextContent('In place');
	});

	it('by hand, waiting for your records: the records to add are shown with copy buttons', async () => {
		page(base({ via: 'manual', config: config({ state: 'waiting_records', via: 'manual', policy_published_at: null }), policy_host_status: cert(false), records: records({ manual: true, state: 'waiting_records' }) }));
		expect(await screen.findByText('Waiting for the DNS records you add at your DNS host.')).toBeInTheDocument();
		const list = screen.getByRole('list', { name: 'Records to add' });
		expect(within(list).getByText(`mta-sts.${DOMAIN}`)).toBeInTheDocument();
		expect(within(list).getByText(`_smtp._tls.${DOMAIN}`)).toBeInTheDocument();
		expect(within(list).queryByText(`_mta-sts.${DOMAIN}`)).not.toBeInTheDocument(); // the id is asked for last
		expect(within(list).getAllByRole('button', { name: /^Copy/ }).length).toBeGreaterThan(0);
	});
});

describe('MTA-STS page: testing', () => {
	it('before any report: the empty state, and enforce is off with the server\'s reasons listed', async () => {
		page(testing());
		expect(await screen.findByText('Testing: senders deliver as before and report problems with encryption. Nothing is rejected.')).toBeInTheDocument();
		expect(screen.getByText('No TLS report yet')).toBeInTheDocument();
		expect(screen.getByText('Senders usually send one a day after they deliver mail to you.')).toBeInTheDocument();
		expect(screen.getByText(`https://mta-sts.${DOMAIN}/.well-known/mta-sts.txt`)).toBeInTheDocument();
		expect(screen.getByText('Up to 1 day.')).toBeInTheDocument();
		const enforce = screen.getByRole('button', { name: 'Switch to enforce' });
		expect(enforce).toBeDisabled();
		for (const r of NOT_YET) expect(screen.getByText(r)).toBeInTheDocument();
	});

	it('with reports: the table of the last 30 days, the totals, and the notice that can be dismissed', async () => {
		const { calls } = page(testing({
			reports: [report(), report({ id: 2, reporter: 'Microsoft', successful_sessions: 10, failed_sessions: 0, sts_successful_sessions: null, sts_failed_sessions: null, failure_types: [] })],
			summary: { total_success: 60, total_failure: 4, report_count: 2, sts_success: 45, sts_failure: 3 },
			config: config({ notice: 'Your MX hosts changed (now: mx.example.com, mx2.example.com); the policy lists them under a new id.', notice_at: NOW - 3600 }),
		}), { 'PATCH /api/domains/1/mta-sts': {} });
		const reports = await screen.findByTestId('tls-reports');
		const table = within(reports).getByRole('table');
		expect(within(table).getAllByRole('columnheader').map((h) => h.textContent)).toEqual(['Reporter', 'Period', 'Successful', 'Failed', 'Failure types']);
		const rows = within(table).getAllByRole('row').slice(1) as [HTMLElement, HTMLElement];
		expect(within(rows[0]).getByText('Google')).toBeInTheDocument();
		expect(within(rows[0]).getByText('45')).toBeInTheDocument();
		expect(within(rows[0]).getByText('3')).toBeInTheDocument();
		expect(within(rows[0]).getByText("your mail server's certificate has expired")).toBeInTheDocument();
		expect(within(rows[1]).getByText('10')).toBeInTheDocument(); // an old row shows its totals
		expect(within(reports).getByText(/Reports received before this page counted MTA-STS sessions separately/)).toBeInTheDocument();
		expect(screen.getByText(/45 successful and 3 failed sessions under this policy, from 2 reports/)).toBeInTheDocument();
		expect(screen.queryByText('No TLS report yet')).not.toBeInTheDocument();

		expect(screen.getByText(/Your MX hosts changed \(now: mx\.example\.com, mx2\.example\.com\)/)).toBeInTheDocument();
		await userEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
		await waitFor(() => expect(calls.find((c) => c.method === 'PATCH')?.body).toEqual({ dismiss_notice: true }));
	});

	it('enforce, once the server says it is ready, asks first and then switches', async () => {
		let mode = 'testing';
		const { calls } = page(() => testing({ config: config({ mode }), enforce: mode === 'testing' ? { ready: true, allowed: true, reasons: [] } : null }), { 'PATCH /api/domains/1/mta-sts': ({ body }: any) => { mode = body.mode; return { ok: true }; } });
		const b = await screen.findByRole('button', { name: 'Switch to enforce' });
		expect(b).toBeEnabled();
		expect(screen.queryByText('Not yet:')).not.toBeInTheDocument();
		await userEvent.click(b);
		const dlg = await screen.findByRole('dialog');
		expect(within(dlg).getByText(/will not deliver the mail/)).toBeInTheDocument();
		await userEvent.click(within(dlg).getByRole('button', { name: 'Switch to enforce' }));
		await waitFor(() => expect(calls.find((c) => c.method === 'PATCH')?.body).toEqual({ mode: 'enforce' }));
		expect(await screen.findByRole('button', { name: 'Switch to testing' })).toBeInTheDocument();
	});
});

describe('MTA-STS page: enforcing and turning off', () => {
	const enforced = (o: Record<string, unknown> = {}) => testing({ config: config({ mode: 'enforce' }), enforce: null, disable: { allowed: false, after: null, reason: 'Switch to testing first. Senders keep the enforce policy for up to 1 day; you can disable it after that.' }, ...o });

	it('enforce: switch to testing is offered, turning off is blocked with the server\'s sentence', async () => {
		page(enforced());
		expect(await screen.findByText('Enforcing: senders must use an encrypted connection, or they do not deliver.')).toBeInTheDocument();
		expect(screen.getByRole('button', { name: 'Switch to testing' })).toBeEnabled();
		expect(screen.queryByRole('button', { name: 'Switch to enforce' })).not.toBeInTheDocument();
		expect(screen.getByText('Switch to testing first. Senders keep the enforce policy for up to 1 day; you can disable it after that.')).toBeInTheDocument();
		expect(screen.getByRole('button', { name: 'Turn off MTA-STS' })).toBeDisabled();
	});

	it('right after leaving enforce: blocked until the time the server names', async () => {
		page(testing({ config: config({ left_enforce_at: NOW - 3600 }), disable: { allowed: false, after: NOW + 82800, reason: 'Senders keep the enforce policy for up to 1 day. You can disable MTA-STS after 2026-11-17 14:00 UTC.' } }));
		expect(await screen.findByText(/You can disable MTA-STS after 2026-11-17 14:00 UTC\./)).toBeInTheDocument();
		expect(screen.getByRole('button', { name: 'Turn off MTA-STS' })).toBeDisabled();
	});

	it('turning off asks, then says what was removed, what was kept and why, and how long senders may keep the policy', async () => {
		const { calls } = page(testing(), { 'DELETE /api/domains/1/mta-sts': { ok: true, kept: [{ type: 'TXT', name: `_smtp._tls.${DOMAIN}`, reason: 'its content no longer matches what Ready Set Mail wrote' }], operator: 'removed', message: 'Senders that already fetched the policy may keep it for up to 1 day.' } });
		await userEvent.click(await screen.findByRole('button', { name: 'Turn off MTA-STS' }));
		const dlg = await screen.findByRole('dialog');
		expect(within(dlg).getByText(/Senders that already fetched the policy may keep it for up to 1 day/)).toBeInTheDocument();
		await userEvent.click(within(dlg).getByRole('button', { name: 'Turn off' }));
		expect(await screen.findByRole('heading', { name: 'MTA-STS is off' })).toBeInTheDocument();
		expect(calls.some((c) => c.method === 'DELETE')).toBe(true);
		expect(screen.getByText('The records Ready Set Mail wrote are removed, except those below.')).toBeInTheDocument();
		expect(screen.getByText(`The policy server for ${DOMAIN} is removed.`)).toBeInTheDocument();
		const kept = screen.getByText('Kept, because you changed them').closest('[role=alert]')!;
		expect(kept).toHaveTextContent(`TXT _smtp._tls.${DOMAIN}`);
		expect(kept).toHaveTextContent('its content no longer matches what Ready Set Mail wrote');
		expect(screen.getByText('Senders that already fetched the policy may keep it for up to 1 day.')).toBeInTheDocument();
		expect(screen.getByRole('link', { name: 'Back to the domain' })).toHaveAttribute('href', '/domains/1');
	});

	it('by hand: turning off says the records you added stay until you delete them', async () => {
		page(testing({ config: config({ via: 'manual' }) }), { 'DELETE /api/domains/1/mta-sts': { ok: true, kept: [], operator: 'pending', message: 'Senders that already fetched the policy may keep it for up to 1 day.' } });
		await userEvent.click(await screen.findByRole('button', { name: 'Turn off MTA-STS' }));
		await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Turn off' }));
		expect(await screen.findByText('You added the records yourself: delete them at your DNS host too.')).toBeInTheDocument();
		expect(screen.getByText(/The policy server could not be removed just now/)).toBeInTheDocument();
	});
});

describe('the DNS tools card', () => {
	const card = async (s: MtaStsStatus) => {
		renderApp(<DnsTools domainId={1} />, { routes: { 'GET /api/domains/1/mta-sts': s, 'GET /api/domains/1/spf-flatten': { available: false, config: null, lookup_count: null } } });
		return screen.findByRole('heading', { name: 'MTA-STS' });
	};

	it.each([
		['Off', base(), 'Set up'],
		['Setting up', base({ config: config({ state: 'waiting_certificate' }) }), 'Continue setup'],
		['Testing', testing(), 'Open'],
		['Enforced', testing({ config: config({ mode: 'enforce' }) }), 'Open'],
		['Not available: needs a Cloudflare connection', base({ available: false, unavailable_reason: 'needs_cloudflare', unavailable_message: 'x', via: null, records: [] }), 'See why'],
		['Not available: this domain uses hosted records', base({ available: false, unavailable_reason: 'hosted_records', unavailable_message: 'x', via: null, records: [] }), 'See why'],
	] as const)('says %s and links to the page', async (word, s, link) => {
		const h = await card(s);
		const c = h.closest('[class*="rounded"]') as HTMLElement;
		expect(within(c).getByText(word)).toBeInTheDocument();
		expect(within(c).getByRole('link', { name: link })).toHaveAttribute('href', '/domains/1/mta-sts');
		expect(within(c).queryByRole('button')).not.toBeInTheDocument(); // everything happens on the page
	});

	it('names only the tools it lists: MTA-STS alone where SPF flattening is not offered', async () => {
		await card(base());
		expect(screen.getByText('Optional tool for your DNS: MTA-STS.')).toBeInTheDocument();
		expect(screen.queryByText(/SPF flattening/)).not.toBeInTheDocument();
	});

	it('cardState is a pure reading of the server\'s state: a setup in progress is never "Testing"', () => {
		expect(cardState(base({ config: config({ state: 'waiting_txt', mode: 'enforce' }) })).state).toBe('setting_up');
		expect(cardState(testing()).state).toBe('testing');
	});
});
