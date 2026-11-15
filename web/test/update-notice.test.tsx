import { screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { Banners } from '../src/components/Banners';
import { SettingsPage } from '../src/pages/settings/SettingsPage';
import { renderApp } from './render';

const NOTES = 'https://github.com/fellowship-dev/ready-set-mail/releases/tag/v2.1.0';
const UPGRADE = 'https://github.com/fellowship-dev/ready-set-mail/blob/v2.1.0/packages/db/UPGRADING.md';
const version = (v: Record<string, unknown>) => ({ current: '2.0.0', latest: null, update_available: false, release_url: 'https://github.com/fellowship-dev/ready-set-mail/releases/latest', upgrade_url: UPGRADE, ...v });
const settingsRoutes = {
	'GET /api/mcp/connections': { connections: [] },
	'GET /api/access': { products: [], principals: [], credentials: [], grants: [] },
	'GET /api/resources': { domains: [] },
	'GET /api/metrics/google/connections': { configured: false, connections: [] },
	'GET /api/cloudflare/connections': { connections: [], oauth: { available: false, scopes: [], via_relay: false }, token_paste: true, encryption_configured: true },
};

beforeEach(() => sessionStorage.clear());

describe('update notice', () => {
	it('names the available version and links the release notes and the upgrade guide', async () => {
		renderApp(<Banners />, { routes: { 'GET /api/version': version({ latest: '2.1.0', status: 'newer', update_available: true, release_url: NOTES }) } });
		expect(await screen.findByText('New version available: v2.1.0')).toBeInTheDocument();
		expect(screen.getByRole('link', { name: 'Release notes' })).toHaveAttribute('href', NOTES);
		expect(screen.getByRole('link', { name: 'How to upgrade' })).toHaveAttribute('href', UPGRADE);
	});

	it('shows nothing when up to date, ahead of the release, off or unknown', async () => {
		for (const v of [{ latest: '2.0.0', status: 'same' }, { latest: '1.2.0', status: 'older' }, { status: 'off' }, { status: 'unknown' }]) {
			const { unmount } = renderApp(<Banners />, { routes: { 'GET /api/version': version(v) } });
			await new Promise(r => setTimeout(r, 20));
			expect(screen.queryByText(/New version available/)).toBeNull();
			unmount();
		}
	});
});

describe('Settings version row', () => {
	const row = async (v: Record<string, unknown>) => {
		const r = renderApp(<SettingsPage />, { status: { mode: 'self-host' }, routes: { ...settingsRoutes, 'GET /api/version': version(v) } });
		await screen.findByRole('heading', { name: 'Instance' });
		return r;
	};

	it('"could not check" is not "up to date"', async () => {
		await row({ status: 'unknown' });
		expect(await screen.findByText('(could not check for updates)')).toBeInTheDocument();
		expect(screen.queryByText('(up to date)')).toBeNull();
	});

	it('up to date, ahead of the release, off, newer', async () => {
		let r = await row({ latest: '2.0.0', status: 'same' });
		expect(await screen.findByText('(up to date)')).toBeInTheDocument();
		r.unmount();
		r = await row({ latest: '1.2.0', status: 'older' });
		expect(await screen.findByText('(newer than the latest release, v1.2.0)')).toBeInTheDocument();
		r.unmount();
		r = await row({ status: 'off' });
		expect(await screen.findByText('(update check off)')).toBeInTheDocument();
		r.unmount();
		await row({ latest: '2.1.0', status: 'newer', update_available: true, release_url: NOTES });
		expect(await screen.findByRole('link', { name: 'v2.1.0 available' })).toHaveAttribute('href', NOTES);
	});
});
