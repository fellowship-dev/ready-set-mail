import { describe, it, expect } from 'vitest';
import { organizationalDomain, isPublicSuffix, domainAncestry, sameOrganizationalDomain } from '../src/org-domain';

describe('organizationalDomain (Public Suffix List)', () => {
  it.each([
    ['example.com', 'example.com'],
    ['mail.example.com', 'example.com'],
    ['a.b.c.example.com', 'example.com'],
    ['mail.example.co.uk', 'example.co.uk'],
    ['example.co.uk', 'example.co.uk'],
    ['shop.example.com.au', 'example.com.au'],
    ['www.example.co.jp', 'example.co.jp'],
    ['Mail.Example.CO.UK.', 'example.co.uk'],
    ['alice.github.io', 'alice.github.io'],
    ['www.alice.github.io', 'alice.github.io'],
  ])('%s → %s', (input, expected) => {
    expect(organizationalDomain(input)).toBe(expected);
  });

  it.each(['co.uk', 'com', 'com.au', 'github.io'])('never returns the bare public suffix %s', s => {
    expect(organizationalDomain(s)).toBeNull();
    expect(isPublicSuffix(s)).toBe(true);
  });

  it('returns null for IPs and empty input', () => {
    expect(organizationalDomain('192.0.2.1')).toBeNull();
    expect(organizationalDomain('')).toBeNull();
  });
});

describe('domainAncestry: the names from a domain up to its organizational domain', () => {
  it('runs up to the organizational domain and stops there', () => {
    expect(domainAncestry('a.b.example.co.uk')).toEqual(['a.b.example.co.uk', 'b.example.co.uk', 'example.co.uk']);
    expect(domainAncestry('Example.com.')).toEqual(['example.com']);
  });
  it('is empty for a public suffix, and a private-suffix name is its own organization', () => {
    expect(domainAncestry('co.uk')).toEqual([]);
    expect(domainAncestry('alice.github.io')).toEqual(['alice.github.io']);
  });
  it('sameOrganizationalDomain is relaxed alignment between two names (RFC 9989 section 3.2.10.1)', () => {
    expect(sameOrganizationalDomain('cf-bounce.app.example.com', 'example.com')).toBe(true);
    expect(sameOrganizationalDomain('a.example.co.uk', 'b.example.co.uk')).toBe(true);
    expect(sameOrganizationalDomain('a.co.uk', 'b.co.uk')).toBe(false);
    expect(sameOrganizationalDomain('co.uk', 'co.uk')).toBe(false);
  });
});
