// The UX walk of the hosted plan (docs/billing.md "Pay as you go"; .flowchad/flows/add-a-paid-domain, create-second-workspace, buy-fix-one-domain): every
// state a person can be in, in a real browser at 375 and 1440 wide, light theme, against throwaway hosted instances with the fake Stripe
// (e2e/support/plan-world.ts). It writes one PNG per state and width (`<state>-<width>.png`) and measures.json (the primary action's bottom edge, the words above
// it at 375, the screens, clicks, fields and Stripe round trips of each flow) into UX_WALK_DIR (default: the system temp folder). It asserts only that each
// step could be taken: the judgement against the rules is the person's, from the shots and the numbers. Ports 8861-8864. Needs `npm run build:dashboard`.
import { expect, test, type Locator, type Page } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addCardOnStripe, member, OWNER, ownerWithFreeDomain, signUp, workspaceOf, world, type Instance } from './support/plan-world';

test.use({ colorScheme: 'light' });
test.setTimeout(900_000);

const DIR = process.env.UX_WALK_DIR ?? join(tmpdir(), 'rsm-ux-walk');
mkdirSync(DIR, { recursive: true });
const WIDTHS = [375, 1440] as const;
const heightOf = (w: number) => (w < 768 ? 812 : 900);
const measures: Record<string, unknown> = {};
const flows: Record<string, unknown> = {};
const problems: string[] = [];
let part = 'walk';
/** Each walk starts clean (a failed test restarts the worker, which would otherwise carry one walk's numbers into the next file). */
const begin = (name: string, page?: Page) => { current = page ?? null; part = name; for (const k of Object.keys(measures)) delete measures[k]; for (const k of Object.keys(flows)) delete flows[k]; problems.length = 0; };
const save = () => writeFileSync(join(DIR, `measures-${part}.json`), JSON.stringify({ measures, flows, problems }, null, 2));

/** One flow, counted the way the gate counts: the screens the person sees, their clicks, the fields they type, the pages left to Stripe. */
class Flow {
	clicks = 0; fields = 0; trips = 0; screens: string[] = [];
	constructor(readonly id: string) {}
	async click(l: Locator, o: { timeout?: number } = {}) { this.clicks++; await l.click(o); }
	async type(l: Locator, v: string) { this.fields++; await l.fill(v); }
	screen(name: string) { if (this.screens[this.screens.length - 1] !== name) this.screens.push(name); }
	done(extra: Record<string, unknown> = {}) { flows[this.id] = { screens: this.screens.length, screen_list: this.screens, clicks: this.clicks, fields_typed: this.fields, stripe_round_trips: this.trips, ...extra }; save(); }
}

/** A state, at both widths: the first screen the person sees (scrolled to `at` when the state is part of a long page) and where its primary action ends. */
async function shot(page: Page, state: string, o: { at?: Locator; primary?: Locator; words?: Locator } = {}) {
	const per: Record<string, unknown> = {};
	for (const w of WIDTHS) {
		await page.setViewportSize({ width: w, height: heightOf(w) });
		await page.waitForTimeout(500);
		await page.evaluate(() => { document.scrollingElement?.scrollTo(0, 0); document.querySelectorAll('main, [data-scroll]').forEach((e) => e.scrollTo?.(0, 0)); });
		await page.waitForTimeout(150);
		// A section of a long page (Settings → Billing) is shot whole; anything else is the first screen the person sees.
		if (o.at) await o.at.screenshot({ path: join(DIR, `${state}-${w}.png`) });
		else await page.screenshot({ path: join(DIR, `${state}-${w}.png`) });
		const entry: Record<string, unknown> = { viewport_h: heightOf(w) };
		if (o.primary) {
			const b = await o.primary.boundingBox().catch(() => null);
			const r = o.at ? await o.at.boundingBox().catch(() => null) : null;
			if (r) entry.primary_bottom_in_section_px = b ? Math.round(b.y + b.height - r.y) : null; // inside Settings: measured from the top of the section
			else { entry.primary_bottom_px = b ? Math.round(b.y + b.height) : null; entry.primary_in_first_screen = b ? b.y + b.height <= heightOf(w) : null; }
		}
		if (o.primary && w === 375) {
			const root = o.words ?? page.locator('main');
			const text = await root.innerText().catch(() => '');
			const label = (await o.primary.innerText().catch(() => '')).trim();
			const i = label ? text.lastIndexOf(label) : -1;
			entry.words_above_primary = i > 0 ? text.slice(0, i).split(/\s+/).filter(Boolean).length : null;
		}
		per[w] = entry;
	}
	measures[state] = per;
	save();
}

