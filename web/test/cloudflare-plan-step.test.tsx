import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes, useLocation } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import type { DnsPlan, PlanWrite } from '../src/lib/dns-plan';
import { DoneStep } from '../src/pages/wizards/cloudflare/DoneStep';
import { PlanStep } from '../src/pages/wizards/cloudflare/PlanStep';
import { fail, renderApp } from './render';

const w = (over: Partial<PlanWrite>): PlanWrite => ({
	id: 'dmarc:1', domain: 'example.com', zone: 'example.com', type: 'TXT', name: '_dmarc.example.com',
	content: 'v=DMARC1; p=none; rua=mailto:rua@reports.example.com', action: 'create', before: null, reason: '', ...over,
});
const plan = (writes: PlanWrite[], over: Partial<DnsPlan> = {}, key: 'dmarc' | 'reports_mailbox' = 'dmarc'): DnsPlan => ({
	plan_id: 'p1', steps: [{ key, writes, satisfied: writes.every(x => x.action === 'none') }], not_written: [], ...over,
});

/** Buttons styled as the primary (brand fill) variant, excluding copy buttons. */
const primaries = () => screen.getAllByRole('button').filter(b => b.className.includes('bg-brand') && !/^Copy/.test(b.getAttribute('aria-label') ?? ''));
const onePrimary = (name: RegExp | string) => {
	const p = primaries();
	expect(p).toHaveLength(1);
	expect(p[0]).toHaveAccessibleName(name);
};

const two = [w({ id: 'dmarc:1' }), w({ id: 'dmarc:2', domain: 'example.org', name: '_dmarc.example.org' })];

