import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchDnsState } from '../src/lib/cloudflare';

afterEach(() => vi.unstubAllGlobals());

/** A server that, like the real one, reads at most 10 names of what it is given. */
function server(calls: string[][]) {
	vi.stubGlobal('fetch', async (url: string) => {
		const names = decodeURIComponent(new URL(url, 'http://x').searchParams.get('names') ?? '').split(',');
		calls.push(names);
		const read = names.slice(0, 10);
		const body = { states: read.map((name) => ({ name, resolves: true, spf: 'found', dmarc: { state: 'missing' }, mx: null })), ...(names.length > 10 ? { capped: true, remaining: names.slice(10) } : {}) };
		return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
	});
}

describe('fetchDnsState', () => {
	it('asks in batches of 10 and returns every name in order', async () => {
		const calls: string[][] = [];
		server(calls);
		const names = Array.from({ length: 25 }, (_, i) => `d${i}.example.com`);
		const states = await fetchDnsState(names);
		expect(calls.map((c) => c.length)).toEqual([10, 10, 5]);
		expect(states.map((s) => s.name)).toEqual(names);
	});

	it('follows `remaining` when the server cuts a batch', async () => {
		const calls: string[][] = [];
		vi.stubGlobal('fetch', async (url: string) => {
			const names = decodeURIComponent(new URL(url, 'http://x').searchParams.get('names') ?? '').split(',');
			calls.push(names);
			const read = names.slice(0, 3); // an even stricter server
			return new Response(JSON.stringify({ states: read.map((name) => ({ name })), ...(names.length > 3 ? { capped: true, remaining: names.slice(3) } : {}) }), { status: 200, headers: { 'content-type': 'application/json' } });
		});
		const names = ['a.com', 'b.com', 'c.com', 'd.com', 'e.com'];
		const states = await fetchDnsState(names);
		expect(states.map((s) => s.name)).toEqual(names);
		expect(calls).toEqual([names, ['d.com', 'e.com']]);
	});
});