let current: Page | null = null;
let renewalNeedsBank = false;
/** The hosted invoice page is Stripe's https address; the fake's own address is plain http, which the app rightly does not offer as a link: show the states that carry that link with one. */
const INVOICE_PAGE = 'https://invoice.stripe.com/i/acct_test/walk';
async function withInvoiceLink(page: Page) {
	await page.route('**/api/billing', async (route) => {
		if (route.request().method() !== 'GET') return route.continue();
		const res = await route.fetch();
		const b = await res.json();
		if (b?.plan?.pending && !b.plan.pending.action_url) b.plan.pending.action_url = INVOICE_PAGE;
		if (renewalNeedsBank && b?.plan && !b.plan.action_required_url) b.plan.action_required_url = INVOICE_PAGE;
		await route.fulfill({ response: res, json: b });
	});
}

/** A step that must not stop the walk: what could not be done is a finding, listed in measures.json and in the test's failure. */
async function step(name: string, fn: () => Promise<void>) {
	try { await fn(); } catch (e) { await current?.screenshot({ path: join(DIR, `problem-${part}-${name.replace(/\W+/g, '-')}.png`) }).catch(() => undefined); problems.push(`${name}: ${String((e as Error).message).replace(/\x1b\[[0-9;]*m/g, '').split('\n').slice(0, 3).join(' ')}`); save(); }
}

const billingOf = (page: Page) => page.getByRole('region', { name: 'Billing' });
const settings = async (page: Page, inst: Instance, ws: string) => { await page.goto(`${inst.url}/#/w/${ws}/settings`); await expect(billingOf(page).getByRole('heading').first()).toBeVisible({ timeout: 30_000 }); };
const FAKE_AUTH = { authorization: 'Bearer rk_test_e2eplankey0123456789', 'stripe-version': '2025-09-30.clover', 'content-type': 'application/x-www-form-urlencoded' };

