import { describe, it, expect } from 'vitest';
import { disableRule, enforceReadiness, maxAgeWords, BLOCKING_FAILURE_TYPES, type EvidenceRow } from '../../src/mta-sts/evidence';

const DAY = 86400;
const NOW = 1_800_000_000;
const cfg = (o: Partial<Parameters<typeof enforceReadiness>[0]> = {}) => ({
  state: 'active' as const, mode: 'testing' as const, mx_hosts: 'mx1.example.com,mx2.example.com',
  policy_published_at: NOW - 10 * DAY, mode_changed_at: NOW - 10 * DAY, ...o,
});
const report = (o: Partial<EvidenceRow> = {}): EvidenceRow => ({ date_begin: NOW - 3 * DAY, date_end: NOW - 2 * DAY, sts_success: 40, sts_failure: 0, sts_failure_types: '[]', reporter_tier: 'counted', ...o });
const MX = ['mx1.example.com', 'mx2.example.com'];

describe('enforceReadiness', () => {
  it('is ready after 7+ days in testing, a report with successful MTA-STS sessions after publication, no blocking failures, and every MX a matching hostname', () => {
    expect(enforceReadiness(cfg(), [report()], MX, NOW)).toEqual({ ready: true, reasons: [] });
  });

  it('is already enforcing: nothing to do', () => {
    expect(enforceReadiness(cfg({ mode: 'enforce' }), [report()], MX, NOW).reasons).toEqual(['It is already enforcing.']);
  });

  it('names the days still to wait (CHANGELOG 1.2.0: 7 days in testing)', () => {
    const r = enforceReadiness(cfg({ mode_changed_at: NOW - 2 * DAY }), [report()], MX, NOW);
    expect(r.ready).toBe(false);
    expect(r.reasons).toEqual(['It has been in testing for 2 of the 7 days senders need to report: 5 more days.']);
  });

  it('needs setup finished', () => {
    expect(enforceReadiness(cfg({ state: 'waiting_certificate' }), [report()], MX, NOW).reasons[0]).toMatch(/Setup is not finished/);
  });

  it('needs a report AFTER the current policy id was published, with successful sessions', () => {
    const none = enforceReadiness(cfg(), [], MX, NOW);
    expect(none.reasons).toEqual([expect.stringMatching(/No verified TLS report has arrived yet for the current policy/)]);
    // a report that ended before the policy was published says nothing about it
    expect(enforceReadiness(cfg(), [report({ date_end: NOW - 11 * DAY })], MX, NOW).ready).toBe(false);
    // failures only, no success
    expect(enforceReadiness(cfg(), [report({ sts_success: 0, sts_failure: 3, sts_failure_types: '["starttls-not-supported"]' })], MX, NOW).reasons.join(' ')).toMatch(/No verified TLS report has arrived yet/);
    // sessions that are not MTA-STS (null = unknown on old rows, 0 = none) do not count
    expect(enforceReadiness(cfg(), [report({ sts_success: null })], MX, NOW).ready).toBe(false);
  });

  it('a policy that is not published yet (by hand) has no evidence at all', () => {
    expect(enforceReadiness(cfg({ policy_published_at: null }), [report()], MX, NOW).ready).toBe(false);
  });

  it('every blocking failure type in the window refuses, and the reason names it', () => {
    for (const type of BLOCKING_FAILURE_TYPES) {
      const r = enforceReadiness(cfg(), [report(), report({ sts_failure: 2, sts_failure_types: JSON.stringify([type]) })], MX, NOW);
      expect(r.ready, type).toBe(false);
      expect(r.reasons.join(' '), type).toContain(type);
    }
  });

  it('other failure types (DANE, DNSSEC) do not block', () => {
    expect(enforceReadiness(cfg(), [report(), report({ sts_failure: 1, sts_failure_types: '["tlsa-invalid","dnssec-invalid"]' })], MX, NOW).ready).toBe(true);
  });

  it('failures older than 14 days, or from before the current policy, do not weigh', () => {
    const old = report({ date_end: NOW - 15 * DAY, sts_failure: 4, sts_failure_types: '["certificate-expired"]' });
    expect(enforceReadiness(cfg({ policy_published_at: NOW - 30 * DAY, mode_changed_at: NOW - 30 * DAY }), [report(), old], MX, NOW).ready).toBe(true);
    const beforePolicy = report({ date_end: NOW - 12 * DAY, sts_failure: 4, sts_failure_types: '["certificate-expired"]' });
    expect(enforceReadiness(cfg(), [report(), beforePolicy], MX, NOW).ready).toBe(true);
  });

  it('failed sessions with no reason given are said, not ignored', () => {
    const r = enforceReadiness(cfg(), [report(), report({ sts_failure: 5, sts_failure_types: '[]' })], MX, NOW);
    expect(r.reasons.join(' ')).toMatch(/1 report counts failed sessions without saying why/);
  });

  it('an MX host that is an address is refused, in words', () => {
    const r = enforceReadiness(cfg({ mx_hosts: '192.0.2.10' }), [report()], ['192.0.2.10'], NOW);
    expect(r.reasons.join(' ')).toMatch(/MX host 192\.0\.2\.10 is an address/);
  });

  it('a live MX host the policy does not list is refused: the list must be refreshed and watched again', () => {
    const r = enforceReadiness(cfg(), [report()], [...MX, 'mx3.example.com'], NOW);
    expect(r.reasons).toEqual([expect.stringMatching(/mx3\.example\.com is not in the published policy yet/)]);
  });

  it('an MX list that could not be read, or is empty, is a reason', () => {
    expect(enforceReadiness(cfg(), [report()], null, NOW).reasons).toEqual([expect.stringMatching(/could not be read/)]);
    expect(enforceReadiness(cfg(), [report()], [], NOW).reasons).toEqual(['The domain has no MX records.']);
  });

  it('lists every failed rule, not just the first', () => {
    const r = enforceReadiness(cfg({ state: 'waiting_txt', mode_changed_at: NOW - DAY }), [], MX, NOW);
    expect(r.reasons).toHaveLength(3);
  });
});

