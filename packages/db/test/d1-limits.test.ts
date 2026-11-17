import { describe, it, expect } from 'vitest';
import { D1_MAX_BOUND_PARAMETERS } from '../src/testing/d1-sqlite';
import { inChunks, IN_LIST_MAX } from '../src/queries/in-list';
import { accessLookups } from '../src/queries/access-grants';
import { freshDb } from './helpers';

/** D1 refuses a statement that binds more than 100 values ("D1_ERROR: too many SQL variables"). The test database refuses the same, so no test passes what production rejects. */
describe('the test database binds at most as many values as D1', () => {
	const marks = (n: number) => Array.from({ length: n }, () => '?').join(', ');
	it('allows 100 and refuses 101, for every way a statement is run', async () => {
		const d = freshDb();
		const sql = (n: number) => `SELECT ${marks(n)}`;
		const hundred = Array.from({ length: D1_MAX_BOUND_PARAMETERS }, (_, i) => i);
		await expect(d.prepare(sql(100)).bind(...hundred).all()).resolves.toBeTruthy();
		for (const run of ['run', 'all', 'first', 'raw'] as const) {
			await expect((d.prepare(sql(101)).bind(...hundred, 1) as unknown as Record<string, () => Promise<unknown>>)[run]!()).rejects.toThrow(/too many SQL variables/);
		}
		await expect(d.batch([d.prepare(sql(101)).bind(...hundred, 1)])).rejects.toThrow(/too many SQL variables/);
	});

	it('is what makes a list in IN (...) of 100 or more ids fail, and what the pieces of IN_LIST_MAX avoid', async () => {
		const d = freshDb();
		const ids = Array.from({ length: 250 }, (_, i) => `app${i}`);
		expect(IN_LIST_MAX).toBeLessThanOrEqual(90);
		expect(inChunks(ids).map((c) => c.length)).toEqual([90, 90, 70]);
		const found = await accessLookups(d as unknown as D1Database).connectedClientIds('mcp_connection:', ids);
		expect(found.size).toBe(0);
		await expect(d.prepare(`SELECT 1 WHERE 'x' IN (${marks(101)})`).bind(...ids, 'a').all()).rejects.toThrow(/too many SQL variables/);
	});
});
