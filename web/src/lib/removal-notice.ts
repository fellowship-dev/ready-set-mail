// What the product left in place when a domain was removed (the `kept` list of DELETE /api/domains/:id), in one sentence.
export interface KeptRecord { type: string; name: string; reason: string }
export interface RemovedState { removed?: { domain: string; kept: KeptRecord[] } }

export function removalNotice(domain: string, kept: KeptRecord[]): string {
	if (kept.length === 0) return `Removed ${domain}.`;
	const list = kept.map((k) => `${k.type} ${k.name} (${k.reason})`).join('; ');
	return `Removed ${domain}. Kept ${kept.length} DNS ${kept.length === 1 ? 'record' : 'records'} you changed: ${list}.`;
}
