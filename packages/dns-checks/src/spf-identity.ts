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

/** What the stored reports say about the mail sent AS a name (its From domain), from the receivers' own alignment verdicts. */
export interface FromEvidence {
  /** Messages in the window with this name as the From domain. */
  from_messages?: number | null;
  /** Of those, messages whose DKIM aligned with the name (policy_evaluated dkim = pass). */
  from_dkim_aligned?: number | null;
  /** Of those, messages whose SPF domain (the return-path) was the name itself. */
  from_spf_at_name?: number | null;
  /** Of those, messages stored before the receiver's verdict was kept (nothing can be said about them). */
  from_unjudged?: number | null;
}

/**
 * A missing SPF record at the From name is not a fault when the reports show it is not used: every counted message sent as the name
 * passed DMARC on aligned DKIM, and none of them used the name as its SPF (return-path) domain, so SPF was evaluated elsewhere
 * (RFC 7208 section 3, RFC 9989 section 3.2.4). Needs at least one message and a verdict for each; anything else leaves the ladder as it is.
 */
export function spfNotNeededAtName(s: FromEvidence): boolean {
  const total = s.from_messages ?? 0;
  return total > 0 && (s.from_dkim_aligned ?? 0) === total && (s.from_spf_at_name ?? 0) === 0 && (s.from_unjudged ?? 0) === 0;
}

/** No SPF record at `name`, and none is needed: the reports show where SPF was evaluated instead. Says exactly what the evidence shows. */
export function noSpfNeededAtName(name: string, e: FromEvidence): string {
  const n = (e.from_messages ?? 0).toLocaleString('en-US');
  return `No SPF record at ${name}. In the reports of the last 30 days all ${n} ${e.from_messages === 1 ? 'message' : 'messages'} sent as ${name} passed DMARC on DKIM that aligns with it, and none used ${name} as its SPF (return-path) domain, so SPF was checked at other names and none is needed here for that mail.`;
}

/** The short next step for a name with no SPF record (a one-line slot). */
export const NO_SPF_NEXT_SHORT = 'If a service sends mail with this name as its return-path, publish an SPF record that lists it.';
