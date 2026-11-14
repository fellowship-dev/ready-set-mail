import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes, useLocation } from 'react-router';
import { describe, expect, it } from 'vitest';
import { ClaimCard } from '../src/components/domain/ClaimCard';
import { DnsHostLine } from '../src/components/domain/DnsHostLine';
import { fail, renderApp } from './render';

const claim = { id: 4, domain: 'acme.io', status: 'pending' as const, txt_name: '_readysetmail.acme.io', txt_value: 'readysetmail-verify=abc', created_at: 1, last_checked_at: null, last_error: null };
const preview = { domain: 'acme.io', checked_at: new Date().toISOString(), source: 'public_dns', cached: false, nxdomain: false, spf: { status: 'found', record: 'v=spf1 ~all', lookup_count: 1, over_limit: false }, dmarc: { status: 'missing', policy: null, issue: null, inherited_from: null, record: null }, dkim: { status: 'not_found', selectors: [], scanned: 5, failed: 0 }, mx: { status: 'found' }, lookup_failed: [] };

const HOST = 'GET /api/domains/dns-host?name=acme.io';
const known = (provider: Record<string, unknown>) => ({ provider, nameservers: ['ns1.x.net'], status: 'known' });
const cf = known({ id: 'cloudflare', name: 'Cloudflare' });
const godaddy = known({ id: 'godaddy', name: 'GoDaddy' });
const conns = (over: Record<string, unknown> = {}) => ({ connections: [], oauth: { available: true, scopes: [], via_relay: false }, token_paste: true, encryption_configured: true, ...over });
const activeConn = { id: 'c1', label: 'Acme', auth_type: 'oauth', status: 'active', status_detail: null, cf_account_id: 'a', cf_account_name: 'Acme', scopes: [], zones: [{ id: 'z1', name: 'acme.io' }] };

const Where = () => <p data-testid="where">{useLocation().pathname + useLocation().search}</p>;
const card = (routes: Record<string, unknown>, props: { preview?: boolean } = {}, role: 'owner' | 'member' = 'owner') =>
	renderApp(
		<Routes>
			<Route path="/" element={<><ClaimCard claim={claim} {...props} /><Where /></>} />
			<Route path="*" element={<Where />} />
		</Routes>,
		{ role, routes: { 'GET /api/cloudflare/connections': conns(), 'GET /api/domains/claims/4/preview': preview, ...routes } },
	);

