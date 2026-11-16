// Where the dashboard says a domain has no Ready Set Mail report address: each place carries the one action (Connect reports) or says why
// there is none; and what the hosted service does not show because it only means something on a self-hosted install.
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router';
import { describe, expect, it } from 'vitest';
import { DoThisNext } from '../src/components/domain/DoThisNext';
import { DomainDetailPage } from '../src/pages/domains/DomainDetailPage';
import { DomainSettingsPage } from '../src/pages/domains/DomainSettingsPage';
import { OverviewPage } from '../src/pages/domains/OverviewPage';
import { ReportsStep } from '../src/pages/wizards/setup/ReportsStep';
import { SpfFlattenPage } from '../src/pages/wizards/SpfFlattenPage';
import { renderApp } from './render';

const ADDR = 'rua@rua.example.net';
const NOW = Math.floor(Date.now() / 1000);
const domain = { id: 1, domain: 'example.com', dmarc_policy: 'reject', rua_address: '', parent_id: null, created_at: 1700000000, alerts_enabled: 1, is_default: 0 };
const addr = (over: Record<string, unknown> = {}) => ({
	available: true, domain_id: 1, domain: 'example.com', managed_by: null, can_connect: true, refusal: null, address: null, connected_at: null, last_report_at: null,
	counted_since_connect: 0, reports_since_connect: 0, reports_before_connect: 0, visibility: null, state: 'not_connected', dns: null, apply_via_cloudflare: false, preview: null, parent: null, ...over,
});
const HOSTED = { status: { mode: 'saas' } } as const;
const baseRoutes = (over: Record<string, unknown> = {}) => ({
	'GET /api/domains': { domains: [domain] },
	'GET /api/hosted/config': { enabled: true, reports: true, records: false },
	'GET /api/domains/1/report-address': addr(),
	'GET /api/domains/1/stats': { domain: 'example.com', days: 7, stats: [] },
	'GET /api/domains/1/sources': { sources: [] },
	'GET /api/domains/1/wizard-state': { domain: 'complete', spf: 'complete', dkim: 'complete', dmarc: 'complete', routing: 'complete' },
	'GET /api/domains/1/dns-check': { found: true, has_rua: false, current_record: 'v=DMARC1; p=reject;', cf_managed: false },
	'GET /api/domains/1/monitor-subs': { subs: [] },
	'GET /api/domains/dns-host': { provider: null, nameservers: [], status: 'unknown' },
	'GET /api/cloudflare/connections': { connections: [], accounts: [], oauth: null, token_paste: false },
	...over,
});
const detail = (routes: Record<string, unknown>, opts: Parameters<typeof renderApp>[1] = {}) =>
	renderApp(
		<Routes>
			<Route path="/domains/:id" element={<DomainDetailPage />} />
		</Routes>,
		{ route: '/domains/1', ...HOSTED, ...opts, routes },
	);
const settings = (routes: Record<string, unknown>, opts: Parameters<typeof renderApp>[1] = {}) =>
	renderApp(
		<Routes>
			<Route path="/domains/:id/settings" element={<DomainSettingsPage />} />
		</Routes>,
		{ route: '/domains/1/settings', ...opts, routes },
	);
const before = (a: Element, b: Element) => !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);

describe('the domain page', () => {
	it('puts the statement and the action in the first screen (first on a narrow one by CSS order, after the steps and the offer on a wide one), and no second panel further down', async () => {
		detail(baseRoutes());
		const panel = await screen.findByTestId('connect-reports');
		expect(within(panel).getByText('Reports not connected yet')).toBeInTheDocument();
		expect(within(panel).getByRole('button', { name: 'Connect reports' })).toBeInTheDocument();
		// The reading and tab order is the wide layout's: the steps, then the panel. On a narrow screen CSS puts the panel first.
		expect(before(await screen.findByRole('heading', { name: 'Do this next' }), panel)).toBe(true);
		expect(panel).toHaveClass('max-lg:order-first');
		expect(screen.queryByTestId('reports-not-connected')).not.toBeInTheDocument();
		expect(screen.getAllByRole('button', { name: 'Connect reports' })).toHaveLength(1);
	});

	it('the panel stays where it is once acted on: connected and not in the record yet is still first', async () => {
		let current: unknown = addr();
		detail(baseRoutes({ 'GET /api/domains/1/report-address': () => current, 'POST /api/domains/1/report-address': () => { current = addr({ address: ADDR, state: 'not_published', dns: { checked_at: NOW, error: null, plan: { kind: 'add', name: '_dmarc.example.com', current: 'v=DMARC1; p=reject;', record: `v=DMARC1; p=reject; rua=mailto:${ADDR}`, created: false } } }); return { __status: 201, body: current }; } }));
		await userEvent.click(await screen.findByRole('button', { name: 'Connect reports' }));
		const panel = await screen.findByTestId('connect-reports');
		expect(await within(panel).findByText('Connected, record not published yet')).toBeInTheDocument();
		expect(panel).toHaveClass('max-lg:order-first'); // it does not move once acted on
	});

	it('where hosted refuses, the true sentence stays below and there is no button', async () => {
		detail(baseRoutes({ 'GET /api/domains/1/report-address': addr({ can_connect: false, refusal: "On this server, only the operator's workspaces can connect reports." }) }));
		expect(await screen.findByText("On this server, only the operator's workspaces can connect reports.")).toBeInTheDocument();
		expect(within(screen.getByTestId('reports-not-connected')).getByText('Reports not connected yet')).toBeInTheDocument();
		expect(screen.queryByRole('button', { name: 'Connect reports' })).not.toBeInTheDocument();
	});

	it('on hosted, without hosted records, no DNS tools are offered: MTA-STS needs the install\'s own reports domain and SPF flattening is off', async () => {
		const { calls } = detail(baseRoutes());
		await screen.findByRole('heading', { name: 'Do this next' });
		expect(screen.queryByRole('button', { name: /^DNS tools/ })).not.toBeInTheDocument();
		expect(calls.some((c) => c.path === '/api/domains/1/mta-sts' || c.path === '/api/domains/1/spf-flatten')).toBe(false);
	});
});

