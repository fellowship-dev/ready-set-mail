import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { tokenLink, tokenPermissions } from '../src/lib/cloudflare-token-link';
import { ConnectStep } from '../src/pages/wizards/cloudflare/ConnectStep';
import { renderApp } from './render';

const parse = (hosted: boolean) => {
	const u = new URL(tokenLink(hosted));
	return { u, keys: JSON.parse(u.searchParams.get('permissionGroupKeys')!) as { key: string; type: string }[] };
};
const ZONE = { key: 'zone', type: 'read' };
const DNS = { key: 'dns', type: 'edit' };

describe('tokenLink', () => {
	it('hosted: Zone Read and DNS Edit only', () => {
		const { u, keys } = parse(true);
		expect(`${u.origin}${u.pathname}`).toBe('https://dash.cloudflare.com/profile/api-tokens');
		expect(keys).toEqual([ZONE, DNS]);
		expect(u.searchParams.get('accountId')).toBe('*');
		expect(u.searchParams.get('zoneId')).toBe('all');
		expect(u.searchParams.get('name')).toBe('Ready Set Mail');
	});
	it('self-host: the same plus Account Settings Read, nothing undocumented', () => {
		const { keys } = parse(false);
		expect(keys).toEqual([ZONE, DNS, { key: 'account_settings', type: 'read' }]);
		for (const p of [...tokenPermissions(true), ...tokenPermissions(false)]) {
			expect(['zone', 'dns', 'account_settings']).toContain(p.key);
			expect(['read', 'edit']).toContain(p.type);
		}
		expect(tokenLink(false)).not.toMatch(/email|routing/i);
	});
	it('encodes the JSON and the name', () => {
		expect(tokenLink(true)).toContain('permissionGroupKeys=%5B%7B%22key%22%3A%22zone%22');
		expect(tokenLink(true)).toContain('&name=Ready%20Set%20Mail');
	});
});

const offer = { connections: [], oauth: { available: false, scopes: [], via_relay: false }, token_paste: true, encryption_configured: true };

describe('ConnectStep token screen', () => {
	it('self-host: a new-tab button with the link, the honest lines and the by-hand sentence', async () => {
		renderApp(<ConnectStep offer={offer} onConnected={() => {}} />, { status: { mode: 'self-host' } });
		const a = await screen.findByRole('link', { name: 'Create the token in Cloudflare' });
		expect(a).toHaveAttribute('target', '_blank');
		expect(a).toHaveAttribute('rel', 'noopener noreferrer');
		expect(a).toHaveAttribute('href', tokenLink(false));
		expect(screen.getByText(/Cloudflare's page opens with Zone Read and DNS Edit already chosen\. You can narrow it to specific zones there before you create the token\./)).toBeInTheDocument();
		expect(screen.getByText(/Add these two by hand, Cloudflare's link cannot pre-fill them: Zone · Email Routing Rules · Edit \(for the reports mailbox\) and Account · Email Routing\s+Addresses · Edit \(for alert emails to you\)\./)).toBeInTheDocument();
		expect(screen.getByText('Create it by hand instead')).toBeInTheDocument();
		expect(screen.getByLabelText('Cloudflare API token')).toBeInTheDocument();
	});
});
