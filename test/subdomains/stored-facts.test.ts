// C (scope): the dashboard's stored DMARC facts have no issue kind for an invalid np=, and none is added (no schema change): an invalid np= is read as
// absent there, as before. The checker and the agent report apply RFC 9989 section 4.10.1 (see packages/dns-checks/test/subdomain-policy.test.ts).
import { describe, expect, it } from 'vitest';
import { lookupDmarc } from '@ready-set-mail/dns-checks';
import { dmarcFactsFromLookup } from '../../src/email/dns-snapshot';
import { dnsFetch } from './world';
import { createResolver } from '@ready-set-mail/dns-checks';

describe('stored DMARC facts', () => {
  it('leave an invalid np= alone: the stored policy of an existing subdomain is the record\'s p=', async () => {
    const zone = { '_dmarc.example.com': { TXT: ['v=DMARC1; p=reject; np=bogus; rua=mailto:r@example.com'] }, 'mail.example.com': { A: ['192.0.2.1'] } };
    const l = await lookupDmarc(createResolver({ fetch: (async (u: string) => dnsFetch(zone)(u)) as never }), 'mail.example.com');
    expect(l.effective).toMatchObject({ status: 'broken', policy: 'none', invalidTag: 'np' });
    expect(dmarcFactsFromLookup(l)).toMatchObject({ policy: 'reject', issue: null, inherited_from: 'example.com' });
  });
});
