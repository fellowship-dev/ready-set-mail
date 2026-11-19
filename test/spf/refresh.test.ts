import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const audits: Array<{ action: string; before_value?: any; after_value?: any; meta?: any }> = [];
vi.mock('../../src/audit/log', () => ({ logAudit: vi.fn((_t: unknown, e: any) => { audits.push(e); }) }));

import { CfApiError } from '../../src/tenancy/cf-client';
import { cloudflareTarget, type SpfTarget } from '../../src/spf/target';
import { disableSpf, enableSpf, newSpfBudget, refreshSpf, rollbackSpf, runSpfRefresh, SPF_DUE_AFTER_SECONDS } from '../../src/spf/refresh';
import { ORIGINAL, silence, world } from './world';

const actions = () => audits.map(a => a.action);
beforeEach(() => { audits.length = 0; silence(); });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

/** Turned on with both providers inlined (the owner chose "flatten anyway"; a record over 10 lookups gets fewest inlined, tested in the package). */
async function on(w = world()) {
  const r = await enableSpf(w.tenant, w.domain, { anyway: true }, w.deps);
  if (!r.ok) throw new Error(JSON.stringify(r));
  audits.length = 0;
  w.cf.calls.length = 0;
  return w;
}

describe('turning on', () => {
  it('stores the ORIGINAL, writes the flattened record, and says so in the audit log', async () => {
    const w = world();
    const r = await enableSpf(w.tenant, w.domain, { anyway: true }, w.deps);
    expect(r.ok).toBe(true);
    expect(w.live()).toBe('v=spf1 ip4:198.51.100.0/28 ip4:203.0.113.9 -all');
    const row = w.row()!;
    expect(row).toMatchObject({ enabled: 1, canonical_record: ORIGINAL, flattened_record: w.live(), ip_count: 2, revision: 1, inline_mode: 'most', problem_kind: null });
    expect(row.last_flattened_at).toBeGreaterThan(0);
    expect(actions()).toEqual(['spf_flatten.enable', 'dns.update']);
  });

  it('an include that is over the limit is the default: only as many includes as it takes are inlined, and the rest stay', async () => {
    const names = Array.from({ length: 12 }, (_, i) => `p${i}.test`);
    const doh = Object.fromEntries(names.map((n, i) => [n, [`v=spf1 ip4:192.0.2.${i + 1} -all`]]));
    const w = world({ original: `v=spf1 ${names.map(n => `include:${n}`).join(' ')} -all`, doh });
    const r = await enableSpf(w.tenant, w.domain, {}, w.deps);
    expect(r.ok).toBe(true);
    expect(w.row()!.inline_mode).toBe('fewest');
    expect(w.row()!.lookup_count).toBe(12);
    expect(w.row()!.lookups_after).toBeLessThanOrEqual(10);
    expect(w.live().match(/include:/g)!.length).toBeLessThan(12);
  });

  it('refuses plainly when an include cannot be read: nothing written, no row', async () => {
    const w = world({ doh: { 'other.test': [] } });
    delete w.cf.doh['other.test'];
    const r = await enableSpf(w.tenant, w.domain, { anyway: true }, w.deps);
    expect(r).toMatchObject({ ok: false, refused: { kind: 'include_unresolved' } });
    expect(w.patches()).toEqual([]);
    expect(w.row()).toBeUndefined();
    expect(w.live()).toBe(ORIGINAL);
  });

  it('twice: one row, one write', async () => {
    const w = world();
    const [a, b] = await Promise.all([enableSpf(w.tenant, w.domain, { anyway: true }, w.deps), enableSpf(w.tenant, w.domain, { anyway: true }, w.deps)]);
    expect([a.ok, b.ok].sort()).toEqual([false, true]);
    expect(w.patches()).toHaveLength(1);
    expect(w.db.sqlite.prepare('SELECT COUNT(*) AS n FROM spf_flatten_config').get().n).toBe(1);
  });

  it('a write that fails leaves no row behind and the record as it was (it used to leave an enabled row)', async () => {
    const w = world();
    const base = cloudflareTarget(w.tenant, 'acme.com');
    const failing: SpfTarget = { read: () => base.read(), write: async () => { throw new CfApiError('boom', 'PATCH', '/x', 500); } };
    const r = await enableSpf(w.tenant, w.domain, { anyway: true }, { ...w.deps, target: failing });
    expect(r).toMatchObject({ ok: false, refused: { kind: 'connection_lost' } });
    expect(w.row()).toBeUndefined();
    expect(w.live()).toBe(ORIGINAL);
  });

  it('Cloudflare unreachable: connection_lost and nothing stored', async () => {
    const w = world();
    w.cf.failWith = { status: 403, message: 'Authentication error' };
    const r = await enableSpf(w.tenant, w.domain, {}, w.deps);
    expect(r).toMatchObject({ ok: false, refused: { kind: 'connection_lost' } });
    expect(w.row()).toBeUndefined();
  });
});

