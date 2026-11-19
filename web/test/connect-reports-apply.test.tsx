// The Connect reports panel when a Cloudflare connection reaches the domain's zone (review, then one Apply), and when it does not.
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { ConnectReports } from '../src/components/reports/ConnectReports';
import { READ_ONLY_REASON } from '../src/lib/session';
import { fail, renderApp } from './render';
import { noReach } from './reach';

const ADDR = 'rua@rua.example.net';
const domain = { id: 1, domain: 'example.com' };
const NOW = Math.floor(Date.now() / 1000);
const NAME = '_dmarc.example.com';
const LIVE = 'v=DMARC1; p=reject;';
const AFTER = `v=DMARC1; p=reject; rua=mailto:${ADDR}`;
const HASH = 'a'.repeat(64);
const review = (over: Record<string, unknown> = {}) => ({
	source: 'cloudflare', name: NAME, address: ADDR, now: LIVE, inherited: null, hash: HASH,
	outcome: { kind: 'write', action: 'update', after: AFTER, reason: 'Adds the Ready Set Mail report address. Every other tag stays as it is.' }, ...over,
});
const view = (over: Record<string, unknown> = {}) => ({
	available: true, reach: noReach, domain_id: 1, domain: 'example.com', managed_by: null, can_connect: true, refusal: null, address: null, connected_at: null,
	last_report_at: null, counted_since_connect: 0, reports_since_connect: 0, reports_before_connect: 0, visibility: null, state: 'not_connected',
	dns: null, apply_via_cloudflare: true, review: review(), ...over,
});
const addPlan = (over: Record<string, unknown> = {}) => ({ kind: 'add', name: NAME, current: LIVE, record: AFTER, created: false, ...over });
const connected = (plan: unknown, over: Record<string, unknown> = {}) =>
	view({ address: ADDR, state: 'not_published', connected_at: NOW, dns: { checked_at: NOW, error: null, plan }, ...over });
const written = () => connected({ kind: 'add', name: NAME, current: LIVE, record: AFTER, created: false }, { state: 'written', review: review({ outcome: { kind: 'present', reason: 'Already sends reports to Ready Set Mail.' }, now: AFTER }) });
const waiting = () => connected({ kind: 'published', name: NAME, record: AFTER }, { state: 'waiting', reach: { ...noReach, kind: 'own' as const }, review: review({ outcome: { kind: 'present', reason: 'Already sends reports to Ready Set Mail.' }, now: AFTER }) });
const ON = { 'GET /api/hosted/config': { enabled: true, reports: true, records: false }, 'GET /api/domains': { domains: [] }, 'GET /api/cloudflare/connections': { connections: [], accounts: [], oauth: null, token_paste: false } };
const show = (routes: Record<string, unknown>, role: 'owner' | 'admin' | 'member' = 'owner') => renderApp(<ConnectReports domain={domain} />, { role, routes: { ...ON, ...routes } });
const writes = (calls: Array<{ method: string; path: string; body: unknown }>) => calls.filter((c) => c.method !== 'GET').map((c) => `${c.method} ${c.path}`);
const APPLY = 'POST /api/domains/1/report-address/apply';
const choose = (extra: Record<string, unknown> = {}) =>
	view({
		review: review({
			now: 'v=DMARC1; p=reject; rua=mailto:a@x.test,mailto:b@y.test',
			outcome: {
				kind: 'choose',
				existing: ['mailto:a@x.test', 'mailto:b@y.test'],
				reason: 'The record already lists two report addresses. Receivers are only required to send reports to the first two, so ours is never added after them. Choose which of the first two it replaces, or leave the record as it is.',
				options: [
					{ replaces: 'mailto:a@x.test', after: `v=DMARC1; p=reject; rua=mailto:${ADDR},mailto:b@y.test` },
					{ replaces: 'mailto:b@y.test', after: `v=DMARC1; p=reject; rua=mailto:a@x.test,mailto:${ADDR}` },
				],
			},
		}),
		...extra,
	});

