import { screen } from '@testing-library/react';
import { useEffect } from 'react';
import { useNavigate } from 'react-router';
import { describe, expect, it } from 'vitest';
import { removalNotice } from '../src/lib/removal-notice';
import { OverviewPage } from '../src/pages/domains/OverviewPage';
import { renderApp } from './render';

describe('removalNotice', () => {
	it('says which records were kept and why', () => {
		expect(removalNotice('acme.com', [{ type: 'TXT', name: '_mta-sts.acme.com', reason: 'its content no longer matches what Ready Set Mail wrote' }])).toBe(
			'Removed acme.com. Kept 1 DNS record you changed: TXT _mta-sts.acme.com (its content no longer matches what Ready Set Mail wrote).',
		);
		expect(removalNotice('acme.com', [])).toBe('Removed acme.com.');
	});
});

/** Arrives on the overview the way DomainSettingsPage sends the owner after a removal: with router state. */
function Arrive({ state }: { state: unknown }) {
	const navigate = useNavigate();
	useEffect(() => { void navigate('/', { state, replace: true }); }, [navigate, state]);
	return <OverviewPage />;
}
const routes = { 'GET /api/domains': { domains: [], pending_claims: [] }, 'GET /api/domains/claims': { claims: [] } };

describe('Overview after a removal', () => {
	const kept = [{ type: 'TXT', name: 'acme.com._report._dmarc.reports.x.com', reason: 'its content no longer matches what Ready Set Mail wrote' }];
	it('shows the kept records', async () => {
		renderApp(<Arrive state={{ removed: { domain: 'acme.com', kept } }} />, { routes });
		expect(await screen.findByText('Removed acme.com. Kept 1 DNS record you changed: TXT acme.com._report._dmarc.reports.x.com (its content no longer matches what Ready Set Mail wrote).')).toBeInTheDocument();
	});
	it('shows nothing when nothing was kept', async () => {
		renderApp(<Arrive state={{ removed: { domain: 'acme.com', kept: [] } }} />, { routes });
		await screen.findByText('Domains');
		expect(screen.queryByText(/Removed acme.com/)).toBeNull();
	});
});
