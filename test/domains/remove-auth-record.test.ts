import { describe, it, expect, vi } from 'vitest';

vi.mock('../../src/audit/log', () => ({ logAudit: vi.fn() }));
import { logAudit } from '../../src/audit/log';
import { removeAuthRecord } from '../../src/domains/remove';
import { makeTenant } from '../helpers/tenant';
import { FakeCloudflare } from '../helpers/cf-fake';

const ZONE = 'a'.repeat(32);
const NAME = 'other-org.net._report._dmarc.reports.a-corp.com';

function setup(stored: { type: string; name: string; content: string }) {
  const fake = new FakeCloudflare({ 'a-corp.com': { id: ZONE } });
  const rec = fake.seed(ZONE, stored);
  const tenant = makeTenant({ cfToken: 'tok', fetch: fake.fetch as unknown as typeof fetch, settings: { reportsDomain: 'reports.a-corp.com', zoneId: ZONE, zoneName: 'a-corp.com' } });
  return { fake, tenant, domain: { id: 1, domain: 'other-org.net', dns_record_id: rec.id } as any };
}

describe('removeAuthRecord', () => {
  it('deletes the authorisation record and audits the removal', async () => {
    vi.mocked(logAudit).mockClear();
    const { fake, tenant, domain } = setup({ type: 'TXT', name: NAME, content: 'v=DMARC1;' });
    await removeAuthRecord(tenant, domain);
    expect(fake.records.get(ZONE)).toEqual([]);
    expect(logAudit).toHaveBeenCalledTimes(1);
  });

  it('refuses to delete another record stored under that id: nothing is deleted, nothing is audited', async () => {
    vi.mocked(logAudit).mockClear();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { fake, tenant, domain } = setup({ type: 'TXT', name: NAME, content: 'v=spf1 -all' });
    await removeAuthRecord(tenant, domain);
    expect(fake.records.get(ZONE)).toHaveLength(1);
    expect(logAudit).not.toHaveBeenCalled();
  });
});
