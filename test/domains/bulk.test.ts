import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/dns/provision', () => ({
  provisionDomain: vi.fn().mockResolvedValue({ recordId: 'dns-rec-1', recordName: 'test.com._report._dmarc.reports.readysetmail.com', manual: false }),
}));

vi.mock('../../src/audit/log', () => ({
  logAudit: vi.fn(),
}));

// The first DNS check of imported domains never leaves the test process: the default resolver answers NXDOMAIN for every
// name (the tests of that check pass their own resolver).
vi.mock('@ready-set-mail/dns-checks', async (importOriginal) => {
  const { fakeResolver } = await import('../../packages/dns-checks/test/helpers');
  return { ...(await importOriginal<typeof import('@ready-set-mail/dns-checks')>()), createResolver: () => fakeResolver({}) };
});

import { createMigratedD1 } from '@ready-set-mail/db/testing';
import { makeTenant } from '../helpers/tenant';
import { parseDomainList, validateDomain, bulkInsertDomains } from '../../src/domains/bulk';
import { fakeResolver, type Zone } from '../../packages/dns-checks/test/helpers';

// ── parseDomainList ───────────────────────────────────────────

describe('parseDomainList', () => {
  it('splits by newlines', () => {
    expect(parseDomainList('acme.com\nexample.com')).toEqual(['acme.com', 'example.com']);
  });

  it('splits by commas', () => {
    expect(parseDomainList('acme.com,example.com')).toEqual(['acme.com', 'example.com']);
  });

  it('splits by mixed delimiters', () => {
    expect(parseDomainList('acme.com, example.com\nfoo.io')).toEqual(['acme.com', 'example.com', 'foo.io']);
  });

  it('lowercases entries', () => {
    expect(parseDomainList('ACME.COM\nFOO.IO')).toEqual(['acme.com', 'foo.io']);
  });

  it('deduplicates entries', () => {
    expect(parseDomainList('acme.com\nacme.com\nacme.com')).toEqual(['acme.com']);
  });

  it('trims whitespace', () => {
    expect(parseDomainList('  acme.com  \n  foo.io  ')).toEqual(['acme.com', 'foo.io']);
  });

  it('ignores empty lines', () => {
    expect(parseDomainList('\n\nacme.com\n\n')).toEqual(['acme.com']);
  });
});

// ── validateDomain ───────────────────────────────────────────

describe('validateDomain', () => {
  it('accepts a valid domain', () => {
    expect(validateDomain('example.com')).toBe(true);
  });

  it('accepts a subdomain', () => {
    expect(validateDomain('mail.example.com')).toBe(true);
  });

  it('accepts a domain with hyphens', () => {
    expect(validateDomain('my-domain.co.uk')).toBe(true);
  });

  it('rejects a domain with spaces', () => {
    expect(validateDomain('my domain.com')).toBe(false);
  });

  it('rejects a bare label with no TLD', () => {
    expect(validateDomain('localhost')).toBe(false);
  });

  it('rejects an empty string', () => {
    expect(validateDomain('')).toBe(false);
  });

  it('rejects a single-char TLD', () => {
    expect(validateDomain('example.c')).toBe(false);
  });
});

// ── bulkInsertDomains ─────────────────────────────────────────

function makeDb() {
  const db = createMigratedD1();
  const domainRows = () => db.sqlite.prepare('SELECT * FROM domains ORDER BY id').all() as Record<string, any>[];
  return Object.assign(db as unknown as D1Database, { domainRows });
}

function seedDomain(db: D1Database, domain: string) {
  (db as any).sqlite
    .prepare("INSERT INTO domains (domain, rua_address) VALUES (?, 'rua@reports.readysetmail.com')")
    .run(domain);
}

