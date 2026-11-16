import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router';
import { describe, expect, it } from 'vitest';
import { DnsTools } from '../src/components/domain/DnsTools';
import { SpfFlattenPage } from '../src/pages/wizards/SpfFlattenPage';
import { fail, me, renderApp, type Handler } from './render';

const now = () => Math.floor(Date.now() / 1000);
const ORIGINAL = 'v=spf1 include:a.example include:b.example ~all';
const FLAT = 'v=spf1 ip4:192.0.2.1 ip4:192.0.2.2 ~all';
const config = (over: Record<string, unknown> = {}) => ({ enabled: true, original_record: ORIGINAL, flattened_record: FLAT, previous_record: null, ip_count: 2, lookups_before: 14, lookups_after: 0, last_changed_at: now() - 86400, last_refreshed_at: now() - 7200, problem: null, ...over });
const status = (cfg: unknown, over: Record<string, unknown> = {}) => ({ available: true, access: { allowed: true }, config: cfg, lookup_count: 14, ...over });
const preview = (over: Record<string, unknown> = {}) => ({
	original: ORIGINAL, within_limits: false, live: null, problem: null,
	flat: { record: FLAT, bytes: 38, ip_count: 2, inlined: ['a.example', 'b.example'], kept_includes: [], lookups_before: 14, lookups_after: 0 },
	...over,
});
const wizard = (extra: Record<string, unknown | Handler> = {}) => ({ 'GET /api/domains/3/spf-flatten': status(null), 'GET /api/domains/3/spf-flatten/preview': preview(), ...extra });
const ui = (
	<Routes>
		<Route path="/domains/:id/spf-flatten" element={<SpfFlattenPage />} />
	</Routes>
);
const hosted = (spf: boolean) => ({ status: { mode: 'saas' as const }, routes: { 'GET /api/me': { ...me('owner'), add_ons: { spf_flattening: spf } } } });

/** Nothing the screens say may promise what the daily check does not do (the old text said "re-resolved daily", "updates itself" and "reduced to 1"). */
const noFalsePromise = () => expect(document.body.textContent).not.toMatch(/re-resolved|updates itself|reduced to 1|Enable SPF flattening/);

