import { describe, expect, it } from 'vitest';
import { buildRecommendedRecord, normalizeDomain, spTag, sumStats, wizardProgress } from '../src/lib/dmarc';
import { weeklyBuckets } from '../src/lib/pdf/report';
import { buildTree, domainRows } from '../src/pages/domains/OverviewPage';
import type { Domain } from '../src/lib/types';


describe('buildRecommendedRecord', () => {
	it('builds a fresh record', () => {
		expect(buildRecommendedRecord(null, 'none', 'r@x.io')).toBe('v=DMARC1; p=none; rua=mailto:r@x.io');
	});
	it('keeps other tags and rua addresses, sets p= and appends ours', () => {
		expect(buildRecommendedRecord('v=DMARC1; p=none; sp=reject; rua=mailto:a@b.c', 'quarantine', 'r@x.io')).toBe('v=DMARC1; p=quarantine; sp=reject; rua=mailto:a@b.c,mailto:r@x.io');
	});
	it('does not add our rua twice', () => {
		const rec = 'v=DMARC1; p=reject; rua=mailto:r@x.io';
		expect(buildRecommendedRecord(rec, 'reject', 'r@x.io')).toBe(rec);
	});
	it('adds a missing p= and rua=', () => {
		expect(buildRecommendedRecord('v=DMARC1', 'none', 'r@x.io')).toBe('v=DMARC1; p=none; rua=mailto:r@x.io');
	});
});

describe('small helpers', () => {
	it('normalizeDomain', () => expect(normalizeDomain('  HTTPS://Example.com/ ')).toBe('example.com'));
	it('spTag', () => {
		expect(spTag('v=DMARC1; p=none; sp=reject')).toBe('reject');
		expect(spTag('v=DMARC1; p=none')).toBeNull();
		expect(spTag(null)).toBeNull();
	});
	it('sumStats', () => expect(sumStats([{ total: 10, passed: 9, failed: 1 }, { total: 10, passed: 10, failed: 0 }])).toEqual({ total: 20, passed: 19, failed: 1, passRate: 95 }));
	it('wizardProgress points at the first unfinished step after the domain step', () => {
		expect(wizardProgress({ domain: 'complete', spf: 'complete', dkim: 'skipped', dmarc: 'not_started', routing: 'not_started' })).toEqual({ done: 2, skipped: 1, total: 5, nextStep: 3 });
		expect(wizardProgress({ domain: 'not_started', spf: 'complete', dkim: 'complete', dmarc: 'complete', routing: 'complete' }).nextStep).toBe(2);
	});
});

describe('setup progress counts one way everywhere', () => {
	it('counts the domain step as done for a domain that exists, whatever its stored state says', () => {
		const added = { domain: 'not_started', spf: 'not_started', dkim: 'not_started', dmarc: 'not_started', routing: 'not_started' } as const;
		expect(wizardProgress(added)).toEqual({ done: 1, skipped: 0, total: 5, nextStep: 2 });
	});
	it('reports skipped steps separately from complete ones', () => {
		expect(wizardProgress({ domain: 'complete', spf: 'skipped', dkim: 'skipped', dmarc: 'complete', routing: 'not_started' })).toMatchObject({ done: 2, skipped: 2 });
	});
});

describe('buildRecommendedRecord never builds a broken record', () => {
	it.each([undefined, '', '   ', null])('with report address %j: no mailto, no "undefined"', (rua) => {
		const fresh = buildRecommendedRecord(null, 'none', rua as string);
		expect(fresh).toBe('v=DMARC1; p=none');
		const kept = buildRecommendedRecord('v=DMARC1; p=quarantine; rua=mailto:a@x.test', 'reject', rua as string);
		expect(kept).toBe('v=DMARC1; p=reject; rua=mailto:a@x.test');
		for (const r of [fresh, kept]) {
			expect(r).not.toMatch(/undefined|null|mailto:(;|$|,)/);
		}
	});
	it('still adds a real report address', () => {
		expect(buildRecommendedRecord(null, 'none', 'r@reports.test')).toBe('v=DMARC1; p=none; rua=mailto:r@reports.test');
	});
});

describe('buildTree', () => {
	const d = (id: number, parent_id: number | null) => ({ id, parent_id, domain: `d${id}.com` }) as Domain;
	it('nests children and keeps orphans at the top', () => {
		const tree = buildTree([d(1, null), d(2, 1), d(3, 99), d(4, 1)]);
		expect(tree.map((t) => [t.root.id, t.children.map((c) => c.id)])).toEqual([[1, [2, 4]], [3, []]]);
	});
});

describe('pdf', () => {
	it('weeklyBuckets opens a new bucket after 7 days', () => {
		const w = weeklyBuckets([
			{ day: '2026-01-08', total: 10, passed: 5, failed: 5 },
			{ day: '2026-01-01', total: 10, passed: 10, failed: 0 },
			{ day: '2026-01-07', total: 10, passed: 10, failed: 0 },
		]);
		expect(w).toEqual([
			{ label: '2026-01-01 -> 2026-01-07', total: 20, passed: 20 },
			{ label: '2026-01-08 -> 2026-01-14', total: 10, passed: 5 },
		]);
	});
});

describe('domainRows', () => {
	const d = (id: number, name: string, parent_id: number | null) => ({ id, domain: name, parent_id, dmarc_policy: null, rua_address: '', created_at: 0, alerts_enabled: 1, is_default: 0 }) as never;
	it('nests every domain under its nearest listed ancestor, at any depth, and never loses one to a loop', () => {
		const rows = domainRows([d(1, 'a.com', null), d(2, 'b.a.com', 1), d(3, 'c.b.a.com', 2), d(4, 'loop1.com', 5), d(5, 'loop2.com', 4)]);
		expect(rows.map((r) => [(r.d as { domain: string }).domain, r.depth, r.parent ?? null])).toEqual([
			['a.com', 0, null], ['b.a.com', 1, 'a.com'], ['c.b.a.com', 2, 'b.a.com'], ['loop1.com', 0, null], ['loop2.com', 0, null],
		]);
	});
});
