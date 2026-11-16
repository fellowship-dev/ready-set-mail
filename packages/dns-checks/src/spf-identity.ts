// What an SPF record at a NAME does and does not prove. SPF is evaluated at the return-path (MAIL FROM) domain of a message, never at
// its From domain (RFC 7208 section 3; RFC 9989 section 3.2.4: DMARC "relies solely on SPF validation of the MAIL FROM identity").
// A name that is only ever used in From: needs no SPF record for DMARC: a sending service with its own return-path subdomain is
// checked there, and aligns with the From name under relaxed alignment when both share the organizational domain
// (RFC 9989 section 3.2.10.1). ONE wording for every surface that judges a typed or monitored name from DNS alone.
//
// Pure, so the dashboard and the Worker can import it.

/** No SPF record at `name`: the precise statement, not a fault. */
export function noSpfAtName(name: string): string {
  return `No SPF record at ${name}. SPF is checked at the return-path (MAIL FROM) domain of each message, so ${name} needs one only if mail is sent with ${name} itself as its return-path. A sending service that uses its own return-path subdomain is checked there, and DMARC can pass on DKIM alone.`;
}

/** The next step for a name with no SPF record, from DNS alone (nothing about its mail is known). */
export const NO_SPF_NEXT_STEP = 'If any service sends mail with this name as its return-path (MAIL FROM), publish an SPF record that lists it. If every service uses its own return-path domain, no SPF record is needed here: check in DMARC reports that DKIM aligns.';

/** What a published SPF record at the name proves: that servers it lists may send with this name as the return-path, nothing more. */
export const SPF_AT_NAME_PROVES = 'An SPF record at a name lists the servers allowed to send mail whose return-path (MAIL FROM) is that name. It says nothing about mail that uses another return-path domain.';

/** The share of reported mail whose DKIM must align with the From domain for DKIM alone to carry DMARC (the same share the DKIM level finding calls healthy). */
export const DKIM_CARRIES_SHARE = 0.95;

/**
 * DKIM alignment carries DMARC for this name: reports carry the receiver's verdict (`aligned_total` messages do) and
 * `dkim_aligned_pass` of them aligned on DKIM. Then a missing SPF record at the name is not a fault: whatever return-path the mail
 * uses, DMARC passes on DKIM. False without that evidence (no reports, or reports stored before the verdict was kept).
 */
export function dkimCarriesDmarc(s: { aligned_total?: number | null; dkim_aligned_pass?: number | null }): boolean {
  const total = s.aligned_total ?? 0;
  return total > 0 && (s.dkim_aligned_pass ?? 0) / total >= DKIM_CARRIES_SHARE;
}

/** No SPF record at `name`, and none is needed: reports show DKIM aligning with `name` on `pct`% of reported mail. */
export function noSpfNeededAtName(name: string, pct: number): string {
  return `No SPF record at ${name}, and none is needed for DMARC: DKIM aligns with ${name} on ${pct}% of reported mail. SPF is checked at each message's return-path domain, not at ${name}.`;
}

/** The short next step for a name with no SPF record (a one-line slot). */
export const NO_SPF_NEXT_SHORT = 'If a service sends mail with this name as its return-path, publish an SPF record that lists it.';
