// ADR 0028: a refresh never removes an authorised address on its first sighting. A removal waits for a second look at least four hours later;
// additions are written at once, together with the addresses whose removal is pending; if both together do not fit, nothing is written.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const audits: Array<{ action: string; before_value?: any; after_value?: any; meta?: any }> = [];
vi.mock('../../src/audit/log', () => ({ logAudit: vi.fn((_t: unknown, e: any) => { audits.push(e); }) }));

import { enableSpf, refreshSpf, rollbackSpf, runSpfRefresh, newSpfBudget, spfView, SPF_PENDING_CONFIRM_SECONDS } from '../../src/spf/refresh';
import { silence, world } from './world';

const T0 = 1_800_000_000_000; // ms
const H = 3600_000;
const actions = () => audits.map(a => a.action);
beforeEach(() => { audits.length = 0; silence(); });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const MAIL_OLD = 'v=spf1 ip4:198.51.100.0/28 ~all';
const published = (w: ReturnType<typeof world>) => w.live();

/** Flattening on at T0 with both providers inlined. */
async function on(w = world()) {
  const r = await enableSpf(w.tenant, w.domain, { anyway: true }, { ...w.deps, now: () => T0 });
  if (!r.ok) throw new Error(JSON.stringify(r));
  audits.length = 0;
  w.cf.calls.length = 0;
  return w;
}
/** One daily check at T0 + `afterMs`. */
async function check(w: ReturnType<typeof world>, afterMs: number, extra: Record<string, unknown> = {}) {
  return refreshSpf(w.tenant, w.row()!, { ...w.deps, now: () => T0 + afterMs, ...extra });
}
const DAY = 24 * H;
const BEFORE = 'v=spf1 ip4:198.51.100.0/28 ip4:203.0.113.9 -all';

