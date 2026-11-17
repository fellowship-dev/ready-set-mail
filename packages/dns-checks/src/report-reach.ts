// How DMARC reports reach a name, in the words every surface uses. The decision itself is `reportReachOf` (src/hosted/report-address.ts) and is
// sent on the report-address view as `reach`; the panel, the setup steps, the domain page and the agent say it only through `reportReachWords`.

/** The window of the counts in `ReportReach`: the page's 30 days. */
export const REACH_WINDOW_DAYS = 30;

export interface ReportReach {
	/**
	 * own: connected, and the name's own record lists the address. via_parent: no connection of its own, and the intake files the reports that name it
	 * under it through a connected parent. inherited_record: no DMARC record of its own, and the record that applies to it lists our address (its mail is
	 * counted in that record's domain's reports). none: nothing arrives for it by these routes.
	 */
	kind: 'own' | 'via_parent' | 'inherited_record' | 'none';
	/** The connected parent (via_parent) or the domain whose record applies (inherited_record); `domain_id` is that domain's row in the workspace. */
	through: { domain_id: number; domain: string } | null;
	/** The counted reports filed under this name in the last `days` days, their messages, and when the newest counted one ever arrived. */
	reports: number;
	messages: number;
	last_report_at: number | null;
	days: number;
}

const plural = (n: number, one: string) => `${n.toLocaleString('en-US')} ${n === 1 ? one : `${one}s`}`;

/**
 * The headline and the sentences for the two ways reports reach a name without a connection of its own (via_parent, inherited_record); null for
 * `own` and `none`, which the panel says from the connection's own state. `at` writes a unix time ("Nov 16, 2026, 10:16 AM").
 */
export function reportReachWords(name: string, r: ReportReach, at: (unix: number) => string): { headline: string; sentences: string[] } | null {
	if (!r.through) return null;
	const via = r.through.domain;
	if (r.kind === 'inherited_record') {
		return {
			headline: `Reports arrive through ${via}'s record`,
			sentences: [`${name} has no DMARC record of its own. ${via}'s record applies to it and already sends reports here; mail sent as ${name} is counted in ${via}'s reports.`],
		};
	}
	if (r.kind !== 'via_parent') return null;
	const filed = r.reports > 0
		? `${plural(r.reports, 'report')} (${plural(r.messages, 'message')}) filed for ${name} in the last ${r.days} days${r.last_report_at ? `; the last arrived ${at(r.last_report_at)}` : ''}.`
		: r.last_report_at
			? `None in the last ${r.days} days; the last arrived ${at(r.last_report_at)}.`
			: `None has arrived yet: receivers send them about once a day once ${name}'s DMARC record lists the report address.`;
	return {
		headline: `Reports arrive through ${via}`,
		sentences: [
			`${name} has no connection of its own: ${via} is connected, and reports that name ${name} as their policy domain are filed for ${name}. ${filed}`,
			`Connecting ${name} would change nothing: it uses the same report address. Mail from ${name} that a receiver lists inside ${via}'s own reports stays with ${via}.`,
		],
	};
}