describe('SPF flatten wizard', () => {
	it('over the limit: why it matters, the two records, one primary action, then turned on', async () => {
		let on = false;
		const { calls } = renderApp(ui, {
			route: '/domains/3/spf-flatten',
			routes: wizard({
				'GET /api/domains/3/spf-flatten': () => (on ? status(config()) : status(null)),
				'POST /api/domains/3/spf-flatten': () => { on = true; return { ok: true, config: config() }; },
			}),
		});
		expect(await screen.findByText(/Your SPF record needs 14 lookups\. Receivers stop at 10 \(RFC 7208, section 4\.6\.4\)/)).toBeInTheDocument();
		expect(screen.getByText(ORIGINAL)).toBeInTheDocument();
		expect(screen.getByText(FLAT)).toBeInTheDocument();
		expect(screen.getByText('38 bytes')).toBeInTheDocument();
		expect(screen.getByText(/We check your includes every day and update the record when they change/)).toBeInTheDocument();
		await userEvent.click(screen.getByRole('button', { name: 'Continue' }));

		expect(await screen.findByText('This changes your live DNS')).toBeInTheDocument();
		expect(screen.getByText(/Every day around 11:00 UTC we read your includes again\. If your providers changed their addresses we update the record\. If we cannot read them we leave the record as it is and show it here\./)).toBeInTheDocument();
		const turnOn = screen.getByRole('button', { name: 'Turn on flattening' });
		await waitFor(() => expect(turnOn).toBeEnabled());
		await userEvent.click(turnOn);
		expect(await screen.findByRole('heading', { name: 'SPF flattening is on' })).toBeInTheDocument();
		expect(screen.getByText(/^On: 2 addresses in your record, using 0 of the 10 lookups\. Checked 2 hours ago; not changed since you turned it on\./)).toBeInTheDocument();
		expect(calls.filter((c) => c.method === 'POST' && c.path.endsWith('/spf-flatten'))).toMatchObject([{ body: { anyway: false } }]);
		expect(screen.getAllByRole('link', { name: 'Back to domain' }).every((l) => l.getAttribute('href') === '/domains/3')).toBe(true);
		noFalsePromise();
	});

	it('within the limit: says so plainly, no primary enable; "Flatten anyway" is the quiet way on', async () => {
		const { calls } = renderApp(ui, {
			route: '/domains/3/spf-flatten',
			routes: wizard({ 'GET /api/domains/3/spf-flatten': status(null, { lookup_count: 3 }), 'GET /api/domains/3/spf-flatten/preview': preview({ within_limits: true, flat: { ...preview().flat, lookups_before: 3 } }), 'POST /api/domains/3/spf-flatten': { ok: true, config: config() } }),
		});
		expect(await screen.findByText('Your record needs 3 of the 10 lookups receivers allow, so it is fine as it is. Flattening is not needed.')).toBeInTheDocument();
		expect(screen.queryByRole('button', { name: 'Continue' })).not.toBeInTheDocument();
		expect(screen.queryByRole('button', { name: /Turn on/ })).not.toBeInTheDocument();
		expect(screen.getAllByRole('link', { name: 'Back to domain' }).length).toBeGreaterThan(0);
		await userEvent.click(screen.getByRole('button', { name: 'Flatten anyway' }));
		const turnOn = await screen.findByRole('button', { name: 'Turn on flattening' });
		await waitFor(() => expect(turnOn).toBeEnabled());
		await userEvent.click(turnOn);
		await waitFor(() => expect(calls.find((c) => c.method === 'POST')?.body).toEqual({ anyway: true }));
		noFalsePromise();
	});

	it('names the includes it leaves as includes (selective flattening)', async () => {
		renderApp(ui, {
			route: '/domains/3/spf-flatten',
			routes: wizard({ 'GET /api/domains/3/spf-flatten/preview': preview({ flat: { ...preview().flat, inlined: ['a.example'], kept_includes: ['b.example'], lookups_after: 2 } }) }),
		});
		expect(await screen.findByText(/Flattening swaps one include for the addresses it lists today; b\.example stays as an include\./)).toBeInTheDocument();
	});

	it('a refusal is one plain sentence and there is no way to turn it on', async () => {
		const message = 'Even with every include replaced by its addresses, your record would need 12 lookups and 800 bytes. A record should stay within 10 lookups and 450 bytes, so we left it as it is.';
		renderApp(ui, { route: '/domains/3/spf-flatten', routes: wizard({ 'GET /api/domains/3/spf-flatten/preview': preview({ flat: null, problem: { kind: 'too_large', message } }) }) });
		expect(await screen.findByText(message)).toBeInTheDocument();
		expect(screen.queryByRole('button', { name: 'Continue' })).not.toBeInTheDocument();
		expect(screen.getAllByRole('link', { name: 'Back to domain' }).length).toBeGreaterThan(0);
	});

	it('a failed read is "could not read", with a retry; a record that is not there says so', async () => {
		renderApp(ui, { route: '/domains/3/spf-flatten', routes: wizard({ 'GET /api/domains/3/spf-flatten/preview': preview({ original: null, flat: null, problem: { kind: 'include_unresolved', message: 'We could not read the SPF record of example.com (timeout).' } }) }) });
		expect(await screen.findByText(/We could not read your SPF record just now/)).toBeInTheDocument();
		expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
	});
	it('really no record: says so and offers a way back', async () => {
		renderApp(ui, { route: '/domains/3/spf-flatten', routes: wizard({ 'GET /api/domains/3/spf-flatten/preview': preview({ original: null, flat: null }) }) });
		expect(await screen.findByText('No SPF record found')).toBeInTheDocument();
	});

	it('members can read but not turn on', async () => {
		renderApp(ui, { role: 'member', route: '/domains/3/spf-flatten', routes: wizard() });
		expect(await screen.findByTestId('read-only-notice')).toBeInTheDocument();
		await userEvent.click(await screen.findByRole('button', { name: 'Continue' }));
		expect(await screen.findByRole('button', { name: 'Turn on flattening' })).toBeDisabled();
	});

	it('shows a retryable error when the status cannot be loaded', async () => {
		renderApp(ui, { route: '/domains/3/spf-flatten', routes: wizard({ 'GET /api/domains/3/spf-flatten': () => fail(403, 'not yours') }) });
		expect(await screen.findByText('not yours')).toBeInTheDocument();
	});

	it('review after an edit made in Cloudflare: both records, Replace asks first, and posts replace', async () => {
		const problem = { kind: 'edited_outside', message: 'The SPF record in Cloudflare is not the one Ready Set Mail published, so someone changed it there. We have left it as it is.', since: now() };
		const { calls } = renderApp(ui, {
			route: '/domains/3/spf-flatten?review=1',
			routes: wizard({ 'GET /api/domains/3/spf-flatten': status(config({ problem })), 'GET /api/domains/3/spf-flatten/preview': preview({ live: 'v=spf1 include:someone.example -all' }), 'POST /api/domains/3/spf-flatten/refresh': { ok: true, outcome: 'changed', config: config() } }),
		});
		expect(await screen.findByText('In Cloudflare now')).toBeInTheDocument();
		expect(screen.getByText('v=spf1 include:someone.example -all')).toBeInTheDocument();
		expect(screen.getByText('Flattened from your original')).toBeInTheDocument();
		await userEvent.click(screen.getByRole('button', { name: 'Replace with the flattened record' }));
		expect(calls.some((c) => c.path.endsWith('/refresh'))).toBe(false);
		await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Replace' }));
		await waitFor(() => expect(calls.find((c) => c.path.endsWith('/refresh'))?.body).toEqual({ replace: true }));
	});

	it('is nothing but one sentence where the add-on is not available, and asks for nothing', async () => {
		const { calls } = renderApp(ui, { route: '/domains/3/spf-flatten', ...hosted(false) });
		expect(await screen.findByText('SPF flattening is not available on the hosted service.')).toBeInTheDocument();
		expect(calls.some((c) => c.path.includes('spf-flatten'))).toBe(false);
	});
});

