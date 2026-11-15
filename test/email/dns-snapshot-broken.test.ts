// A DMARC record receivers do not apply as written (RFC 7489 section 6.6.3) is stored as the problem it is, with what
// receivers apply instead, so every page and the agent tools can say it exactly (packages/dns-checks/src/dmarc-problem.ts).
import { describe, expect, it } from 'vitest';
import { lookupDmarc, type Resolver } from '@ready-set-mail/dns-checks';
import { dmarcRecordProblem as receiverProblem } from '@ready-set-mail/dns-checks/dmarc-problem';
import { dmarcSteps, policyInForce } from '@ready-set-mail/dns-checks/dmarc-next-step';
import { dmarcFactsFromLookup } from '../../src/email/dns-snapshot';
import { dmarcRecordProblem as publishProblem } from '../../src/dmarc/dns-record';

const resolverFor = (records: Record<string, string[]>): Resolver =>
  ({ txt: async (name: string) => ({ status: 'ok', records: records[name.toLowerCase()] ?? [] }) }) as unknown as Resolver;
const factsFor = async (record: string) => dmarcFactsFromLookup(await lookupDmarc(resolverFor({ '_dmarc.example.com': [record] }), 'example.com'));
const RUA = 'mailto:r@reports.test';

describe('stored facts for a record that is not applied as written', () => {
  it('an invalid sp= with a valid rua=: issue invalid_sp, no policy, receivers apply p=none, the value kept', async () => {
    expect(await factsFor(`v=DMARC1; p=reject; sp=bogus; rua=${RUA}`)).toMatchObject({ policy: null, issue: 'invalid_sp', p: 'none', sp: 'bogus', pct: 100 });
  });
  it('an invalid sp= without rua=: receivers apply no DMARC', async () => {
    expect(await factsFor('v=DMARC1; p=reject; sp=bogus')).toMatchObject({ policy: null, issue: 'invalid_sp', p: null, sp: 'bogus' });
  });
  it('an invalid sp= is stored as written, and named as written', async () => {
    const f = (await factsFor(`v=DMARC1; p=reject; sp=Rejectt; rua=${RUA}`))!;
    expect(f).toMatchObject({ issue: 'invalid_sp', sp: 'Rejectt' });
    const s = { dmarc_policy: f.policy, dmarc_issue: f.issue, dmarc_inherited_from: f.inherited_from, dmarc_pct: f.pct, dmarc_p: f.p, dmarc_sp: f.sp, dmarc_rua: 1 };
    const [step] = dmarcSteps('example.com', policyInForce('example.com', s), { reportsAddress: true, ruaAddress: null, reports: { total: 0, passed: 0, days: 30 } });
    expect(step!.why).toContain('sp=Rejectt is not a valid policy');
    expect(step!.why).toBe(receiverProblem(`v=DMARC1; p=reject; sp=Rejectt; rua=${RUA}`, '_dmarc.example.com'));
  });
  it('an invalid p= with a valid rua=: issue invalid, receivers apply p=none', async () => {
    expect(await factsFor(`v=DMARC1; p=rejected; rua=${RUA}`)).toMatchObject({ policy: null, issue: 'invalid', p: 'none', sp: null });
  });
  it('an invalid p= without rua=: no DMARC', async () => {
    expect(await factsFor('v=DMARC1; p=rejected')).toMatchObject({ policy: null, issue: 'invalid', p: null });
  });
  it('an inherited parent record with an invalid sp=', async () => {
    const f = dmarcFactsFromLookup(await lookupDmarc(resolverFor({ '_dmarc.example.com': [`v=DMARC1; p=reject; sp=bogus; rua=${RUA}`] }), 'mail.example.com'));
    expect(f).toMatchObject({ policy: null, issue: 'invalid_sp', inherited_from: 'example.com', p: 'none', sp: 'bogus' });
  });
  it('a valid record is unchanged', async () => {
    expect(await factsFor(`v=DMARC1; p=reject; sp=quarantine; rua=${RUA}`)).toMatchObject({ policy: 'reject', issue: null, p: 'reject', sp: 'quarantine' });
  });
  it('the agent tools read the stored row as the dashboard does: "Fix sp=" first, with the one sentence', async () => {
    const f = (await factsFor(`v=DMARC1; p=reject; sp=bogus; rua=${RUA}`))!;
    const s = { dmarc_policy: f.policy, dmarc_issue: f.issue, dmarc_inherited_from: f.inherited_from, dmarc_pct: f.pct, dmarc_p: f.p, dmarc_sp: f.sp, dmarc_rua: 1 };
    const [step] = dmarcSteps('example.com', policyInForce('example.com', s), { reportsAddress: true, ruaAddress: null, reports: { total: 0, passed: 0, days: 30 } });
    expect(step).toMatchObject({ key: 'dmarc-invalid-sp', do: 'Fix sp= at _dmarc.example.com', why: 'At _dmarc.example.com, sp=bogus is not a valid policy, so receivers treat the whole record as p=none. Fix sp= or remove it.' });
  });
});

describe('the server refuses to publish every record the dashboard calls broken', () => {
  const records = [
    'v=DMARC1; p=reject; sp=bogus', `v=DMARC1; p=reject; sp=bogus; rua=${RUA}`, 'v=DMARC1; p=rejected', `v=DMARC1; p=rejected; rua=${RUA}`,
    'v=DMARC1; rua=' + RUA, 'v=DMARC1; p=', 'v=DMARC1; p=none; sp=', 'v=DMARC1; p=quarantine; sp=Reject2', 'google-site-verification=abc',
    'v=DMARC1; p=reject', `v=DMARC1; p=Quarantine; sp=reject; rua=${RUA}`, 'v=DMARC1; p= none ; pct=50',
  ];
  for (const r of records) {
    it(r, () => {
      const shown = receiverProblem(r, '_dmarc.example.com');
      if (shown) expect(publishProblem(r)).not.toBeNull();
    });
  }
});
