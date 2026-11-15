import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { dmarcSteps, policyInForce } from '@ready-set-mail/dns-checks/dmarc-next-step';
import { domainActions } from '../src/lib/actions';
import { buildRecommendedRecord, parseDmarcPolicy } from '../src/lib/dmarc-record';
import { inheritedCoverage, offeredDmarcRecord, recordAlignment, type DmarcCoverage } from '../src/lib/dmarc-coverage';
import { evidenceFor } from '../src/lib/dmarc-step';

/**
 * Property: for any live record, a record the dashboard offers is never weaker than the policy in force: p=, pct= (while
 * enforcing), the policy subdomains get (sp=, else p=) and strict alignment, in any letter case or spacing.
 */
type P = 'none' | 'quarantine' | 'reject';
const RANK: Record<P, number> = { none: 0, quarantine: 1, reject: 2 };
const OURS = 'r@reports.test';

/** An independent reading of a record, as a receiver would: tag names and policy values case-insensitive, spaces ignored. */
function reference(record: string): { p: P | null; sp: P | null; pct: number; adkim: string | null; aspf: string | null } {
	const tags: Record<string, string> = {};
	for (const part of record.split(';')) {
		const i = part.indexOf('=');
		if (i < 0) continue;
		const k = part.slice(0, i).trim().toLowerCase();
		if (k && !(k in tags)) tags[k] = part.slice(i + 1).trim().toLowerCase();
	}
	const pol = (v: string | undefined): P | null => (v === 'none' || v === 'quarantine' || v === 'reject' ? v : null);
	const pct = /^\d{1,3}$/.test(tags.pct ?? '') ? Math.min(100, Number(tags.pct)) : 100;
	return { p: pol(tags.p), sp: pol(tags.sp), pct, adkim: tags.adkim ?? null, aspf: tags.aspf ?? null };
}

/** `offered` is at least as strict as `inForce` for mail from the name itself (and for its subdomains). */
function assertNotWeaker(inForce: { p: P; pct: number; sub: P; adkim: string | null; aspf: string | null }, offered: string, label: string) {
	const o = reference(offered);
	expect(o.p, `${label}: offered has a valid p= (${offered})`).not.toBeNull();
	const op = o.p!;
	expect(RANK[op], `${label}: p=${op} is weaker than p=${inForce.p} (${offered})`).toBeGreaterThanOrEqual(RANK[inForce.p]);
	if (op === inForce.p && op !== 'none') expect(o.pct, `${label}: pct (${offered})`).toBeGreaterThanOrEqual(inForce.pct);
	const osub = o.sp ?? op;
	expect(RANK[osub], `${label}: subdomain policy ${osub} is weaker than ${inForce.sub} (${offered})`).toBeGreaterThanOrEqual(RANK[inForce.sub]);
	if (inForce.adkim === 's') expect(o.adkim, `${label}: adkim (${offered})`).toBe('s');
	if (inForce.aspf === 's') expect(o.aspf, `${label}: aspf (${offered})`).toBe('s');
}

const cases = (p: string) => [p, p.toUpperCase(), p.charAt(0).toUpperCase() + p.slice(1)];
const spaced = (k: string, v: string) => [`${k}=${v}`, `${k}= ${v}`, ` ${k} = ${v} `, `${k.toUpperCase()}=${v}`];

/** Live records with every combination that matters: policy letter case and spacing, pct=, sp=, alignment, existing rua=. */
function liveRecords(): string[] {
	const out: string[] = [];
	for (const p of ['none', 'quarantine', 'reject'] as const)
		for (const pv of cases(p))
			for (const ptag of spaced('p', pv))
				for (const pct of [null, '0', '50', '100'])
					for (const sp of [null, 'none', 'Quarantine', 'REJECT'])
						for (const align of [null, 'adkim=s', 'aspf=S; adkim=r'])
							for (const rua of [null, 'rua=mailto:someone@else.test', `rua=mailto:${OURS.toUpperCase()}`]) {
								const tags = ['v=DMARC1', ptag, pct !== null ? `pct=${pct}` : null, sp ? `sp=${sp}` : null, align, rua].filter(Boolean) as string[];
								out.push(tags.join('; '));
								out.push(tags.join(';'));
							}
	return out;
}