describe('PlanStep', () => {
	it('has one primary button in each state, and copy buttons on every value', async () => {
		const user = userEvent.setup();
		renderApp(<PlanStep stepKey="dmarc" domainIds={[1, 2]} onNext={() => {}} />, {
			routes: { 'POST /api/onboarding/dns-plan': plan(two), 'POST /api/onboarding/dns-apply': { results: [{ id: 'dmarc:1', ok: true }, { id: 'dmarc:2', ok: true }] } },
		});
		await screen.findAllByRole('button');
		await screen.findByRole('button', { name: 'Write 2 records' });
		onePrimary('Write 2 records');
		expect(screen.getAllByRole('button', { name: /^Copy value of/ })).toHaveLength(2);
		await user.click(screen.getByRole('button', { name: 'Write 2 records' }));
		await screen.findByRole('button', { name: 'Next' });
		onePrimary('Next');
		expect(screen.getAllByText('Written')).toHaveLength(2);
	});

	it('is satisfied: "Already in place" and Next', async () => {
		const onNext = vi.fn();
		renderApp(<PlanStep stepKey="dmarc" domainIds={[1]} onNext={onNext} />, {
			routes: { 'POST /api/onboarding/dns-plan': plan([w({ action: 'none' })]) },
		});
		await screen.findByText('Already in place', { selector: 'p' });
		onePrimary('Next');
		await userEvent.setup().click(screen.getByRole('button', { name: 'Next' }));
		expect(onNext).toHaveBeenCalled();
	});

	it('shows the failure reason, keeps completed rows and retries only what is needed', async () => {
		const user = userEvent.setup();
		let applies = 0;
		const { calls } = renderApp(<PlanStep stepKey="dmarc" domainIds={[1, 2]} onNext={() => {}} />, {
			routes: {
				'POST /api/onboarding/dns-plan': () => (applies === 0 ? plan(two) : { ...plan([{ ...two[0]!, action: 'none' }, two[1]!]), plan_id: 'p2' }),
				'POST /api/onboarding/dns-apply': () => {
					applies++;
					return applies === 1
						? { results: [{ id: 'dmarc:1', ok: true }, { id: 'dmarc:2', ok: false, error: 'This zone is not allowed.' }] }
						: { results: [{ id: 'dmarc:2', ok: true }] };
				},
			},
		});
		await user.click(await screen.findByRole('button', { name: 'Write 2 records' }));
		await screen.findByText('This zone is not allowed.');
		onePrimary('Try again');
		expect(screen.getByText('Written')).toBeInTheDocument();
		expect(screen.getByText('example.com')).toBeInTheDocument();
		await user.click(screen.getByRole('button', { name: 'Try again' }));
		await screen.findByRole('button', { name: 'Next' });
		const apply = calls.filter(c => c.path === '/api/onboarding/dns-apply');
		expect(apply[1]!.body.plan_id).toBe('p2');
		expect(screen.getAllByText('Written')).toHaveLength(2);
	});

	it('shows the new plan when Cloudflare changed, and writes nothing', async () => {
		const user = userEvent.setup();
		renderApp(<PlanStep stepKey="dmarc" domainIds={[1]} onNext={() => {}} />, {
			routes: {
				'POST /api/onboarding/dns-plan': plan([w({})]),
				'POST /api/onboarding/dns-apply': { __status: 409, body: { error: 'x', code: 'plan_changed', plan: { ...plan([w({}), w({ id: 'dmarc:9', name: '_dmarc.b.com', domain: 'b.com' })]), plan_id: 'p9' } } },
			},
		});
		await user.click(await screen.findByRole('button', { name: 'Write 1 record' }));
		expect(await screen.findByText('Cloudflare changed since you looked; review again.')).toBeInTheDocument();
		onePrimary('Write 2 records');
		expect(screen.queryByText('Written')).toBeNull();
	});

	it('shows before and after on an update row', async () => {
		renderApp(<PlanStep stepKey="dmarc" domainIds={[1]} onNext={() => {}} />, {
			routes: { 'POST /api/onboarding/dns-plan': plan([w({ action: 'update', before: 'v=DMARC1; p=reject', content: 'v=DMARC1; p=reject; rua=mailto:rua@reports.example.com' })]) },
		});
		const row = (await screen.findByText('Update')).closest<HTMLElement>('li, tr')!;
		expect(within(row).getByText(/Before:/)).toBeInTheDocument();
		expect(row.textContent).toContain('v=DMARC1; p=reject');
		expect(row.textContent).toContain('After:');
		expect(row.textContent).toContain('rua=mailto:rua@reports.example.com');
	});

	it('shows rule sentences, "Write N changes" and non-written entries with links', async () => {
		renderApp(<PlanStep stepKey="reports_mailbox" domainIds={[1]} onNext={() => {}} />, {
			routes: {
				'POST /api/onboarding/dns-plan': plan(
					[w({ id: 'catch_all', type: 'EMAIL_ROUTING', content: 'Every address at reports.example.com → this Worker', action: 'rule' })],
					{ not_written: [{ what: 'Reports mailbox', step: 'reports_mailbox', reason: 'Nothing to do.', link: '/domains/1/setup' }, { what: 'SPF and DKIM', step: null, reason: 'Hidden here.' }, { what: 'DMARC', step: 'dmarc', reason: 'Other step.' }] },
					'reports_mailbox',
				),
			},
		});
		expect(await screen.findByText('Every address at reports.example.com → this Worker')).toBeInTheDocument();
		onePrimary('Write 1 change');
		expect(screen.getByRole('link', { name: 'Set it up by hand' })).toHaveAttribute('href', '/domains/1/setup');
		expect(screen.queryByText(/Hidden here/)).toBeNull();
		expect(screen.queryByText(/Other step/)).toBeNull();
	});
});

describe('PlanStep write results and layout', () => {
	it('says "Written and checked in Cloudflare" when verified, else "Written"', async () => {
		const user = userEvent.setup();
		renderApp(<PlanStep stepKey="dmarc" domainIds={[1, 2]} onNext={() => {}} />, {
			routes: {
				'POST /api/onboarding/dns-plan': plan(two),
				'POST /api/onboarding/dns-apply': { results: [{ id: 'dmarc:1', ok: true, verified: true }, { id: 'dmarc:2', ok: true, verified: false }] },
			},
		});
		await user.click(await screen.findByRole('button', { name: 'Write 2 records' }));
		expect(await screen.findByText('Written and checked in Cloudflare')).toBeInTheDocument();
		expect(screen.getAllByText('Written')).toHaveLength(1);
	});

	it('stacks each write below md and uses the table from md', async () => {
		const orig = window.matchMedia;
		const { unmount } = renderApp(<PlanStep stepKey="dmarc" domainIds={[1, 2]} onNext={() => {}} />, { routes: { 'POST /api/onboarding/dns-plan': plan(two) } });
		await screen.findByText('Write 2 records', { selector: 'button' }).catch(() => {});
		expect(await screen.findAllByRole('listitem')).toHaveLength(2);
		expect(screen.queryByRole('table')).toBeNull();
		unmount();
		window.matchMedia = ((q: string) => ({ ...orig(q), matches: true })) as typeof window.matchMedia;
		try {
			renderApp(<PlanStep stepKey="dmarc" domainIds={[1, 2]} onNext={() => {}} />, { routes: { 'POST /api/onboarding/dns-plan': plan(two) } });
			expect(await screen.findByRole('table')).toBeInTheDocument();
			expect(screen.queryAllByRole('listitem')).toHaveLength(0);
		} finally {
			window.matchMedia = orig;
		}
	});
});

