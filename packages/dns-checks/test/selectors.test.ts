// B10: ONE list of DKIM selectors. The public checker and the agent report probe COMMON_DKIM_SELECTORS, the dashboard probes
// getAllDkimSelectors(): both are the same list, so a selector added once (cf-bounce, Cloudflare Email Service) is probed everywhere.
import { describe, expect, it } from 'vitest';
import { COMMON_DKIM_SELECTORS } from '../src/dkim';
import { getAllDkimSelectors, matchDkimProvider } from '../src/email-service-providers';
import { checkDomain } from '../src/report';
import { fakeResolver } from './helpers';

// The 36 selectors COMMON_DKIM_SELECTORS held before the lists were merged: none may be lost.
const BEFORE = ['default', 'google', 'selector1', 'selector2', 'k1', 'k2', 'k3', 's1', 's2', 'mandrill', 'mte1', 'resend', 'dkim', 'mail', 'smtp', 'email', 'amazonses', 'pm', 'pm-bounces', 'mxvault', 'zoho', 'zmail', 'sendgrid', 'smtpapi', 'mailgun', 'krs', 'scph0120', 'protonmail', 'protonmail2', 'protonmail3', 'fm1', 'fm2', 'fm3', 'cm', 'everlytickey1', 'shopify'];

describe('one list of DKIM selectors', () => {
  it('the checker list and the dashboard list are the same list', () => {
    expect([...COMMON_DKIM_SELECTORS]).toEqual(getAllDkimSelectors());
    expect(new Set(COMMON_DKIM_SELECTORS).size).toBe(COMMON_DKIM_SELECTORS.length);
  });
  it('keeps every selector of the old 36 and adds the registry\'s others (44 in all), cf-bounce among them', () => {
    expect(BEFORE).toHaveLength(36);
    for (const s of BEFORE) expect(COMMON_DKIM_SELECTORS, s).toContain(s);
    expect(COMMON_DKIM_SELECTORS).toHaveLength(44);
    expect(COMMON_DKIM_SELECTORS).toContain('cf-bounce');
    expect(matchDkimProvider('cf-bounce._domainkey.app.example.com')?.name).toBe('Cloudflare Email Service');
  });
  it('the agent report finds the cf-bounce key', async () => {
    const r = await checkDomain('app.example.com', { resolver: fakeResolver({ 'TXT cf-bounce._domainkey.app.example.com': ['v=DKIM1; k=rsa; p=MIIBIjANBgkq'] }), dkimProbeHex: () => '0123456789abcdef' });
    expect(r.dkim.found.map((f) => f.selector)).toEqual(['cf-bounce']);
  });
});