describe('the refresh follows the providers (the atlas case; the old job re-read its own flat record and never changed it)', () => {
  it('a provider changes its addresses: the record changes, the previous one is kept, one audit row', async () => {
    const w = await on();
    const before = w.live();
    w.cf.doh['mail.test'] = ['v=spf1 ip4:198.51.100.0/28 ip4:192.0.2.50 ~all'];
    const r = await refreshSpf(w.tenant, w.row()!, w.deps);
    expect(r.outcome).toBe('changed');
    expect(w.live()).toBe('v=spf1 ip4:198.51.100.0/28 ip4:192.0.2.50 ip4:203.0.113.9 -all');
    expect(w.row()).toMatchObject({ previous_record: before, flattened_record: w.live(), canonical_record: ORIGINAL, problem_kind: null });
    expect(actions()).toEqual(['spf_flatten.update', 'dns.update']);
    expect(audits[0]).toMatchObject({ before_value: { spf_record: before }, after_value: { spf_record: w.live() } });
    expect(w.events.map(e => e.type)).toEqual(['spf.changed']);
  });

  it('nothing changed: no write, no audit row, no event, the check is recorded', async () => {
    const w = await on();
    const changedAt = w.row()!.last_flattened_at;
    w.cf.calls.length = 0;
    const r = await refreshSpf(w.tenant, w.row()!, w.deps);
    expect(r.outcome).toBe('unchanged');
    expect(w.patches()).toEqual([]);
    expect(audits).toEqual([]);
    expect(w.events).toEqual([]);
    expect(w.row()).toMatchObject({ last_flattened_at: changedAt, problem_kind: null });
    expect(w.row()!.last_refreshed_at).toBeGreaterThan(0);
  });

  it('the same addresses in another order are not a change', async () => {
    const w = await on();
    w.cf.doh['mail.test'] = ['v=spf1 ip4:198.51.100.0/28 ~all'];
    w.cf.doh['other.test'] = ['v=spf1 +ip4:203.0.113.9 -all'];
    expect((await refreshSpf(w.tenant, w.row()!, w.deps)).outcome).toBe('unchanged');
  });

  it('an include that stops resolving: the last good record stays, the problem is recorded once, recovery clears it', async () => {
    const w = await on();
    const good = w.live();
    delete w.cf.doh['other.test'];
    expect((await refreshSpf(w.tenant, w.row()!, w.deps)).outcome).toBe('problem');
    expect(w.live()).toBe(good);
    expect(w.patches()).toEqual([]);
    expect(w.row()).toMatchObject({ problem_kind: 'include_unresolved', flattened_record: good });
    expect(w.row()!.last_error).toMatch(/other\.test/);
    expect(w.row()!.problem_since).toBeGreaterThan(0);
    expect(actions()).toEqual(['spf_flatten.problem']);
    expect(w.events).toMatchObject([{ type: 'spf.problem', problem: 'include_unresolved', first: true }]);

    // the next day, same problem: no new audit row, not "first"
    expect((await refreshSpf(w.tenant, w.row()!, w.deps)).outcome).toBe('problem');
    expect(actions()).toEqual(['spf_flatten.problem']);
    expect(w.events.map(e => (e as any).first)).toEqual([true, false]);

    w.cf.doh['other.test'] = ['v=spf1 ip4:203.0.113.9 -all'];
    expect((await refreshSpf(w.tenant, w.row()!, w.deps)).outcome).toBe('unchanged');
    expect(w.row()).toMatchObject({ problem_kind: null, last_error: null });
    expect(w.events.at(-1)!.type).toBe('spf.recovered');
  });

  it('a macro that appears in an include is refused; nothing is written', async () => {
    const w = await on();
    w.cf.doh['other.test'] = ['v=spf1 include:%{d}.spf.test -all'];
    expect((await refreshSpf(w.tenant, w.row()!, w.deps)).outcome).toBe('problem');
    expect(w.row()!.problem_kind).toBe('macro');
    expect(w.patches()).toEqual([]);
  });

  it('a result that no longer fits both limits is refused with the record left as it is', async () => {
    const names = Array.from({ length: 12 }, (_, i) => `q${i}.test`);
    const doh = Object.fromEntries(names.map((n, i) => [n, [`v=spf1 ip4:192.0.2.${i + 1} -all`]]));
    const w = world({ original: `v=spf1 ${names.map(n => `include:${n}`).join(' ')} -all`, doh });
    await enableSpf(w.tenant, w.domain, {}, w.deps);
    audits.length = 0;
    const good = w.live();
    for (const n of names.slice(1)) w.cf.doh[n] = ['v=spf1 -ip4:1.1.1.1 ip4:1.1.1.0/24 -all']; // now they cannot be inlined: 11 lookups stay
    expect((await refreshSpf(w.tenant, w.row()!, w.deps)).outcome).toBe('problem');
    expect(w.row()!.problem_kind).toBe('too_large');
    expect(w.live()).toBe(good);
  });

  it('Cloudflare lost: connection_lost, the record is untouched', async () => {
    const w = await on();
    w.cf.failWith = { status: 403, message: 'Authentication error' };
    expect((await refreshSpf(w.tenant, w.row()!, w.deps)).outcome).toBe('problem');
    expect(w.row()).toMatchObject({ problem_kind: 'connection_lost' });
    expect(w.row()!.last_error).toMatch(/Authentication error/);
  });

  it('a hand edit outside the app is detected and not overwritten', async () => {
    const w = await on();
    w.setLive('v=spf1 include:someone-else.test -all');
    w.cf.doh['mail.test'] = ['v=spf1 ip4:192.0.2.50 ~all'];
    expect((await refreshSpf(w.tenant, w.row()!, w.deps)).outcome).toBe('problem');
    expect(w.live()).toBe('v=spf1 include:someone-else.test -all');
    expect(w.patches()).toEqual([]);
    expect(w.row()!.problem_kind).toBe('edited_outside');
  });

  it('Replace after an outside edit writes the fresh record (the owner asked), keeping the edit as the previous value', async () => {
    const w = await on();
    w.setLive('v=spf1 include:someone-else.test -all');
    await refreshSpf(w.tenant, w.row()!, w.deps);
    const r = await refreshSpf(w.tenant, w.row()!, { ...w.deps, manual: true, takeOver: true });
    expect(r.outcome).toBe('changed');
    expect(w.live()).toBe('v=spf1 ip4:198.51.100.0/28 ip4:203.0.113.9 -all');
    expect(w.row()).toMatchObject({ previous_record: 'v=spf1 include:someone-else.test -all', problem_kind: null });
  });

  it('a record deleted in Cloudflare is record_missing, and nothing is created', async () => {
    const w = await on();
    w.cf.records.set('zone-acme', []);
    expect((await refreshSpf(w.tenant, w.row()!, w.deps)).outcome).toBe('problem');
    expect(w.row()!.problem_kind).toBe('record_missing');
    expect(w.cf.calls.filter(c => c.method === 'POST')).toEqual([]);
  });

  it('two runs at once write once', async () => {
    const w = await on();
    w.cf.doh['mail.test'] = ['v=spf1 ip4:192.0.2.50 ~all'];
    const row = w.row()!;
    const [a, b] = await Promise.all([refreshSpf(w.tenant, row, w.deps), refreshSpf(w.tenant, row, w.deps)]);
    expect([a.outcome, b.outcome].sort()).toEqual(['changed', 'skipped']);
    expect(w.patches()).toHaveLength(1);
  });

  it('a refresh that is writing when flattening is turned off ends with the ORIGINAL back and no row', async () => {
    const w = await on();
    w.cf.doh['mail.test'] = ['v=spf1 ip4:192.0.2.50 ~all'];
    const base = cloudflareTarget(w.tenant, 'acme.com');
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    let reached!: () => void;
    const atWrite = new Promise<void>(r => { reached = r; });
    const slow: SpfTarget = { read: () => base.read(), write: async (id, c) => { reached(); await gate; return base.write(id, c); } };
    const running = refreshSpf(w.tenant, w.row()!, { ...w.deps, target: slow });
    await atWrite;
    const off = await disableSpf(w.tenant, w.domain, w.deps); // reads the old flat record, writes the original
    expect(off).toMatchObject({ ok: true, restored: true });
    release();
    expect((await running).outcome).toBe('skipped');
    expect(w.live()).toBe(ORIGINAL);
    expect(w.row()).toBeUndefined();
  });
});

