// Independent first-time-user walk of the hosted plan. Evidence capture, not judgement. Ports 8871-8879. Needs `npm run build:dashboard`.
import { expect, test, type Page } from '@playwright/test';
import { addCardOnStripe, member, OWNER, ownerWithFreeDomain, quantities, signUp, workspaceOf, world, type Instance } from '../support/plan-world';
import { publishTxt, Walk } from './lib';

test.setTimeout(900_000);
const billingOf = (p: Page) => p.getByRole('region', { name: 'Billing' });
const FREE = 'free-one.com';

/** An owner who holds a free domain but has no Cloudflare connection (so a domain is typed, not picked). */
async function ownerPlain(page: Page, inst: Instance) {
	await signUp(page, inst, OWNER);
	const ws = workspaceOf(inst, OWNER);
	inst.d1(`INSERT INTO domains (workspace_id, domain, rua_address, verified_via, org_domain) VALUES ('${ws}', '${FREE}', '', 'txt', '${FREE}')`);
	return ws;
}
/** Type a domain on Add domain; if the page asks for a TXT record, publish it (what the person does at their DNS host) and check it. Returns whether a record was asked for. */
async function typeAndProve(w: Walk, inst: Instance, ws: string, domain: string, zone: string, o: { capState?: string } = {}) {
	const p = w.page;
	await p.goto(`${inst.url}/#/w/${ws}/add`);
	await expect(p.getByRole('button', { name: 'Continue' })).toBeVisible({ timeout: 30_000 });
	await w.type(p.getByLabel('Your domain'), domain);
	await w.click(p.getByRole('button', { name: 'Continue' }));
	const asked = await p.getByText('Verification record').waitFor({ timeout: 8_000 }).then(() => true, () => false);
	if (!asked) { w.note(`${domain}: no TXT record was asked for`); return false; }
	const txt = await p.locator('main').innerText();
	const name = /NAME\s+(\S+)/.exec(txt)![1]!, value = /VALUE\s+(\S+)/.exec(txt)![1]!;
	if (o.capState) await w.cap(o.capState, { primary: p.getByRole('button', { name: 'Check the record' }) });
	await publishTxt(inst, zone, name, value);
	await w.click(p.getByRole('button', { name: 'Check the record' }));
	return true;
}
const PRIMARY = /^(Add a card to continue|Pay \$\d+ and add|Add for .*|Add \d+: .*|Update your card)$/;

