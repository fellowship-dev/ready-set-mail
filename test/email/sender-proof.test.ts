import { describe, it, expect } from 'vitest';
import { readAuthHeaders, trustedResults, spfPassesFor } from '../../src/email/sender-proof';

const ar = (body: string) => `mx.cloudflare.net; ${body}`;

describe('spfPassesFor', () => {
  it('accepts one spf=pass for exactly the envelope domain', () => {
    expect(spfPassesFor(ar('dkim=none; spf=pass (ok) smtp.mailfrom=a@v.com; dmarc=none header.from=v.com'), 'v.com')).toBe(true);
  });

  it('refuses a header that carries more than one spf clause, even when one passes', () => {
    expect(spfPassesFor(ar('dmarc=none header.from=x;spf=pass smtp.mailfrom=v.com; spf=fail smtp.mailfrom=a@v.com'), 'v.com')).toBe(false);
  });
});

describe('readAuthHeaders and trustedResults', () => {
  const stream = (t: string) => new Response(new TextEncoder().encode(t)).body!;
  const ID = 'mx.cloudflare.net';

  it('reads the topmost Authentication-Results and ARC-Authentication-Results from the raw header block, unfolding, ignoring the body', async () => {
    const h = await readAuthHeaders(stream('Authentication-Results: mx.a;\r\n dkim=pass header.d=a.com\r\nARC-Authentication-Results: i=1; mx.a; dkim=pass\r\nARC-Authentication-Results: i=2; evil; dkim=pass\r\nAuthentication-Results: x; dkim=pass header.d=b.com\r\n\r\nAuthentication-Results: y; in-body'));
    expect(h).toEqual({ ar: 'mx.a; dkim=pass header.d=a.com', arc: 'i=1; mx.a; dkim=pass', from: null, dkimSignatures: 0 });
    expect(await readAuthHeaders(stream('Subject: x\r\n\r\nbody'))).toEqual({ ar: null, arc: null, from: null, dkimSignatures: 0 });
    expect(await readAuthHeaders(null)).toEqual({ ar: null, arc: null });
  });

  it('fails closed without AUTHSERV_ID or AUTHSERV_HEADER', () => {
    const good = 'mx.cloudflare.net; dkim=pass header.d=acme.com';
    for (const id of [undefined, '', '  ']) expect(trustedResults({ ar: good, arc: null }, id, 'ar')).toBeNull();
    for (const only of [undefined, '', 'both']) expect(trustedResults({ ar: good, arc: null }, ID, only)).toBeNull();
    expect(trustedResults({ ar: good, arc: null }, ' MX.cloudflare.net ', ' AR ')).toBe(good);
  });

  it('ar: a header naming another server is refused; a forged ARC header is not consulted', () => {
    expect(trustedResults({ ar: 'attacker.example; dkim=pass header.d=acme.com', arc: null }, ID, 'ar')).toBeNull();
    expect(trustedResults({ ar: null, arc: 'i=1; mx.cloudflare.net; dkim=pass header.d=acme.com' }, ID, 'ar')).toBeNull();
  });

  it('arc: only the instance i=1 with our authserv-id; a plain header is not consulted', () => {
    const arc = (hop: string, id = ID) => ({ ar: null, arc: `${hop}; ${id}; dkim=pass header.d=acme.com` });
    expect(trustedResults(arc('i=1'), ID, 'arc')).toBe(' mx.cloudflare.net; dkim=pass header.d=acme.com');
    expect(trustedResults(arc('i=2'), ID, 'arc')).toBeNull();
    expect(trustedResults(arc('i=1', 'evil.example'), ID, 'arc')).toBeNull();
    expect(trustedResults({ ar: 'mx.cloudflare.net; dkim=pass', arc: null }, ID, 'arc')).toBeNull();
  });
});