describe('"Do this next" carries the action', () => {
	const action = { key: 'connect-reports', status: 'note' as const, do: 'Connect reports so senders can be confirmed', why: 'Reports would show which services send.', who: 'You', cta: 'Connect reports', connectReports: true };
	it('a button that takes the person to the panel; none for a read-only member', async () => {
		const { unmount } = renderApp(
			<div>
				<DoThisNext actions={[action]} pending={false} canWrite onRetry={() => {}} />
				<div data-testid="connect-reports"><button type="button">Connect reports</button></div>
			</div>,
		);
		const link = within(await screen.findByRole('list')).getByRole('button', { name: 'Connect reports' });
		expect(link).toBeInTheDocument();
		unmount();
		renderApp(<DoThisNext actions={[action]} pending={false} canWrite={false} onRetry={() => {}} />);
		expect(await screen.findByText('Connect reports so senders can be confirmed')).toBeInTheDocument();
		expect(screen.queryByRole('button', { name: 'Connect reports' })).not.toBeInTheDocument();
	});
});

describe('the domain settings page', () => {
	it('hosted: the RUA line carries Connect reports; no Infrastructure and no Monitoring alerts (they need an install\'s own reports domain and sender)', async () => {
		settings(baseRoutes(), HOSTED);
		expect(await screen.findByText('Reports not connected yet: this domain has no Ready Set Mail report address.')).toBeInTheDocument();
		expect(await screen.findByRole('button', { name: 'Connect reports' })).toBeInTheDocument();
		expect(screen.queryByRole('heading', { name: 'Infrastructure' })).not.toBeInTheDocument();
		expect(screen.queryByRole('button', { name: /Set as default domain/ })).not.toBeInTheDocument();
		expect(screen.queryByRole('heading', { name: 'Monitoring alerts' })).not.toBeInTheDocument();
		expect(screen.getByRole('heading', { name: 'Danger zone' })).toBeInTheDocument();
	});

	it('hosted, where reports cannot be connected: the sentence, no button', async () => {
		settings(baseRoutes({ 'GET /api/domains/1/report-address': addr({ can_connect: false, refusal: "On this server, only the operator's workspaces can connect reports." }) }), HOSTED);
		expect(await screen.findByText('Reports not connected yet: this domain has no Ready Set Mail report address.')).toBeInTheDocument();
		expect(await screen.findByText("On this server, only the operator's workspaces can connect reports.")).toBeInTheDocument();
		expect(screen.queryByRole('button', { name: 'Connect reports' })).not.toBeInTheDocument();
	});

	it('self-host: Infrastructure stays, with what the button does and why you would press it, and the warning after', async () => {
		const { calls } = settings(baseRoutes({ 'GET /api/hosted/config': { enabled: false }, 'PUT /api/domains/1/set-default': { ok: true, domain: 'example.com', warning: 'Auth records for other domains now point to the old reports subdomain. Re-apply DMARC on each domain to update them.' } }));
		expect(await screen.findByRole('heading', { name: 'Infrastructure' })).toBeInTheDocument();
		expect(screen.getByText(/Reports for all your domains are received at/)).toHaveTextContent('reports.example.com once this is the default domain: choose it instead of the current default, for example before you remove that one.');
		expect(screen.getByRole('heading', { name: 'Monitoring alerts' })).toBeInTheDocument();
		expect(screen.queryByRole('button', { name: 'Connect reports' })).not.toBeInTheDocument();
		const btn = screen.getByRole('button', { name: /Set as default domain/ });
		await waitFor(() => expect(btn).toBeEnabled());
		await userEvent.click(btn);
		expect(await screen.findByText(/Re-apply DMARC on each domain/)).toBeInTheDocument();
		expect(calls.some((c) => c.method === 'PUT' && c.path === '/api/domains/1/set-default')).toBe(true);
	});
});

