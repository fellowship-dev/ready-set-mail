import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { CloudflareSection } from '../src/pages/settings/CloudflareSection';
import { renderApp } from './render';

const conn = (over: Record<string, unknown> = {}) => ({ id: 'c1', label: 'Acme', auth_type: 'token', status: 'active', status_detail: null, cf_account_name: 'Acme Inc', zones: [{ id: 'z1', name: 'a.example.com' }], scopes: [], ...over });
const list = (connections: unknown[]) => ({ connections, oauth: { available: false, scopes: [], via_relay: false }, token_paste: true, encryption_configured: true });
const zone = (n: number, allowed: boolean) => ({ id: `z${n}`, name: `z${n}.example.com`, allowed });

beforeEach(() => window.history.replaceState(null, '', '/'));

describe('Settings: Cloudflare', () => {
	it('lists connections with account, status and zone count, and one primary Connect when empty', async () => {
		const { unmount } = renderApp(<CloudflareSection />, { routes: { 'GET /api/cloudflare/connections': list([conn(), conn({ id: 'c2', label: 'Old', status: 'broken', status_detail: 'Cloudflare refused the token', zones: [] })]) } });
		expect(await screen.findByText('Acme')).toBeInTheDocument();
		expect(screen.getByText(/Account Acme Inc · 1 zone allowed/)).toBeInTheDocument();
		expect(screen.getByText('Connected')).toBeInTheDocument();
		expect(screen.getByText('Needs reconnecting')).toBeInTheDocument();
		expect(screen.getByText('Cloudflare refused the token')).toBeInTheDocument();
		expect(screen.getByRole('link', { name: 'Connect Cloudflare' })).toHaveAttribute('href', '/cloudflare/connect?back=%2Fsettings');
		unmount();
		renderApp(<CloudflareSection />, { routes: { 'GET /api/cloudflare/connections': list([]) } });
		expect(await screen.findByText(/No Cloudflare connection yet/)).toBeInTheDocument();
	});

	it('renders nothing for members', async () => {
		const { container } = renderApp(<CloudflareSection />, { role: 'member', routes: {} });
		await waitFor(() => expect(container.textContent).toBe(''));
	});

	it('chooses zones and saves the allow-list', async () => {
		const { calls } = renderApp(<CloudflareSection />, {
			routes: {
				'GET /api/cloudflare/connections': list([conn()]),
				'GET /api/cloudflare/connections/c1/zones': { zones: [zone(1, true), zone(2, false)] },
				'PUT /api/cloudflare/connections/c1/zones': { zones: [] },
			},
		});
		await userEvent.click(await screen.findByRole('button', { name: 'Choose zones' }));
		const boxes = await screen.findAllByRole('checkbox');
		expect(boxes[0]).toBeChecked();
		await userEvent.click(boxes[1]!);
		await userEvent.click(screen.getByRole('button', { name: 'Save zones' }));
		await waitFor(() => expect(calls.find((c) => c.method === 'PUT')?.body).toEqual({ zone_ids: ['z1', 'z2'] }));
	});

	it('disconnects only after a confirmation that mentions revoking the token at Cloudflare', async () => {
		const { calls } = renderApp(<CloudflareSection />, { routes: { 'GET /api/cloudflare/connections': list([conn()]), 'DELETE /api/cloudflare/connections/c1': { ok: true } } });
		await userEvent.click(await screen.findByRole('button', { name: 'Disconnect' }));
		const dialog = await screen.findByRole('dialog');
		expect(within(dialog).getByText(/does not cancel it at Cloudflare\. Revoke the token in your Cloudflare profile too/)).toBeInTheDocument();
		expect(calls.some((c) => c.method === 'DELETE')).toBe(false);
		await userEvent.click(within(dialog).getByRole('button', { name: 'Disconnect' }));
		await waitFor(() => expect(calls.some((c) => c.method === 'DELETE' && c.path === '/api/cloudflare/connections/c1')).toBe(true));
	});

	it('reconnects a broken pasted-token connection with a new token', async () => {
		const { calls } = renderApp(<CloudflareSection />, { routes: { 'GET /api/cloudflare/connections': list([conn({ status: 'broken' })]), 'PUT /api/cloudflare/connections/c1/token': { ok: true } } });
		expect(screen.queryByRole('button', { name: 'Choose zones' })).toBeNull();
		await userEvent.click(await screen.findByRole('button', { name: 'Reconnect' }));
		const field = screen.getByLabelText('New Cloudflare API token');
		expect(field).toHaveAttribute('type', 'password');
		await userEvent.type(field, 't'.repeat(40));
		await userEvent.click(screen.getByRole('button', { name: 'Save token' }));
		await waitFor(() => expect(calls.find((c) => c.method === 'PUT')?.body).toEqual({ token: 't'.repeat(40) }));
	});

	it('reconnects a broken OAuth connection by starting OAuth with its id', async () => {
		const { calls } = renderApp(<CloudflareSection />, {
			routes: {
				'GET /api/cloudflare/connections': { ...list([conn({ auth_type: 'oauth', status: 'broken' })]), oauth: { available: true, scopes: [], via_relay: false } },
				'POST /api/cloudflare/oauth/start': { authorize_url: 'http://localhost/authorize' },
			},
		});
		Object.defineProperty(window, 'location', { value: { ...window.location, assign: () => {}, hash: '#/settings', search: '' }, configurable: true, writable: true });
		await userEvent.click(await screen.findByRole('button', { name: 'Reconnect' }));
		await waitFor(() => expect(calls.find((c) => c.path === '/api/cloudflare/oauth/start')?.body).toEqual({ return_to: '/#/settings', connection_id: 'c1' }));
	});
});
