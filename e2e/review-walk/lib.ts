// Independent first-time-user walk: evidence capture only. Writes ~/walk/<flow>/<NN>-<state>-<width>-<scheme>[-full].png, steps.jsonl and measures.json.
// No page.route, no stubbed responses: a state that cannot be reached without stubbing is recorded as a problem.
import type { Locator, Page } from '@playwright/test';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const ROOT = join(homedir(), 'walk');
const H = (w: number) => (w < 768 ? 812 : 900);

const SENTENCE = /[^\n]+?(?:[.!?](?=\s|$)|$)/g;
const CATS: Record<string, RegExp> = {
	amount: /\$\s?\d|\bfree\b|per month|a month/i,
	moment_of_charge: /\b(now|today|charged?|next invoice|renew|from [A-Z][a-z]{2} \d|at the end|this month|immediately|when you)\b/i,
	which_card: /\bcard\b|visa|····|\*{3}|\d{4}\b/i,
	how_to_cancel: /cancel|remove|stop|end (the|your) plan|any time|anytime/i,
};

export class Walk {
	dir: string;
	step = 0;
	clicks = 0;
	fields = 0;
	trips = 0;
	screens: string[] = [];
	problems: string[] = [];
	errors: string[] = [];
	pre: Record<string, unknown> = {};
	notes: string[] = [];
	t0 = Date.now();
	constructor(readonly flow: string, readonly page: Page) {
		this.dir = join(ROOT, flow);
		mkdirSync(this.dir, { recursive: true });
		writeFileSync(join(this.dir, 'steps.jsonl'), '');
		this.watch(page);
	}
	watch(p: Page) {
		p.on('console', (m) => { if (m.type() === 'error') this.errors.push(`${m.text()} @ ${p.url()}`.slice(0, 400)); });
		p.on('pageerror', (e) => this.errors.push(`pageerror: ${e.message} @ ${p.url()}`.slice(0, 400)));
	}
	async click(l: Locator, o: { timeout?: number } = {}) { this.clicks++; await l.click(o); }
	async type(l: Locator, v: string) { this.fields++; await l.fill(v); }
	note(s: string) { this.notes.push(s); this.save(); }
	/** Run a step that must not stop the walk; what failed is a finding. */
	async attempt(name: string, fn: () => Promise<void>) {
		try { await fn(); } catch (e) {
			const msg = String((e as Error).message).replace(/\x1b\[[0-9;]*m/g, '').split('\n').slice(0, 4).join(' | ');
			this.problems.push(`${name}: ${msg}`);
			await this.page.screenshot({ path: join(this.dir, `problem-${name.replace(/\W+/g, '-')}.png`), fullPage: true }).catch(() => undefined);
			this.save();
		}
	}
	/** The sentences shown before the paying click (read from the dialog if one is open, else main). */
	async preClick(label: string, root?: Locator) {
		const r = root ?? this.page.locator('[role=dialog]').last().or(this.page.locator('main')).last();
		const text = await r.innerText().catch(() => '');
		const sentences = text.split('\n').flatMap((l) => l.match(SENTENCE) ?? []).map((s) => s.trim()).filter(Boolean);
		const by: Record<string, string[]> = {};
		for (const [k, re] of Object.entries(CATS)) by[k] = sentences.filter((s) => re.test(s));
		this.pre[label] = { full_text: text, ...by };
		this.save();
	}
	/** One screen, captured at every width and scheme. `key` adds dark at 1440. */
	async cap(state: string, o: { primary?: Locator; key?: boolean } = {}) {
		const p = this.page;
		this.step++;
		const nn = String(this.step).padStart(2, '0');
		const slug = state.replace(/[^\w-]+/g, '-');
		if (this.screens[this.screens.length - 1] !== state) this.screens.push(state);
		await p.waitForTimeout(500);
		const combos: Array<[number, 'light' | 'dark']> = [[375, 'light'], [375, 'dark'], [1440, 'light']];
		if (o.key) combos.push([1440, 'dark']);
		for (const [w, scheme] of combos) {
			await p.setViewportSize({ width: w, height: H(w) });
			await p.emulateMedia({ colorScheme: scheme });
			await p.waitForTimeout(350);
			await p.evaluate(() => { document.scrollingElement?.scrollTo(0, 0); document.querySelectorAll('main, [data-scroll]').forEach((e) => e.scrollTo?.(0, 0)); });
			await p.waitForTimeout(100);
			const base = join(this.dir, `${nn}-${slug}-${w}-${scheme}`);
			await p.screenshot({ path: `${base}.png` });
			await p.screenshot({ path: `${base}-full.png`, fullPage: true }).catch(() => undefined);
			const data = await p.evaluate((vh) => {
				const vis = (e: Element) => { const r = e.getBoundingClientRect(); const s = getComputedStyle(e); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
				const main = (document.querySelector('main') as HTMLElement | null)?.innerText ?? document.body.innerText;
				const dialogs = [...document.querySelectorAll('[role=dialog],[role=alertdialog]')].filter(vis).map((d) => (d as HTMLElement).innerText);
				const els = [...document.querySelectorAll('button, a[href], [role=button], [role=link], [role=checkbox]')].filter(vis).map((e) => {
					const r = e.getBoundingClientRect();
					const label = ((e as HTMLElement).innerText || e.getAttribute('aria-label') || '').trim().replace(/\s+/g, ' ');
					const region = e.closest('[role=dialog],[role=alertdialog]') ? 'dialog' : e.closest('main') ? 'main' : 'chrome';
					return { label, region, inside_first_screen: r.top >= 0 && r.bottom <= vh };
				}).filter((e) => e.label);
				const alerts = [...document.querySelectorAll('[role=alert],[role=status],[data-sonner-toast],[aria-live]')].filter(vis).map((e) => (e as HTMLElement).innerText.trim()).filter(Boolean);
				return { main, dialogs, els, alerts, title: document.title };
			}, H(w));
			let primary_label: string | null = null, bottom: number | null = null, words: number | null = null;
			if (o.primary) {
				const b = await o.primary.first().boundingBox({ timeout: 2000 }).catch(() => null);
				primary_label = ((await o.primary.first().innerText({ timeout: 2000 }).catch(() => '')) || (await o.primary.first().getAttribute('aria-label').catch(() => '')) || '').trim();
				bottom = b ? Math.round(b.y + b.height) : null;
				const root = data.dialogs.length ? data.dialogs.join('\n') : data.main;
				const i = primary_label ? root.lastIndexOf(primary_label) : -1;
				words = i >= 0 ? root.slice(0, i).split(/\s+/).filter(Boolean).length : null;
			}
			const grep = [...data.main.split('\n'), ...data.dialogs.flatMap((d) => d.split('\n')), ...data.alerts.flatMap((a) => a.split('\n'))].map((l) => l.trim()).filter((l) => /\$|\bprice|\bpay|\bplan|\bcard|\bupgrade|\bbilling|\binvoice/i.test(l));
			const errs = this.errors.splice(0);
			appendFileSync(join(this.dir, 'steps.jsonl'), JSON.stringify({
				step: this.step, state, url: p.url(), width: w, scheme, clicks_so_far: this.clicks, fields_so_far: this.fields,
				main_text: data.main, dialog_text: data.dialogs, buttons_and_links_visible: data.els,
				primary_action_label: primary_label, primary_action_bottom_px: bottom, primary_in_first_screen: bottom === null ? null : bottom <= H(w), words_above_primary: words,
				alerts: data.alerts, money_words_lines: grep, console_errors: errs, first_png: `${nn}-${slug}-${w}-${scheme}.png`,
			}) + '\n');
		}
		await p.setViewportSize({ width: 1440, height: 900 });
		await p.emulateMedia({ colorScheme: 'light' });
		await p.waitForTimeout(250);
		this.save();
	}
	save(extra: Record<string, unknown> = {}) {
		writeFileSync(join(this.dir, 'measures.json'), JSON.stringify({
			flow: this.flow, screens: this.screens.length, screen_list: this.screens, clicks: this.clicks, fields_typed: this.fields, stripe_round_trips: this.trips,
			total_seconds: Math.round((Date.now() - this.t0) / 100) / 10, pre_click_sentences: this.pre, notes: this.notes, problems: this.problems, ...extra,
		}, null, 2));
	}
}

/** What the person does at their DNS host: the fake's zone for the registrable domain holds the TXT record the page asked for (the Worker reads it through DoH). */
export async function publishTxt(inst: { fake: { url: string } }, zone: string, name: string, value: string) {
	await fetch(`${inst.fake.url}/__zones`, { method: 'POST', body: JSON.stringify({ name: zone }) });
	const st = (await (await fetch(`${inst.fake.url}/__state`)).json()) as { zones: Array<{ id: string; name: string }> };
	const z = st.zones.find((x) => x.name === zone)!;
	for (const base of ['', '/client/v4']) {
		const r = await fetch(`${inst.fake.url}${base}/zones/${z.id}/dns_records`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer x' }, body: JSON.stringify({ type: 'TXT', name, content: value, ttl: 1 }) });
		if (r.ok) return;
	}
	throw new Error('could not publish TXT in the fake');
}
