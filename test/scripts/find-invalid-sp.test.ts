// scripts/find-invalid-sp.ts: the release scan's filter. Given record names, it prints those whose live DMARC record has an
// invalid sp=, by the dashboard's own rule, including the rows older builds stored by their p= (p=reject; sp=bogus as reject).
import { describe, expect, it } from 'vitest';
import type { Resolver } from '@ready-set-mail/dns-checks';
import { findInvalidSp } from '../../scripts/find-invalid-sp';

const zone: Record<string, string[] | 'error'> = {
  '_dmarc.reject-bogus.test': ['v=DMARC1; p=reject; sp=bogus; rua=mailto:r@x.test'],
  '_dmarc.case.test': ['v=DMARC1; p=quarantine; SP=Rejectt'],
  '_dmarc.none-bogus.test': ['v=DMARC1; p=none; sp=bogus'],
  '_dmarc.valid.test': ['v=DMARC1; p=reject; sp=quarantine'],
  '_dmarc.nosp.test': ['v=DMARC1; p=none; rua=mailto:r@x.test'],
  '_dmarc.badp.test': ['v=DMARC1; p=rejected; sp=bogus'],
  '_dmarc.multi.test': ['v=DMARC1; p=reject; sp=bogus', 'v=DMARC1; p=none'],
  '_dmarc.other-txt.test': ['google-site-verification=abc', 'v=DMARC1; p=reject; sp=nope'],
  '_dmarc.down.test': 'error',
};
const resolver = {
  txt: async (name: string) => {
    const v = zone[name.toLowerCase()];
    return v === 'error' ? { status: 'error', records: [], error: 'SERVFAIL' } : { status: v ? 'ok' : 'nxdomain', records: v ?? [] };
  },
} as unknown as Resolver;

describe('find-invalid-sp: names whose live DMARC record has an invalid sp=', () => {
  it('prints exactly those, with the record, and lists the names it could not read', async () => {
    const input = ['reject-bogus.test', 'CASE.test.', 'none-bogus.test', 'valid.test', 'nosp.test', 'badp.test', 'multi.test', 'other-txt.test', 'missing.test', 'down.test', '', 'reject-bogus.test   extra'];
    const { found, failed } = await findInvalidSp(input, resolver);
    expect(found).toEqual([
      { name: 'reject-bogus.test', record: 'v=DMARC1; p=reject; sp=bogus; rua=mailto:r@x.test' },
      { name: 'case.test', record: 'v=DMARC1; p=quarantine; SP=Rejectt' },
      { name: 'none-bogus.test', record: 'v=DMARC1; p=none; sp=bogus' },
      { name: 'other-txt.test', record: 'v=DMARC1; p=reject; sp=nope' },
    ]);
    // An invalid p= is its own problem (already stored as such), several records too: not listed here.
    expect(failed).toEqual(['down.test']);
  });
});
