import { screen, waitFor } from '@testing-library/react';
import { Route, Routes } from 'react-router';
import { describe, expect, it } from 'vitest';
import { MtaStsPage } from '../src/pages/wizards/MtaStsPage';
import { SpfFlattenPage } from '../src/pages/wizards/SpfFlattenPage';
import { renderApp } from './render';

const hostedStatus = { enabled: true, hosted_id: 'abc', mta_sts: false, records: {}, pointers: [], pointer_status: { dmarc: 'ok', spf: 'ok', tls_rpt: 'ok', mta_sts: null, checked_at: 1 }, level_inputs: { dmarc_published: true, spf_published: true, mta_sts_published: false } };
const hosted = { status: { mode: 'saas' as const, configured: true, signup_open: true } };
const toolApi = (c: { path: string }) => /\/(mta-sts|spf-flatten|onboarding-status|spf-lookup-count)/.test(c.path);

const mtaRoute = (
	<Routes>
		<Route path="/domains/:id/mta-sts" element={<MtaStsPage />} />
	</Routes>
);
const spfRoute = (
	<Routes>
		<Route path="/domains/:id/spf-flatten" element={<SpfFlattenPage />} />
	</Routes>
);

describe('DNS tool routes where the tool is off', () => {
	it('hosted: SPF flattening is one line and a link back, and asks the tool nothing', async () => {
		const { calls, container } = renderApp(spfRoute, { ...hosted, route: '/domains/3/spf-flatten', routes: { 'GET /api/hosted/config': { enabled: true, records: true }, 'GET /api/domains/3/hosted': hostedStatus } });
		expect(await screen.findByText('SPF flattening is not available on the hosted service yet.')).toBeInTheDocument();
		expect(screen.getByRole('link', { name: 'Back to domain' })).toHaveAttribute('href', '/domains/3');
		expect(screen.queryByText(/Cloudflare/)).not.toBeInTheDocument();
		expect(screen.queryByRole('button')).not.toBeInTheDocument();
		expect(container.querySelectorAll('p')).toHaveLength(1);
		expect(calls.filter(toolApi)).toEqual([]);
	});

	it('hosted without hosted records: MTA-STS is one line and a link back, and asks the tool nothing', async () => {
		const { calls, container } = renderApp(mtaRoute, { ...hosted, route: '/domains/3/mta-sts', routes: { 'GET /api/hosted/config': { enabled: true, records: true }, 'GET /api/domains/3/hosted': { enabled: false } } });
		expect(await screen.findByText('MTA-STS is not available on the hosted service yet.')).toBeInTheDocument();
		expect(screen.getByRole('link', { name: 'Back to domain' })).toHaveAttribute('href', '/domains/3');
		expect(screen.queryByText(/Cloudflare/)).not.toBeInTheDocument();
		expect(screen.queryByRole('button')).not.toBeInTheDocument();
		expect(container.querySelectorAll('p')).toHaveLength(1);
		expect(calls.filter(toolApi)).toEqual([]);
	});

	it('hosted with the hosted-records config off: MTA-STS is off too', async () => {
		const { calls } = renderApp(mtaRoute, { ...hosted, route: '/domains/3/mta-sts', routes: { 'GET /api/hosted/config': { enabled: false } } });
		expect(await screen.findByText('MTA-STS is not available on the hosted service yet.')).toBeInTheDocument();
		expect(calls.filter(toolApi)).toEqual([]);
	});

	it('hosted with hosted records: the MTA-STS wizard opens as before', async () => {
		const { calls } = renderApp(mtaRoute, {
			...hosted,
			route: '/domains/3/mta-sts',
			routes: { 'GET /api/hosted/config': { enabled: true, records: true }, 'GET /api/domains/3/hosted': hostedStatus, 'GET /api/domains/3/mta-sts': { available: false, config: null, summary: null } },
		});
		expect(await screen.findByText(/MTA-STS tells sending mail servers/)).toBeInTheDocument();
		expect(screen.queryByText(/not available on the hosted service/)).not.toBeInTheDocument();
		await waitFor(() => expect(calls.some((c) => c.method === 'GET' && c.path === '/api/domains/3/mta-sts')).toBe(true));
	});

	it('self-host: both wizards open as before', async () => {
		renderApp(mtaRoute, { route: '/domains/3/mta-sts', routes: { 'GET /api/domains/3/mta-sts': { available: true, config: null, summary: null } } });
		expect(await screen.findByText(/MTA-STS tells sending mail servers/)).toBeInTheDocument();
	});
});
