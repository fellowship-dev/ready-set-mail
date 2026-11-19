// The daily job asks the one capability answer (src/hosted/plan-limits.ts capability) before it reads or writes anything for a workspace.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../src/audit/log', () => ({ logAudit: vi.fn() }));

import { capability } from '../../src/hosted/plan-limits';
import { enableSpf, newSpfBudget, runSpfRefresh } from '../../src/spf/refresh';
import { silence, world } from './world';

beforeEach(() => silence());
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

/** Flattening on, a provider changed, the row due: would the job write? `env` is what the instance runs with. */
async function due(env: Record<string, unknown>, team?: { email: string }) {
  const w = world();
  expect((await enableSpf(w.tenant, w.domain, { anyway: true }, w.deps)).ok).toBe(true);
  w.db.sqlite.prepare('UPDATE spf_flatten_config SET last_attempt_at = NULL').run();
  if (team) {
    w.db.sqlite.prepare("INSERT INTO users (id, email, name) VALUES ('u_op', ?, 'Operator')").run(team.email);
    w.db.sqlite.prepare("INSERT INTO memberships (workspace_id, user_id, role) VALUES ('ws_default', 'u_op', 'owner')").run();
  }
  Object.defineProperty(w.tenant, 'env', { value: { ...w.tenant.env, ...env } });
  w.cf.doh['mail.test'] = ['v=spf1 ip4:192.0.2.50 ip4:198.51.100.0/28 ~all']; // an addition: written at once when the job runs
  w.cf.calls.length = 0;
  await runSpfRefresh(w.tenant, undefined, newSpfBudget(), w.deps);
  return { w, wrote: w.patches().length > 0, calls: w.cf.calls.length };
}

describe('the daily job and the capability gate', () => {
  it('hosted, setting unset: no Cloudflare call at all, the row is left alone', async () => {
    const { w, calls } = await due({ MODE: 'saas' });
    expect(calls).toBe(0);
    expect(w.row()!.last_attempt_at).toBeNull();
  });
  it('hosted, a setting that is not understood: off as well', async () => {
    expect((await due({ MODE: 'saas', HOSTED_SPF_FLATTENING: 'yes please' })).calls).toBe(0);
  });
  it('hosted, a list of workspace ids: admits exactly the listed workspace, not another', async () => {
    expect((await due({ MODE: 'saas', HOSTED_SPF_FLATTENING: 'ws_000000000000000000000000000000aa' })).calls).toBe(0);
    const listed = await due({ MODE: 'saas', HOSTED_SPF_FLATTENING: 'ws_000000000000000000000000000000aa, ws_default' });
    expect(listed.wrote).toBe(true);
  });
  it('hosted, owner: the workspace owned by OWNER_EMAIL, and no other', async () => {
    expect((await due({ MODE: 'saas', HOSTED_SPF_FLATTENING: 'owner', OWNER_EMAIL: 'op@example.com' }, { email: 'op@example.com' })).wrote).toBe(true);
    expect((await due({ MODE: 'saas', HOSTED_SPF_FLATTENING: 'owner', OWNER_EMAIL: 'boss@example.com' }, { email: 'op@example.com' })).calls).toBe(0);
    expect((await due({ MODE: 'saas', HOSTED_SPF_FLATTENING: 'owner' }, { email: 'op@example.com' })).calls).toBe(0);
  });
  it('hosted, all', async () => {
    expect((await due({ MODE: 'saas', HOSTED_SPF_FLATTENING: 'all' })).wrote).toBe(true);
  });
  it('self-host: always allowed, whatever HOSTED_SPF_FLATTENING says', async () => {
    expect((await due({})).wrote).toBe(true);
    expect((await due({ MODE: 'selfhost', HOSTED_SPF_FLATTENING: 'ws_nobody' })).wrote).toBe(true);
  });
});

describe('capability()', () => {
  const env = (extra: Record<string, unknown>) => ({ DB: world().db as unknown as D1Database, ...extra }) as never;
  it('answers with a reason', async () => {
    expect(await capability(env({}), 'spf_flattening', { workspaceId: 'ws_x' })).toEqual({ allowed: true, reason: 'self_host' });
    expect(await capability(env({ MODE: 'saas' }), 'spf_flattening', { workspaceId: 'ws_x' })).toEqual({ allowed: false, reason: 'not_enabled' });
    expect(await capability(env({ MODE: 'saas', HOSTED_SPF_FLATTENING: 'all' }), 'spf_flattening', { workspaceId: 'ws_x', domainId: 3 })).toEqual({ allowed: true, reason: 'operator_setting' });
  });
});