describe('claim proof step', () => {
	it('DOM order: reason, record, Verify, expectation, compact level', async () => {
		card({ [HOST]: godaddy }, { preview: true });
		const reason = await screen.findByText(/DNS is hosted at GoDaddy/);
		const record = screen.getByRole('group', { name: 'DNS record to add' });
		const verify = screen.getByRole('button', { name: 'Verify' });
		const expectation = screen.getByText('Usually a minute or two.');
		const level = await screen.findByText(/Public DNS today:/);
		const before = (a: Node, b: Node) => expect(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
		before(reason, record);
		before(record, verify);
		before(verify, expectation);
		before(expectation, level);
		expect(screen.getByRole('button', { name: 'See details' })).toHaveAttribute('aria-expanded', 'false');
	});

	it('while loading: the generic record, no sentence about who hosts DNS', async () => {
		card({ [HOST]: () => new Promise(() => {}) });
		expect(await screen.findByText('Prove you control acme.io by adding this DNS record')).toBeInTheDocument();
		expect(screen.getByText('_readysetmail.acme.io')).toBeInTheDocument();
		expect(screen.queryByText(/couldn't tell/)).toBeNull();
		expect(screen.getByRole('button', { name: 'Verify' })).toBeInTheDocument();
	});

	it.each([['unknown', { provider: null, nameservers: [], status: 'unknown' }], ['mixed', { provider: null, nameservers: ['a', 'b'], status: 'mixed', providers: [{ id: 'x', name: 'X' }] }], ['error', { provider: { id: 'godaddy', name: 'GoDaddy' }, nameservers: [], status: 'error' }]])('%s: we could not tell, generic record: the full name once, the short one in a quiet line and behind a toggle', async (_n, data) => {
		card({ [HOST]: data });
		expect(await screen.findByText("We couldn't tell who hosts DNS for acme.io.")).toBeInTheDocument();
		expect(screen.getByText('_readysetmail.acme.io')).toBeInTheDocument();
		expect(screen.getByText(/If your DNS provider adds the domain for you, use only/)).toHaveTextContent('_readysetmail');
		expect(screen.getAllByRole('button', { name: /^Copy name$/ })).toHaveLength(1);
		expect(screen.queryByText('Host')).toBeNull();
		expect(screen.queryByText(/GoDaddy/)).toBeNull();
		expect(screen.getAllByRole('button', { name: /^(Verify|Connect Cloudflare)$/ })).toHaveLength(1);
	});

	it('a failing request is also treated as unknown', async () => {
		card({ [HOST]: fail(500) });
		expect(await screen.findByText("We couldn't tell who hosts DNS for acme.io.")).toBeInTheDocument();
	});

	it('another known provider: names it, no help link without help_url, full name with the quiet line without host_field', async () => {
		card({ [HOST]: godaddy });
		expect(await screen.findByText("acme.io's DNS is hosted at GoDaddy. Add this record there to show you control the domain")).toBeInTheDocument();
		expect(screen.queryByRole('link')).toBeNull();
		expect(screen.getByText(/If your DNS provider adds the domain for you, use only/)).toBeInTheDocument();
		expect(screen.getByText('_readysetmail.acme.io')).toBeInTheDocument();
		expect(screen.getByRole('button', { name: 'Verify' })).toBeInTheDocument();
		expect(screen.queryByRole('button', { name: /Connect Cloudflare/ })).toBeNull();
	});

	it('help_url gives the link; host_field relative leads with the short name, the toggle shows the full one', async () => {
		card({ [HOST]: known({ id: 'godaddy', name: 'GoDaddy', help_url: 'https://example.com/help', host_field: 'relative' }) });
		const link = await screen.findByRole('link', { name: 'How to add a TXT record at GoDaddy' });
		expect(link).toHaveAttribute('href', 'https://example.com/help');
		expect(screen.getByText('_readysetmail')).toBeInTheDocument();
		expect(screen.queryByText('_readysetmail.acme.io')).toBeNull();
		expect(screen.queryByText(/If your DNS provider adds/)).toBeNull();
		await userEvent.click(screen.getByRole('button', { name: 'Show full name' }));
		expect(screen.getByText('_readysetmail.acme.io')).toBeInTheDocument();
		expect(screen.queryByText('_readysetmail')).toBeNull();
		await userEvent.click(screen.getByRole('button', { name: 'Show short name' }));
		expect(screen.getByText('_readysetmail')).toBeInTheDocument();
	});

	it('host_field fqdn leads with the full name', async () => {
		card({ [HOST]: known({ id: 'x', name: 'X', host_field: 'fqdn' }) });
		expect(await screen.findByText(/DNS is hosted at X/)).toBeInTheDocument();
		expect(screen.getByText('_readysetmail.acme.io')).toBeInTheDocument();
		expect(screen.queryByText(/If your DNS provider adds/)).toBeNull();
		expect(screen.getByRole('button', { name: 'Show short name' })).toBeInTheDocument();
	});

	it('Cloudflare DNS and a connectable instance: connect is the one primary, the record waits behind "I\'ll add it myself"', async () => {
		card({ [HOST]: cf });
		expect(await screen.findByText('acme.io uses Cloudflare for DNS. Connect Cloudflare and we add the record and verify for you')).toBeInTheDocument();
		expect(screen.queryByRole('group', { name: 'DNS record to add' })).toBeNull();
		expect(screen.queryByRole('button', { name: 'Verify' })).toBeNull();
		await userEvent.click(screen.getByRole('button', { name: 'Connect Cloudflare' }));
		await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent('/cloudflare/connect?back=%2F'));
	});

	it('"I\'ll add it myself" reveals the record and Verify', async () => {
		card({ [HOST]: cf });
		await userEvent.click(await screen.findByRole('button', { name: "I'll add it myself" }));
		expect(screen.getByRole('group', { name: 'DNS record to add' })).toBeInTheDocument();
		expect(screen.getByRole('button', { name: 'Verify' })).toBeInTheDocument();
	});

	it('Cloudflare DNS but the instance cannot store connections: the record first, never "is hosted at"', async () => {
		card({ [HOST]: cf, 'GET /api/cloudflare/connections': conns({ oauth: { available: false, scopes: [], via_relay: false }, token_paste: false, encryption_configured: false }) });
		expect(await screen.findByText('acme.io uses Cloudflare for DNS. Add this record there to show you control the domain')).toBeInTheDocument();
		expect(screen.queryByText(/is hosted at/)).toBeNull();
		expect(screen.getByRole('group', { name: 'DNS record to add' })).toBeInTheDocument();
		expect(screen.queryByRole('button', { name: /Connect Cloudflare/ })).toBeNull();
	});

	it('an allowed zone of an active connection: one primary Verify that works with no record shown', async () => {
		const { calls } = card({ [HOST]: cf, 'GET /api/cloudflare/connections': conns({ connections: [activeConn] }), 'POST /api/domains/claims/4/verify': { domain: { id: 9, domain: 'acme.io' } }, 'GET /api/domains': { domains: [] } });
		expect(await screen.findByText('Cloudflare is connected for acme.io. Verify to prove you control it.')).toBeInTheDocument();
		expect(screen.queryByRole('group', { name: 'DNS record to add' })).toBeNull();
		expect(screen.queryByRole('button', { name: 'Connect Cloudflare' })).toBeNull();
		await userEvent.click(screen.getByRole('button', { name: 'Verify' }));
		await waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.path === '/api/domains/claims/4/verify')).toBe(true));
	});

	it('a parent zone covers a subdomain claim', async () => {
		renderApp(<ClaimCard claim={{ ...claim, domain: 'mail.acme.io', txt_name: '_readysetmail.mail.acme.io' }} />, {
			routes: { 'GET /api/domains/dns-host?name=mail.acme.io': cf, 'GET /api/cloudflare/connections': conns({ connections: [activeConn] }) },
		});
		expect(await screen.findByText('Cloudflare is connected for mail.acme.io. Verify to prove you control it.')).toBeInTheDocument();
	});

	it('a member never sees the connect offer', async () => {
		card({ [HOST]: cf }, {}, 'member');
		expect(await screen.findByText('acme.io uses Cloudflare for DNS. Add this record there to show you control the domain')).toBeInTheDocument();
		expect(screen.queryByRole('button', { name: /Connect Cloudflare/ })).toBeNull();
	});
});

