// The stored result shape (schema version 1). Same as ready-set-mail-website frontend/lib/tools/types.ts, which renders it.
/**
 * JSON shapes returned by /api/tools/* and consumed by the checker widget.
 * The checks themselves live in `lib/dns-checks` (vendored, see SOURCE.md); this layer only turns their results into
 * plain-English findings.
 *
 * CRUCIAL: a failed DNS lookup is never the same thing as "no record". `CheckState` keeps those apart end to end.
 */

export type CheckState =
  /** A record was found and analysed. */
  | "ok"
  /** DNS answered and the record genuinely does not exist (NODATA / NXDOMAIN). */
  | "no-record"
  /** We could not find out (timeout, SERVFAIL, REFUSED, network, bad response). Says nothing about the record. */
  | "lookup-failed";

export type Severity = "pass" | "warn" | "fail" | "info";

/** One plain-English observation. Names the email problem first, the protocol second. */
export interface Finding {
  severity: Severity;
  /** Stable machine-readable id, e.g. "dmarc-policy-none". */
  code: string;
  message: string;
}

interface Base {
  state: CheckState;
  domain: string;
  /** False when a lookup failed or was cut short: the answer is not final and must not be cached. */
  complete: boolean;
  findings: Finding[];
  /** Short reason string when state is "lookup-failed". */
  reason?: string;
  /** `false` only on a clear NXDOMAIN for the checked name itself; absent when it exists or when the lookup failed (unknown is never "does not exist"). */
  domainExists?: false;
}

export interface DmarcResult extends Base {
  /** Where the record was found: the domain itself, its organizational domain, or nowhere. */
  source: "domain" | "organizational-domain" | null;
  /** The domain whose `_dmarc` record was used. */
  recordDomain: string | null;
  organizationalDomain: string | null;
  /** The record came from the parent domain, so for this (sub)domain `sp=` is the policy that applies. */
  inherited: boolean;
  record: string | null;
  /** The policy in force for THIS name and where it comes from (RFC 9989 section 4.10.1); `grade` is graded on it, never on another name's `p=`. */
  effective: { policy: "none" | "quarantine" | "reject" | null; tag: "p" | "sp" | "np" | null; at: string | null; source: "own" | "organizational" | null; exists: boolean | null } | null;
  /** Competing records when more than one `v=DMARC1` exists at the same name (DMARC then does not apply). */
  rawRecords?: string[];
  tags: {
    p: string;
    /** Subdomain policy in effect (`sp=`, or `p=` when `sp=` is absent). */
    sp: string;
    spExplicit: boolean;
    pct: number;
    pctPresent: boolean;
    rua: string[];
    ruf: string[];
    adkim: "r" | "s";
    aspf: "r" | "s";
  } | null;
  grade: string;
}

export interface SpfIssueView {
  code: string;
  domain: string;
  message: string;
}

export interface SpfResult extends Base {
  record: string | null;
  recordLength: number;
  /**
   * The all-mechanism verdict that decides: strict (-all), soft (~all), open (+all/?all) or missing. A record with no
   * `all` but a redirect= is decided by the redirect target's record (RFC 7208 §6.1), so this is the effective one.
   */
  verdict: "strict" | "soft" | "open" | "missing" | null;
  /** The deciding all qualifier (tells +all from ?all); absent when none decides. */
  allQualifier?: "+" | "-" | "~" | "?";
  /** The domain whose record decided the verdict, set only when a redirect= handed over to it. */
  verdictFrom?: string;
  totalLookups: number;
  lookupLimit: number;
  voidLookups: number;
  voidLimit: number;
  /** Every include:/redirect= domain reached, depth-first. */
  includes: string[];
  usesPtr: boolean;
  /** Set when the record would make receivers return SPF PermError. */
  permError: string | null;
  issues: SpfIssueView[];
  rawRecords?: string[];
}

export type DkimSelectorState = "found" | "not-found" | "lookup-failed";

export interface DkimSelectorResult {
  selector: string;
  /** DNS name queried, `<selector>._domainkey.<domain>`. */
  name: string;
  state: DkimSelectorState;
  record: string | null;
  /** Estimated RSA key size in bits (null for non-RSA, revoked or unreadable keys). */
  keyBits: number | null;
  findings: Finding[];
  reason?: string;
}

export interface DkimResult extends Base {
  mode: "selector" | "scan";
  scanned: number;
  foundCount: number;
  failedCount: number;
  selectors: DkimSelectorResult[];
}

export type CheckResult = DmarcResult | SpfResult | DkimResult;