describe('turning off', () => {
  it('puts the original back and removes the row', async () => {
    const w = await on();
    expect(await disableSpf(w.tenant, w.domain, w.deps)).toEqual({ ok: true, restored: true });
    expect(w.live()).toBe(ORIGINAL);
    expect(w.row()).toBeUndefined();
    expect(actions()).toContain('spf_flatten.disable');
  });

  it('never writes over a record that was changed outside: flattening just stops', async () => {
    const w = await on();
    w.setLive('v=spf1 include:someone-else.test -all');
    w.cf.calls.length = 0;
    expect(await disableSpf(w.tenant, w.domain, w.deps)).toEqual({ ok: true, restored: false, why: 'edited_outside' });
    expect(w.live()).toBe('v=spf1 include:someone-else.test -all');
    expect(w.patches()).toEqual([]);
    expect(w.row()).toBeUndefined();
  });

  it('a restore that Cloudflare refuses keeps the row and the original; trying again works; enabling meanwhile is refused (it used to lose the original)', async () => {
    const w = await on();
    const base = cloudflareTarget(w.tenant, 'acme.com');
    const refusing: SpfTarget = { read: () => base.read(), write: async () => { throw new CfApiError('no', 'PATCH', '/x', 500); } };
    const r = await disableSpf(w.tenant, w.domain, { ...w.deps, target: refusing });
    expect(r).toMatchObject({ ok: false, restoreFailed: expect.stringMatching(/original record back/), original: ORIGINAL });
    expect(w.row()).toMatchObject({ enabled: 0, canonical_record: ORIGINAL, problem_kind: 'restore_failed' });
    expect(w.live()).not.toBe(ORIGINAL);

    expect(await enableSpf(w.tenant, w.domain, {}, w.deps)).toEqual({ ok: false, conflict: 'finish_turning_off' });
    expect(w.row()!.canonical_record).toBe(ORIGINAL); // a flat record was never taken as the original

    expect(await disableSpf(w.tenant, w.domain, w.deps)).toMatchObject({ ok: true, restored: true });
    expect(w.live()).toBe(ORIGINAL);
    expect(w.row()).toBeUndefined();
  });

  it('turn off, then on again: the original is the restored record, never a flat one', async () => {
    const w = await on();
    await disableSpf(w.tenant, w.domain, w.deps);
    await enableSpf(w.tenant, w.domain, { anyway: true }, w.deps);
    expect(w.row()!.canonical_record).toBe(ORIGINAL);
  });

  it('a domain with nothing to turn off', async () => {
    expect(await disableSpf(world().tenant, { id: 1, domain: 'acme.com' })).toEqual({ ok: false, notConfigured: true });
  });
});