describe('the overview', () => {
	const summary = (id: number, d: string, report_connect: unknown = { can_connect: true, refusal: null, refusal_kind: null }) => ({ domain_id: id, domain: d, dmarc_policy: 'reject', spf_record: 'v=spf1 -all', total_messages: 0, pass_messages: 0, fail_messages: 0, dkim_total: 0, dkim_pass: 0, spf_total: 0, spf_pass: 0, mta_sts_enabled: 0, mta_sts_mode: null, report_connect });
	const over = (domains: Array<{ id: number; domain: string }>, rc?: unknown) =>
		renderApp(<OverviewPage />, {
			...HOSTED,
			routes: {
				'GET /api/domains': { domains: domains.map((d) => ({ ...domain, ...d })) },
				'GET /api/hosted/config': { enabled: true, reports: true, records: false },
				'GET /api/hosted/statuses': { statuses: {} },
				'GET /api/domains/summaries': { summaries: domains.map((d) => summary(d.id, d.domain, rc)), next_after: null, window_days: 30 },
				'GET /api/domains/1/report-address': addr(),
				'GET /api/domains/2/report-address': addr({ domain_id: 2, domain: 'example.org' }),
			},
		});
	it('one domain: its own action', async () => {
		over([{ id: 1, domain: 'example.com' }]);
		const box = await screen.findByTestId('reports-not-connected');
		expect(await within(box).findByRole('button', { name: 'Connect reports' })).toBeInTheDocument();
	});
	it('several domains: a Connect reports link to each domain\'s page', async () => {
		over([{ id: 1, domain: 'example.com' }, { id: 2, domain: 'example.org' }]);
		const box = await screen.findByTestId('reports-not-connected');
		const links = await within(box).findAllByRole('link', { name: 'Connect reports' });
		expect(links.map((l) => l.getAttribute('href'))).toEqual(['/domains/1', '/domains/2']);
	});
	it('where reports cannot come to this server: no action at all', async () => {
		over([{ id: 1, domain: 'example.com' }, { id: 2, domain: 'example.org' }], { can_connect: false, refusal: 'x', refusal_kind: 'operator_only' });
		expect(await screen.findByText('Reports are not available')).toBeInTheDocument();
		const box = screen.getByTestId('reports-not-connected');
		expect(within(box).queryByRole('link', { name: 'Connect reports' })).not.toBeInTheDocument();
		expect(within(box).queryByRole('button', { name: 'Connect reports' })).not.toBeInTheDocument();
	});
});

describe('the setup wizard\'s reports step', () => {
	const status = { domain_id: 1, domain: 'example.com', rua_address: '', offered_rua_address: null, cf_available: false, dmarc: { found: true, current_record: 'v=DMARC1; p=reject;' }, dns_errors: [] } as never;
	it('has the Connect reports action and a Back to the DMARC step', async () => {
		renderApp(
			<Routes>
				<Route path="/domains/:id/setup/5" element={<ReportsStep status={status} onNext={() => {}} onSkip={() => {}} onRetry={() => {}} />} />
				<Route path="/domains/:id/setup/4" element={<p>the DMARC step</p>} />
			</Routes>,
			{ route: '/domains/1/setup/5', ...HOSTED, routes: baseRoutes() },
		);
		expect(await screen.findByRole('button', { name: 'Connect reports' })).toBeInTheDocument();
		await userEvent.click(screen.getByRole('button', { name: 'Back' }));
		expect(await screen.findByText('the DMARC step')).toBeInTheDocument();
	});
});

describe('SPF flattening is not offered on the hosted service', () => {
	it('no entry point under DNS tools, no request for it, and the page says it is not available', async () => {
		const { calls } = detail(baseRoutes({ 'GET /api/domains/1/spf-flatten': { available: true, config: null, lookup_count: 1 } }));
		await screen.findByRole('heading', { name: 'Do this next' });
		expect(screen.queryByRole('button', { name: /^DNS tools/ })).not.toBeInTheDocument();
		expect(screen.queryByText('SPF flattening')).not.toBeInTheDocument();
		expect(calls.some((c) => c.path.includes('spf-flatten'))).toBe(false);
		const { unmount } = renderApp(
			<Routes>
				<Route path="/domains/:id/spf-flatten" element={<SpfFlattenPage />} />
			</Routes>,
			{ route: '/domains/1/spf-flatten', ...HOSTED, routes: baseRoutes() },
		);
		expect(await screen.findByText('SPF flattening is not available on the hosted service yet.')).toBeInTheDocument();
		unmount();
	});

	it('self-host keeps the tool and says only what the daily run does', async () => {
		detail(baseRoutes({ 'GET /api/hosted/config': { enabled: false }, 'GET /api/domains/1/mta-sts': { available: false, config: null, summary: null }, 'GET /api/domains/1/spf-flatten': { available: true, config: { enabled: true, ip_count: 7 }, lookup_count: 1 } }), { status: {} });
		await userEvent.click(await screen.findByRole('button', { name: /^DNS tools/ }));
		expect(await screen.findByText('7 IPs, as resolved when it ran. Not updated when your providers change theirs.')).toBeInTheDocument();
		expect(screen.queryByText(/re-resolved daily/)).not.toBeInTheDocument();
	});
});