test('walk 1: the paid domain, the renewal that fails, the bank at renewal, the lapse, the member', async ({ page, browser }) => {
	begin('walk1', page);
	const { stripe, inst, stop } = await world(8861);
	try {
		const ws = await ownerWithFreeDomain(page, inst);
		await withInvoiceLink(page);
		await step('billing-free', async () => { await settings(page, inst, ws); await shot(page, 'billing-free', { at: billingOf(page), primary: billingOf(page).getByRole('button', { name: 'Start pay as you go' }), words: billingOf(page) }); });

		// 1. a second domain, no card: the list, the confirm, Stripe, the SAME confirm showing the card, one click.
		const f1 = new Flow('1 second domain, no card');
		await page.goto(`${inst.url}/#/w/${ws}/add`);
		f1.screen('Add domain (the zones of the Cloudflare account)');
		await step('cloudflare-also-list', async () => { await expect(page.getByRole('checkbox', { name: 'quietfield.net' })).toBeVisible({ timeout: 30_000 }); await shot(page, 'cloudflare-also-list', { primary: page.getByRole('button', { name: 'Not now' }) }); });
		await step('cloudflare-also-selected', async () => {
			await page.getByRole('checkbox', { name: 'brightwave-mail.com' }).click();
			await page.getByRole('checkbox', { name: 'quietfield.net' }).click();
			await shot(page, 'cloudflare-also-selected', { primary: page.getByRole('button', { name: 'Add 2: $10 a month' }) });
			await page.getByRole('checkbox', { name: 'brightwave-mail.com' }).click(); // one is enough for the walk
		});
		await step('flow 1', async () => {
			f1.clicks += 1; // ticking the zone (still ticked from the selection above)
			await f1.click(page.getByRole('button', { name: 'Add 1: $5 a month' }));
			f1.screen('Confirm, no card');
			await expect(page.getByRole('button', { name: 'Add a card to continue' })).toBeVisible({ timeout: 30_000 });
			await shot(page, 'confirm-no-card', { primary: page.getByRole('button', { name: 'Add a card to continue' }) });
			await f1.click(page.getByRole('button', { name: 'Add a card to continue' }));
			f1.trips++; f1.screen("Stripe's card page");
			await expect(page.getByText('Save a card (session')).toBeVisible({ timeout: 30_000 });
			await f1.click(page.getByRole('link', { name: 'Use test card 4242' }));
			f1.screen('Confirm, with the card');
			await expect(page.getByText(/^\$5 now, then \$5 a month from/)).toBeVisible({ timeout: 30_000 });
			await shot(page, 'confirm-card-first', { primary: page.getByRole('button', { name: 'Pay $5 and add' }) });
			await shot(page, 'card-return', { primary: page.getByRole('button', { name: 'Pay $5 and add' }) });
			await f1.click(page.getByRole('button', { name: 'Pay $5 and add' }));
			f1.screen('Domain list: Added');
			await expect(page.getByText('Added. $5 paid now, then $5 a month.')).toBeVisible({ timeout: 60_000 });
			await shot(page, 'added-and-billed');
		});
		f1.done({ words_above_primary: (measures['confirm-no-card'] as any)?.['375']?.words_above_primary ?? null });
		await step('billing-payg-qty1', async () => { await settings(page, inst, ws); await shot(page, 'billing-payg-qty1', { at: billingOf(page), primary: billingOf(page).getByRole('button', { name: /Change card, see invoices or cancel/ }), words: billingOf(page) }); });

		// 2. a third with the card on file: one confirm click, nothing charged at the click.
		const f2 = new Flow('2 paid domain, card on file');
		await step('flow 2', async () => {
			await page.goto(`${inst.url}/#/w/${ws}/add`);
			f2.screen('Add domain (the zones)');
			await f2.click(page.getByRole('checkbox', { name: 'harbor-lane.org' }));
			await f2.click(page.getByRole('button', { name: 'Add 1: $5 a month' }));
			f2.screen('Confirm, card on file');
			await expect(page.getByText('$5 a month for this domain, from today.')).toBeVisible({ timeout: 30_000 });
			await shot(page, 'confirm-with-card', { primary: page.getByRole('button', { name: 'Add for $5 a month' }) });
			await f2.click(page.getByRole('button', { name: 'Add for $5 a month' }));
			f2.screen('Domain list: Added');
			await expect(page.getByText('Added. $5 a month from today.')).toBeVisible({ timeout: 60_000 });
		});
		f2.done({ words_above_primary: (measures['confirm-with-card'] as any)?.['375']?.words_above_primary ?? null });
		await step('billing-payg-qtyN', async () => { await settings(page, inst, ws); await shot(page, 'billing-payg-qtyN', { at: billingOf(page), primary: billingOf(page).getByRole('button', { name: /Change card, see invoices or cancel/ }), words: billingOf(page) }); });

		// 5. a renewal that is declined, and the way back through Stripe's portal (the card is replaced there).
		const sub = [...stripe.fake.state.subscriptions.values()][0]!;
		const f5 = new Flow('5 renewal declined, recovery');
		await step('payment failed', async () => {
			stripe.fake.setCardBehavior(sub.customer, 'decline');
			stripe.fake.advancePeriod(sub.id);
			await page.goto(`${inst.url}/#/w/${ws}/`); await page.reload();
			f5.screen('Domain list: banner');
			await expect(page.getByText('Your last payment did not go through')).toBeVisible({ timeout: 30_000 });
			await shot(page, 'payment-problem-banner', { primary: page.getByRole('button', { name: 'Update your card' }) });
			await settings(page, inst, ws);
			await shot(page, 'billing-payment-failed', { at: billingOf(page), primary: billingOf(page).getByRole('button', { name: 'Update your card' }), words: billingOf(page) });
			await page.goto(`${inst.url}/#/w/${ws}/add`);
			await page.getByRole('checkbox', { name: 'brightwave-mail.com' }).click();
			await page.getByRole('button', { name: 'Add 1: $5 a month' }).click();
			await expect(page.getByText('Your last payment did not go through. Update your card to add more domains.')).toBeVisible({ timeout: 30_000 });
			await shot(page, 'payment-problem-add', { primary: page.getByRole('button', { name: 'Update your card' }) });
		});
		f5.clicks = 1; f5.trips = 1; f5.done({ note: 'banner on every page; one click to Stripe\'s portal where the card is replaced; the retry is Stripe\'s' });
		await step('recovered', async () => { stripe.fake.retryPayment(sub.id, { card: 'ok' }); await page.goto(`${inst.url}/#/w/${ws}/`); await page.reload(); await expect(page.getByText('Your last payment did not go through')).toHaveCount(0, { timeout: 30_000 }); });

		// 6b. a renewal that needs the bank (3-D Secure).
		await step('action required', async () => {
			stripe.fake.setCardBehavior(sub.customer, 'requires_action');
			stripe.fake.advancePeriod(sub.id);
			renewalNeedsBank = true;
			await settings(page, inst, ws); await page.reload();
			await expect(page.getByText('Your bank needs you to confirm the payment.')).toBeVisible({ timeout: 30_000 });
			await shot(page, 'billing-action-required', { at: billingOf(page), primary: billingOf(page).getByRole('link', { name: /Confirm the payment/ }), words: billingOf(page) });
			const inv = [...stripe.fake.state.invoices.values()].filter((i: any) => i.status !== 'paid').at(-1);
			if (inv) stripe.fake.completeInvoiceAction(inv.id, 'succeed');
			stripe.fake.setCardBehavior(sub.customer, 'ok');
			renewalNeedsBank = false;
		});

		// 8. the lapse after a declined card: free again, the other domains paused, the card said to be the problem.
		await step('lapsed declined', async () => {
			stripe.fake.setCardBehavior(sub.customer, 'decline');
			if (stripe.fake.state.subscriptions.get(sub.id).status === 'active') stripe.fake.advancePeriod(sub.id);
			(stripe.fake as any).exhaustRetries(sub.id, { to: 'canceled' });
			await settings(page, inst, ws); await page.reload();
			await expect(billingOf(page).getByText(/Pay as you go ended because a payment did not go through/)).toBeVisible({ timeout: 30_000 });
			await shot(page, 'billing-lapsed-declined', { at: billingOf(page), primary: billingOf(page).getByRole('button', { name: 'Update your card' }), words: billingOf(page) });
			await page.goto(`${inst.url}/#/w/${ws}/`);
			await shot(page, 'domains-paused');
		});

		// 8. the member's view.
		await step('billing-member', async () => {
			const m = await member(browser, inst, ws, 'member@harbor-lane.org');
			try { await m.page.goto(`${inst.url}/#/w/${ws}/settings`); await expect(billingOf(m.page).getByText(/Ask the workspace owner/)).toBeVisible({ timeout: 30_000 }); await shot(m.page, 'billing-member', { at: billingOf(m.page), words: billingOf(m.page) }); } finally { await m.ctx.close(); }
		});
	} finally {
		await stop();
		save();
	}
	expect(problems, problems.join('\n')).toEqual([]);
});

