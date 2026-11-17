import { describe, expect, it } from 'vitest';
import { classifySource, likelyNotYours, serviceNotSetUpSentence } from '../src/sender-providers';

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

describe('classifySource: the one judgement of whose failure a source is', () => {
  it('yours: SPF or DKIM passed for a name of the owner\'s organization', () => {
    expect(classifySource({ ...base, spf_pass: 1, spf_domain: 'mail.example.com', reverse_dns: 'mx.vps.test' }, 'example.com')).toBe('yours');
    expect(classifySource({ ...base, dkim_pass: 1, dkim_domain: 'example.com', spf_pass: 1, spf_domain: 'other.test' }, 'example.com')).toBe('yours');
  });
  it('service_not_set_up: a known sending service, or SPF AND DKIM both passed for its own domains', () => {
    expect(classifySource({ ...base, reverse_dns: 'o1.sendgrid.net' }, 'example.com')).toBe('service_not_set_up');
    expect(classifySource({ spf_pass: 1, dkim_pass: 1, spf_domain: 'bounce.other-provider.example', dkim_domain: 'some-other-domain.example', reverse_dns: 'mx.vps.test' }, 'example.com')).toBe('service_not_set_up');
  });
  it('not_yours: anything else, one pass for another domain is not enough', () => {
    expect(classifySource({ ...base, reverse_dns: 'mail.evil.test', spf_domain: 'evil.test', dkim_domain: 'other.test' }, 'example.com')).toBe('not_yours');
    expect(classifySource({ spf_pass: 1, dkim_pass: 0, spf_domain: 'bounce.other.example', dkim_domain: 'other.example', reverse_dns: 'mx.vps.test' }, 'example.com')).toBe('not_yours');
    expect(classifySource({ spf_pass: 1, dkim_pass: 1, spf_domain: null, dkim_domain: null }, 'example.com')).toBe('not_yours');
  });
  it('likelyNotYours is a reading of it', () => {
    expect(likelyNotYours({ spf_pass: 1, dkim_pass: 1, spf_domain: 'a.other.example', dkim_domain: 'b.other.example' }, 'example.com')).toBe(false);
  });
  it('the one sentence', () => {
    expect(serviceNotSetUpSentence('example.com')).toBe('a service sending as example.com that is not set up for it: if it is yours, set up its custom return-path and DKIM for example.com; if not, nothing to do');
  });
});
