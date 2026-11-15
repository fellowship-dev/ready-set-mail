import { screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { SettingsPage } from '../src/pages/settings/SettingsPage';
import { renderApp } from './render';

const routes = {
	'GET /api/mcp/connections': { connections: [] },
	'GET /api/access': { products: [], principals: [], credentials: [], grants: [] },
	'GET /api/resources': { domains: [] },
	'GET /api/metrics/google/connections': { configured: false, connections: [] },
	'GET /api/cloudflare/connections': { connections: [], oauth: { available: false, scopes: [], via_relay: false }, token_paste: true, encryption_configured: true },
	'GET /api/version': { current: '1.0.0', latest: null, update_available: false, release_url: '' },
};

describe('Settings by mode', () => {
	it('hosted: customer words, no installer or operator sections', async () => {
		renderApp(<SettingsPage />, { status: { mode: 'saas' }, routes });
		expect(await screen.findByLabelText('Agent address')).toBeInTheDocument();
		expect(screen.getByRole('button', { name: 'Copy agent address' })).toBeInTheDocument();
		expect(screen.getByText('Your account and workspace.')).toBeInTheDocument();
		await waitFor(() => expect(screen.queryByText('Loading metric connections…')).toBeNull());
		for (const gone of [/MCP endpoint/i, /Access keys/i, /resources:read/, /installer must configure/i, /Google Postmaster/, /Instance/, /Base domain/, /service credentials/i, /New group name/]) {
			expect(screen.queryByText(gone)).toBeNull();
		}
		expect(screen.queryByLabelText('Key name')).toBeNull();
		expect(screen.queryByRole('button', { name: /Access keys for scripts and services/ })).toBeNull();
	});

	it('self-hosted: keeps the operator view', async () => {
		renderApp(<SettingsPage />, { status: { mode: 'self-host' }, routes });
		expect(await screen.findByLabelText("This installation's MCP endpoint")).toBeInTheDocument();
		expect(await screen.findByRole('button', { name: /^Access keys for scripts and services/ })).toHaveAttribute('aria-expanded', 'false');
		expect(await screen.findByLabelText('Key name')).toBeInTheDocument();
		expect(screen.getByText('resources:read')).toBeInTheDocument();
		expect(await screen.findByText(/The installer must configure its Google OAuth application/)).toBeInTheDocument();
		expect(screen.getByRole('heading', { name: 'Instance' })).toBeInTheDocument();
	});
});
