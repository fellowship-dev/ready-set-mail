// Subdomain slice, B2 / B3 / B4 (audit 2026-11-15): the policy in force for a NAME, not the parent's p=.
// RFC 9989 section 4.10.1 (own record, else the organizational domain's sp= for an existing name, np= for one that does not exist,
// p= when the applicable tag is absent), section 4.7 (np= absent: sp=, then p=), section 3.2.13 (NXDOMAIN: the name does not exist).
import { describe, expect, it } from 'vitest';
import { checkDomain } from '../src/report';
import { lookupDmarc } from '../src/dmarc';
import { createResolver } from '../src/doh';
import { dmarcSteps, policyInForce } from '../src/dmarc-next-step';
import { dohFetch, fakeResolver, type Zone } from './helpers';

const PARENT = (record: string): Zone => ({
  'TXT _dmarc.example.com': [record],
  'TXT example.com': ['v=spf1 -all'],
  'A example.com': ['192.0.2.1'],
  'A mail.example.com': ['192.0.2.2'],
  'TXT mail.example.com': ['v=spf1 include:_spf.example.net -all'],
  'TXT _spf.example.net': ['v=spf1 ip4:192.0.2.0/24 -all'],
});
const RUA = 'rua=mailto:r@example.com';
const run = (zone: Zone, name: string) => checkDomain(name, { resolver: fakeResolver(zone), dkimProbeHex: () => '0123456789abcdef' });

describe('B2: the effective policy of a name that follows the organizational domain', () => {
  it('sp= applies to an existing subdomain, not the parent\'s p= (sp=none under p=reject)', async () => {
    const l = await lookupDmarc(fakeResolver(PARENT(`v=DMARC1; p=reject; sp=none; ${RUA}`)), 'mail.example.com');
    expect(l.effective).toMatchObject({ status: 'applies', policy: 'none', tag: 'sp', at: 'example.com', source: 'organizational' });
  });
  it('the agent report no longer calls it enforced: p=reject; sp=none grades the subdomain as monitoring (level 1), with the tag that applies', async () => {
    const r = await run(PARENT(`v=DMARC1; p=reject; sp=none; ${RUA}`), 'mail.example.com');
    expect(r.grade.level).toBe(1);
    expect(r.grade.reasons.join(' ')).toContain('sp=none');
    expect(r.grade.reasons.join(' ')).not.toMatch(/DMARC reject/);
  });
  it('sp=quarantine grades the subdomain enforced, never hardened by the parent\'s reject', async () => {
    const r = await run(PARENT(`v=DMARC1; p=reject; sp=quarantine; ${RUA}`), 'mail.example.com');
    expect(r.grade.level).toBe(2);
    expect(r.grade.nextSteps.join(' ')).toContain('Move DMARC to p=reject');
  });
  it('the organizational domain itself is graded on its own p=, whatever sp= says', async () => {
    const l = await lookupDmarc(fakeResolver(PARENT(`v=DMARC1; p=reject; sp=none; ${RUA}`)), 'example.com');
    expect(l.effective).toMatchObject({ policy: 'reject', tag: 'p', source: 'own', at: 'example.com' });
  });
  it('a subdomain with its own record uses its p=; the parent\'s sp= is irrelevant, and sp= on the subdomain\'s own record is ignored (section 4.7)', async () => {
    const zone = { ...PARENT(`v=DMARC1; p=none; sp=none; ${RUA}`), 'TXT _dmarc.mail.example.com': [`v=DMARC1; p=reject; sp=none; ${RUA}`] };
    const l = await lookupDmarc(fakeResolver(zone), 'mail.example.com');
    expect(l.effective).toMatchObject({ policy: 'reject', tag: 'p', source: 'own', at: 'mail.example.com' });
  });
  it('an invalid sp= with a valid rua= is applied as p=none (section 4.10.1), the existing invalid_sp rule', async () => {
    const l = await lookupDmarc(fakeResolver(PARENT(`v=DMARC1; p=reject; sp=rejectt; ${RUA}`)), 'mail.example.com');
    expect(l.effective).toMatchObject({ status: 'broken', policy: 'none' });
  });
  it('no sp=: p= applies to the subdomain and the sentence says so', async () => {
    const l = await lookupDmarc(fakeResolver(PARENT(`v=DMARC1; p=reject; ${RUA}`)), 'mail.example.com');
    expect(l.effective).toMatchObject({ policy: 'reject', tag: 'p', source: 'organizational' });
  });
});