describe('Cloudflare reaches the zone, not connected yet', () => {
	it('one statement and one action; the action opens a review of now and after and writes nothing', async () => {
		const { calls } = show({ 'GET /api/domains/1/report-address': view() });
		expect(await screen.findByText('Reports not connected yet')).toBeInTheDocument();
		expect(screen.getByText(/A report address is where a domain's DMARC record sends its reports/)).toBeInTheDocument();
		await userEvent.click(await screen.findByRole('button', { name: 'Connect reports' }));
		expect(await screen.findByText(`Review the change to ${NAME}`)).toBeInTheDocument();
		const change = screen.getByTestId('change-dmarc');
		expect(change).toHaveTextContent(`Now: ${LIVE}`);
		expect(change).toHaveTextContent(`After Apply: ${AFTER}`);
		expect(screen.getByText(/Only rua= changes: the policy and every other tag stay as they are, and the report addresses already there are kept\./)).toBeInTheDocument();
		expect(screen.getByRole('button', { name: 'Apply' })).toBeEnabled();
		expect(writes(calls)).toEqual([]);
		await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
		expect(await screen.findByRole('button', { name: 'Connect reports' })).toBeInTheDocument();
		expect(writes(calls)).toEqual([]);
	});

	it('Apply sends the reviewed hash and the choice, never a record, and shows the state the server answers: written, public DNS not showing it yet', async () => {
		let current: unknown = view();
		const { calls } = show({
			'GET /api/domains/1/report-address': () => current,
			[APPLY]: () => {
				current = written();
				return { ok: true, wrote: true, status: current };
			},
		});
		await userEvent.click(await screen.findByRole('button', { name: 'Connect reports' }));
		await userEvent.click(await screen.findByRole('button', { name: 'Apply' }));
		expect(await screen.findByText('Report address added.')).toBeInTheDocument();
		expect(await screen.findByText('Written to Cloudflare, not in public DNS yet')).toBeInTheDocument();
		expect(screen.getByText('Written to Cloudflare; public DNS can take a few minutes to show it.')).toBeInTheDocument();
		expect(screen.queryByText(/not published/i)).not.toBeInTheDocument();
		expect(screen.queryByText(/Publish the record below/)).not.toBeInTheDocument();
		expect(screen.queryByRole('button', { name: 'Apply' })).not.toBeInTheDocument();
		expect(writes(calls)).toEqual([APPLY]);
		expect(calls.find((c) => c.method === 'POST')!.body).toEqual({ reviewed: HASH, choice: { kind: 'add' } });
		expect(JSON.stringify(calls.find((c) => c.method === 'POST')!.body)).not.toContain('v=DMARC1');
		expect(calls.some((c) => c.path.endsWith('/apply-dmarc'))).toBe(false);
	});

	it('then waiting, once public DNS shows the record', async () => {
		show({ 'GET /api/domains/1/report-address': waiting() });
		expect(await screen.findByText('Published, waiting for the first report')).toBeInTheDocument();
		expect(screen.getByText(/Your DMARC record lists the report address\. Receivers send reports about once a day, so the first one can take a day or two\./)).toBeInTheDocument();
	});

	it('a new record (none published) is p=none, said plainly', async () => {
		show({ 'GET /api/domains/1/report-address': view({ review: review({ now: null, outcome: { kind: 'write', action: 'create', after: `v=DMARC1; p=none; rua=mailto:${ADDR}`, reason: 'No DMARC record yet.' } }) }) });
		await userEvent.click(await screen.findByRole('button', { name: 'Connect reports' }));
		expect(await screen.findByTestId('change-dmarc')).toHaveTextContent('DMARC · TXT _dmarc · New');
		expect(screen.getByText(/p=none asks receivers for reports and changes nothing/)).toBeInTheDocument();
	});

	it('a subdomain with no record of its own: says which record it follows, and the record it gets keeps that policy', async () => {
		show({
			'GET /api/domains/1/report-address': view({
				review: review({
					now: null, inherited: { from: 'example.com', record: 'v=DMARC1; p=reject' },
					outcome: { kind: 'write', action: 'create', after: `v=DMARC1; p=reject; rua=mailto:${ADDR}`, reason: 'No DMARC record yet. It keeps the policy example.com already applies.' },
				}),
			}),
		});
		await userEvent.click(await screen.findByRole('button', { name: 'Connect reports' }));
		expect(await screen.findByText(/has no DMARC record of its own: it follows the record of/)).toBeInTheDocument();
		expect(screen.getByTestId('change-dmarc')).toHaveTextContent(`Will be: v=DMARC1; p=reject; rua=mailto:${ADDR}`);
		expect(screen.getByText(/It keeps the policy example\.com already applies/)).toBeInTheDocument();
	});

	it('two addresses already: only the first two can be replaced, or the record is left as it is; Apply only after one is chosen; no third', async () => {
		let current: unknown = choose();
		const { calls } = show({
			'GET /api/domains/1/report-address': () => current,
			[APPLY]: () => {
				current = written();
				return { ok: true, wrote: true, status: current };
			},
		});
		await userEvent.click(await screen.findByRole('button', { name: 'Connect reports' }));
		expect(await screen.findByText(/already lists two report addresses/)).toBeInTheDocument();
		expect(screen.getAllByRole('radio').map((r) => r.closest('label')?.textContent)).toEqual([
			expect.stringContaining('Replace mailto:a@x.test'),
			expect.stringContaining('Replace mailto:b@y.test'),
			expect.stringContaining('Leave the record as it is'),
		]);
		expect(screen.queryByText(/third/)).not.toBeInTheDocument();
		expect(screen.getByRole('button', { name: 'Apply' })).toBeDisabled();
		await userEvent.click(screen.getByRole('radio', { name: /Replace mailto:b@y\.test/ }));
		expect(screen.getByTestId('change-dmarc')).toHaveTextContent(`After Apply: v=DMARC1; p=reject; rua=mailto:a@x.test,mailto:${ADDR}`);
		await userEvent.click(screen.getByRole('button', { name: 'Apply' }));
		await waitFor(() => expect(calls.some((c) => c.method === 'POST')).toBe(true));
		expect(calls.find((c) => c.method === 'POST')!.body).toEqual({ reviewed: HASH, choice: { kind: 'replace', address: 'mailto:b@y.test' } });
	});

	it('two addresses, leave the record as it is: nothing is sent, and the panel says reports stay not connected', async () => {
		const { calls } = show({ 'GET /api/domains/1/report-address': choose() });
		await userEvent.click(await screen.findByRole('button', { name: 'Connect reports' }));
		await userEvent.click(await screen.findByRole('radio', { name: /Leave the record as it is/ }));
		expect(screen.getByText(/The record stays as it is and reports stay not connected/)).toBeInTheDocument();
		expect(screen.queryByRole('button', { name: 'Apply' })).not.toBeInTheDocument();
		expect(writes(calls)).toEqual([]);
	});

	it('the record changed since the review: the heading says so, the fresh record is shown with one Apply, and that Apply carries the fresh hash', async () => {
		const FRESH = 'b'.repeat(64);
		const changedNow = 'v=DMARC1; p=quarantine; rua=mailto:dmarc@thirdparty.example';
		const fresh = review({ hash: FRESH, now: changedNow, outcome: { kind: 'write', action: 'update', after: `${changedNow},mailto:${ADDR}`, reason: 'Adds the Ready Set Mail report address. Every other tag stays as it is.' } });
		let first = true;
		let current: unknown = view();
		const { calls } = show({
			'GET /api/domains/1/report-address': () => current,
			[APPLY]: () => {
				if (first) {
					first = false;
					return { __status: 409, body: { error: 'The record changed since you looked. Review it again before anything is written.', code: 'record_changed', review: fresh } };
				}
				current = written();
				return { ok: true, wrote: true, status: current };
			},
		});
		await userEvent.click(await screen.findByRole('button', { name: 'Connect reports' }));
		await userEvent.click(await screen.findByRole('button', { name: 'Apply' }));
		expect(await screen.findByRole('heading', { name: 'The record changed since you looked: here it is now' })).toBeInTheDocument();
		const change = screen.getByTestId('change-dmarc');
		expect(change).toHaveTextContent(`Now: ${changedNow}`);
		expect(change).toHaveTextContent(`After Apply: ${changedNow},mailto:${ADDR}`);
		expect(screen.getAllByRole('button', { name: 'Apply' })).toHaveLength(1);
		expect(screen.queryByText('Could not write the record')).not.toBeInTheDocument();
		await userEvent.click(screen.getByRole('button', { name: 'Apply' }));
		await waitFor(() => expect(calls.filter((c) => c.method === 'POST')).toHaveLength(2));
		expect(calls.filter((c) => c.method === 'POST')[1]!.body).toEqual({ reviewed: FRESH, choice: { kind: 'add' } });
		expect(await screen.findByText('Written to Cloudflare, not in public DNS yet')).toBeInTheDocument();
	});

	it('a write that fails after the server connected the domain: the error comes first, then the true state, and Apply to retry', async () => {
		let current: unknown = view();
		show({
			'GET /api/domains/1/report-address': () => current,
			[APPLY]: () => {
				current = connected(addPlan()); // the server connected the reports before the write that failed
				return fail(502, 'Cloudflare refused the write');
			},
		});
		await userEvent.click(await screen.findByRole('button', { name: 'Connect reports' }));
		await userEvent.click(await screen.findByRole('button', { name: 'Apply' }));
		const alert = await screen.findByText('Could not write the record');
		expect(screen.getByText('Cloudflare refused the write')).toBeInTheDocument();
		expect(await screen.findByText('Connected, record not published yet')).toBeInTheDocument();
		// FOLD: the error is above the state and the long record, so it is in the first screen at 375 wide.
		expect(alert.compareDocumentPosition(screen.getByText('Connected, record not published yet')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
		expect(screen.getByTestId('change-dmarc')).toHaveTextContent(AFTER);
		expect(screen.getByRole('button', { name: 'Apply' })).toBeEnabled();
		expect(screen.queryByText('Report address added.')).not.toBeInTheDocument();
		expect(screen.queryByText(/Publish the record below/)).not.toBeInTheDocument();
	});

	it('connected, not in the record yet, Cloudflare linked: the review and Apply are offered, not "publish the record below"', async () => {
		show({ 'GET /api/domains/1/report-address': connected(addPlan()) });
		expect(await screen.findByText('Connected, record not published yet')).toBeInTheDocument();
		expect(screen.getByRole('button', { name: 'Apply' })).toBeEnabled();
		expect(screen.getByText(/Review the change below and press Apply/)).toBeInTheDocument();
		expect(screen.queryByText(/Publish the record below/)).not.toBeInTheDocument();
		expect(screen.queryByText(/Add this TXT record at your DNS provider/)).not.toBeInTheDocument();
	});

	it('a read-only member sees the review but no enabled Apply, and nothing is written', async () => {
		const { calls } = show({ 'GET /api/domains/1/report-address': connected(addPlan()) }, 'member');
		expect(await screen.findByText('Connected, record not published yet')).toBeInTheDocument();
		const apply = screen.getByRole('button', { name: 'Apply' });
		await waitFor(() => expect(apply).toBeDisabled());
		expect(screen.getAllByText(READ_ONLY_REASON).length).toBeGreaterThan(0);
		expect(writes(calls)).toEqual([]);
	});

	it('a review that cannot be applied (several records, an invalid p=) says why and offers no Apply', async () => {
		show({ 'GET /api/domains/1/report-address': view({ review: review({ outcome: { kind: 'blocked', reason: 'There is more than one DMARC record. Receivers ignore all of them until only one is left.' } }) }) });
		expect(await screen.findByText(/There is more than one DMARC record/)).toBeInTheDocument();
		expect(screen.queryByRole('button', { name: 'Apply' })).not.toBeInTheDocument();
	});
});

describe('Cloudflare does not reach the zone', () => {
	it('Connect reports connects at once, then shows the full record to copy, never before', async () => {
		let current: unknown = view({ apply_via_cloudflare: false, review: null });
		const { calls } = show({
			'GET /api/domains/1/report-address': () => current,
			'POST /api/domains/1/report-address': () => {
				current = connected(addPlan(), { apply_via_cloudflare: false });
				return { __status: 201, body: current };
			},
			'GET /api/domains/dns-host': { provider: { id: 'godaddy', name: 'GoDaddy' }, nameservers: ['ns1.domaincontrol.com'], status: 'known' },
		});
		await screen.findByText('Reports not connected yet');
		expect(screen.queryByText(AFTER)).not.toBeInTheDocument();
		await userEvent.click(await screen.findByRole('button', { name: 'Connect reports' }));
		expect(await screen.findByText('Connected, record not published yet')).toBeInTheDocument();
		expect(screen.getByText(AFTER)).toBeInTheDocument();
		expect(screen.queryByRole('button', { name: 'Apply' })).not.toBeInTheDocument();
		expect(await screen.findByText(/Add these at GoDaddy, where example\.com's DNS is hosted\./)).toBeInTheDocument();
		expect(screen.queryByRole('link', { name: /Connect Cloudflare/ })).not.toBeInTheDocument();
		expect(writes(calls)).toEqual(['POST /api/domains/1/report-address']);
		// FOLD-01 at 375 wide: Check again sits with the status, above the long record to publish.
		const again = screen.getByRole('button', { name: 'Check again' });
		expect(again.compareDocumentPosition(screen.getByText(/TXT record at/)) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
	});

	it('with Cloudflare name servers, Connect Cloudflare is the alternative', async () => {
		show({
			'GET /api/domains/1/report-address': connected(addPlan(), { apply_via_cloudflare: false }),
			'GET /api/domains/dns-host': { provider: { id: 'cloudflare', name: 'Cloudflare' }, nameservers: ['ada.ns.cloudflare.com'], status: 'known' },
		});
		expect(await screen.findByRole('link', { name: 'Connect Cloudflare to write this for you' })).toBeInTheDocument();
	});
});

describe('where hosted refuses', () => {
	it('keeps the true sentence and shows no button, and nothing to apply', async () => {
		show({ 'GET /api/domains/1/report-address': view({ can_connect: false, refusal: "On this server, only the operator's workspaces can connect reports.", apply_via_cloudflare: false, review: null }) });
		expect(await screen.findByText("On this server, only the operator's workspaces can connect reports.")).toBeInTheDocument();
		expect(screen.queryByRole('button', { name: 'Connect reports' })).not.toBeInTheDocument();
		expect(screen.queryByRole('button', { name: 'Apply' })).not.toBeInTheDocument();
	});
});

describe('the explanation', () => {
	it('is one sentence with a More disclosure that says only what RFC 7489 guarantees', async () => {
		show({ 'GET /api/domains/1/report-address': view({ apply_via_cloudflare: false, review: null }) });
		const more = await screen.findByText('More');
		const box = more.closest('details')!;
		expect(box).not.toHaveAttribute('open');
		await userEvent.click(more);
		const t = within(box);
		expect(t.getByText(/send aggregate reports to the addresses in the rua= tag/)).toBeInTheDocument();
		expect(t.getByText(/ri= interval defaults to 86400 seconds/)).toBeInTheDocument();
		expect(t.getByText(/Reports contain no message content/)).toBeInTheDocument();
	});
});
