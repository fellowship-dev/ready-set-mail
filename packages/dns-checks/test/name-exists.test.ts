// The one existence test (RFC 9989 section 3.2.13): NXDOMAIN means the name does not exist, except that a name that is a CNAME to a missing
// target answers NXDOMAIN too while the name itself has a record. The website's vendored copy patches doh.ts for the same reason.
import { describe, expect, it } from 'vitest';
import { lookupDmarc } from '../src/dmarc';
import { createResolver, type FetchLike } from '../src/doh';
import { nameExists } from '../src/name-exists';
import { dohFetch, fakeResolver, resp, type Zone } from './helpers';

const ZONE: Zone = { 'TXT _dmarc.example.com': ['v=DMARC1; p=reject; np=none; rua=mailto:r@example.com'], 'A example.com': ['192.0.2.1'], 'TXT mail.example.com': ['hello'] };

describe('nameExists', () => {
  it('a dangling CNAME is not a non-existent name: NXDOMAIN with a CNAME in the answer exists (np= does not apply)', async () => {
    const zone = ZONE;
    const fetch: FetchLike = async (url) => {
      const u = new URL(url);
      if (u.searchParams.get('name') === 'www.example.com' && u.searchParams.get('type') === 'A') {
        return resp(200, JSON.stringify({ Status: 3, Answer: [{ name: 'www.example.com.', type: 5, TTL: 60, data: 'gone.example.net.' }] }));
      }
      return dohFetch(zone)(url);
    };
    const r = createResolver({ fetch });
    expect(await nameExists(r, 'www.example.com')).toBe(true);
    expect((await lookupDmarc(r, 'www.example.com')).effective).toMatchObject({ policy: 'reject', tag: 'p', exists: true });
    expect(await nameExists(r, 'ghost.example.com')).toBe(false);
  });
  it('a failed lookup says nothing: unknown, never "does not exist"', async () => {
    const r = fakeResolver({ 'A x.example.com': 'SERVFAIL' });
    expect(await nameExists(r, 'x.example.com')).toBeNull();
  });
  it('a name with only TXT records answers NODATA and exists', async () => {
    expect(await nameExists(fakeResolver({ ...ZONE, 'A mail.example.com': 'NODATA' }), 'mail.example.com')).toBe(true);
  });
});