describe('B3: np= for a name that does not exist (NXDOMAIN)', () => {
  const ghost = 'ghost.example.com'; // not in the zone: A answers NXDOMAIN
  it('np=none under p=reject: the non-existent name is under none (the audit M5)', async () => {
    const l = await lookupDmarc(fakeResolver(PARENT(`v=DMARC1; p=reject; np=none; ${RUA}`)), ghost);
    expect(l.effective).toMatchObject({ policy: 'none', tag: 'np', exists: false, at: 'example.com' });
  });
  it('np=reject under p=none: the non-existent name is under reject (the audit M5b)', async () => {
    const l = await lookupDmarc(fakeResolver(PARENT(`v=DMARC1; p=none; np=reject; ${RUA}`)), ghost);
    expect(l.effective).toMatchObject({ policy: 'reject', tag: 'np', exists: false });
  });
  it('np= never applies to a name that exists', async () => {
    const l = await lookupDmarc(fakeResolver(PARENT(`v=DMARC1; p=reject; np=none; ${RUA}`)), 'mail.example.com');
    expect(l.effective).toMatchObject({ policy: 'reject', tag: 'p', exists: true });
  });
  it('np= absent: sp= applies to a non-existent name, then p= (section 4.7)', async () => {
    expect((await lookupDmarc(fakeResolver(PARENT(`v=DMARC1; p=reject; sp=quarantine; ${RUA}`)), ghost)).effective).toMatchObject({ policy: 'quarantine', tag: 'sp' });
    expect((await lookupDmarc(fakeResolver(PARENT(`v=DMARC1; p=reject; ${RUA}`)), ghost)).effective).toMatchObject({ policy: 'reject', tag: 'p' });
  });
  it('DNS is asked whether the name exists only when np= can change the answer', async () => {
    const calls: string[] = [];
    const r = createResolver({ fetch: dohFetch(PARENT(`v=DMARC1; p=reject; sp=none; ${RUA}`), calls) });
    await lookupDmarc(r, ghost);
    expect(calls.some((c) => c.startsWith('A '))).toBe(false);
  });
  it('no record is offered at a name that does not exist: the step says what applies to it instead', () => {
    const none = dmarcSteps('ghost.example.com', policyInForce('ghost.example.com', { dmarc_policy: null }, true), { reportsAddress: false, reports: null, nameExists: false });
    expect(none).toHaveLength(1);
    expect(none[0]).toMatchObject({ key: 'name-missing', status: 'note', who: 'nobody' });
    expect(none[0]!.record).toBeUndefined();
    expect(none[0]!.why).toContain('does not exist in DNS');
    const inherited = dmarcSteps('ghost.example.com', policyInForce('ghost.example.com', { dmarc_policy: 'none', dmarc_inherited_from: 'example.com', dmarc_p: 'none', dmarc_pct: 100, dmarc_rua: 1 }, true), { reportsAddress: true, ruaAddress: 'r@example.com', reports: { total: 100, passed: 100, days: 30 }, nameExists: false });
    expect(inherited[0]!.record).toBeUndefined();
    expect(inherited[0]!.why).toContain('np=');
  });
});

describe('B4: an SPF record is judged at the return-path domain, not at the From name (the agent report)', () => {
  const zone: Zone = { 'TXT _dmarc.app.example.com': [`v=DMARC1; p=reject; ${RUA}`], 'A app.example.com': ['192.0.2.9'] };
  it('no SPF record at a name is stated precisely, not as "No SPF record" alone', async () => {
    const r = await run(zone, 'app.example.com');
    const spf = r.grade.reasons.find((x) => x.startsWith('No SPF'))!;
    expect(spf).not.toBe('No SPF record');
    expect(spf).toContain('return-path');
    expect(spf).toContain('app.example.com');
  });
  it('the next step does not tell everyone to publish an SPF record at the From name', async () => {
    const r = await run(zone, 'app.example.com');
    expect(r.grade.nextSteps.join(' ')).not.toContain('Publish an SPF record listing your senders');
    expect(r.grade.nextSteps.join(' ')).toContain('return-path');
  });
});

describe('C: an invalid np= breaks the record like an invalid sp= (RFC 9989 section 4.10.1)', () => {
  it('with a valid rua= receivers act as p=none, for the name that exists too', async () => {
    const l = await lookupDmarc(fakeResolver(PARENT(`v=DMARC1; p=reject; np=bogus; ${RUA}`)), 'mail.example.com');
    expect(l.effective).toMatchObject({ status: 'broken', policy: 'none', tag: 'np', invalidTag: 'np', at: 'example.com' });
  });
  it('without a valid rua= the record is ignored: no policy applies', async () => {
    const l = await lookupDmarc(fakeResolver(PARENT('v=DMARC1; p=reject; np=bogus')), 'mail.example.com');
    expect(l.effective).toMatchObject({ status: 'broken', policy: null, tag: null, invalidTag: 'np' });
  });
  it('the agent report grades it monitoring (level 1) and says why, never "DMARC reject"', async () => {
    const r = await run(PARENT(`v=DMARC1; p=reject; np=bogus; ${RUA}`), 'mail.example.com');
    expect(r.grade.level).toBe(1);
    expect(r.grade.reasons.join(' ')).toContain('invalid np= value, so receivers act as if it said p=none');
    expect(r.grade.nextSteps.join(' ')).toContain('Fix np=');
  });
  it('the agent report counts it as no usable DMARC without a valid rua=', async () => {
    const r = await run(PARENT('v=DMARC1; p=reject; np=bogus'), 'mail.example.com');
    expect(r.grade.level).toBe(0);
    expect(r.grade.reasons.join(' ')).toContain('ignore it, because it has no valid rua=');
  });
  it('a valid np= is unaffected', async () => {
    const l = await lookupDmarc(fakeResolver(PARENT(`v=DMARC1; p=reject; np=quarantine; ${RUA}`)), 'mail.example.com');
    expect(l.effective).toMatchObject({ status: 'applies', policy: 'reject', tag: 'p', invalidTag: null });
  });
});
