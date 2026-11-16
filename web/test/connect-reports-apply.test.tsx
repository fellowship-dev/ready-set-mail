// The Connect reports panel when a Cloudflare connection reaches the domain's zone (review, then one Apply), and when it does not.
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { ConnectReports } from '../src/components/reports/ConnectReports';
import { READ_ONLY_REASON } from '../src/lib/session';
import { fail, renderApp } from './render';

const ADDR = 'rua@rua.example.net';
const domain = { id: 1, domain: 'example.com' };
const NOW = Math.floor(Date.now() / 1000);
const NAME = '_dmarc.example.com';
const LIVE = 'v=DMARC1; p=reject;';
const AFTER = `v=DMARC1; p=reject; rua=mailto:${ADDR}`;
const addPlan = (over: Record<string, unknown> = {}) => ({ kind: 'add', name: NAME, current: LIVE, record: AFTER, created: false, ...over });
const view = (over: Record<string, unknown> = {}) => ({
	available: true, domain_id: 1, domain: 'example.com', managed_by: null, can_connect: true, refusal: null, address: null, connected_at: null,
	last_report_at: null, counted_since_connect: 0, reports_since_connect: 0, reports_before_connect: 0, visibility: null, state: 'not_connected',
	dns: null, apply_via_cloudflare: true, preview: { checked_at: NOW, error: null, plan: addPlan() }, ...over,
});
const connected = (plan: unknown, over: Record<string, unknown> = {}) =>
	view({ address: ADDR, state: 'not_published', connected_at: NOW, preview: null, dns: { checked_at: NOW, error: null, plan }, ...over });