describe('bulkInsertDomains', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns imported status for a new valid domain', async () => {
    const db = makeDb(); // empty = not duplicate
    const results = await bulkInsertDomains(makeTenant({ db, settings: { reportsDomain: 'reports.readysetmail.com' }, cfToken: 'tok' }), ['acme.com']);
    expect(results).toHaveLength(1);
    expect(results[0].status).toBe('imported');
    expect(results[0].domain).toBe('acme.com');
    const rows = db.domainRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ domain: 'acme.com', rua_address: 'rua@reports.readysetmail.com', dns_record_id: 'dns-rec-1' });
  });

  it('uses the configured reports domain for the rua address', async () => {
    const db = makeDb();
    await bulkInsertDomains(makeTenant({ db, settings: { reportsDomain: 'reports.example.org' }, cfToken: 'tok' }), ['acme.com']);
    expect(db.domainRows()[0]).toMatchObject({ domain: 'acme.com', rua_address: 'rua@reports.example.org' });
  });

  it('fails with an error naming the reports domain when none is configured, and inserts nothing', async () => {
    const db = makeDb();
    await expect(bulkInsertDomains(makeTenant({ db, settings: { reportsDomain: undefined } }), ['acme.com']))
      .rejects.toThrow(/reports domain not configured/i);
    expect(db.domainRows()).toHaveLength(0);
  });

  it('returns duplicate status when domain already exists', async () => {
    const db = makeDb();
    seedDomain(db, 'acme.com'); // existing row
    const results = await bulkInsertDomains(makeTenant({ db, settings: { reportsDomain: 'reports.readysetmail.com' } }), ['acme.com']);
    expect(results[0].status).toBe('duplicate');
    expect(db.domainRows()).toHaveLength(1);
  });

  it('returns invalid status for a malformed domain', async () => {
    const db = makeDb();
    const results = await bulkInsertDomains(makeTenant({ db, settings: { reportsDomain: 'reports.readysetmail.com' } }), ['not a domain']);
    expect(results[0].status).toBe('invalid');
    expect(db.domainRows()).toHaveLength(0);
  });

  it('processes a mixed list and returns per-row status', async () => {
    const db = makeDb();
    seedDomain(db, 'dupe.com');

    const results = await bulkInsertDomains(makeTenant({ db, settings: { reportsDomain: 'reports.readysetmail.com' }, cfToken: 'tok' }), ['acme.com', 'not-valid!', 'dupe.com']);
    expect(results.find(r => r.domain === 'acme.com')?.status).toBe('imported');
    expect(results.find(r => r.domain === 'not-valid!')?.status).toBe('invalid');
    expect(results.find(r => r.domain === 'dupe.com')?.status).toBe('duplicate');
    expect(db.domainRows().map(r => r.domain).sort()).toEqual(['acme.com', 'dupe.com']);
  });

  it('caps batch at 50 entries', async () => {
    const db = makeDb();
    const domains = Array.from({ length: 60 }, (_, i) => `domain${i}.com`);
    const results = await bulkInsertDomains(makeTenant({ db, settings: { reportsDomain: 'reports.readysetmail.com' } }), domains);
    expect(results).toHaveLength(50);
    expect(db.domainRows()).toHaveLength(50);
  });

  it('returns imported with manual_dns=true when provisioning falls back to manual mode', async () => {
    const { provisionDomain } = await import('../../src/dns/provision');
    vi.mocked(provisionDomain).mockResolvedValueOnce({ recordId: null, recordName: 'acme.com._report._dmarc.reports.readysetmail.com', manual: true });
    const db = makeDb();
    const results = await bulkInsertDomains(makeTenant({ db, settings: { reportsDomain: 'reports.readysetmail.com' } }), ['acme.com']);
    expect(results[0].status).toBe('imported');
    expect(results[0].manual_dns).toBe(true);
    expect(db.domainRows()[0].dns_record_id).toBeNull();
  });
});

// ── first DNS check of imported domains ─────────────────────

describe('bulkInsertDomains: the first DNS read of each imported domain', () => {
  const zone = (names: string[]): Zone => Object.fromEntries(names.flatMap((d) => [[`TXT ${d}`, ['v=spf1 -all']], [`TXT _dmarc.${d}`, ['v=DMARC1; p=reject']]]));
  const stored = (db: ReturnType<typeof createMigratedD1>) => db.sqlite.prepare('SELECT domain, dns_checked_at, dmarc_policy, spf_record FROM domains ORDER BY domain').all() as { domain: string; dns_checked_at: number | null; dmarc_policy: string | null; spf_record: string | null }[];

  it('stores a level for every imported domain, as the single add does, and says so per row', async () => {
    const names = ['a-bulk.com', 'b-bulk.com', 'c-bulk.com'];
    const db = createMigratedD1();
    const results = await bulkInsertDomains(makeTenant({ db }), names, {}, { resolver: fakeResolver(zone(names)) });
    expect(results.map((r) => [r.domain, r.status, r.dns_checked])).toEqual(names.map((d) => [d, 'imported', true]));
    for (const row of stored(db)) {
      expect(row.dns_checked_at, row.domain).not.toBeNull();
      expect(row).toMatchObject({ dmarc_policy: 'reject', spf_record: 'v=spf1 -all' });
    }
  });

  it('over the lookup budget: checks what fits and marks the rest not checked yet, storing nothing for them', async () => {
    const names = ['a-bulk.com', 'b-bulk.com', 'c-bulk.com', 'd-bulk.com'];
    const db = createMigratedD1();
    const calls: string[] = [];
    // Room for one worst-case check at a time: the first domain is read, the rest are not started.
    const results = await bulkInsertDomains(makeTenant({ db }), names, {}, { resolver: fakeResolver(zone(names), calls), lookupBudget: 14 });
    const checked = results.filter((r) => r.dns_checked);
    const unchecked = results.filter((r) => r.dns_checked === false);
    expect(checked.length).toBeGreaterThanOrEqual(1);
    expect(unchecked.length).toBeGreaterThanOrEqual(1);
    expect(checked.length + unchecked.length).toBe(4);
    expect(calls.length).toBeLessThanOrEqual(14);
    const rows = stored(db);
    for (const r of results) expect(rows.find((x) => x.domain === r.domain)!.dns_checked_at !== null, r.domain).toBe(r.dns_checked);
  });

  it('a domain whose DNS read fails is reported as not checked, never as checked', async () => {
    const db = createMigratedD1();
    const results = await bulkInsertDomains(makeTenant({ db }), ['broken-bulk.com'], {}, { resolver: fakeResolver({ 'TXT broken-bulk.com': 'SERVFAIL', 'TXT _dmarc.broken-bulk.com': 'SERVFAIL' }) });
    expect(results).toMatchObject([{ status: 'imported', dns_checked: false }]);
    expect(stored(db)[0].dns_checked_at).toBeNull();
  });
});
