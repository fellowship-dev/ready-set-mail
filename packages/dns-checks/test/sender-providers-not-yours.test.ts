import { describe, expect, it } from 'vitest';
import { likelyNotYours } from '../src/sender-providers';

const base = { spf_pass: 0, dkim_pass: 0 };
describe('likelyNotYours', () => {
  it('an unknown sender with unrelated spf/dkim domains', () => {
    expect(likelyNotYours({ ...base, reverse_dns: 'mail.evil.test', spf_domain: 'evil.test', dkim_domain: 'other.test' }, 'example.com')).toBe(true);
  });
  it('a known provider is not', () => {
    expect(likelyNotYours({ ...base, reverse_dns: 'o1.sendgrid.net' }, 'example.com')).toBe(false);
  });
  it('SPF passed for the organization\'s own domain is not', () => {
    expect(likelyNotYours({ ...base, spf_pass: 1, spf_domain: 'example.com', reverse_dns: 'mx.vps.test' }, 'example.com')).toBe(false);
  });
  it('DKIM passed for a subdomain of the organization counts as the same org', () => {
    expect(likelyNotYours({ ...base, dkim_pass: true, dkim_domain: 'mail.example.com', reverse_dns: 'mx.vps.test' }, 'example.com')).toBe(false);
    expect(likelyNotYours({ ...base, spf_pass: true, spf_domain: 'example.com', reverse_dns: 'mx.vps.test' }, 'shop.example.com')).toBe(false);
  });
  it('an own-domain name that did not pass does not count', () => {
    expect(likelyNotYours({ ...base, spf_domain: 'example.com', reverse_dns: 'mx.vps.test' }, 'example.com')).toBe(true);
  });
});
