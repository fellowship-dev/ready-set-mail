import { describe, expect, it } from 'vitest';
import { classifyDohBody } from '../src/doh';

// Upstreamed from the website's local patch (frontend/lib/dns-checks/patches/doh-nxdomain-cname.patch): a name that is a CNAME to a
// missing target answers NXDOMAIN, but the name itself exists. The public reports' "does this domain exist" check relies on it.
describe('classifyDohBody: NXDOMAIN with a CNAME', () => {
  it('marks a dangling CNAME, and only that', () => {
    expect(classifyDohBody({ Status: 3, Answer: [{ name: 'www.acme.com.', type: 5, TTL: 60, data: 'gone.example.net.' }] }, 'A')).toEqual({ status: 'nxdomain', answers: [], rcode: 3, hasCname: true });
    expect(classifyDohBody({ Status: 3 }, 'A')).toEqual({ status: 'nxdomain', answers: [], rcode: 3 });
    expect(classifyDohBody({ Status: 3, Answer: [{ type: 1, data: '192.0.2.1' }] }, 'A')).toEqual({ status: 'nxdomain', answers: [], rcode: 3 });
  });
});