describe('disableRule', () => {
  const row = (o: Partial<Parameters<typeof disableRule>[0]> = {}) => ({ mode: 'testing' as const, left_enforce_at: null, max_age: DAY, ...o });

  it('allows disabling from testing when it was never in enforce', () => {
    expect(disableRule(row(), NOW)).toEqual({ allowed: true, after: null, reason: null });
  });
  it('refuses from enforce and says switch to testing first, with the max_age', () => {
    expect(disableRule(row({ mode: 'enforce' }), NOW)).toMatchObject({ allowed: false, reason: 'Switch to testing first. Senders keep the enforce policy for up to 1 day; you can disable it after that.' });
  });
  it('refuses until max_age after the switch back to testing, saying when, then allows', () => {
    const left = NOW - 3600;
    const early = disableRule(row({ left_enforce_at: left }), NOW);
    expect(early.allowed).toBe(false);
    expect(early.after).toBe(left + DAY);
    expect(early.reason).toMatch(/up to 1 day\. You can disable MTA-STS after \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC\./);
    expect(disableRule(row({ left_enforce_at: left }), left + DAY).allowed).toBe(true);
  });
  it('uses the row\'s own max_age', () => {
    expect(disableRule(row({ left_enforce_at: NOW - DAY, max_age: 7 * DAY }), NOW).allowed).toBe(false);
  });
  it('says the age in plain words', () => {
    expect(maxAgeWords(86400)).toBe('1 day');
    expect(maxAgeWords(604800)).toBe('7 days');
    expect(maxAgeWords(7200)).toBe('2 hours');
    expect(maxAgeWords(90)).toBe('90 seconds');
  });
});