test('F2 second-domain-no-card', async ({ page }) => {
	const w = new Walk('F2-second-domain-no-card', page);
	const { stripe, inst, stop } = await world(8871);
	try {
		const ws = await ownerPlain(page, inst);
		await page.goto(`${inst.url}/#/w/${ws}/`); await page.reload();
		await expect(page.getByRole('link', { name: FREE, exact: true })).toBeVisible({ timeout: 30_000 });
		await w.cap('dashboard-one-free-domain', { primary: page.getByRole('link', { name: 'Add domain' }).first() });
		await w.attempt('second-domain', async () => {
			await w.click(page.getByRole('link', { name: 'Add domain' }).first());
			await expect(page.getByLabel('Your domain')).toBeVisible();
			await w.cap('add-domain-empty', { primary: page.getByRole('button', { name: 'Continue' }) });
			await w.type(page.getByLabel('Your domain'), 'second-site.com');
			await w.click(page.getByRole('button', { name: 'Continue' }));
			await expect(page.getByText('Verification record')).toBeVisible({ timeout: 30_000 });
			await w.cap('verify-txt-record', { primary: page.getByRole('button', { name: 'Check the record' }) });
			const txt = await page.locator('main').innerText();
			await publishTxt(inst, 'second-site.com', /NAME\s+(\S+)/.exec(txt)![1]!, /VALUE\s+(\S+)/.exec(txt)![1]!);
			await w.click(page.getByRole('button', { name: 'Check the record' }));
			await expect(page.getByRole('button', { name: PRIMARY })).toBeVisible({ timeout: 45_000 });
			await w.cap('confirm-no-card', { key: true, primary: page.getByRole('button', { name: PRIMARY }) });
			await w.preClick('confirm-no-card');
			await w.click(page.getByRole('button', { name: 'Add a card to continue' }));
			w.trips++;
			await expect(page.getByText('Save a card (session')).toBeVisible({ timeout: 30_000 });
			await w.cap('stripe-card-page', { primary: page.getByRole('link', { name: 'Use test card 4242' }) });
			await w.click(page.getByRole('link', { name: 'Use test card 4242' }));
			await expect(page.getByRole('button', { name: /^Pay \$\d+ and add$/ })).toBeVisible({ timeout: 30_000 });
			await w.cap('confirm-with-card-back-from-stripe', { key: true, primary: page.getByRole('button', { name: /^Pay \$\d+ and add$/ }) });
			await w.preClick('confirm-with-card-before-pay-click');
			await w.click(page.getByRole('button', { name: /^Pay \$\d+ and add$/ }));
			await expect(page.getByText(/^Added\./)).toBeVisible({ timeout: 60_000 });
			await w.cap('after-added-domain-list');
			w.note(`fake subscription item quantities after 2nd domain: ${JSON.stringify(quantities(stripe))}`);
		});
		// a subdomain of the free domain
		await w.attempt('subdomain-of-free', async () => {
			const asked = await typeAndProve(w, inst, ws, `mail.${FREE}`, FREE, { capState: 'subdomain-verify-txt' }); w.note(`subdomain asked for TXT: ${asked}`);
			await page.waitForTimeout(3000);
			await w.cap('subdomain-of-free-after-check', { key: true, primary: page.getByRole('button', { name: PRIMARY }).or(page.getByRole('link', { name: /^Go to/ })) });
			await w.attempt('subdomain-in-list', async () => { await page.goto(`${inst.url}/#/w/${ws}/`); await w.cap('domain-list-after-subdomain'); });
			await w.preClick('subdomain-of-free');
			w.note(`quantities after subdomain of the free domain: ${JSON.stringify(quantities(stripe))}`);
		});
		// a.pair-site.com + b.pair-site.com without pair-site.com
		await w.attempt('a-and-b-siblings', async () => {
			w.note(`a.pair-site.com asked for TXT: ${await typeAndProve(w, inst, ws, 'a.pair-site.com', 'pair-site.com', { capState: 'sibling-a-verify-txt' })}`);
			await page.waitForTimeout(3000);
			await w.cap('sibling-a-after-check', { key: true, primary: page.getByRole('button', { name: PRIMARY }).or(page.getByRole('link', { name: /^Go to/ })) });
			await w.preClick('sibling-a');
			const btn = page.getByRole('button', { name: /^(Add for|Pay \$\d+ and add)/ });
			if (await btn.isVisible().catch(() => false)) { await w.click(btn); await expect(page.getByText(/^Added\./)).toBeVisible({ timeout: 60_000 }); await w.cap('sibling-a-added'); }
			w.note(`quantities after a.pair-site.com: ${JSON.stringify(quantities(stripe))}`);
			w.note(`b.pair-site.com asked for TXT: ${await typeAndProve(w, inst, ws, 'b.pair-site.com', 'pair-site.com', { capState: 'sibling-b-verify-txt' })}`);
			await page.waitForTimeout(3000);
			await w.cap('sibling-b-after-check', { key: true, primary: page.getByRole('button', { name: PRIMARY }).or(page.getByRole('link', { name: /^Go to/ })) });
			await w.preClick('sibling-b');
			const btn2 = page.getByRole('button', { name: /^(Add for|Pay \$\d+ and add)/ });
			if (await btn2.isVisible().catch(() => false)) { await w.click(btn2); await expect(page.getByText(/^Added\./)).toBeVisible({ timeout: 60_000 }); await w.cap('sibling-b-added'); }
			w.note(`quantities after b.pair-site.com: ${JSON.stringify(quantities(stripe))}`);
		});
		await w.attempt('settings-billing', async () => {
			await page.goto(`${inst.url}/#/w/${ws}/settings`);
			await expect(billingOf(page).getByRole('heading').first()).toBeVisible({ timeout: 30_000 });
			await w.cap('settings-billing');
		});
		w.note(`domains in D1: ${JSON.stringify(inst.d1('SELECT domain, org_domain, verified_via FROM domains ORDER BY id'))}`);
	} finally { w.save(); await stop(); }
	expect(w.problems, w.problems.join('\n')).toEqual([]);
});