const inForceOf = (record: string) => {
	const r = reference(record);
	return { p: r.p!, pct: r.pct, sub: r.sp ?? r.p!, adkim: r.adkim, aspf: r.aspf };
};

describe('offeredDmarcRecord: never weaker than the policy in force', () => {
	const records = liveRecords();

	it(`own record: ${records.length} live records`, () => {
		for (const live of records) {
			for (const rua of [OURS, null]) {
				const offered = offeredDmarcRecord(live, { kind: 'own' }, rua);
				expect(offered).not.toBeNull();
				assertNotWeaker(inForceOf(live), offered!, live);
				if (rua) expect(offered!.toLowerCase()).toContain(`mailto:${OURS}`);
			}
		}
	});

	it('reads p= in any letter case or spacing (p=Reject, p=REJECT, p= reject): never offers p=none for them', () => {
		for (const live of ['v=DMARC1; p=Reject', 'v=DMARC1; p=REJECT; rua=mailto:a@b.test', 'v=DMARC1; p= reject', 'v=DMARC1;P=Quarantine', 'v=DMARC1; p = reject ; pct=50']) {
			const offered = offeredDmarcRecord(live, { kind: 'own' }, OURS)!;
			expect(offered).not.toMatch(/p=none/i);
			expect(parseDmarcPolicy(offered)).toBe(parseDmarcPolicy(live));
		}
	});

	it('inherited: a record of its own carries exactly the parent policy for this name (sp=, else p=), pct= and alignment', () => {
		for (const parent of records) {
			const r = reference(parent);
			const effective = (r.sp ?? r.p)!;
			const coverage = inheritedCoverage('example.com', parent, effective);
			const offered = offeredDmarcRecord(null, coverage, OURS);
			expect(offered).not.toBeNull();
			// The new record is the subdomain's own: its p= now governs the name, and its subdomains inherit it too.
			assertNotWeaker({ p: effective, pct: r.pct, sub: effective, adkim: r.adkim, aspf: r.aspf }, offered!, `inherited from ${parent}`);
		}
	});

	it('offers nothing while the policy that applies is unknown, and p=none only when no policy applies', () => {
		expect(offeredDmarcRecord(null, { kind: 'unknown' }, OURS)).toBeNull();
		expect(offeredDmarcRecord(null, { kind: 'none' }, OURS)).toBe(`v=DMARC1; p=none; rua=mailto:${OURS}`);
	});

	it('the DMARC wizard only tightens: from the live policy (shared parser) to the next one, every tag kept', () => {
		const next: Record<P, P> = { none: 'quarantine', quarantine: 'reject', reject: 'reject' };
		for (const live of records) {
			const from = parseDmarcPolicy(live) as P;
			assertNotWeaker(inForceOf(live), buildRecommendedRecord(live, next[from], OURS), `wizard ${live}`);
		}
	});
});

