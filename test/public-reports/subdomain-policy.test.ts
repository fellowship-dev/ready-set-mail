// Subdomain slice, B2 / B3 / B4: the free checker grades a (sub)domain by the policy that applies to THAT name (RFC 9989 section 4.10.1),
// says which tag sets it, and does not call a name with no SPF record a fault by that alone (SPF is judged at the return-path domain).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { checkDmarc, checkSpf } from '../../src/public-reports/check';
import { installFakeDns, resetFakeDns } from './fake-dns';

vi.mock('../../src/public-reports/resolver', async (importOriginal) => (await import('./fake-dns')).fakeResolverModule(importOriginal));
afterEach(resetFakeDns);

const txt = (...t: string[]) => ({ txt: t });
const A = { answers: [{ type: 1, data: '192.0.2.1' }] };
const findings = (r: { findings: { code: string; message: string; severity: string }[] }) => Object.fromEntries(r.findings.map((f) => [f.code, f]));

describe('B2: the checker grades the subdomain by sp=, not the parent\'s p= (the audit: "p=reject; sp=none" called strongest)', () => {
  it('p=reject; sp=none on the parent: the subdomain is monitoring, and it is not called the strongest setting', async () => {
    installFakeDns({ '_dmarc.example.com/TXT': txt('v=DMARC1; p=reject; sp=none; rua=mailto:r@example.com'), 'app.example.com/A': A });
    const r = await checkDmarc('app.example.com');
    expect(r.grade).toBe('monitoring');
    expect(r.effective).toMatchObject({ policy: 'none', tag: 'sp', at: 'example.com', source: 'organizational' });
    const f = findings(r);
    expect(f['dmarc-policy-none']?.message).toContain('sp=none');
    expect(f['dmarc-policy-reject']).toBeUndefined();
    expect(JSON.stringify(r.findings)).not.toContain('strongest');
  });
  it('p=reject with no sp=: the subdomain really is under reject, and says p= applies', async () => {
    installFakeDns({ '_dmarc.example.com/TXT': txt('v=DMARC1; p=reject; rua=mailto:r@example.com'), 'app.example.com/A': A });
    const r = await checkDmarc('app.example.com');
    expect(r.grade).toBe('strict');
    expect(findings(r)['dmarc-inherited']?.message).toContain('p=reject');
  });
  it('a subdomain with its own record: its p= is graded, the parent\'s sp= does not matter, and sp= on its own record is not "weaker"', async () => {
    installFakeDns({
      '_dmarc.example.com/TXT': txt('v=DMARC1; p=none; sp=none; rua=mailto:r@example.com'),
      '_dmarc.app.example.com/TXT': txt('v=DMARC1; p=reject; sp=none; rua=mailto:r@example.com'),
    });
    const r = await checkDmarc('app.example.com');
    expect(r.grade).toBe('strict');
    expect(r.effective).toMatchObject({ policy: 'reject', tag: 'p', source: 'own' });
    expect(findings(r)['dmarc-sp-weaker']).toBeUndefined();
  });
  it('the organizational domain keeps its warning when sp= is weaker than p=', async () => {
    installFakeDns({ '_dmarc.example.com/TXT': txt('v=DMARC1; p=reject; sp=none; rua=mailto:r@example.com') });
    expect(Object.keys(findings(await checkDmarc('example.com')))).toContain('dmarc-sp-weaker');
  });
});

describe('B3: np= for a name that does not exist', () => {
  it('p=reject; np=none: a name that is NXDOMAIN is under none', async () => {
    installFakeDns({ '_dmarc.example.com/TXT': txt('v=DMARC1; p=reject; np=none; rua=mailto:r@example.com') });
    const r = await checkDmarc('ghost.example.com');
    expect(r.grade).toBe('monitoring');
    expect(r.effective).toMatchObject({ policy: 'none', tag: 'np', exists: false });
    expect(findings(r)['dmarc-inherited']?.message).toContain('does not exist');
  });
});

describe('B4: no SPF record at a name', () => {
  it('says what that means (SPF is checked at the return-path domain), not only that it is missing', async () => {
    installFakeDns({});
    const r = await checkSpf('app.example.com');
    expect(r.state).toBe('no-record');
    const m = r.findings.find((f) => f.code === 'spf-missing')!.message;
    expect(m).toContain('return-path');
    expect(m).toContain('app.example.com');
  });
});

describe('C: an invalid np=', () => {
  it('with a valid rua= the name is under p=none, said so, and the record is not called strict', async () => {
    installFakeDns({ '_dmarc.example.com/TXT': txt('v=DMARC1; p=reject; np=bogus; rua=mailto:r@example.com'), 'app.example.com/A': A });
    const r = await checkDmarc('app.example.com');
    expect(r.grade).toBe('monitoring');
    const f = findings(r);
    expect(f['dmarc-invalid-np']?.message).toContain('invalid np= value, so receivers act as if it said p=none');
    expect(f['dmarc-policy-none']?.message).toContain('p=none (record not applied as written)');
  });
  it('without a valid rua= the checker says the record is not valid and grades nothing', async () => {
    installFakeDns({ '_dmarc.example.com/TXT': txt('v=DMARC1; p=reject; np=bogus'), 'app.example.com/A': A });
    const r = await checkDmarc('app.example.com');
    expect(r.grade).toBe('missing');
    expect(findings(r)['dmarc-invalid']?.severity).toBe('fail');
  });
});
