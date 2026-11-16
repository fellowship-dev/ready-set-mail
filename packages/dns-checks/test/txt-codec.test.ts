import { describe, it, expect } from 'vitest';
import { decodeTxtData, encodeTxtData, TXT_STRING_MAX_BYTES } from '../src/txt';

const bytes = (s: string) => new TextEncoder().encode(s).length;
/** The character-strings of a quoted presentation form, unescaped. */
const strings = (q: string) => [...q.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map(m => m[1]!.replace(/\\(.)/g, '$1'));

describe('encodeTxtData / decodeTxtData', () => {
  it('quotes a short record as one string', () => {
    expect(encodeTxtData('v=spf1 ip4:1.2.3.4 -all')).toBe('"v=spf1 ip4:1.2.3.4 -all"');
    expect(decodeTxtData('"v=spf1 ip4:1.2.3.4 -all"')).toBe('v=spf1 ip4:1.2.3.4 -all');
  });
  it('splits after a space into strings of at most 255 bytes, and the decoder joins them back', () => {
    for (const n of [20, 30, 31, 32, 60, 120]) {
      const record = `v=spf1 ${Array.from({ length: n }, (_, i) => `ip4:10.${i % 250}.${(i * 7) % 250}.0/24`).join(' ')} -all`;
      const q = encodeTxtData(record);
      const parts = strings(q);
      expect(parts.every(p => bytes(p) <= TXT_STRING_MAX_BYTES)).toBe(true);
      expect(parts.length).toBeGreaterThanOrEqual(Math.ceil(bytes(record) / TXT_STRING_MAX_BYTES));
      expect(parts.join('')).toBe(record);
      expect(decodeTxtData(q)).toBe(record);
      // every string but the last ends at a term boundary
      for (const p of parts.slice(0, -1)) expect(p.endsWith(' ')).toBe(true);
    }
  });
  it('a 300-byte and a 449-byte record are two strings', () => {
    for (const size of [300, 449]) {
      let r = 'v=spf1';
      for (let i = 0; bytes(r) < size - 20; i++) r += ` ip4:192.0.${i % 250}.${i % 200}`;
      r += ' ' + 'x'.repeat(size - bytes(r) - 1);
      expect(bytes(r)).toBe(size);
      const q = encodeTxtData(r);
      expect(strings(q)).toHaveLength(2);
      expect(decodeTxtData(q)).toBe(r);
    }
  });
  it('cuts a word longer than a string by bytes and never inside a multi-byte character', () => {
    const word = 'é'.repeat(300); // 600 bytes
    const q = encodeTxtData(word);
    for (const p of strings(q)) { expect(bytes(p)).toBeLessThanOrEqual(255); expect(p).not.toContain('�'); }
    expect(decodeTxtData(q)).toBe(word);
    const mixed = `a ${'€'.repeat(100)} b`; // 3-byte characters straddle the 255 boundary
    expect(decodeTxtData(encodeTxtData(mixed))).toBe(mixed);
    for (const p of strings(encodeTxtData(mixed))) expect(bytes(p)).toBeLessThanOrEqual(255);
  });
  it('escapes quotes and backslashes the way the decoder reads them', () => {
    const t = 'n="note" back\\slash';
    expect(decodeTxtData(encodeTxtData(t))).toBe(t);
  });
  it('an empty text is one empty string', () => {
    expect(encodeTxtData('')).toBe('""');
  });
  it('decodes what Cloudflare returns for a long record: several quoted strings', () => {
    expect(decodeTxtData('"v=spf1 ip4:1.1.1.1 ip4:2.2.2.2 " "ip4:3.3.3.3 -all"')).toBe('v=spf1 ip4:1.1.1.1 ip4:2.2.2.2 ip4:3.3.3.3 -all');
  });
});
