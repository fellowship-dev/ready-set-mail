/**
 * D1 allows at most 100 bound values in one statement ("D1_ERROR: too many SQL variables"); the test database refuses the same
 * (packages/db/src/testing/d1-sqlite.ts). A list bound into `IN (...)` is cut into pieces of this many, which leaves room for the
 * statement's own values (a prefix, a workspace id, a time).
 */
export const IN_LIST_MAX = 90;

export const inChunks = <T>(items: readonly T[], size = IN_LIST_MAX): T[][] => {
	const out: T[][] = [];
	for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
	return out;
};