/** Every place that offers a DMARC record builds it with offeredDmarcRecord; no screen reads p= with a regex of its own. */
describe('one way to offer a DMARC record', () => {
	const SITES = [
		'src/components/domain/DnsRecords.tsx',
		'src/pages/domains/AddDomainPage.tsx',
		'src/pages/wizards/setup/DmarcStep.tsx',
		'src/components/reports/ConnectReports.tsx',
		'src/pages/domains/DomainSettingsPage.tsx',
	];
	const read = (p: string) => readFileSync(join(__dirname, '..', p), 'utf8');

	it.each(SITES)('%s offers records through offeredDmarcRecord only', (site) => {
		const src = read(site);
		expect(src).toContain('offeredDmarcRecord(');
		expect(src).not.toMatch(/\b(buildRecommendedRecord|recordFor)\(/);
	});

	it('the DMARC wizard tightens from the policy the shared parser reads', () => {
		const src = read('src/pages/wizards/DmarcWizardPage.tsx');
		expect(src).toMatch(/parseDmarcPolicy\(record\)/);
	});

	it('no source reads a DMARC p= tag with a hand-rolled regex', () => {
		const files: string[] = [];
		const walk = (dir: string) => {
			for (const f of readdirSync(dir)) {
				const p = join(dir, f);
				if (statSync(p).isDirectory()) walk(p);
				else if (/\.tsx?$/.test(f)) files.push(p);
			}
		};
		walk(join(__dirname, '..', 'src'));
		walk(join(__dirname, '..', '..', 'src'));
		const offenders = files.filter((f) => /match\(\/[^/]*\bp=\(|\\bp=\(\[a-z/i.test(readFileSync(f, 'utf8')));
		expect(offenders).toEqual([]);
	});
});

describe('"Do this next" and the DNS records section offer the same record', () => {
	const parent = 'v=DMARC1; p=quarantine; pct=50; adkim=s; aspf=s; rua=mailto:other@else.test';
	const stored = { dmarc_policy: 'quarantine', dmarc_issue: null, dmarc_inherited_from: 'example.com', dmarc_pct: 50, dmarc_p: 'quarantine', dmarc_sp: null, dmarc_rua: 0 };

	it('the shared rule keeps the governing record\'s adkim=/aspf= in the record of its own', () => {
		const steps = dmarcSteps('mail.example.com', policyInForce('mail.example.com', stored), evidenceFor({ rua_address: OURS }, { total: 100, passed: 99, days: 30 }, null, { alignment: recordAlignment(parent) }));
		const rua = steps.find((s) => s.key === 'dmarc-rua')!;
		const coverage: DmarcCoverage = inheritedCoverage('example.com', parent, 'quarantine');
		expect(rua.record).toBe(offeredDmarcRecord(null, coverage, OURS));
		expect(rua.record).toBe(`v=DMARC1; p=quarantine; pct=50; adkim=s; aspf=s; rua=mailto:${OURS}`);
	});

	it('on the domain page, the action built from the live read offers the DNS records section\'s bytes', () => {
		const summary = {
			domain_id: 2, domain: 'mail.example.com', spf_record: 'v=spf1 -all', dns_checked_at: Math.floor(Date.now() / 1000), dns_check_attempted_at: null, dns_check_status: 'ok', dns_last_good_status: 'ok',
			total_messages: 100, pass_messages: 99, fail_messages: 1, dkim_total: 0, dkim_pass: 0, spf_total: 0, spf_pass: 0, mta_sts_enabled: 0, mta_sts_mode: null, spf_lookup_count: 2, ...stored,
		};
		const onboarding = {
			domain_id: 2, domain: 'mail.example.com', rua_address: OURS, cf_available: false,
			dmarc: { found: false, has_our_rua: false, current_record: null, effective: { policy: 'quarantine', inherited_from: 'example.com', issue: null, record: parent } },
			spf: { record: 'v=spf1 -all', lookup_count: 2, flattening_active: false },
			dkim: { selectors: [{ name: 'google._domainkey.mail.example.com', record: 'v=DKIM1; k=rsa; p=AAA' }], source: 'doh' },
			routing: { mx_found: true, destination_verified: true, reports_domain: null, admin_email: null },
		};
		const actions = domainActions({
			domain: { id: 2, domain: 'mail.example.com', rua_address: OURS },
			dns: { found: false, has_rua: false, current_record: null, cf_managed: false } as never,
			onboarding: onboarding as never,
			summary: summary as never,
			sources: [],
		});
		const rua = actions.find((a) => a.key === 'dmarc-rua')!;
		expect(rua.record).toBe(offeredDmarcRecord(null, inheritedCoverage('example.com', parent, 'quarantine'), OURS));
	});
});