const waiting = () => connected({ kind: 'published', name: NAME, record: AFTER }, { state: 'waiting' });
const ON = { 'GET /api/hosted/config': { enabled: true, reports: true, records: false }, 'GET /api/domains': { domains: [] }, 'GET /api/cloudflare/connections': { connections: [], accounts: [], oauth: null, token_paste: false } };
const show = (routes: Record<string, unknown>, role: 'owner' | 'admin' | 'member' = 'owner') => renderApp(<ConnectReports domain={domain} />, { role, routes: { ...ON, ...routes } });
const writes = (calls: Array<{ method: string; path: string; body: unknown }>) => calls.filter((c) => c.method !== 'GET').map((c) => `${c.method} ${c.path}`);

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

	it('Apply writes the record through the one apply route, then shows the report address added and the waiting words', async () => {
		let current: unknown = view();
		const { calls } = show({
			'GET /api/domains/1/report-address': () => current,
			'POST /api/domains/1/apply-dmarc': () => {
				current = waiting();
				return { ok: true, record: AFTER, created: false, reports: { state: 'connected', address: ADDR } };
			},
		});
		await userEvent.click(await screen.findByRole('button', { name: 'Connect reports' }));
		await userEvent.click(await screen.findByRole('button', { name: 'Apply' }));
		expect(await screen.findByText('Report address added.')).toBeInTheDocument();
		expect(await screen.findByText('Published, waiting for the first report')).toBeInTheDocument();
		expect(screen.getByText(/Your DMARC record lists the report address\. Receivers send reports about once a day, so the first one can take a day or two\./)).toBeInTheDocument();
		expect(writes(calls)).toEqual(['POST /api/domains/1/apply-dmarc']);
		expect(calls.find((c) => c.method === 'POST')!.body).toEqual({ record: AFTER });
	});

	it('a new record (none published) is p=none, said plainly', async () => {
		show({ 'GET /api/domains/1/report-address': view({ preview: { checked_at: NOW, error: null, plan: addPlan({ current: null, record: `v=DMARC1; p=none; rua=mailto:${ADDR}`, created: true }) } }) });
		await userEvent.click(await screen.findByRole('button', { name: 'Connect reports' }));
		expect(await screen.findByTestId('change-dmarc')).toHaveTextContent('DMARC · TXT _dmarc · New');
		expect(screen.getByText(/p=none asks receivers for reports and changes nothing/)).toBeInTheDocument();
	});

	it('two addresses already: the existing choice and its words, and Apply only after one is chosen', async () => {
		const options = [
			{ replaces: 'mailto:a@x.test', record: `v=DMARC1; p=reject; rua=mailto:${ADDR},mailto:b@y.test` },
			{ replaces: 'mailto:b@y.test', record: `v=DMARC1; p=reject; rua=mailto:a@x.test,mailto:${ADDR}` },
			{ replaces: null, record: `v=DMARC1; p=reject; rua=mailto:a@x.test,mailto:b@y.test,mailto:${ADDR}` },
		];
		const two = 'v=DMARC1; p=reject; rua=mailto:a@x.test,mailto:b@y.test';
		const { calls } = show({
			'GET /api/domains/1/report-address': view({ preview: { checked_at: NOW, error: null, plan: { kind: 'choose', name: NAME, current: two, existing: ['mailto:a@x.test', 'mailto:b@y.test'], options, created: false } } }),
			'POST /api/domains/1/apply-dmarc': { ok: true, record: options[1]!.record, created: false, reports: { state: 'connected', address: ADDR } },
		});
		await userEvent.click(await screen.findByRole('button', { name: 'Connect reports' }));
		expect(await screen.findByText(/Receivers only have to send to two, so choose which one this address replaces\. Nothing changes until you press Apply\./)).toBeInTheDocument();
		expect(screen.getByRole('button', { name: 'Apply' })).toBeDisabled();
		await userEvent.click(screen.getByRole('radio', { name: /Replace mailto:b@y\.test/ }));
		expect(screen.getByText(options[1]!.record)).toBeInTheDocument();
		await userEvent.click(screen.getByRole('button', { name: 'Apply' }));
		await waitFor(() => expect(calls.some((c) => c.method === 'POST')).toBe(true));
		expect(calls.find((c) => c.method === 'POST')!.body).toEqual({ record: options[1]!.record });
	});

	it('a write that fails after the server connected the domain: the true state, the error, and Apply to retry', async () => {
		let current: unknown = view();
		show({
			'GET /api/domains/1/report-address': () => current,
			'POST /api/domains/1/apply-dmarc': () => {
				current = connected(addPlan()); // the server connected the reports before the write that failed
				return fail(502, 'Cloudflare refused the write');
			},
		});
		await userEvent.click(await screen.findByRole('button', { name: 'Connect reports' }));
		await userEvent.click(await screen.findByRole('button', { name: 'Apply' }));
		expect(await screen.findByText('Could not write the record')).toBeInTheDocument();
		expect(screen.getByText('Cloudflare refused the write')).toBeInTheDocument();
		expect(await screen.findByText('Connected, record not published yet')).toBeInTheDocument();
		expect(screen.getByTestId('change-dmarc')).toHaveTextContent(AFTER);
		expect(screen.getByRole('button', { name: 'Apply' })).toBeEnabled();
		expect(screen.queryByText('Report address added.')).not.toBeInTheDocument();
	});

	it('connected, not in the record yet, Cloudflare linked: Apply is always offered', async () => {
		show({ 'GET /api/domains/1/report-address': connected(addPlan()) });
		expect(await screen.findByText('Connected, record not published yet')).toBeInTheDocument();
		expect(screen.getByRole('button', { name: 'Apply' })).toBeEnabled();
		expect(screen.queryByText(/Add this TXT record at your DNS provider/)).not.toBeInTheDocument();
	});

	it('the record was written but public DNS does not show it yet: says so instead of "publish the record below"', async () => {
		let current: unknown = view();
		show({
			'GET /api/domains/1/report-address': () => current,
			'POST /api/domains/1/apply-dmarc': () => {
				current = connected(addPlan());
				return { ok: true, record: AFTER, created: false, reports: { state: 'connected', address: ADDR } };
			},
		});
		await userEvent.click(await screen.findByRole('button', { name: 'Connect reports' }));
		await userEvent.click(await screen.findByRole('button', { name: 'Apply' }));
		expect(await screen.findByText('Report address added.')).toBeInTheDocument();
		expect(screen.getByText(/The record was written to Cloudflare\. Public DNS can take a few minutes to show it/)).toBeInTheDocument();
		expect(screen.queryByRole('button', { name: 'Apply' })).not.toBeInTheDocument();
	});

	it('a read-only member sees the review but no enabled Apply, and nothing is written', async () => {
		const { calls } = show({ 'GET /api/domains/1/report-address': connected(addPlan()) }, 'member');
		expect(await screen.findByText('Connected, record not published yet')).toBeInTheDocument();
		const apply = screen.getByRole('button', { name: 'Apply' });
		await waitFor(() => expect(apply).toBeDisabled());
		expect(screen.getAllByText(READ_ONLY_REASON).length).toBeGreaterThan(0);
		expect(writes(calls)).toEqual([]);
	});
});

describe('Cloudflare does not reach the zone', () => {
	it('Connect reports connects at once, then shows the full record to copy, never before', async () => {
		let current: unknown = view({ apply_via_cloudflare: false, preview: null });
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
		show({ 'GET /api/domains/1/report-address': view({ can_connect: false, refusal: "On this server, only the operator's workspaces can connect reports.", apply_via_cloudflare: false, preview: null }) });
		expect(await screen.findByText("On this server, only the operator's workspaces can connect reports.")).toBeInTheDocument();
		expect(screen.queryByRole('button', { name: 'Connect reports' })).not.toBeInTheDocument();
		expect(screen.queryByRole('button', { name: 'Apply' })).not.toBeInTheDocument();
	});
});

describe('the explanation', () => {
	it('is one sentence with a More disclosure that says only what RFC 7489 guarantees', async () => {
		show({ 'GET /api/domains/1/report-address': view({ apply_via_cloudflare: false, preview: null }) });
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
