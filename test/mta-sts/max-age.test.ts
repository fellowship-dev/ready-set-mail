// R2 item 6: the policy's max_age follows its mode. RFC 8461 section 3.2: max_age is "typically in the range of weeks or greater" (a short one weakens
// the policy at refresh time); section 5: start in testing, where a mistake should heal in a day. Proton serves 604800 in enforce.
import { describe, it, expect } from 'vitest';
import { policyText } from '../../src/mta-sts/serve';
import { maxAgeFor, MAX_AGE_ENFORCE, MAX_AGE_TESTING } from '../../src/mta-sts/config';

const row = (o: object) => ({ mode: 'testing' as const, mx_hosts: 'mx1.example.com,mx2.example.com', max_age: 86400, state: 'active' as const, ...o });

describe('max_age by mode (one place: maxAgeFor, used by policyText)', () => {
  it('testing is one day, enforce is seven', () => {
    expect([MAX_AGE_TESTING, MAX_AGE_ENFORCE]).toEqual([86400, 604800]);
    expect(maxAgeFor('testing')).toBe(86400);
    expect(maxAgeFor('enforce')).toBe(604800);
  });
  it('the policy file says the max_age of its mode, not whatever the row stored', () => {
    expect(policyText(row({ mode: 'testing', max_age: 604800 }))).toBe('version: STSv1\nmode: testing\nmx: mx1.example.com\nmx: mx2.example.com\nmax_age: 86400\n');
    expect(policyText(row({ mode: 'enforce', max_age: 86400 }))).toBe('version: STSv1\nmode: enforce\nmx: mx1.example.com\nmx: mx2.example.com\nmax_age: 604800\n');
  });
});