test('walk 2: a second workspace, not eligible and eligible; a workspace that pays from its first minute', async ({ page }) => {
	begin('walk2', page);
	const { inst, stop } = await world(8862);
	try {
		await signUp(page, inst, OWNER);
		const ws = workspaceOf(inst, OWNER);
		const f3 = new Flow('3a second workspace, not eligible');
		const openDialog = async () => {
			await page.getByRole('button', { name: /^Workspace: .*Switch workspace$/ }).click();
			await page.getByRole('menuitem', { name: 'Create workspace' }).click();
		};
		await step('flow 3a', async () => {
			await page.goto(`${inst.url}/#/w/${ws}/`);
			f3.screen('Domain list');
			await f3.click(page.getByRole('button', { name: /^Workspace: .*Switch workspace$/ })); await f3.click(page.getByRole('menuitem', { name: 'Create workspace' }));
			f3.screen('Create workspace');
			await f3.type(page.getByLabel('Workspace name'), 'Client A');
			await f3.click(page.getByRole('button', { name: 'Create workspace' }));
			await expect(page.getByText('Add a card to create more workspaces')).toBeVisible({ timeout: 30_000 });
			await shot(page, 'create-workspace-not-eligible', { primary: page.getByRole('button', { name: 'Add a card to continue' }), words: page.getByRole('dialog') });
			await f3.click(page.getByRole('button', { name: 'Add a card to continue' }));
			f3.trips++; f3.screen("Stripe's card page");
			await addCardOnStripe(page); f3.clicks++;
			f3.screen('The new workspace');
			await expect(page.getByText('Workspace created', { exact: true })).toBeVisible({ timeout: 30_000 });
		});
		f3.done({ words_above_primary: (measures['create-workspace-not-eligible'] as any)?.['375']?.words_above_primary ?? null });
		await step('billing-payg-qty0', async () => {
			const id = inst.d1("SELECT id FROM workspaces WHERE name = 'Client A'")[0]!.id as string;
			await settings(page, inst, id);
			await shot(page, 'billing-payg-qty0', { at: billingOf(page), primary: billingOf(page).getByRole('button', { name: /Change card, see invoices or cancel/ }), words: billingOf(page) });
		});
		const f3b = new Flow('3b second workspace, already paying');
		await step('flow 3b', async () => {
			f3b.screen('Domain list');
			await f3b.click(page.getByRole('button', { name: /^Workspace: .*Switch workspace$/ })); await f3b.click(page.getByRole('menuitem', { name: 'Create workspace' }));
			f3b.screen('Create workspace');
			await shot(page, 'create-workspace-eligible', { primary: page.getByRole('button', { name: 'Create workspace' }), words: page.getByRole('dialog') });
			await f3b.type(page.getByRole('dialog').getByLabel('Workspace name'), 'Client B');
			await f3b.click(page.getByRole('dialog').getByRole('button', { name: 'Create workspace' }));
			f3b.screen('The new workspace');
			await expect.poll(() => inst.d1("SELECT COUNT(*) AS n FROM workspaces WHERE name = 'Client B'")[0]!.n, { timeout: 30_000 }).toBe(1);
		});
		f3b.done({ words_above_primary: (measures['create-workspace-eligible'] as any)?.['375']?.words_above_primary ?? null });
		void openDialog;
	} finally {
		await stop();
		save();
	}
	expect(problems, problems.join('\n')).toEqual([]);
});

