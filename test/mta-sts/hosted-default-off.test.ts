// The hosted default is MTA-STS off: with POLICY_HOST_ZONE, POLICY_HOST_TARGET and POLICY_HOST_TOKEN not all set, nothing is offered, written, reconciled or served.
// (test/mta-sts/lifecycle.test.ts has the page and the refused enable; web/test/mta-sts.test.tsx the "Not available" page and card.)
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { resetSchemaReadyCache } from '@ready-set-mail/db';
import worker from '../../src/index';
import { refreshMtaStsHosted } from '../../src/mta-sts/refresh';
import { mtaWorld, quietLogs, OP_ZONE } from './world';

vi.mock('cloudflare:email', () => ({ EmailMessage: class { constructor(public from: string, public to: string, public raw: string) {} } }));
const ctx = { waitUntil: vi.fn() } as unknown as ExecutionContext;
beforeEach(() => { quietLogs(); resetSchemaReadyCache(); });
afterEach(() => { vi.restoreAllMocks(); });

const UNSET = [
  { POLICY_HOST_ZONE: undefined, POLICY_HOST_TARGET: undefined, POLICY_HOST_TOKEN: undefined },
  { POLICY_HOST_TOKEN: undefined },
  { POLICY_HOST_TARGET: undefined },
  { POLICY_HOST_ZONE: undefined },
];

describe.each(UNSET)('hosted with the policy host settings not all set (%j)', (unset) => {
  it('the instance reconcile and the daily job do nothing, and a policy host answers 404', async () => {
    const w = await mtaWorld(unset);
    const r = await w.api(w.A.token, 'POST', '/api/instance/mta-sts/reconcile');
    expect(await r.json()).toMatchObject({ ok: true, visited: 0, changed: 0, errors: 0, removed: 0, served: 0, not_served: 0 });
    expect(await refreshMtaStsHosted(w.env)).toEqual({ visited: 0, changed: 0, errors: 0, removed: 0, served: 0, notServed: 0 });
    expect(w.writes(OP_ZONE)).toEqual([]);
    const res = await worker.fetch(new Request('https://mta-sts.a-corp.com/.well-known/mta-sts.txt'), w.env as never, ctx);
    expect(res.status).toBe(404);
  });
});