describe('DnsHostLine', () => {
	const line = (routes: Record<string, unknown>) => renderApp(<DnsHostLine domain="acme.io" />, { routes: { 'GET /api/cloudflare/connections': conns(), ...routes } });

	it('names the provider, with the help link only when given', async () => {
		line({ [HOST]: known({ id: 'godaddy', name: 'GoDaddy', help_url: 'https://example.com/h' }) });
		expect(await screen.findByText(/Add these at GoDaddy, where acme.io's DNS is hosted\./)).toBeInTheDocument();
		expect(screen.getByRole('link', { name: 'How to add a TXT record at GoDaddy' })).toBeInTheDocument();
	});

	it('no link without help_url', async () => {
		line({ [HOST]: godaddy });
		expect(await screen.findByText("Add these at GoDaddy, where acme.io's DNS is hosted.")).toBeInTheDocument();
		expect(screen.queryByRole('link')).toBeNull();
	});

	it.each([['unknown', { provider: null, nameservers: [], status: 'unknown' }], ['error', { provider: { id: 'godaddy', name: 'GoDaddy' }, nameservers: [], status: 'error' }], ['mixed', { provider: null, nameservers: [], status: 'mixed' }]])('renders nothing for %s', async (_n, data) => {
		const { calls, container } = line({ [HOST]: data });
		await waitFor(() => expect(calls.some((c) => c.path.startsWith('/api/domains/dns-host'))).toBe(true));
		await new Promise((r) => setTimeout(r, 30));
		expect(container).toBeEmptyDOMElement();
	});

	it('renders nothing while loading', () => {
		const { container } = line({ [HOST]: () => new Promise(() => {}) });
		expect(container).toBeEmptyDOMElement();
	});

	it('renders nothing when DNS is at Cloudflare and Cloudflare is connected, but says so when it is not', async () => {
		const { container } = line({ [HOST]: cf, 'GET /api/cloudflare/connections': conns({ connections: [activeConn] }) });
		await new Promise((r) => setTimeout(r, 50));
		expect(container).toBeEmptyDOMElement();
	});

	it('Cloudflare without a connection still names Cloudflare', async () => {
		line({ [HOST]: cf });
		expect(await screen.findByText("Add these at Cloudflare, where acme.io's DNS is hosted.")).toBeInTheDocument();
	});
});