test('walk 3: the grandfather choice, the transfer refusal, the free-plan limit notice', async ({ page, browser }) => {
	begin('walk3', page);
	const { inst, stop } = await world(8863);
	try {
		const ws = await ownerWithFreeDomain(page, inst);
		const day = new Date().toISOString().slice(0, 10);
		await step('free-limit-notice', async () => {
			const id = inst.d1("SELECT id FROM domains WHERE domain = 'free-one.example'")[0]!.id;
			inst.d1(`INSERT INTO intake_failures (domain_id, workspace_id, day, reason, messages, last_at) VALUES (${id}, '${ws}', '${day}', 'cap_free_plan_day', 7, unixepoch())`);
			await page.goto(`${inst.url}/#/w/${ws}/domains/${id}`);
			await expect(page.getByText('Some reports were not saved')).toBeVisible({ timeout: 30_000 });
			await shot(page, 'free-limit-notice');
		});
		await step('grandfather-choice', async () => {
			for (const d of ['older-two.example', 'older-three.example']) inst.d1(`INSERT INTO domains (workspace_id, domain, rua_address, verified_via, org_domain) VALUES ('${ws}', '${d}', '', 'txt', '${d}')`);
			await page.goto(`${inst.url}/#/w/${ws}/settings?plan=start`);
			const b = billingOf(page);
			await expect(b.getByText(/This workspace holds 3 domains and only one is free/).first()).toBeVisible({ timeout: 30_000 });
			await shot(page, 'grandfather-choice', { at: b, primary: b.getByRole('button', { name: 'Add a card to continue' }), words: b });
		});
		await step('transfer-refusal', async () => {
			const other = await member(browser, inst, ws, 'colleague@harbor-lane.org', 'admin');
			try {
				await page.goto(`${inst.url}/#/w/${ws}/members`);
				await page.getByRole('button', { name: 'Make colleague@harbor-lane.org the owner' }).click();
				await page.getByRole('button', { name: 'Transfer ownership' }).click();
				await expect(page.getByText(/already has a free workspace/)).toBeVisible({ timeout: 30_000 });
				await shot(page, 'transfer-refusal');
			} finally { await other.ctx.close(); }
		});
	} finally {
		await stop();
		save();
	}
	expect(problems, problems.join('\n')).toEqual([]);
});

