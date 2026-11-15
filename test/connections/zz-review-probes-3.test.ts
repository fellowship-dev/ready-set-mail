import { describe, it, vi } from 'vitest';
import { world } from './world';
import { loadTenant } from '../../src/tenancy/load';
vi.mock('cloudflare:email', () => ({ EmailMessage: class {} }));
vi.mock('../../src/telemetry', () => ({ track: vi.fn() }));
const out = (l: string, v: unknown) => process.stdout.write(`PROBE ${l}: ${JSON.stringify(v)}\n`);
describe('atomic', () => {
  it('N9 freeing + failing insert rolls back the detach (capped and uncapped)', async () => {
    for (const max of [undefined, 5]) {
      const w = await world();
      const t = await loadTenant(w.env, { workspaceId: w.B.ws });
      let err = '';
      try { await t.scope.domains.insert({ domain: 'b-corp.org', rua_address: '', verified_via: 'txt' }, undefined, { maxDomains: max, freeing: 1 }); } catch (e: any) { err = String(e.message).slice(0, 80); }
      out(`N9 max=${max}`, { err, holder: w.rows('SELECT domain, evicted_at FROM domains WHERE id = 1') });
    }
  });
});
