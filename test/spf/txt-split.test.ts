// Our split of long TXT content. The stand-in Cloudflare re-splits whatever it is sent (realisticTxt), so a test that reads the stored record cannot see a wrong split
// of ours: these tests read the `content` we SEND (the PATCH body) and check each quoted string against what Cloudflare accepts (RFC 1035: at most 255 bytes each).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { decodeTxtData } from '@ready-set-mail/dns-checks/txt';
import { SPF_FLAT_MAX_BYTES } from '@ready-set-mail/dns-checks';
import { enableSpf } from '../../src/spf/refresh';
import { cloudflareTarget } from '../../src/spf/target';
import { silence, world } from './world';

vi.mock('../../src/audit/log', () => ({ logAudit: vi.fn() }));
beforeEach(() => { silence(); });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const bytes = (s: string) => new TextEncoder().encode(s).length;

/** `n` distinct ip4 terms whose lengths, joined by single spaces, are exactly `total` bytes. */
function terms(total: number): string[] {
  const n = Math.ceil((total + 1) / 18); // a term is 12 to 18 bytes
  const sum = total - (n - 1);
  const base = Math.floor(sum / n);
  const extra = sum - base * n;
  const pool = new Map<number, string[]>();
  for (let a = 0; a < 256; a++) for (let b = 0; b < 256; b += 7) for (let c = 1; c < 256; c += 11) {
    const t = `ip4:10.${a}.${b}.${c}`;
    const list = pool.get(t.length) ?? [];
    if (list.length < n) { list.push(t); pool.set(t.length, list); }
  }
  const used = new Map<number, number>();
  return Array.from({ length: n }, (_, i) => {
    const len = base + (i < extra ? 1 : 0);
    const k = used.get(len) ?? 0;
    used.set(len, k + 1);
    return pool.get(len)![k]!;
  });
}
/** A record of exactly `size` bytes: the one a provider's addresses flatten to (`v=spf1 <terms> -all`). */
const recordOf = (size: number) => `v=spf1 ${terms(size - 'v=spf1  -all'.length).join(' ')} -all`;

/** The quoted strings of a sent `content`: nothing but `"…"` separated by one space. */
function strings(content: string): string[] {
  expect(content).toMatch(/^"[^"]*"( "[^"]*")*$/);
  return [...content.matchAll(/"([^"]*)"/g)].map(m => m[1]!);
}
function expectSplitOf(record: string, content: string) {
  const parts = strings(content);
  expect(parts.length).toBeGreaterThanOrEqual(Math.ceil(bytes(record) / 255)); // splitting after a space can need one more than the bytes alone
  for (const p of parts) expect(bytes(p)).toBeLessThanOrEqual(255);
  for (const p of parts.slice(0, -1)) expect(p.endsWith(' ')).toBe(true); // split after a space, never inside a term
  for (const p of parts.slice(1)) expect(p.startsWith(' ')).toBe(false);
  expect(parts.join('')).toBe(record); // joined, the strings are the record
  expect(content).toBe(parts.map(p => `"${p}"`).join(' ')); // one space between strings
  expect(decodeTxtData(content)).toBe(record);
}

describe('the content we send for a flattened record', () => {
  it.each([256, 300, 449])('turning on with a record of %i bytes: the PATCH body is split in strings of at most 255 bytes, after a space, one space between', async (size) => {
    const rec = recordOf(size);
    expect(bytes(rec)).toBe(size);
    const w = world({ original: 'v=spf1 include:big.test -all', doh: { 'big.test': [`${rec.replace(/ -all$/, ' ~all')}`] } });
    w.cf.calls.length = 0;
    const r = await enableSpf(w.tenant, w.domain, { anyway: true }, w.deps);
    expect(r.ok).toBe(true);
    const sent = w.cf.calls.filter(c => c.method === 'PATCH');
    expect(sent).toHaveLength(1);
    const content = sent[0]!.body.content as string;
    expect(w.live()).toBe(rec.replace(/ -all$/, ' -all')); // the record Cloudflare holds, read back
    expect(bytes(w.row()!.flattened_record!)).toBe(size);
    expectSplitOf(w.row()!.flattened_record!, content);
    expect(strings(content).length).toBe(2); // 256 to 449 bytes: two strings
    expect(content).toBe(sent[0]!.body.content);
  });

  it('a record within 255 bytes is one string', async () => {
    const rec = recordOf(200);
    const w = world({ original: 'v=spf1 include:big.test -all', doh: { 'big.test': [rec.replace(/ -all$/, ' ~all')] } });
    w.cf.calls.length = 0;
    expect((await enableSpf(w.tenant, w.domain, { anyway: true }, w.deps)).ok).toBe(true);
    expect(strings(w.cf.calls.find(c => c.method === 'PATCH')!.body.content)).toEqual([rec]);
  });

  it('510 bytes is over the 450 limit: SPF refuses a record that size and writes nothing; the encoder the SPF write uses splits one in three', async () => {
    // Three providers of about 260 bytes each with five nested includes: all inlined is over 450 bytes, one inlined and two kept is 12 lookups. Nothing fits, so nothing is written.
    const doh: Record<string, string[]> = {};
    for (const [i, p] of ['p1', 'p2', 'p3'].entries()) {
      const addrs = Array.from({ length: 12 }, (_, j) => `ip4:10.${i + 1}.${j}.${j + 100}`);
      const nested = Array.from({ length: 5 }, (_, j) => `include:n${j}.${p}.test`);
      doh[`${p}.test`] = [`v=spf1 ${addrs.join(' ')} ${nested.join(' ')} ~all`];
      nested.forEach((n, j) => { doh[`n${j}.${p}.test`] = [`v=spf1 ip4:172.${16 + i}.${j}.${j + 1} -all`]; });
    }
    const w = world({ original: 'v=spf1 include:p1.test include:p2.test include:p3.test -all', doh });
    w.cf.calls.length = 0;
    expect(await enableSpf(w.tenant, w.domain, { anyway: true }, w.deps)).toMatchObject({ ok: false, refused: { kind: 'too_large' } });
    expect(w.cf.calls.filter(c => c.method === 'PATCH')).toEqual([]);
    // the call site the SPF path uses (cloudflareTarget(...).write): what it sends for a record of 510 bytes
    const rec = recordOf(510);
    expect(bytes(rec)).toBe(510);
    expect(bytes(rec)).toBeGreaterThan(SPF_FLAT_MAX_BYTES);
    w.cf.calls.length = 0;
    await cloudflareTarget(w.tenant, 'acme.com').write('spf-acme', rec);
    const sent = w.cf.calls.filter(c => c.method === 'PATCH');
    expect(sent).toHaveLength(1);
    expectSplitOf(rec, sent[0]!.body.content);
    expect(strings(sent[0]!.body.content)).toHaveLength(3);
  });
});
