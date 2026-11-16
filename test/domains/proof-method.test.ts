// The kind of proof as a category, read through src/domains/ownership.ts so no other module names the proof column.
import { describe, expect, it } from 'vitest';
import { proofMethodOf, proofMethodOfVia, proofPathOf } from '../../src/domains/ownership';

describe('proof method and path', () => {
  it('maps an admission and a stored row to the same method', () => {
    for (const [via, method] of [['cloudflare', 'cloudflare_zone'], ['txt', 'txt'], ['parent', 'parent'], ['selfhost', 'selfhost'], ['existing', 'other'], ['legacy', 'other'], ['', 'other']] as const) {
      expect(proofMethodOfVia(via), via).toBe(method);
      expect(proofMethodOf({ verified_via: via }), via).toBe(method);
    }
    expect(proofMethodOfVia(undefined)).toBe('other');
    expect(proofMethodOfVia(null)).toBe('other');
  });

  it('the path is cloudflare only for a zone proof, manual for everything else', () => {
    expect(proofPathOf('cloudflare_zone')).toBe('cloudflare');
    for (const m of ['txt', 'parent', 'selfhost', 'other'] as const) expect(proofPathOf(m), m).toBe('manual');
  });
});