describe('one step back', () => {
  it('puts the previous flattened record back; there is nothing to roll back before a change', async () => {
    const w = await on();
    expect(await rollbackSpf(w.tenant, w.domain, w.deps)).toBe('nothing_to_roll_back');
    const first = w.live();
    w.cf.doh['mail.test'] = ['v=spf1 ip4:192.0.2.50 ~all'];
    await refreshSpf(w.tenant, w.row()!, w.deps);
    const second = w.live();
    expect(await rollbackSpf(w.tenant, w.domain, w.deps)).toBe('rolled_back');
    expect(w.live()).toBe(first);
    expect(w.row()).toMatchObject({ flattened_record: first, previous_record: second });
    expect(actions()).toContain('spf_flatten.rollback');
  });

  it('does not write over an outside edit', async () => {
    const w = await on();
    w.cf.doh['mail.test'] = ['v=spf1 ip4:192.0.2.50 ~all'];
    await refreshSpf(w.tenant, w.row()!, w.deps);
    w.setLive('v=spf1 -all');
    expect(await rollbackSpf(w.tenant, w.domain, w.deps)).toBe('edited_outside');
    expect(w.live()).toBe('v=spf1 -all');
  });
});

describe('the daily job', () => {
  it('refreshes due rows, oldest attempt first, within the budget; a row looked at within 20 hours is not due', async () => {
    const w = await on();
    w.db.sqlite.prepare("INSERT INTO domains (id, domain, rua_address) VALUES (2, 'b.acme.com', 'r@x'), (3, 'c.acme.com', 'r@x')").run();
    const row = (id: number, attempt: number | null) => w.db.sqlite.prepare("INSERT INTO spf_flatten_config (domain_id, enabled, canonical_record, cf_record_id, flattened_record, last_attempt_at) VALUES (?, 1, 'v=spf1 include:mail.test -all', 'x', 'v=spf1 ip4:1.1.1.1 -all', ?)").run(id, attempt);
    row(2, 100);
    row(3, null);
    const now = Math.floor(Date.now() / 1000);
    w.db.sqlite.prepare('UPDATE spf_flatten_config SET last_attempt_at = ? WHERE domain_id = 1').run(now - 60); // looked at a minute ago: not due
    const due = await w.tenant.scope.spf.due(now - SPF_DUE_AFTER_SECONDS, 10);
    expect(due.map(r => r.domain_id)).toEqual([3, 2]); // never attempted first, then the oldest; domain 1 is not due
    const budget = newSpfBudget();
    budget.domains = 1;
    const seen: number[] = [];
    await runSpfRefresh(w.tenant, undefined, budget, { ...w.deps, onEvent: undefined, resolver: undefined, target: undefined });
    for (const d of [2, 3]) seen.push((w.db.sqlite.prepare('SELECT last_attempt_at AS a FROM spf_flatten_config WHERE domain_id = ?').get(d) as any).a);
    expect(budget.domains).toBe(0);
    expect(seen[1]).toBeGreaterThan(1000); // domain 3 was visited
    expect(seen[0]).toBe(100); // domain 2 was not: the budget was one
  });

  it('does nothing for a workspace the add-on is not available to (hosted, setting off): the record stays, the row stays', async () => {
    const w = await on();
    w.db.sqlite.prepare('UPDATE spf_flatten_config SET last_attempt_at = NULL').run();
    const hosted = { ...w.tenant.env, MODE: 'saas' } as typeof w.tenant.env;
    Object.defineProperty(w.tenant, 'env', { value: hosted });
    w.cf.doh['mail.test'] = ['v=spf1 ip4:192.0.2.50 ~all'];
    await runSpfRefresh(w.tenant, undefined, newSpfBudget(), w.deps);
    expect(w.patches()).toEqual([]);
    expect(w.row()!.last_attempt_at).toBeNull();
  });
});
