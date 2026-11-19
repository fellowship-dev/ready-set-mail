import { beforeEach, describe, expect, it } from 'vitest';
import { forWorkspace, IMPLICIT_WORKSPACE_ID } from '../../packages/db/src';
import { createMigratedD1, type TestD1 } from '../../packages/db/src/testing';

const A = IMPLICIT_WORKSPACE_ID;
const B = 'ws_b';
let d1: TestD1;
let a: ReturnType<typeof forWorkspace>;
let b: ReturnType<typeof forWorkspace>;
let id: number;
let otherId: number;
const rows = () => d1.sqlite.prepare('SELECT domain_id, records_live_at, live_seen_by, policy_seen, policy_seen_at FROM domain_milestones ORDER BY domain_id').all();

beforeEach(async () => {
	d1 = createMigratedD1();
	d1.sqlite.exec(`INSERT INTO workspaces (id, name) VALUES ('${B}', 'Other')`);
	a = forWorkspace(d1, A);
	b = forWorkspace(d1, B);
	id = Number((await a.domains.insert({ domain: 'acme.com', rua_address: 'x@r.test' })).meta.last_row_id);
	otherId = Number((await b.domains.insert({ domain: 'other.com', rua_address: 'x@r.test' })).meta.last_row_id);
});

describe('lifecycle milestones', () => {
	it('recordLive fills a row that exists for its policy columns, once', async () => {
		const m = a.lifecycleEmail.milestones;
		expect(await m.observePolicy(id, 'none', 100)).toBe(true);
		expect(await m.recordLive(id, 'job', 200)).toBe(true);
		expect(await m.recordLive(id, 'app', 300)).toBe(false);
		expect(rows()).toEqual([{ domain_id: id, records_live_at: 200, live_seen_by: 'job', policy_seen: 'none', policy_seen_at: 100 }]);
		expect(await m.list()).toEqual(rows().map((r) => ({ ...r, dns_read_at: null })));
	});

	it('recordLive on a new row writes it once and leaves the policy columns empty', async () => {
		const m = a.lifecycleEmail.milestones;
		expect(await m.recordLive(id, 'app', 200)).toBe(true);
		expect(await m.recordLive(id, 'job', 300)).toBe(false);
		expect(rows()).toEqual([{ domain_id: id, records_live_at: 200, live_seen_by: 'app', policy_seen: null, policy_seen_at: null }]);
	});

	it('observePolicy writes only when new or changed, and keeps the live fact', async () => {
		const m = a.lifecycleEmail.milestones;
		expect(await m.recordLive(id, 'job', 200)).toBe(true);
		expect(await m.observePolicy(id, 'none', 300)).toBe(true);
		expect(await m.observePolicy(id, 'none', 400)).toBe(false);
		expect(await m.observePolicy(id, 'quarantine', 500)).toBe(true);
		expect(rows()).toEqual([{ domain_id: id, records_live_at: 200, live_seen_by: 'job', policy_seen: 'quarantine', policy_seen_at: 500 }]);
	});

	it("another workspace's domain writes nothing", async () => {
		const m = a.lifecycleEmail.milestones;
		expect(await m.recordLive(otherId, 'job', 200)).toBe(false);
		expect(await m.observePolicy(otherId, 'none', 200)).toBe(false);
		expect(rows()).toEqual([]);
	});
});
