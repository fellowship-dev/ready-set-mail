import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { Route, Routes, useLocation } from 'react-router';
import { ConnectCloudflareLink } from '../src/components/ConnectCloudflareLink';
import { ConnectCloudflarePage, safeBack } from '../src/pages/cloudflare/ConnectCloudflarePage';
import { renderApp } from './render';

const conn = (over: Record<string, unknown> = {}) => ({ id: 'c1', label: 'Acme', auth_type: 'token', status: 'active', cf_account_name: 'Acme', zones: [], scopes: [], ...over });
const offer = () => ({ connections: [], oauth: { available: false, scopes: [], via_relay: false }, token_paste: true, encryption_configured: true });
const zone = (n: number, allowed = false) => ({ id: `z${n}`.padEnd(32, '0'), name: `d${n}.example.com`, allowed });

function Where() {
	const l = useLocation();
	return <p data-testid="where">{l.pathname + l.search}</p>;
}

beforeEach(() => {
	sessionStorage.clear();
	window.history.replaceState(null, '', '/');
});

describe('ConnectCloudflareLink', () => {
	const ui = (
		<Routes>
			<Route path="/domains/:id/setup" element={<><ConnectCloudflareLink /><Where /></>} />
		</Routes>
	);

	it('shows owners and admins a link that carries the current route', async () => {
		for (const role of ['owner', 'admin'] as const) {
			const { unmount } = renderApp(ui, { route: '/domains/5/setup?x=1', role });
			const link = await screen.findByRole('link', { name: 'Connect Cloudflare to write this for you' });
			expect(link).toHaveAttribute('href', `/cloudflare/connect?back=${encodeURIComponent('/domains/5/setup?x=1')}`);
			unmount();
		}
	});

	it('shows members nothing', async () => {
		renderApp(ui, { route: '/domains/5/setup', role: 'member' });
		await screen.findByTestId('where');
		expect(screen.queryByRole('link', { name: /Connect Cloudflare/ })).toBeNull();
	});
});

describe('safeBack', () => {
	it('keeps in-app paths and sends everything else home', () => {
		expect(safeBack('/domains/5/setup')).toBe('/domains/5/setup');
		for (const bad of [null, '', 'https://evil.example', '//evil.example', 'domains/5', '/\\evil.example', 'javascript:alert(1)']) expect(safeBack(bad)).toBe('/');
	});
});

describe('Connect Cloudflare page return path', () => {
	const page = (route: string, routes: Record<string, unknown>) =>
		renderApp(
			<Routes>
				<Route path="/cloudflare/connect" element={<ConnectCloudflarePage />} />
				<Route path="*" element={<Where />} />
			</Routes>,
			{ route, routes },
		);

	async function connectWithToken() {
		await userEvent.type(await screen.findByLabelText('Cloudflare API token'), 'x'.repeat(40));
		await userEvent.click(screen.getByRole('button', { name: 'Connect' }));
		await screen.findByRole('heading', { name: 'Choose zones' });
	}

	it('links the domain when its zone is allowed, then lands on back', async () => {
		const { calls } = page(`/cloudflare/connect?back=${encodeURIComponent('/domains/5/setup')}`, {
			'GET /api/cloudflare/connections': offer(),
			'POST /api/cloudflare/connections': { connection: conn() },
			'GET /api/cloudflare/connections/c1/zones': { zones: [zone(1, true), zone(2)] },
			'PUT /api/cloudflare/connections/c1/zones': { zones: [] },
			'GET /api/domains': { domains: [{ id: 5, domain: 'mail.d1.example.com' }] },
			'PUT /api/domains/5/connection': { ok: true },
		});
		await connectWithToken();
		await userEvent.click(screen.getByRole('button', { name: 'Next' }));
		await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent('/domains/5/setup'));
		expect(calls.find((c) => c.method === 'PUT' && c.path === '/api/domains/5/connection')?.body).toEqual({ connection_id: 'c1' });
	});

	it('does not link a domain whose zone is not allowed, but still returns', async () => {
		const { calls } = page(`/cloudflare/connect?back=${encodeURIComponent('/domains/5')}`, {
			'GET /api/cloudflare/connections': offer(),
			'POST /api/cloudflare/connections': { connection: conn() },
			'GET /api/cloudflare/connections/c1/zones': { zones: [zone(1, true), zone(2)] },
			'PUT /api/cloudflare/connections/c1/zones': { zones: [] },
			'GET /api/domains': { domains: [{ id: 5, domain: 'other.example.org' }] },
		});
		await connectWithToken();
		await userEvent.click(screen.getByRole('button', { name: 'Next' }));
		await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent('/domains/5'));
		expect(calls.some((c) => c.path === '/api/domains/5/connection')).toBe(false);
	});

	it('falls back to / when back is not an in-app path', async () => {
		page(`/cloudflare/connect?back=${encodeURIComponent('//evil.example/x')}`, {
			'GET /api/cloudflare/connections': offer(),
			'POST /api/cloudflare/connections': { connection: conn() },
			'GET /api/cloudflare/connections/c1/zones': { zones: [zone(1, true)] },
			'PUT /api/cloudflare/connections/c1/zones': { zones: [] },
		});
		await connectWithToken();
		await userEvent.click(screen.getByRole('button', { name: 'Next' }));
		await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent(/^\/$/));
	});
});