describe('a removal waits (ADR 0028)', () => {
  it('an include that now answers v=spf1 -all writes nothing that removes it: the last good record stays, the removal is marked pending', async () => {
    const w = await on();
    expect(published(w)).toBe(BEFORE);
    w.cf.doh['mail.test'] = ['v=spf1 -all'];
    const r = await check(w, DAY);
    expect(r.outcome).toBe('pending');
    expect(w.patches()).toEqual([]);
    expect(published(w)).toBe(BEFORE);
    const row = w.row()!;
    expect(row).toMatchObject({ flattened_record: BEFORE, pending_since: (T0 + DAY) / 1000, pending_additions: 1, problem_kind: null });
    const view = spfView(row);
    expect(view.pending).toEqual({ removed: { 'mail.test': ['ip4:198.51.100.0/28'] }, providers: ['mail.test'], since: (T0 + DAY) / 1000, confirm_after: (T0 + DAY) / 1000 + SPF_PENDING_CONFIRM_SECONDS, additions_written: true });
    expect(view.flattened_record).toBe(BEFORE);
    expect(actions()).toEqual(['spf_flatten.pending']);
    expect(audits[0]!.after_value).toMatchObject({ removed: { 'mail.test': ['ip4:198.51.100.0/28'] }, additions_written: true });
  });

  it('the same removal seen again 3 hours later writes nothing; seen again 4 hours after the first time it is written, with the time it waited', async () => {
    const w = await on();
    w.cf.doh['mail.test'] = ['v=spf1 -all'];
    await check(w, DAY);
    audits.length = 0;
    expect((await check(w, DAY + 3 * H)).outcome).toBe('pending');
    expect(w.patches()).toEqual([]);
    expect(w.row()!.pending_since).toBe((T0 + DAY) / 1000); // the clock did not restart
    expect(actions()).toEqual([]);

    expect((await check(w, DAY + 4 * H)).outcome).toBe('changed');
    expect(w.patches()).toHaveLength(1);
    expect(published(w)).toBe('v=spf1 ip4:203.0.113.9 -all');
    expect(w.row()).toMatchObject({ pending_removed: null, pending_since: null, pending_additions: null, previous_record: BEFORE });
    expect(spfView(w.row()!).pending).toBeNull();
    expect(actions()).toEqual(['spf_flatten.update', 'dns.update']);
    expect(audits[0]!.meta).toMatchObject({ confirmed_after_seconds: 4 * 3600 });
  });

  it('the provider comes back: the wait ends with no write', async () => {
    const w = await on();
    w.cf.doh['mail.test'] = ['v=spf1 -all'];
    await check(w, DAY);
    w.cf.doh['mail.test'] = [MAIL_OLD];
    audits.length = 0;
    expect((await check(w, DAY + 3 * H)).outcome).toBe('unchanged');
    expect(w.patches()).toEqual([]);
    expect(w.row()).toMatchObject({ pending_removed: null, pending_since: null });
    expect(actions()).toEqual(['spf_flatten.pending_cleared']);
    expect(audits[0]!.meta).toMatchObject({ waited_seconds: 3 * 3600 });
    // and a later disappearance starts a new wait from that day
    w.cf.doh['mail.test'] = ['v=spf1 -all'];
    await check(w, 2 * DAY);
    expect(w.row()!.pending_since).toBe((T0 + 2 * DAY) / 1000);
  });

  it('a mixed change writes the additions at once and holds the removal', async () => {
    const w = await on();
    w.cf.doh['mail.test'] = ['v=spf1 ip4:198.51.100.64/28 ~all']; // a new range replaces the old one
    const r = await check(w, DAY);
    expect(r.outcome).toBe('changed');
    expect(w.patches()).toHaveLength(1);
    expect(published(w)).toBe('v=spf1 ip4:198.51.100.64/28 ip4:198.51.100.0/28 ip4:203.0.113.9 -all'); // the old range is still there
    expect(w.row()).toMatchObject({ pending_additions: 1, pending_since: (T0 + DAY) / 1000 });
    expect(actions().sort()).toEqual(['dns.update', 'spf_flatten.pending', 'spf_flatten.update']);

    w.cf.calls.length = 0;
    expect((await check(w, DAY + 4 * H)).outcome).toBe('changed'); // the second look: the old range goes
    expect(published(w)).toBe('v=spf1 ip4:198.51.100.64/28 ip4:203.0.113.9 -all');
    expect(w.row()!.pending_since).toBeNull();
  });

  it('a different removal replaces the pending one and the clock restarts', async () => {
    const w = await on();
    w.cf.doh['other.test'] = ['v=spf1 -all'];
    await check(w, DAY);
    expect(Object.keys(spfView(w.row()!).pending!.removed)).toEqual(['other.test']);
    w.cf.doh['other.test'] = ['v=spf1 ip4:203.0.113.9 -all']; // that one is back, another provider leaves
    w.cf.doh['mail.test'] = ['v=spf1 -all'];
    audits.length = 0;
    expect((await check(w, DAY + 5 * H)).outcome).toBe('pending'); // 5 hours after the first look, but the set is another one
    expect(w.patches()).toEqual([]);
    expect(spfView(w.row()!).pending!.providers).toEqual(['mail.test']);
    expect(w.row()!.pending_since).toBe((T0 + DAY + 5 * H) / 1000);
    expect(actions()).toEqual(['spf_flatten.pending']);
    expect(audits[0]!.meta).toMatchObject({ replaced: true });
    expect((await check(w, DAY + 8 * H)).outcome).toBe('pending'); // 3 hours after the second look
    expect((await check(w, DAY + 9 * H)).outcome).toBe('changed');
    expect(published(w)).toBe('v=spf1 ip4:203.0.113.9 -all');
  });

  it('every provider losing every address is a problem, not a pending removal: the record is never emptied', async () => {
    const w = await on();
    w.cf.doh['other.test'] = ['v=spf1 -all'];
    w.cf.doh['mail.test'] = ['v=spf1 -all'];
    expect((await check(w, DAY)).outcome).toBe('problem');
    expect(w.row()).toMatchObject({ problem_kind: 'no_addresses', flattened_record: BEFORE });
    expect(w.patches()).toEqual([]);
  });

  it('a provider that loses every address is the same rule, and the view names it', async () => {
    const w = await on();
    w.cf.doh['other.test'] = ['v=spf1 -all'];
    await check(w, DAY);
    expect(spfView(w.row()!).pending).toMatchObject({ providers: ['other.test'], removed: { 'other.test': ['ip4:203.0.113.9'] } });
  });

  it('when the addresses held and the new ones do not fit both limits, nothing is written, not even the additions, and the view says so', async () => {
    const old = Array.from({ length: 12 }, (_, i) => `ip4:10.1.${i}.0/24`);
    const fresh = Array.from({ length: 20 }, (_, i) => `ip4:10.2.${i}.0/24`);
    const w = world({ original: 'v=spf1 include:big.test -all', doh: { 'big.test': [`v=spf1 ${old.join(' ')} ~all`] } });
    await on(w);
    const before = published(w);
    w.cf.doh['big.test'] = [`v=spf1 ${fresh.join(' ')} ~all`];
    const r = await check(w, DAY);
    expect(r.outcome).toBe('pending');
    expect(w.patches()).toEqual([]);
    expect(published(w)).toBe(before);
    expect(spfView(w.row()!).pending).toMatchObject({ additions_written: false, providers: ['big.test'] });
    expect(actions()).toEqual(['spf_flatten.pending']);
    expect(audits[0]!.after_value).toMatchObject({ additions_written: false });
    // the second look, four hours on, writes the new record in full
    expect((await check(w, DAY + 4 * H)).outcome).toBe('changed');
    expect(published(w)).toBe(`v=spf1 ${fresh.join(' ')} -all`);
  });

  it('an address a new range covers is not a removal: written at once, nothing pending', async () => {
    const w = world({ original: 'v=spf1 include:big.test -all', doh: { 'big.test': ['v=spf1 ip4:10.1.1.0/24 ip4:10.1.1.7 ~all'] } });
    await on(w);
    w.cf.doh['big.test'] = ['v=spf1 ip4:10.1.0.0/23 ~all'];
    expect((await check(w, DAY)).outcome).toBe('changed');
    expect(published(w)).toBe('v=spf1 ip4:10.1.0.0/23 -all');
    expect(w.row()!.pending_since).toBeNull();
  });

  it('turning flattening off while a removal waits restores the original and leaves nothing behind', async () => {
    const { disableSpf } = await import('../../src/spf/refresh');
    const w = await on();
    w.cf.doh['mail.test'] = ['v=spf1 -all'];
    await check(w, DAY);
    expect(await disableSpf(w.tenant, w.domain, { ...w.deps, now: () => T0 + DAY })).toMatchObject({ ok: true, restored: true });
    expect(w.row()).toBeUndefined();
  });

  it('the daily job does the same: the first run holds the removal, a run 4 hours on writes it', async () => {
    const w = await on();
    w.cf.doh['mail.test'] = ['v=spf1 -all'];
    await runSpfRefresh(w.tenant, undefined, newSpfBudget(), { ...w.deps, now: () => T0 + DAY });
    expect(w.patches()).toEqual([]);
    expect(w.row()!.pending_since).toBe((T0 + DAY) / 1000);
    await runSpfRefresh(w.tenant, undefined, newSpfBudget(), { ...w.deps, now: () => T0 + DAY + 20 * H + 4 * H });
    expect(w.patches()).toHaveLength(1);
    expect(published(w)).toBe('v=spf1 ip4:203.0.113.9 -all');
  });

  it('one step back forgets what was waiting and what the older record authorised: the next check makes its own choice', async () => {
    const w = await on();
    w.cf.doh['mail.test'] = ['v=spf1 ip4:198.51.100.64/28 ~all'];
    await check(w, DAY); // the new range is written, the old one waits
    expect(w.row()!.pending_since).not.toBeNull();
    expect(await rollbackSpf(w.tenant, w.domain, { ...w.deps, now: () => T0 + DAY + H })).toBe('rolled_back');
    expect(published(w)).toBe(BEFORE);
    expect(w.row()).toMatchObject({ provider_state: null, pending_removed: null, pending_since: null, pending_additions: null });
  });
});