describe('the SPF flattening card on the domain page', () => {
	const card = (spf: unknown, extra: Record<string, unknown> = {}) => renderApp(<DnsTools domainId={3} />, { route: '/domains/3', routes: { 'GET /api/domains/3/spf-flatten': spf, 'GET /api/domains/3/mta-sts': { available: false, config: null, summary: null }, ...extra } });

	it('off and over the limit: why, the lookups, and one quiet way in', async () => {
		card(status(null));
		expect(await screen.findByText('Your record needs 14 lookups; receivers stop at 10. Flattening replaces the includes with the addresses behind them.')).toBeInTheDocument();
		expect(screen.getByText(/14\/10 lookups/)).toBeInTheDocument();
		expect(screen.getByRole('link', { name: 'Open SPF flattening' })).toHaveAttribute('href', '/domains/3/spf-flatten');
	});
	it('off and within the limit: says it is not needed', async () => {
		card(status(null, { lookup_count: 3 }));
		expect(await screen.findByText('Your record uses 3 of the 10 lookups receivers allow, so it does not need flattening.')).toBeInTheDocument();
		expect(screen.getByRole('link', { name: 'See how it works' })).toBeInTheDocument();
	});
	it('on: what it holds, when it last looked, when it looks again; nothing about price', async () => {
		card(status(config({ lookups_after: 7 })));
		expect(await screen.findByText(/^On: 2 addresses in your record, using 7 of the 10 lookups\. Checked 2 hours ago; not changed since you turned it on\. Checked again every day around 11:00 UTC\.$/)).toBeInTheDocument();
		expect(screen.getByRole('button', { name: 'Turn off' })).toBeInTheDocument();
		expect(document.body.textContent).not.toMatch(/\$|price|per month|billing/i);
		noFalsePromise();
	});
	it('after a change: the previous and the current record are one click away', async () => {
		card(status(config({ previous_record: 'v=spf1 ip4:192.0.2.9 ~all', last_changed_at: 1_700_000_000 })));
		const summary = await screen.findByText(/^What changed on /);
		await userEvent.click(summary);
		expect(screen.getByText('v=spf1 ip4:192.0.2.9 ~all')).toBeInTheDocument();
		expect(screen.getByText('Before')).toBeInTheDocument();
		expect(screen.getByText('Now')).toBeInTheDocument();
		expect(screen.getAllByText(/changed on/).length).toBeGreaterThan(0);
	});
	it('the daily check has not run: says so, with the date', async () => {
		card(status(config({ last_refreshed_at: now() - 5 * 86400 })));
		expect(await screen.findByText(/^Last checked .*The daily check has not run since\.$/)).toBeInTheDocument();
	});

	const problems: Array<[string, string, string, 'button' | 'link']> = [
		['include_unresolved', 'We could not read the SPF record of b.example (it publishes no SPF record). Your record in Cloudflare is unchanged.', 'Try again', 'button'],
		['connection_lost', 'We could not reach Cloudflare. Your record in Cloudflare is unchanged.', 'Reconnect Cloudflare', 'link'],
		['too_large', 'Even with every include replaced by its addresses, your record would need 12 lookups and 800 bytes. A record should stay within 10 lookups and 450 bytes, so we left it as it is.', 'Turn off', 'button'],
		['macro', 'include:%{d}.x uses a macro, so the addresses depend on who is sending and cannot be flattened. Your record in Cloudflare is unchanged.', 'Turn off', 'button'],
		['edited_outside', 'The SPF record in Cloudflare is not the one Ready Set Mail published, so someone changed it there. We have left it as it is.', 'Review', 'link'],
		['record_missing', 'There is no SPF record at example.com in Cloudflare now. We have not added one.', 'Review', 'link'],
	];
	it.each(problems)('%s: the server sentence and the one action', async (kind, message, label, as) => {
		card(status(config({ problem: { kind, message, since: now() } })));
		expect(await screen.findByText(message)).toBeInTheDocument();
		expect(await screen.findByText('Needs attention')).toBeInTheDocument();
		expect(screen.getByRole(as, { name: label })).toBeInTheDocument();
	});
	it('Try again checks now and says what happened', async () => {
		const { calls } = card(status(config({ problem: { kind: 'include_unresolved', message: 'We could not read x.', since: now() } })), { 'POST /api/domains/3/spf-flatten/refresh': { ok: true, outcome: 'unchanged' } });
		await userEvent.click(await screen.findByRole('button', { name: 'Try again' }));
		await waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.path.endsWith('/refresh'))).toBe(true));
	});
	it('a turn-off that could not put the original back shows the original and tries again', async () => {
		const { calls } = card(status(config({ enabled: false, problem: { kind: 'restore_failed', message: 'We could not put your original record back in Cloudflare.', since: now() } })), { 'DELETE /api/domains/3/spf-flatten': undefined });
		expect(await screen.findByText(/We could not put your original record back in Cloudflare\. It is below: copy it into Cloudflare, or try again\./)).toBeInTheDocument();
		expect(screen.getByText(ORIGINAL)).toBeInTheDocument();
		await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
		await waitFor(() => expect(calls.some((c) => c.method === 'DELETE')).toBe(true));
	});
	it('the add-on went away while it was on: says refreshing stopped, and Turn off is there', async () => {
		card(status(config(), { access: { allowed: false } }));
		expect(await screen.findByText('Flattening is not switched on for this workspace any more, so the record is no longer refreshed. It still lists the addresses from the last check.')).toBeInTheDocument();
		expect(screen.getAllByRole('button', { name: 'Turn off' }).length).toBeGreaterThan(0);
	});
	it('where the add-on is not available the card is not there, and nothing is asked', async () => {
		const { calls } = renderApp(<DnsTools domainId={3} />, { route: '/domains/3', ...hosted(false), });
		await waitFor(() => expect(calls.some((c) => c.path === '/api/domains/3/mta-sts')).toBe(false));
		expect(screen.queryByText('SPF flattening')).not.toBeInTheDocument();
		expect(calls.some((c) => c.path.includes('spf-flatten'))).toBe(false);
	});
});
