import { describe, expect, it } from 'vitest';
import { planDmarc, equivalentRecord } from '../../src/onboarding/dmarc-plan';

const RUA = 'rua@reports.me.org';
const none = { kind: 'none' } as const;

describe('planDmarc', () => {
  it('own record with our rua is left alone', () => {
    const d = planDmarc({ ownRecords: [`"v=DMARC1; p=reject; rua=mailto:${RUA.toUpperCase()}"`], inherited: none, rua: RUA });
    expect(d.action).toBe('none');
  });
  it('own record without our rua gets only the rua added', () => {
    const d = planDmarc({ ownRecords: ['v=DMARC1; p=quarantine; sp=reject; pct=25; fo=1'], inherited: none, rua: RUA });
    expect(d).toMatchObject({ action: 'update', record: `v=DMARC1; p=quarantine; sp=reject; pct=25; fo=1; rua=mailto:${RUA}` });
  });
  it('keeps other rua addresses', () => {
    const d = planDmarc({ ownRecords: ['v=DMARC1; p=none; rua=mailto:a@x.org'], inherited: none, rua: RUA });
    expect(d).toMatchObject({ action: 'update', record: `v=DMARC1; p=none; rua=mailto:a@x.org,mailto:${RUA}` });
  });
  it('missing record with nothing inherited is p=none plus rua', () => {
    expect(planDmarc({ ownRecords: [], inherited: none, rua: RUA })).toMatchObject({ action: 'create', record: `v=DMARC1; p=none; rua=mailto:${RUA}` });
  });
  it('missing record carries the inherited enforcement, pct and alignment', () => {
    const inherited = { kind: 'inherited', parent: 'me.org', record: 'v=DMARC1; p=reject; pct=20; adkim=s; aspf=r' } as const;
    expect(equivalentRecord(inherited, RUA)).toBe(`v=DMARC1; p=reject; pct=20; adkim=s; aspf=r; rua=mailto:${RUA}`);
  });
  it('uses the parent sp= for a subdomain, even when weaker', () => {
    const inherited = { kind: 'inherited', parent: 'me.org', record: 'v=DMARC1; p=reject; sp=none' } as const;
    expect(equivalentRecord(inherited, null)).toBe('v=DMARC1; p=none');
  });
  it('hosted (no rua): existing is none, missing has no rua', () => {
    expect(planDmarc({ ownRecords: ['v=DMARC1; p=none'], inherited: none, rua: null }).action).toBe('none');
    expect(planDmarc({ ownRecords: [], inherited: none, rua: null })).toMatchObject({ action: 'create', record: 'v=DMARC1; p=none' });
  });
  it('several records, invalid p=, unknown lookup: no write', () => {
    expect(planDmarc({ ownRecords: ['v=DMARC1; p=none', 'v=DMARC1; p=reject'], inherited: none, rua: RUA }).action).toBe('skip');
    expect(planDmarc({ ownRecords: ['v=DMARC1; p=bogus'], inherited: none, rua: RUA }).action).toBe('skip');
    expect(planDmarc({ ownRecords: [], inherited: { kind: 'unknown', reason: 'timeout' }, rua: RUA }).action).toBe('skip');
  });
  it('ignores TXT records that are not DMARC', () => {
    expect(planDmarc({ ownRecords: ['hello'], inherited: none, rua: null }).action).toBe('create');
  });
});
