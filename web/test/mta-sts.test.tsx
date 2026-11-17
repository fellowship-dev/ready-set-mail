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

const NOT_YET = ['In testing for 5 of 7 days: 2 more.', 'No verified TLS report has arrived yet for this policy.'];
const RULE = [
	{ key: 'days', label: '7 days in testing' },
	{ key: 'report', label: 'A report signed by Google or Microsoft about this policy, with successful sessions' },
	{ key: 'failures', label: 'No failures in signed reports about this policy in the last 14 days' },
	{ key: 'mx', label: 'The MX hosts match the policy' },
	{ key: 'served', label: 'The policy is served' },
] as const;
/** The enforce rule as the server sends it: every line, with the reasons of the ones that are missing. */
const checks = (missing: Record<string, string[]> = {}) => RULE.map((r) => ({ ...r, met: !missing[r.key], reasons: missing[r.key] ?? [] }));
const TESTING_SENTENCE = 'Testing: mail is delivered as before, and senders that send TLS reports tell you about problems.';
const ENFORCING_SENTENCE = 'Enforcing: senders that check MTA-STS deliver only over a verified encrypted connection to a listed MX host.';
const SERVED = { ok: true, checked_at: NOW - 60, reason: null, message: null, action: null, url: `https://mta-sts.${DOMAIN}/.well-known/mta-sts.txt` };
const EVIDENCE = { rule: 'x', no_reports_note: 'A domain that receives no TLS reports can never switch to enforce.', counted_reports: 0, uncounted_reports: 0, verifiable: true };
const testing = (o: Record<string, unknown> = {}) => base({ config: config(), policy_host_status: cert(true), records: records({ written: true, id: '20261116155117' }), summary: { total_success: 0, total_failure: 0, report_count: 0, sts_success: 0, sts_failure: 0 }, enforce: { ready: false, allowed: false, reasons: NOT_YET, checks: checks({ days: [NOT_YET[0]!], report: [NOT_YET[1]!] }) }, disable: { allowed: true, after: null, reason: null }, served: SERVED, evidence: EVIDENCE, ...o });

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
		const waiting = testing({ config: config({ state: 'waiting_certificate', policy_published_at: null }), policy_host_status: cert(false), enforce: { ready: false, allowed: false, reasons: ['Setup is not finished.'] }, served: null });
		let on = false;
		const { calls } = page(() => (on ? waiting : base()), { 'POST /api/domains/1/mta-sts': () => { on = true; return waiting; } });
		expect(await screen.findByText('MTA-STS asks other mail servers to encrypt delivery to example.com and to report how it went.')).toBeInTheDocument();
		expect(screen.getByRole('list', { name: 'MX hosts' })).toHaveTextContent('mx.example.com');
		// no definitions of MX, CNAME and TXT; the records Cloudflare writes are behind "Show records"
		expect(screen.queryByText(/MX hosts are the servers/)).not.toBeInTheDocument();
		expect(screen.queryByText(/A CNAME record points one name at another/)).not.toBeInTheDocument();
		const disclosure = screen.getByRole('button', { name: 'Show records' });
		expect(disclosure).toHaveAttribute('aria-expanded', 'false');
		await userEvent.click(disclosure);
		const list = screen.getByRole('list', { name: 'Records' });
		expect(within(list).getByText(`mta-sts.${DOMAIN}`)).toBeInTheDocument();
		expect(within(list).getByText(TARGET)).toBeInTheDocument();
		expect(within(list).getByText(`_smtp._tls.${DOMAIN}`)).toBeInTheDocument();
		expect(within(list).getByText(/v=TLSRPTv1;/)).toBeInTheDocument();
		expect(within(list).getByText(`_mta-sts.${DOMAIN}`)).toBeInTheDocument();
		expect(within(list).queryByText(/Proxied|DNS only/)).not.toBeInTheDocument(); // no per-record notes
		expect(within(list).queryByRole('button', { name: /^Copy/ })).not.toBeInTheDocument(); // nothing to paste: it is written for you
		expect(screen.getByText('It starts in testing mode: mail is delivered as before and nothing is rejected.')).toBeInTheDocument();
		// the action comes before the records, so it is on the first screen on a phone
		expect(screen.getByRole('button', { name: 'Turn on in testing mode' }).compareDocumentPosition(screen.getByRole('list', { name: 'Records' })) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
		const buttons = screen.getAllByRole('button').filter((b) => /Turn on|Enable/.test(b.textContent ?? ''));
		expect(buttons.map((b) => b.textContent)).toEqual(['Turn on in testing mode']);

		await userEvent.click(buttons[0]!);
		expect(await screen.findByText('Waiting for the certificate. This takes a few minutes.')).toBeInTheDocument();
		expect(calls.filter((c) => c.method === 'POST').map((c) => c.path)).toEqual(['/api/domains/1/mta-sts']);
		expect(screen.getByRole('button', { name: 'Check now' })).toBeInTheDocument();
	});

	it('by hand: the records are for you to add after turning it on, each copyable', async () => {
		page(base({ via: 'manual' }));
		expect(await screen.findByText('After you turn it on, add these records at your DNS host.')).toBeInTheDocument();
		const list = screen.getByRole('list', { name: 'Records' });
		expect(within(list).getAllByRole('button', { name: /^Copy/ }).length).toBeGreaterThanOrEqual(6);
	});

	it('no MX records: says so and offers no action; a failed lookup is not "none" and can be tried again', async () => {
		const first = page(base({ mx_preview: { status: 'none', hosts: [], error: null } }));
		expect(await screen.findByText(/has no MX records\. Add them at your DNS host first/)).toBeInTheDocument();
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
		expect(await screen.findByText('Waiting for the certificate. This takes a few minutes.')).toBeInTheDocument();
		await userEvent.click(screen.getByRole('button', { name: 'Check now' }));
		const list = await screen.findByRole('list', { name: 'Setup checks' });
		expect(within(list).getByText('In place')).toBeInTheDocument();
		expect(within(list).getByText('Waiting')).toBeInTheDocument();
		expect(within(list).getByText('Wrong')).toBeInTheDocument();
		expect(within(list).getByText('Not found yet')).toBeInTheDocument();
		expect(within(list).getByText(/does not send reports to tls-rpt@rua\.readysetmail\.com/)).toBeInTheDocument();
		expect(calls.some((c) => c.method === 'POST' && c.path === '/api/domains/1/mta-sts/verify')).toBe(true);
	});

	it('once the policy is served and every check is in place, Check now is small and secondary and the last check shows its time', async () => {
		const ok = (key: string, label: string) => ({ key, label, state: 'ok', detail: null });
		let checked = false;
		page(() => (checked ? testing({ config: config({ last_checked_at: NOW }) }) : base({ config: config({ state: 'waiting_certificate', policy_published_at: null }), policy_host_status: cert(false), records: records({ written: true }) })), {
			'POST /api/domains/1/mta-sts/verify': () => { checked = true; return { ok: true, state: 'active', notice: null, last_error: null, served: SERVED, checks: [ok('policy_host', 'a'), ok('certificate', 'b'), ok('tls_rpt', 'c'), ok('policy_id', 'd')] }; },
		});
		await userEvent.click(await screen.findByRole('button', { name: 'Check now' }));
		expect(await screen.findByText(TESTING_SENTENCE)).toBeInTheDocument();
		expect(screen.getByText(`Served at https://mta-sts.${DOMAIN}/.well-known/mta-sts.txt`)).toBeInTheDocument();
		expect(screen.getByRole('button', { name: 'Check now' })).toHaveClass('bg-surface-1');
		expect(screen.queryByText(/Last checked/)).not.toBeInTheDocument();
	});

	it('a policy that cannot be reached says so with the one action, and is not "served"', async () => {
		const served = { ok: false, checked_at: NOW - 60, reason: 'certificate', action: 'check_now', message: `The policy at https://mta-sts.${DOMAIN}/.well-known/mta-sts.txt cannot be reached yet. A new certificate takes a few minutes after the CNAME resolves; choose Check now to look again.`, url: 'u' };
		page(testing({ served }));
		expect(await screen.findByText(/cannot be reached yet/)).toBeInTheDocument();
		expect(screen.queryByText(/^Served at/)).not.toBeInTheDocument();
		expect(screen.getByRole('button', { name: 'Check now' })).toBeInTheDocument();
		expect(screen.getByRole('button', { name: 'Switch to enforce' })).toBeDisabled();
	});

	it('a setup stopped after 7 days says how to restart', async () => {
		page(base({ setup_expired: { notice: 'Setup was not finished within 7 days, so it was stopped. Turn it on again to restart.', at: NOW } }));
		expect(await screen.findByText('Setup was not finished within 7 days, so it was stopped. Turn it on again to restart.')).toBeInTheDocument();
		expect(screen.getByRole('button', { name: 'Turn on in testing mode' })).toBeInTheDocument();
	});

	it('a policy being retired says what senders may still do, and until when', async () => {
		page(base({ available: false, unavailable_reason: 'unproven', unavailable_message: 'Prove that you own this domain first: MTA-STS publishes a policy under its name.', via: null, records: [], retiring: { retiring: true, reason: 'lost_proof', enforced: true, until: NOW + 7 * 86400, message: 'MTA-STS is being switched off. Senders that already fetched the enforce policy may refuse to deliver to mail servers that are not in it for up to 7 days.' } }));
		expect(await screen.findByText(/may refuse to deliver to mail servers that are not in it for up to 7 days\. Until /)).toBeInTheDocument();
		expect(screen.getByText('MTA-STS is being switched off')).toBeInTheDocument();
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
		expect(await screen.findByText(TESTING_SENTENCE)).toBeInTheDocument();
		expect(screen.getByText('No signed TLS report yet')).toBeInTheDocument();
		expect(screen.getByText('Senders usually send one a day after they deliver mail to you.')).toBeInTheDocument();
		expect(screen.getByText(`Served at https://mta-sts.${DOMAIN}/.well-known/mta-sts.txt`)).toBeInTheDocument();
		const enforce = screen.getByRole('button', { name: 'Switch to enforce' });
		expect(enforce).toBeDisabled();
		// the whole rule, once, each line met or missing now, the missing ones with their reason; and the one thing about domains without reports
		const rule = screen.getByRole('list', { name: 'What enforce needs' });
		const items = within(rule).getAllByRole('listitem').map((li) => li.textContent);
		expect(items).toEqual([
			'Missing: 7 days in testingIn testing for 5 of 7 days: 2 more.',
			'Missing: A report signed by Google or Microsoft about this policy, with successful sessionsNo verified TLS report has arrived yet for this policy.',
			'Met: No failures in signed reports about this policy in the last 14 days',
			'Met: The MX hosts match the policy',
			'Met: The policy is served',
		]);
		expect(screen.queryByText(/like Google or Microsoft/)).not.toBeInTheDocument();
		expect(screen.getByText('A domain that receives no TLS reports can never switch to enforce.')).toBeInTheDocument();
		// brand blue is for the action that can be pressed: a disabled Switch to enforce is not filled
		expect(enforce.className).not.toMatch(/bg-brand/);
	});

	it('with reports: the table of the last 30 days, the totals, and the notice that can be dismissed', async () => {
		const { calls } = page(testing({
			reports: [report(), report({ id: 2, reporter: 'Microsoft', successful_sessions: 10, failed_sessions: 0, sts_successful_sessions: null, sts_failed_sessions: null, failure_types: [] })],
			summary: { total_success: 60, total_failure: 4, report_count: 2, sts_success: 45, sts_failure: 3 },
			evidence: { ...EVIDENCE, counted_reports: 2, uncounted_reports: 3 },
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
		expect(screen.getByText(/45 successful and 3 failed sessions, from 2 signed reports/)).toBeInTheDocument();
		expect(screen.queryByText('No signed TLS report yet')).not.toBeInTheDocument();

		expect(screen.getByText('3 more reports arrived but are not counted: sender not verified.')).toBeInTheDocument();
		expect(screen.queryByText(/other senders/)).not.toBeInTheDocument();
		expect(screen.getByText(/Your MX hosts changed \(now: mx\.example\.com, mx2\.example\.com\)/)).toBeInTheDocument();
		await userEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
		await waitFor(() => expect(calls.find((c) => c.method === 'PATCH')?.body).toEqual({ dismiss_notice: true }));
	});

	it('enforce, once the server says it is ready, asks first and then switches', async () => {
		let mode = 'testing';
		const { calls } = page(() => testing({ config: config({ mode }), enforce: mode === 'testing' ? { ready: true, allowed: true, reasons: [] } : null }), { 'PATCH /api/domains/1/mta-sts': ({ body }: any) => { mode = body.mode; return { ok: true }; } });
		const b = await screen.findByRole('button', { name: 'Switch to enforce' });
		expect(b).toBeEnabled();
		expect(screen.queryByRole('list', { name: 'What enforce needs' })).not.toBeInTheDocument();
		expect(b.className).toMatch(/bg-brand|primary/); // the one primary action once it can be pressed
		await userEvent.click(b);
		const dlg = await screen.findByRole('dialog');
		expect(within(dlg).getByText(/only over a verified encrypted connection to a listed MX host/)).toBeInTheDocument();
		expect(within(dlg).getByText(/signed reports from Google or Microsoft: senders that send none are not covered/)).toBeInTheDocument();
		expect(within(dlg).queryByText(/The reports show they can/)).not.toBeInTheDocument();
		await userEvent.click(within(dlg).getByRole('button', { name: 'Switch to enforce' }));
		await waitFor(() => expect(calls.find((c) => c.method === 'PATCH')?.body).toEqual({ mode: 'enforce' }));
		expect(await screen.findByRole('button', { name: 'Switch to testing' })).toBeInTheDocument();
	});
});

describe('MTA-STS page: enforcing and turning off', () => {
	const enforced = (o: Record<string, unknown> = {}) => testing({ config: config({ mode: 'enforce' }), enforce: null, disable: { allowed: false, after: null, reason: 'Switch to testing first. Senders keep the enforce policy for up to 1 day; you can disable it after that.' }, ...o });

	it('enforce: switch to testing is offered, turning off is blocked with the server\'s sentence', async () => {
		page(enforced());
		expect(await screen.findByText(ENFORCING_SENTENCE)).toBeInTheDocument();
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

/** Visible words, counted the way the walk's measure does: in the main content, hidden parts (a closed disclosure) left out. */
const visibleWords = (root: HTMLElement) => {
	const clone = root.cloneNode(true) as HTMLElement;
	clone.querySelectorAll('[hidden], script, style, [aria-hidden="true"]').forEach((n) => n.remove());
	return ((clone.textContent ?? '').match(/[\p{L}\p{N}][\p{L}\p{N}'’._-]*/gu) ?? []).length;
};

describe('MTA-STS page: the words on the enable path (the reviewer measured 1,054; the target is 450)', () => {
	it('the four screens of the flow add up to at most 450 words', async () => {
		const states: Array<[string, MtaStsStatus]> = [
			['open', base()],
			['setting up', base({ config: config({ state: 'waiting_certificate', policy_published_at: null }), policy_host_status: cert(false), records: records({ written: true }), enforce: { ready: false, allowed: false, reasons: ['Setup is not finished.'] } })],
			['testing, served, no report', testing()],
			['testing, first report', testing({ reports: [report()], summary: { total_success: 50, total_failure: 4, report_count: 1, sts_success: 45, sts_failure: 3 }, evidence: { ...EVIDENCE, counted_reports: 1 } })],
		];
		let total = 0;
		const per: Record<string, number> = {};
		for (const [name, status] of states) {
			const r = page(status);
			await screen.findByRole('heading', { name: /MTA-STS for example\.com/ });
			await waitFor(() => expect(screen.queryByLabelText('Loading MTA-STS')).toBeNull());
			per[name] = visibleWords(document.querySelector('main') ?? document.body);
			total += per[name];
			r.unmount();
		}
		process.stderr.write(`WORDS ${JSON.stringify(per)} total ${total}\n`);
		expect(total).toBeLessThanOrEqual(450);
	});
});

describe('MTA-STS page: every sentence is true for the state it is shown in', () => {
	const heldLine = () => screen.getByText(/MX hosts in the policy:/).textContent;
	const openRecords = async () => userEvent.click(await screen.findByRole('button', { name: 'Show records' }));

	describe('how long senders may keep the policy (the policy\'s max_age AND when the last enforce policy was served)', () => {
		it('never enforced: the testing policy\'s one day', async () => {
			page(testing());
			await openRecords();
			expect(heldLine()).toBe('MX hosts in the policy: mx.example.com. Senders keep it up to 1 day.');
		});

		it('enforcing: the enforce policy\'s seven days', async () => {
			page(testing({ config: config({ mode: 'enforce', max_age: 604800 }), enforce: null, disable: { allowed: false, after: null, reason: 'Switch to testing first.' } }));
			await openRecords();
			expect(heldLine()).toBe('MX hosts in the policy: mx.example.com. Senders keep it up to 7 days.');
		});

		it('after leaving enforce it never says one day: senders that fetched the enforce policy may keep it until the week is over', async () => {
			const left = Date.UTC(2026, 10, 16, 22, 40) / 1000;
			page(testing({ config: config({ left_enforce_at: left, max_age: 86400 }), disable: { allowed: false, after: left + 604800, reason: 'x' } }));
			await openRecords();
			expect(heldLine()).toBe('MX hosts in the policy: mx.example.com. Senders that fetched the enforce policy may keep it until 2026-11-23 22:40 UTC.');
			expect(heldLine()).not.toMatch(/1 day/);
		});

		it('a week after leaving enforce the testing policy\'s one day is true again', async () => {
			page(testing({ config: config({ left_enforce_at: NOW - 9 * 86400, max_age: 86400 }), disable: { allowed: true, after: null, reason: null } }));
			await openRecords();
			expect(heldLine()).toBe('MX hosts in the policy: mx.example.com. Senders keep it up to 1 day.');
		});
	});

	describe('"Served" is the last fetch, which the server renews when the view is old', () => {
		const url = `https://mta-sts.${DOMAIN}/.well-known/mta-sts.txt`;
		const when = (sec: number) => `${new Date(sec * 1000).toISOString().replace('T', ' ').slice(0, 16)} UTC`;

		it('a served policy says when it was checked, offers a small secondary Check now, and the page itself fetches nothing', async () => {
			const { calls } = page(testing({ served: { ...SERVED, checked_at: NOW - 540 } }));
			expect(await screen.findByText(`Served at ${url}`)).toBeInTheDocument();
			expect(screen.getByText(`Checked ${when(NOW - 540)}`)).toBeInTheDocument();
			expect(screen.getByRole('button', { name: 'Check now' })).toHaveClass('bg-surface-1');
			expect(calls.filter((c) => c.method === 'POST')).toEqual([]);
		});

		it('a host that answers 404 is "cannot be reached" with its check time and the one action, and enforce stays off', async () => {
			const unreachable = { ok: false, checked_at: NOW, reason: 'not_found', action: 'check_now', message: `The policy at ${url} cannot be reached: the host answered 404.`, url, could_not_check: false };
			page(testing({ served: unreachable }));
			expect(await screen.findByText('The policy cannot be reached')).toBeInTheDocument();
			expect(screen.getByText(`Checked ${when(NOW)}`)).toBeInTheDocument();
			expect(screen.queryByText(/^Served at/)).not.toBeInTheDocument();
			expect(screen.getByRole('button', { name: 'Check now' })).toBeInTheDocument();
			expect(screen.getByRole('button', { name: 'Switch to enforce' })).toBeDisabled();
		});

		it('a fetch that got no answer says so, with the last known result and its time, and never claims "Served"', async () => {
			page(testing({ served: { ...SERVED, checked_at: NOW - 3600, could_not_check: true } }));
			expect(await screen.findByText(`Could not check just now. Last known: served at ${url}, checked ${when(NOW - 3600)}.`)).toBeInTheDocument();
			expect(screen.queryByText(/^Served at/)).not.toBeInTheDocument();
			expect(screen.getByRole('button', { name: 'Check now' })).toBeInTheDocument();
		});

		it('Check now fetches and shows the new result', async () => {
			let verified = false;
			const gone = { ok: false, checked_at: NOW, reason: 'not_found', action: 'check_now', message: 'gone', url };
			const { calls } = page(() => testing({ served: verified ? gone : SERVED }), {
				'POST /api/domains/1/mta-sts/verify': () => { verified = true; return { ok: true, state: 'active', notice: null, last_error: null, served: gone, checks: [] }; },
			});
			await userEvent.click(await screen.findByRole('button', { name: 'Check now' }));
			expect(await screen.findByText('The policy cannot be reached')).toBeInTheDocument();
			expect(calls.filter((c) => c.method === 'POST').map((c) => c.path)).toEqual(['/api/domains/1/mta-sts/verify']);
		});
	});

	describe('one count source: the sentence and the table are the same reports', () => {
		it('the table lists the counted reports and the sentence counts them; the others are one sentence that does not say "other senders"', async () => {
			page(testing({
				reports: [report()],
				summary: { total_success: 50, total_failure: 4, report_count: 1, sts_success: 45, sts_failure: 3 },
				evidence: { ...EVIDENCE, counted_reports: 1, uncounted_reports: 1 },
			}));
			const reports = await screen.findByTestId('tls-reports');
			expect(within(within(reports).getByRole('table')).getAllByRole('row')).toHaveLength(2); // header and the one report
			expect(screen.getByText(/45 successful and 3 failed sessions, from 1 signed report\./)).toBeInTheDocument();
			expect(screen.getByText('1 more report arrived but is not counted: sender not verified.')).toBeInTheDocument();
			expect(screen.queryByText(/other senders/)).not.toBeInTheDocument();
		});

		it('only an unverified report: no table, no "0 reports" sentence, and the unverified one says it is not counted', async () => {
			page(testing({ evidence: { ...EVIDENCE, counted_reports: 0, uncounted_reports: 2 } }));
			expect(await screen.findByText('No signed TLS report yet')).toBeInTheDocument();
			expect(screen.queryByText(/successful and .* failed sessions/)).not.toBeInTheDocument();
			expect(screen.getByText('2 more reports arrived but are not counted: sender not verified.')).toBeInTheDocument();
		});

		it('more reports than the table lists: the sentence says how many are listed', async () => {
			page(testing({ reports: [report()], summary: { total_success: 500, total_failure: 4, report_count: 25, sts_success: 450, sts_failure: 3 } }));
			expect(await screen.findByText(/from 25 signed reports\. The newest 1 are listed\./)).toBeInTheDocument();
		});
	});

	describe('a verified report that covers a period before this policy was published', () => {
		const before = 'A verified report arrived, but it covers a period before this policy was published.';
		it('is said as it is, in testing, with the rule\'s other lines as they are', async () => {
			page(testing({
				reports: [report()], summary: { total_success: 50, total_failure: 4, report_count: 1, sts_success: 45, sts_failure: 3 },
				enforce: { ready: false, allowed: false, reasons: [before], checks: checks({ report: [before] }) },
			}));
			const rule = await screen.findByRole('list', { name: 'What enforce needs' });
			expect(within(rule).getByText(before)).toBeInTheDocument();
			expect(screen.queryByText(/No verified TLS report has arrived yet/)).not.toBeInTheDocument();
		});
	});

	describe('the whole enforce rule, with each line met or missing now', () => {
		it('names the senders the server names, operator additions included', async () => {
			const c = checks({ days: ['In testing for 5 of 7 days: 2 more.'] }).map((k) => (k.key === 'report' ? { ...k, label: 'A report signed by Google, Microsoft or Acme about this policy, with successful sessions' } : k));
			page(testing({ enforce: { ready: false, allowed: false, reasons: ['x'], checks: c }, evidence: { ...EVIDENCE, reporters: ['Google', 'Microsoft', 'Acme'] } }));
			const rule = await screen.findByRole('list', { name: 'What enforce needs' });
			expect(within(rule).getByText(/Google, Microsoft or Acme/)).toBeInTheDocument();
			expect(screen.queryByText(/known sender|like Google/)).not.toBeInTheDocument();
		});

		it('everything met but the policy cannot be reached: "The policy is served" is missing and the button stays off', async () => {
			const served = { ok: false, checked_at: NOW, reason: 'not_found', action: 'check_now', message: 'cannot be reached', url: 'u' };
			page(testing({ served, enforce: { ready: false, allowed: false, reasons: ['The policy cannot be reached right now.'], checks: checks({ served: ['The policy cannot be reached right now.'] }) } }));
			const rule = await screen.findByRole('list', { name: 'What enforce needs' });
			expect(within(rule).getByText(/Missing:/).closest('li')).toHaveTextContent('The policy is served');
			expect(screen.getByRole('button', { name: 'Switch to enforce' })).toBeDisabled();
		});
	});

	describe('what happens when enforcing is described', () => {
		it('only senders that check MTA-STS refuse, and only without a verified encrypted connection to a listed MX host; the evidence is not oversold', async () => {
			page(testing({ enforce: { ready: true, allowed: true, reasons: [], checks: checks() } }));
			await userEvent.click(await screen.findByRole('button', { name: 'Switch to enforce' }));
			const dlg = await screen.findByRole('dialog');
			expect(dlg).toHaveTextContent('senders that check MTA-STS deliver to example.com only over a verified encrypted connection to a listed MX host; they refuse otherwise.');
			expect(dlg).toHaveTextContent('senders that fetched the enforce policy may keep it for up to 7 days');
			expect(dlg).not.toHaveTextContent(/The reports show they can/);
		});

		it('switching back says senders that fetched the enforce policy MAY keep it', async () => {
			page(testing({ config: config({ mode: 'enforce', max_age: 604800 }), enforce: null, disable: { allowed: false, after: null, reason: 'x' } }));
			await userEvent.click(await screen.findByRole('button', { name: 'Switch to testing' }));
			expect(await screen.findByRole('dialog')).toHaveTextContent('Senders will deliver again even without a verified encrypted connection, and keep reporting. Senders that already fetched the enforce policy may keep it for up to 7 days.');
		});
	});
});
