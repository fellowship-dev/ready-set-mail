import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Rollout } from '../src/components/domain/Rollout';
import { renderApp } from './render';

const domain = { id: 1, domain: 'app.example.com', rua_address: 'r@x.net', dmarc_policy: 'reject', parent_id: null, created_at: 1, alerts_enabled: 1, is_default: 0 } as never;
const next = (over: Record<string, unknown>) => ({ current_policy: 'reject', current_pct: 100, current_testing: false, current_record: 'v=DMARC1; p=reject; rua=mailto:r@x.net', current_step_index: 4, total_steps: 5, next_step: null, blocked: false, block_reason: null, behind_schedule: false, dns_preview: null, ...over });

describe('Rollout on the last step', () => {
	it('says "Fully graduated" and never "Cannot advance yet": there is nothing to advance to', async () => {
		renderApp(<Rollout domain={domain} />, { routes: { 'GET /api/domains/1/rollout-next': next({ blocked: true, block_reason: 'Pass rate is 82% — must be ≥90% to advance' }) } });
		expect(await screen.findByText('Fully graduated')).toBeInTheDocument();
		expect(screen.queryByText('Cannot advance yet')).toBeNull();
		expect(screen.queryByText(/must be ≥90% to advance/)).toBeNull();
	});
	it('still says why a real next step is blocked', async () => {
		renderApp(<Rollout domain={domain} />, { routes: { 'GET /api/domains/1/rollout-next': next({ current_policy: 'quarantine', current_step_index: 2, next_step: { policy: 'reject', pct: 100, testing: false }, blocked: true, block_reason: 'Pass rate is 82% — must be ≥90% to advance' }) } });
		expect(await screen.findByText('Cannot advance yet')).toBeInTheDocument();
	});
});
