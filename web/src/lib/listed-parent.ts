import type { Domain } from './types';

type Node = Pick<Domain, 'id' | 'parent_id'>;

/**
 * The nearest ancestor of a domain that is in `domains` (following parent_id), never itself; null when the parent is not
 * listed or the chain loops. The overview's rows and the domain page both use this, so a name has the same parent on both.
 */
export function listedParentFinder<T extends Node>(domains: readonly T[]): (d: Node) => T | null {
	const byId = new Map(domains.map((d) => [d.id, d]));
	return (d) => {
		const p = d.parent_id ?? null;
		if (p === null || p === d.id) return null;
		const hit = byId.get(p);
		if (!hit) return null; // the parent is not in this workspace's list: the domain stands alone
		// Walking on from the parent must not lead back to d (a loop makes the domain a root).
		const chain = new Set<number>([hit.id]);
		let q = hit.parent_id ?? null;
		while (q !== null && q !== undefined && byId.has(q)) {
			if (q === d.id || chain.has(q)) return null;
			chain.add(q);
			q = byId.get(q)!.parent_id ?? null;
		}
		return hit;
	};
}