describe('DoneStep', () => {
	it('runs the first check, shows the summary and goes to the overview', async () => {
		const user = userEvent.setup();
		const Where = () => <p data-testid="where">{useLocation().pathname}</p>;
		const { calls } = renderApp(
			<>
				<Routes>
					<Route path="/done" element={<DoneStep domainIds={[1, 2, 3]} written={{ domains: 3, records: 5 }} notWritten={[{ what: 'SPF and DKIM', reason: 'They depend on your senders.', link: '#/domains/1/setup' }]} />} />
					<Route path="/" element={<p>Overview</p>} />
				</Routes>
				<Where />
			</>,
			{ route: '/done', routes: { 'POST /api/onboarding/first-check': { results: [] } } },
		);
		expect(await screen.findByText('3 domains added, 5 records written')).toBeInTheDocument();
		await waitFor(() => expect(calls.find(c => c.path === '/api/onboarding/first-check')?.body).toEqual({ domain_ids: [1, 2, 3] }));
		expect(screen.getByRole('link', { name: 'Set it up by hand' })).toHaveAttribute('href', '/domains/1/setup');
		expect(screen.getAllByText('Public DNS can take a few minutes to show the changes.')).toHaveLength(1);
		onePrimary('Go to overview');
		sessionStorage.setItem('rsm_cf_wizard:ws_default', JSON.stringify({ step: 'done', domainIds: [1, 2, 3], written: { domains: 3, records: 5 } }));
		await user.click(screen.getByRole('button', { name: 'Go to overview' }));
		expect(await screen.findByText('Overview')).toBeInTheDocument();
		expect(screen.getByTestId('where')).toHaveTextContent('/');
		expect(sessionStorage.getItem('rsm_cf_wizard:ws_default')).toBeNull();
	});
});

describe('DoneStep waits for the first check', () => {
	function setup(firstCheck: () => unknown) {
		const Where = () => <p data-testid="where">{useLocation().pathname}</p>;
		return renderApp(
			<>
				<Routes>
					<Route path="/done" element={<DoneStep domainIds={[1]} written={{ domains: 1, records: 2 }} notWritten={[]} />} />
					<Route path="/" element={<p>Overview</p>} />
				</Routes>
				<Where />
			</>,
			{ route: '/done', routes: { 'POST /api/onboarding/first-check': firstCheck } },
		);
	}

	it('shows "Checking your domains…" until the check finishes, then clears progress and navigates', async () => {
		const user = userEvent.setup();
		let release!: () => void;
		const gate = new Promise<void>((r) => (release = r));
		sessionStorage.setItem('rsm_cf_wizard:ws_default', '{"step":"done","domainIds":[1],"written":{"domains":1,"records":2}}');
		setup(async () => {
			await gate;
			return { results: [] };
		});
		await user.click(await screen.findByRole('button', { name: 'Go to overview' }));
		expect(await screen.findByRole('button', { name: /Checking your domains/ })).toBeInTheDocument();
		expect(screen.getByTestId('where')).toHaveTextContent('/done');
		expect(sessionStorage.getItem('rsm_cf_wizard:ws_default')).not.toBeNull();
		release();
		expect(await screen.findByText('Overview')).toBeInTheDocument();
		expect(sessionStorage.getItem('rsm_cf_wizard:ws_default')).toBeNull();
	});

	it('still navigates when the check fails', async () => {
		const user = userEvent.setup();
		setup(() => fail(500, 'boom'));
		await user.click(await screen.findByRole('button', { name: 'Go to overview' }));
		expect(await screen.findByText('Overview')).toBeInTheDocument();
	});
});
