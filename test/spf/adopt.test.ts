// The record in Cloudflare was edited outside the app. Two ways out: use the edit as the new original (adopt), or discard it (Replace).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const audits: Array<{ action: string; before_value?: any; after_value?: any; meta?: any }> = [];
vi.mock('../../src/audit/log', () => ({ logAudit: vi.fn((_t: unknown, e: any) => { audits.push(e); }) }));

import { adoptSpf, enableSpf, refreshSpf, spfView } from '../../src/spf/refresh';
import { ORIGINAL, silence, world } from './world';

beforeEach(() => { audits.length = 0; silence(); });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const FLAT = 'v=spf1 ip4:198.51.100.0/28 ip4:203.0.113.9 -all';
const EDITED = 'v=spf1 ip4:198.51.100.0/28 ip4:203.0.113.9 include:newprovider.example -all';

async function edited() {
  const w = world({ doh: { 'newprovider.example': ['v=spf1 ip4:192.0.2.77 ~all'] } });
  expect((await enableSpf(w.tenant, w.domain, { anyway: true }, w.deps)).ok).toBe(true);
  w.setLive(EDITED);
  const first = await refreshSpf(w.tenant, w.row()!, w.deps);
  expect(first.outcome).toBe('problem');
  expect(w.row()!.problem_kind).toBe('edited_outside');
  audits.length = 0;
  w.cf.calls.length = 0;
  return w;
}

describe('use my edit as the new original', () => {
  it('the edited record becomes the original and is flattened from, so the include the edit added is kept', async () => {
    const w = await edited();
    const r = await adoptSpf(w.tenant, w.domain, w.deps);
    expect(r).toMatchObject({ ok: true, outcome: 'written' });
    expect(w.row()).toMatchObject({ canonical_record: EDITED, problem_kind: null, previous_record: EDITED, enabled: 1 });
    expect(w.live()).toBe('v=spf1 ip4:198.51.100.0/28 ip4:203.0.113.9 ip4:192.0.2.77 -all'); // the new provider's address is there
    expect(spfView(w.row()!)).toMatchObject({ original_record: EDITED, problem: null, pending: null });
    const a = audits.find(x => x.action === 'spf_flatten.adopt')!;
    expect(a.before_value).toMatchObject({ original_record: ORIGINAL, flattened_record: FLAT });
    expect(a.after_value).toMatchObject({ original_record: EDITED });
    // and the daily check goes on from the new original: the new provider's change arrives
    w.cf.doh['newprovider.example'] = ['v=spf1 ip4:192.0.2.78 ~all'];
    w.db.sqlite.prepare('UPDATE spf_flatten_config SET last_attempt_at = NULL').run();
    await refreshSpf(w.tenant, w.row()!, w.deps);
    expect(w.live()).toContain('ip4:192.0.2.78');
  });

  it('nothing is written when the edit is already what flattening would write', async () => {
    const w = world();
    expect((await enableSpf(w.tenant, w.domain, { anyway: true }, w.deps)).ok).toBe(true);
    w.setLive('v=spf1 ip4:198.51.100.0/28 ip4:203.0.113.9 ip4:192.0.2.1 -all');
    await refreshSpf(w.tenant, w.row()!, w.deps);
    w.cf.calls.length = 0;
    expect(await adoptSpf(w.tenant, w.domain, w.deps)).toMatchObject({ ok: true, outcome: 'unchanged' });
    expect(w.patches()).toEqual([]);
    expect(w.row()!.canonical_record).toBe('v=spf1 ip4:198.51.100.0/28 ip4:203.0.113.9 ip4:192.0.2.1 -all');
  });

  it('an edit that cannot be flattened writes nothing and changes nothing', async () => {
    const w = await edited();
    w.setLive('v=spf1 include:nowhere.example -all');
    const r = await adoptSpf(w.tenant, w.domain, w.deps);
    expect(r).toMatchObject({ ok: false, refused: { kind: 'include_unresolved' } });
    expect(w.patches()).toEqual([]);
    expect(w.row()).toMatchObject({ canonical_record: ORIGINAL, problem_kind: 'edited_outside' });
    expect(audits.map(a => a.action)).toEqual([]);
  });

  it('only for a domain that has flattening on', async () => {
    const w = world();
    expect(await adoptSpf(w.tenant, w.domain, w.deps)).toEqual({ ok: false, conflict: 'not_on' });
  });
});

describe('discard my edit', () => {
  it('writes the flattened record, drops what the edit added, and the audit entry keeps the dropped record', async () => {
    const w = await edited();
    const r = await refreshSpf(w.tenant, w.row()!, { ...w.deps, takeOver: true });
    expect(r.outcome).toBe('changed');
    expect(w.live()).toBe(FLAT);
    expect(w.live()).not.toContain('newprovider');
    expect(w.row()).toMatchObject({ canonical_record: ORIGINAL, previous_record: EDITED });
    const u = audits.find(x => x.action === 'spf_flatten.update')!;
    expect(u.before_value).toEqual({ spf_record: EDITED });
    expect(u.meta).toMatchObject({ by: 'replace' });
  });
});
