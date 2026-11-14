import { describe, expect, it } from 'vitest';
import { dmarcSteps, hostedInForce, inForceSentence, policyInForce, type DmarcEvidence, type InForce } from '../src/dmarc-next-step';

const ev = (o: Partial<DmarcEvidence> = {}): DmarcEvidence => ({ reportsAddress: true, ruaAddress: 'r@reports.test', reports: { total: 1000, passed: 990, days: 30 }, ...o });
const stored = (o: Record<string, unknown>) => ({ dmarc_policy: 'reject', dmarc_issue: null, dmarc_inherited_from: null, dmarc_pct: 100, dmarc_p: 'reject', dmarc_sp: null, dmarc_rua: 1, ...o });
const first = (name: string, s: Record<string, unknown>, e = ev()) => dmarcSteps(name, policyInForce(name, stored(s) as never), e)[0];

describe('policyInForce: one reading of the stored facts', () => {
	it('own record, inherited via p=, inherited via sp=', () => {
		expect(policyInForce('a.com', stored({}) as never)).toMatchObject({ kind: 'own', at: 'a.com', tag: 'p', policy: 'reject', pct: 100, reportsHere: true });
		expect(policyInForce('www.a.com', stored({ dmarc_inherited_from: 'a.com', dmarc_policy: 'quarantine', dmarc_p: 'quarantine' }) as never)).toMatchObject({ kind: 'inherited', at: 'a.com', tag: 'p' });
		expect(policyInForce('www.a.com', stored({ dmarc_inherited_from: 'a.com', dmarc_policy: 'quarantine', dmarc_sp: 'quarantine' }) as never)).toMatchObject({ kind: 'inherited', tag: 'sp', p: 'reject', sp: 'quarantine' });
	});

	it('unknown is never "no record": not read, or the tags not read since they are stored', () => {
		expect(policyInForce('a.com', stored({ dmarc_policy: null, dmarc_p: null }) as never, false)).toEqual({ kind: 'unread' });
		expect(policyInForce('a.com', stored({ dmarc_policy: null, dmarc_p: null }) as never, true)).toEqual({ kind: 'none' });
		expect(policyInForce('a.com', stored({ dmarc_p: null }) as never)).toMatchObject({ kind: 'partial-read', policy: 'reject' });
		expect(policyInForce('a.com', stored({ dmarc_pct: null }) as never)).toMatchObject({ kind: 'partial-read' });
	});

	it('hosted: our own record at full pct, reports here once connected', () => {
		expect(hostedInForce('a.com', 'none', false)).toMatchObject({ kind: 'own', policy: 'none', pct: 100, reportsHere: false });
	});
});

describe('dmarcSteps: the same ladder for own and inherited names', () => {
	it('names the exact tag at the exact record, and what else it affects', () => {
		// Parent with sp=: the parent's p= does not reach the subdomain.
		const sp = first('www.a.com', { dmarc_inherited_from: 'a.com', dmarc_policy: 'quarantine', dmarc_sp: 'quarantine' })!;
		expect(sp).toMatchObject({ key: 'tighten', status: 'approval', do: 'Set sp=reject at _dmarc.a.com', where: 'parent', at: 'a.com', record: 'v=DMARC1; p=reject; rua=mailto:r@reports.test', recordAt: '_dmarc.www.a.com' });
		expect(sp.why).toMatch(/changing a\.com's p= would not change it/);
		// Parent without sp=: adding sp= changes only subdomains; changing p= would also change the parent.
		const p = first('www.a.com', { dmarc_inherited_from: 'a.com', dmarc_policy: 'quarantine', dmarc_p: 'quarantine' })!;
		expect(p.do).toBe('Add sp=reject at _dmarc.a.com');
		expect(p.why).toMatch(/would also apply to a\.com itself/);
		expect(p.why).toMatch(/Or publish a DMARC record at _dmarc\.www\.a\.com with p=reject: it affects only www\.a\.com\./);
	});

	it('mentions pct whenever it is below 100', () => {
		const ucsc = first('www.ucsc.edu', { dmarc_inherited_from: 'ucsc.edu', dmarc_policy: 'none', dmarc_p: 'quarantine', dmarc_sp: 'none', dmarc_pct: 0 })!;
		expect(ucsc.do).toBe('Set sp=quarantine at _dmarc.ucsc.edu and raise pct from 0 to 100');
		const f = policyInForce('www.ucsc.edu', stored({ dmarc_inherited_from: 'ucsc.edu', dmarc_policy: 'none', dmarc_p: 'quarantine', dmarc_sp: 'none', dmarc_pct: 0 }) as never) as InForce;
		expect(inForceSentence(f)).toMatch(/sets sp=none at pct=0 for its subdomains/);
		expect(first('a.com', { dmarc_pct: 25 })!.do).toBe('Raise pct from 25 to 100');
	});

	it('every rung waits on the same report evidence', () => {
		const none = { dmarc_policy: 'none', dmarc_p: 'none' };
		expect(first('a.com', none, ev({ reportsAddress: false }))!.key).toBe('connect-reports');
		expect(first('a.com', { ...none, dmarc_rua: 0 })!.key).toBe('dmarc-rua');
		expect(first('a.com', none, ev({ reports: null }))!.key).toBe('reports-failed');
		expect(first('a.com', none, ev({ reports: { total: 0, passed: 0, days: 30 } }))!.key).toBe('gathering');
		expect(first('a.com', none, ev({ reports: { total: 1000, passed: 946, days: 30 } }))!.key).toBe('senders'); // 94.6 is not 95
		expect(first('a.com', none)!.key).toBe('tighten');
		expect(dmarcSteps('a.com', policyInForce('a.com', stored(none) as never), ev({ reports: undefined }))).toEqual([]);
	});

	it('no pass share is used without a reports address, however good old totals look', () => {
		expect(first('a.com', { dmarc_policy: 'none', dmarc_p: 'none' }, ev({ reportsAddress: false }))).toMatchObject({ key: 'connect-reports', status: 'improve' });
	});

	it('only p=reject at pct=100 is Nothing to do; missing reports there are a note', () => {
		expect(first('a.com', {})).toMatchObject({ key: 'done', status: 'verified', do: 'Nothing to do' });
		expect(first('a.com', { dmarc_policy: 'quarantine', dmarc_p: 'quarantine' }, ev({ reports: { total: 0, passed: 0, days: 30 } }))!.status).toBe('gathering');
		const steps = dmarcSteps('a.com', policyInForce('a.com', stored({ dmarc_rua: 0 }) as never), ev());
		expect(steps.map((s) => `${s.status}:${s.key}`)).toEqual(['verified:done', 'note:dmarc-rua']);
	});

	it('a name no record covers is offered p=none; a listed public-suffix parent is explained', () => {
		const s = dmarcSteps('www.gov.uk', { kind: 'none' }, ev({ suffixParent: 'gov.uk' }))[0]!;
		expect(s).toMatchObject({ key: 'dmarc-missing', do: 'Publish a DMARC record at p=none', record: 'v=DMARC1; p=none; rua=mailto:r@reports.test' });
		expect(s.why).toMatch(/gov\.uk is a public suffix, so its DMARC record does not apply to www\.gov\.uk/);
	});
});
