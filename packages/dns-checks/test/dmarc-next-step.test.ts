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

	it('the sentence follows the record offered: "it starts the reports" only with a reports address in it', () => {
		const withAddr = dmarcSteps('a.com', { kind: 'none' }, ev())[0]!;
		expect(withAddr.record).toContain('rua=mailto:');
		expect(withAddr.why).toContain('p=none changes no delivery; it starts the reports.');
		const without = dmarcSteps('a.com', { kind: 'none' }, ev({ reportsAddress: false, ruaAddress: '' }))[0]!;
		expect(without.record).toBe('v=DMARC1; p=none');
		expect(without.why).toContain('p=none changes no delivery. Reports start once the record names a reports address: connect reports first, or add your own rua=.');
		expect(without.why).not.toContain('it starts the reports');
	});
});

describe('dmarcSteps: failures that are only others\' mail', () => {
  const rep = { total: 25, passed: 17, days: 30 };
  const steps = (policy: string, e: Partial<DmarcEvidence>) => dmarcSteps('example.test', policyInForce('example.test', stored({ dmarc_policy: policy, dmarc_p: policy }) as never), ev({ reports: rep, ...e }));
  it('p=reject, every failure not yours: done first, no "Fix the senders"', () => {
    const s = steps('reject', { failedNotYours: 8 });
    expect(s[0]!.key).toBe('done');
    expect(s.find((x) => x.key === 'not-yours')?.do).toBe('Nothing to fix');
    expect(s.some((x) => x.do.includes('Fix the senders'))).toBe(false);
  });
  it('p=reject, only some failures not yours: unchanged', () => {
    const s = steps('reject', { failedNotYours: 2 });
    expect(s[0]!.do).toBe('Fix the senders that fail DMARC');
  });
  it('p=none gate keeps waiting but asks whether the senders are yours', () => {
    const s = steps('none', { failedNotYours: 8 });
    expect(s[0]).toMatchObject({ key: 'senders', status: 'improve', who: 'you', do: 'Check whether the failing senders are yours' });
    expect(s[0]!.why).toContain('nothing to fix');
    expect(s[0]!.why).toContain('95%');
  });
  it('p=reject, 8 recorded not-yours failures and 5 with no recorded verdict: no "Fix the senders", and the sentences say which is which', () => {
    const s = steps('reject', { reports: { total: 42, passed: 29, days: 30 }, failedNotYours: 8, failedUnrecorded: 5 });
    expect(s[0]!.key).toBe('done');
    const note = s.find((x) => x.key === 'not-yours')!;
    expect(note.do).toBe('Nothing to fix in the mail with a recorded verdict');
    expect(note.why).toContain('Of the 13 messages that failed, 8 came from servers that are not a known sending service');
    expect(note.why).toContain("likely mail pretending to be example.test, which p=reject asks receivers to reject. The other 5 are in reports stored before Ready Set Mail kept each receiver's verdict, so who sent them is not recorded.");
    expect(s.some((x) => x.do.includes('Fix the senders'))).toBe(false);
  });
  it('nothing recorded as not-yours, only unrecorded failures: unchanged', () => {
    const s = steps('reject', { reports: { total: 42, passed: 29, days: 30 }, failedNotYours: 0, failedUnrecorded: 13 });
    expect(s[0]!.do).toBe('Fix the senders that fail DMARC');
  });
  it('a recorded failure that is yours keeps the senders step even with unrecorded ones', () => {
    const s = steps('reject', { reports: { total: 42, passed: 29, days: 30 }, failedNotYours: 5, failedUnrecorded: 5 });
    expect(s[0]!.do).toBe('Fix the senders that fail DMARC');
  });
  it('the gate with unrecorded failures says so too', () => {
    const s = steps('none', { reports: { total: 42, passed: 29, days: 30 }, failedNotYours: 8, failedUnrecorded: 5 });
    expect(s[0]!.why).toContain("The other 5 are in reports stored before Ready Set Mail kept each receiver's verdict, so who sent them is not recorded.");
    expect(s[0]!.why).toContain('If none of the failing senders is a service you use, there is nothing to fix for them;');
  });
});

describe('dmarcSteps: a service that sends as the name without being set up for it (classifySource service_not_set_up)', () => {
  const rep = { total: 100, passed: 92, days: 30 };
  const steps = (policy: string, e: Partial<DmarcEvidence>) => dmarcSteps('example.test', policyInForce('example.test', stored({ dmarc_policy: policy, dmarc_p: policy }) as never), ev({ reports: rep, ...e }));
  const SERVICE = 'a service sending as rua.example.test that is not set up for it: if it is yours, set up its custom return-path and DKIM for rua.example.test; if not, nothing to do';
  it('case 2, one unaligned real service: one thing to look at, not "Nothing to fix", and no "done" step', () => {
    const s = steps('reject', { failedService: 8, failedServiceNames: ['rua.example.test'] });
    expect(s[0]).toMatchObject({ key: 'service-not-set-up', status: 'improve', who: 'you', do: 'Check the service sending as rua.example.test that is not set up for it' });
    expect(s[0]!.why).toContain(`Every message that failed came from ${SERVICE}`);
    expect(s[0]!.why).toContain('Until it is set up, p=reject asks receivers to reject its mail.');
    expect(s.map((x) => x.key)).not.toContain('done');
    expect(s.map((x) => x.do).join(' ')).not.toMatch(/Nothing to (fix|do)/);
    expect(s.map((x) => x.why).join(' ')).not.toContain('likely mail pretending');
  });
  it('case 3, a mix of a spoofer and the service: the spoofer is named as needing no fix, the service as the one thing to look at', () => {
    const s = steps('reject', { failedNotYours: 6, failedService: 2, failedServiceNames: ['rua.example.test'] });
    expect(s[0]).toMatchObject({ key: 'service-not-set-up', do: 'Check the service sending as rua.example.test that is not set up for it' });
    expect(s[0]!.why).toContain(`Of the 8 messages that failed, 6 came from servers that are not a known sending service and passed SPF or DKIM for no name of example.test: likely mail pretending to be example.test, which needs no fix, and 2 from ${SERVICE}`);
    expect(s.map((x) => x.key)).not.toContain('done');
  });
  it('case 1, only spoofers, is unchanged: done first and nothing to fix', () => {
    const s = steps('reject', { failedNotYours: 8 });
    expect(s[0]!.key).toBe('done');
    expect(s.find((x) => x.key === 'not-yours')?.do).toBe('Nothing to fix');
  });
  it('p=none gate: waits, names the service as the thing to look at, and says what the pass rate still needs', () => {
    const s = steps('none', { failedService: 8, failedServiceNames: ['rua.example.test'] });
    expect(s[0]).toMatchObject({ key: 'service-not-set-up', status: 'improve', do: 'Check the service sending as rua.example.test that is not set up for it' });
    expect(s[0]!.why).toContain('still waits until 95% of reported messages pass');
  });
  it('a failure that is yours beside the service keeps "Fix the senders"', () => {
    const s = steps('reject', { failedService: 2, failedServiceNames: ['rua.example.test'] });
    expect(s[0]!.do).toBe('Fix the senders that fail DMARC');
  });
  it('falls back to the name itself when the names are not known', () => {
    const s = steps('reject', { failedService: 8 });
    expect(s[0]!.do).toBe('Check the service sending as example.test that is not set up for it');
  });
});
