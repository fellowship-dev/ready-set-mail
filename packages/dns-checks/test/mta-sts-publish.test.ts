import { describe, it, expect } from 'vitest';
import { isIpLiteral, mxMatchesPattern, nextPolicyId, generatePolicyId } from '../src';

describe('nextPolicyId', () => {
  it('is the timestamp id, and differs from the previous one even within the same second', () => {
    const now = new Date('2026-11-16T12:00:00Z');
    expect(nextPolicyId(null, now)).toBe('20261116120000');
    expect(nextPolicyId('20261116115959', now)).toBe('20261116120000');
    expect(nextPolicyId('20261116120000', now)).toBe('20261116120000a');
    expect(nextPolicyId(generatePolicyId(now), now)).not.toBe(generatePolicyId(now));
  });
});

describe('mxMatchesPattern (RFC 8461 §4.1)', () => {
  it('matches an exact name, ignoring case and a trailing dot', () => {
    expect(mxMatchesPattern('Mail.Example.com.', 'mail.example.com')).toBe(true);
    expect(mxMatchesPattern('mail.example.com', 'mx.example.com')).toBe(false);
  });
  it('a wildcard is exactly the left-most label: "*.example.com" matches "mail.example.com", not "example.com" or "foo.bar.example.com"', () => {
    expect(mxMatchesPattern('mail.example.com', '*.example.com')).toBe(true);
    expect(mxMatchesPattern('example.com', '*.example.com')).toBe(false);
    expect(mxMatchesPattern('foo.bar.example.com', '*.example.com')).toBe(false);
  });
  it('empty names match nothing', () => {
    expect(mxMatchesPattern('', 'a.b')).toBe(false);
    expect(mxMatchesPattern('a.b', '')).toBe(false);
  });
});

describe('isIpLiteral', () => {
  it('knows addresses from hostnames', () => {
    for (const ip of ['192.0.2.1', '2001:db8::1', '[2001:db8::1]']) expect(isIpLiteral(ip), ip).toBe(true);
    for (const h of ['mail.example.com', 'mx1.example.com.', '1.example.com']) expect(isIpLiteral(h), h).toBe(false);
  });
});