test('walk 4: the first payment that waits for the bank; cancelling at the period end; the plan that ended', async ({ page }) => {
	begin('walk4', page);
	const { stripe, inst, stop } = await world(8864);
	try {
		const ws = await ownerWithFreeDomain(page, inst);
		await withInvoiceLink(page);
		const f6 = new Flow('6 first payment needs the bank');
		await step('bank-pending', async () => {
			await f6.click(page.getByRole('checkbox', { name: 'quietfield.net' }));
			await f6.click(page.getByRole('button', { name: 'Add 1: $5 a month' }));
			f6.screen('Confirm, no card');
			await f6.click(page.getByRole('button', { name: 'Add a card to continue' }));
			f6.trips++; f6.screen("Stripe's card page");
			await expect(page.getByText('Save a card (session')).toBeVisible({ timeout: 30_000 });
			await f6.click(page.getByRole('link', { name: 'Card that needs authentication' }));
			f6.screen('Confirm, with the card');
			await expect(page.getByRole('button', { name: 'Pay $5 and add' })).toBeVisible({ timeout: 30_000 });
			await f6.click(page.getByRole('button', { name: 'Pay $5 and add' }));
			f6.trips++; f6.screen("Waiting for the bank (and the bank's page)");
			await expect(page.getByText("Waiting for your bank's confirmation")).toBeVisible({ timeout: 60_000 });
			await shot(page, 'bank-pending', { primary: page.getByRole('button', { name: 'Cancel' }) });
			await settings(page, inst, ws);
			await shot(page, 'billing-bank-pending', { at: billingOf(page), primary: billingOf(page).getByRole('button', { name: 'Cancel' }), words: billingOf(page) });
		});
		f6.done();
		await step('cancel the waiting payment', async () => {
			await billingOf(page).getByRole('button', { name: 'Cancel' }).click();
			await expect(billingOf(page).getByRole('button', { name: 'Start pay as you go' })).toBeVisible({ timeout: 30_000 });
			expect(inst.d1('SELECT COUNT(*) AS n FROM domains WHERE payment_pending_at IS NOT NULL')).toEqual([{ n: 0 }]);
		});
		// the same domain again, the bank now content with the card, then cancel in the portal (at the period end), then the end
		await step('payg again', async () => {
			for (const c of stripe.fake.state.customers.values()) stripe.fake.setCardBehavior(c.id, 'ok');
			await page.goto(`${inst.url}/#/w/${ws}/add`);
			await page.getByRole('checkbox', { name: 'quietfield.net' }).click();
			await page.getByRole('button', { name: 'Add 1: $5 a month' }).click();
			await expect(page.getByRole('button', { name: /^(Add a card to continue|Pay \$5 and add)$/ })).toBeVisible({ timeout: 30_000 });
			if (await page.getByRole('button', { name: 'Add a card to continue' }).isVisible()) { await page.getByRole('button', { name: 'Add a card to continue' }).click(); await addCardOnStripe(page); }
			await page.getByRole('button', { name: /^Pay \$5 and add$/ }).click();
			await expect(page.getByText(/^Added\./)).toBeVisible({ timeout: 60_000 });
		});
		const sub = [...stripe.fake.state.subscriptions.values()].at(-1);
		await step('billing-canceling', async () => {
			await fetch(`${stripe.url}/v1/subscriptions/${sub!.id}`, { method: 'POST', headers: FAKE_AUTH, body: 'cancel_at_period_end=true' });
			await page.waitForTimeout(2500);
			await settings(page, inst, ws); await page.reload();
			await expect(billingOf(page).getByText(/Your domains keep working until then/)).toBeVisible({ timeout: 30_000 });
			await shot(page, 'billing-canceling', { at: billingOf(page), primary: billingOf(page).getByRole('button', { name: /Change card, see invoices or cancel/ }), words: billingOf(page) });
		});
		await step('billing-lapsed', async () => {
			await fetch(`${stripe.url}/v1/subscriptions/${sub!.id}`, { method: 'DELETE', headers: FAKE_AUTH });
			await page.waitForTimeout(2500);
			await settings(page, inst, ws); await page.reload();
			await expect(billingOf(page).getByText(/Pay as you go ended\./)).toBeVisible({ timeout: 30_000 });
			await shot(page, 'billing-lapsed', { at: billingOf(page), primary: billingOf(page).getByRole('button', { name: 'Start pay as you go again' }), words: billingOf(page) });
		});
	} finally {
		await stop();
		save();
	}
	expect(problems, problems.join('\n')).toEqual([]);
});
