// A workspace with one domain in a fake Cloudflare zone and fake provider DNS, for the SPF flattening tests.
import { vi } from 'vitest';
import { createMigratedD1 } from '@ready-set-mail/db/testing';
import { decodeTxtData } from '@ready-set-mail/dns-checks/txt';
import { FakeCloudflare, cloudflareTxtContent, stubCloudflare } from '../helpers/cf-fake';
import { makeTenant } from '../helpers/tenant';
import type { SpfConfigRow } from '@ready-set-mail/db';
import type { SpfRefreshEvent } from '../../src/spf/events';

export const ORIGINAL = 'v=spf1 include:mail.test include:other.test -all';

export function world(opts: { original?: string; env?: Record<string, unknown>; doh?: Record<string, string[]> } = {}) {
  const db = createMigratedD1();
  db.sqlite.prepare("INSERT INTO domains (id, domain, rua_address) VALUES (1, 'acme.com', 'rua@reports.test.com')").run();
  const cf = new FakeCloudflare({ 'acme.com': { id: 'zone-acme', cfAccountId: 'cf' } });
  cf.realisticTxt = true; // stored the way Cloudflare does: quoted strings of at most 255 bytes
  cf.seed('zone-acme', { id: 'spf-acme', type: 'TXT', name: 'acme.com', content: opts.original ?? ORIGINAL });
  cf.doh['mail.test'] = ['v=spf1 ip4:198.51.100.0/28 ~all'];
  cf.doh['other.test'] = ['v=spf1 ip4:203.0.113.9 -all'];
  Object.assign(cf.doh, opts.doh ?? {});
  stubCloudflare(cf);
  const tenant = makeTenant({ db, cfToken: 'tok', settings: { zoneId: 'zone-acme', zoneName: 'acme.com' }, env: opts.env as never });
  const events: SpfRefreshEvent[] = [];
  const deps = { onEvent: (e: SpfRefreshEvent) => { events.push(e); }, actor: { id: 'u1', email: 'o@acme.com' } };
  const domain = { id: 1, domain: 'acme.com' };
  return {
    db, cf, tenant, events, deps, domain,
    /** The record as text (what a person reads in the dashboard); `liveRaw` is what Cloudflare returns: quoted character strings. */
    live: () => decodeTxtData(cf.records.get('zone-acme')![0]!.content),
    liveRaw: () => cf.records.get('zone-acme')![0]!.content,
    setLive: (content: string) => { cf.records.get('zone-acme')![0]!.content = cloudflareTxtContent(content); },
    row: () => db.sqlite.prepare('SELECT * FROM spf_flatten_config WHERE domain_id = 1').get() as SpfConfigRow | undefined,
    patches: () => cf.calls.filter(c => c.method === 'PATCH'),
  };
}

/** A record's mechanisms with the all stripped, for readable assertions. */
export const mechs = (record: string) => record.replace(/^v=spf1 /, '').split(' ');
export const silence = () => { vi.spyOn(console, 'log').mockImplementation(() => {}); vi.spyOn(console, 'warn').mockImplementation(() => {}); };
