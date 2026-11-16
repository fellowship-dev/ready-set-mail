// A flattened record over 255 bytes is several quoted character strings in Cloudflare (RFC 1035; Cloudflare stores and returns them that way, the stand-in
// too: test/helpers/cf-fake.ts cloudflareTxtContent). Turn on, the daily check, the outside-edit check and turn off must all work on it.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../src/audit/log', () => ({ logAudit: vi.fn() }));

import { disableSpf, enableSpf, refreshSpf } from '../../src/spf/refresh';
import { ORIGINAL, silence, world } from './world';

beforeEach(() => silence());
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const bytes = (s: string) => new TextEncoder().encode(s).length;

/** An IPv4 address of exactly `len` characters (7 to 15) whose first octet starts with `lead`: addresses of different lengths and leads differ. */
function address(len: number, lead: string): string {
  const widths = [1, 1, 1, 1];
  for (let extra = len - 3 - 4, i = 3; extra > 0; extra--, i = (i + 3) % 4) widths[i]!++; // a length 3 octet is the widest
  const octet = (w: number, k: number) => (k === 0 ? (w === 1 ? lead : w === 2 ? `${lead}1` : `1${lead}1`) : '1'.repeat(w));
  return widths.map((w, k) => octet(w, k)).join('.');
}

/** A provider's record whose flattened form (`v=spf1 <addresses> -all`) is exactly `size` bytes. */
function providerOfSize(size: number): { record: string; flat: string } {
  const terms: string[] = [];
  const flatOf = () => `v=spf1 ${terms.join(' ')} -all`;
  for (let i = 0; size - bytes(flatOf()) > 40; i++) terms.push(`ip4:10.${1 + Math.floor(i / 250)}.${i % 250}.1`);
  // the gap is now 24 to 40 bytes: two more terms of 12 to 20 bytes each (the space included) fill it exactly
  const gap = size - bytes(flatOf());
  const first = Math.min(Math.max(Math.floor(gap / 2), 12), 20);
  terms.push(`ip4:${address(first - 1 - 4, '8')}`, `ip4:${address(gap - first - 1 - 4, '9')}`);
  const flat = flatOf();
  return { record: `v=spf1 ${terms.join(' ')} ~all`, flat };
}

for (const size of [300, 449]) {
  describe(`a flattened record of ${size} bytes`, () => {
    const p = providerOfSize(size);
    const original = 'v=spf1 include:big.test -all';
    const setup = () => world({ original, doh: { 'big.test': [p.record] } });

    it('has the size the test says (a precondition)', () => {
      expect(bytes(p.flat)).toBe(size);
    });

    it('turns on, is stored as quoted strings, refreshes unchanged with no write, shows no outside edit, and turns off restoring the original', async () => {
      const w = setup();
      const on = await enableSpf(w.tenant, w.domain, { anyway: true }, w.deps);
      expect(on.ok).toBe(true);
      // what Cloudflare holds: several quoted strings of at most 255 bytes, the record when joined
      const raw = w.liveRaw();
      expect(raw).toMatch(/^"[^"]+"( "[^"]+")+$/);
      expect(raw.slice(1, -1).split('" "').every(s => bytes(s) <= 255)).toBe(true);
      expect(w.live()).toBe(p.flat);
      expect(w.row()).toMatchObject({ enabled: 1, flattened_record: p.flat, problem_kind: null });

      // the daily check reads it back as the same record: no write, no problem, no "edited outside"
      w.cf.calls.length = 0;
      const r = await refreshSpf(w.tenant, w.row()!, w.deps);
      expect(r.outcome).toBe('unchanged');
      expect(w.patches()).toEqual([]);
      expect(w.row()!.problem_kind).toBeNull();

      // turning off puts the original back (Cloudflare stores it as one quoted string)
      const off = await disableSpf(w.tenant, w.domain, w.deps);
      expect(off).toMatchObject({ ok: true, restored: true });
      expect(w.live()).toBe(original);
      expect(w.row()).toBeUndefined();
    });

    it('an edit outside is still found on a record of several strings', async () => {
      const w = setup();
      await enableSpf(w.tenant, w.domain, { anyway: true }, w.deps);
      w.setLive(`${p.flat} `.replace(' -all ', ' ~all ').trim());
      const r = await refreshSpf(w.tenant, w.row()!, w.deps);
      expect(r.outcome).toBe('problem');
      expect(w.row()!.problem_kind).toBe('edited_outside');
    });
  });
}

it('an original record already over 255 bytes is read as one record and put back unchanged', async () => {
  const many = Array.from({ length: 22 }, (_, i) => `ip4:198.51.100.${i + 1}`).join(' ');
  const original = `v=spf1 include:mail.test ${many} -all`;
  expect(bytes(original)).toBeGreaterThan(255);
  const w = world({ original });
  expect(await enableSpf(w.tenant, w.domain, { anyway: true }, w.deps)).toMatchObject({ ok: true });
  expect(w.row()!.canonical_record).toBe(original);
  expect(await disableSpf(w.tenant, w.domain, w.deps)).toMatchObject({ ok: true, restored: true });
  expect(w.live()).toBe(original);
  expect(ORIGINAL).toBeTruthy();
});
