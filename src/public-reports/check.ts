// The free checker's findings layer: packages/dns-checks results turned into plain-English findings, the shape the website renders
// (types.ts). Ported unchanged from ready-set-mail-website frontend/lib/tools/checks.ts so the app computes what the site shows; the
// site keeps its copy only for the inline fallback when this Worker cannot be reached.
import {
  COMMON_DKIM_SELECTORS,
  SPF_LOOKUP_LIMIT,
  SPF_MX_NAME_LIMIT,
  SPF_VOID_LIMIT,
  analyzeSpf,
  gradeDmarcPolicy,
  lookupDkim,
  lookupDmarc,
  isSpfRecord,
  normalizeName,
  parseSpfTerms,
  type DkimLookup,
  type DmarcRecord,
  type Resolver,
} from "@ready-set-mail/dns-checks";
import { createToolsResolver } from "./resolver";
import type { DkimResult, DkimSelectorResult, DmarcResult, Finding, Severity, SpfIssueView, SpfResult } from "./types";

// Turns the vendored package's results into API payloads with plain-English findings.
// The checks (discovery, PSL fallback, SPF lookup/void/MX limits, DKIM selectors) all live in lib/dns-checks.

const f = (severity: Severity, code: string, message: string): Finding => ({ severity, code, message });

// ── DMARC ────────────────────────────────────────────────────

const STRENGTH: Readonly<Record<string, number>> = { none: 0, quarantine: 1, reject: 2 };

function dmarcFindings(domain: string, record: DmarcRecord, inherited: boolean, recordDomain: string, spExplicit: boolean): Finding[] {
  const out: Finding[] = [];
  if (!record.valid) {
    out.push(f("fail", "dmarc-invalid", `The DMARC record is not valid: ${record.issues.join("; ")}. Receivers will ignore it.`));
    return out;
  }
  if (record.policy === "none") {
    out.push(f("warn", "dmarc-policy-none", "Policy is p=none: monitoring only. Mail that fails DMARC is still delivered, so spoofers are not blocked."));
  } else if (record.policy === "quarantine") {
    out.push(f("pass", "dmarc-policy-quarantine", "Policy is p=quarantine: mail that fails DMARC is treated as suspicious (usually sent to spam). Consider p=reject once reports look clean."));
  } else {
    out.push(f("pass", "dmarc-policy-reject", "Policy is p=reject: mail that fails DMARC is refused. This is the strongest setting."));
  }

  if (record.rua.length === 0) {
    out.push(f("warn", "dmarc-rua-missing", "No reporting address (rua=): you will not receive DMARC reports, so you cannot see which senders fail."));
  } else if (record.rua.some((u) => !/^mailto:/i.test(u))) {
    out.push(f("warn", "dmarc-rua-uri", "A rua= address is not a mailto: URI, so receivers may not send reports to it."));
  } else {
    out.push(f("pass", "dmarc-rua-ok", "Aggregate reports (rua=) are requested, so you can see who sends mail as your domain."));
  }

  if (inherited) {
    out.push(
      f(
        "info",
        "dmarc-inherited",
        `${domain} has no DMARC record of its own, so receivers use the record of ${recordDomain}. For a subdomain, the subdomain policy applies: ${
          spExplicit ? `sp=${record.subdomainPolicy} (set explicitly)` : `sp= is not set, so p=${record.policy} applies`
        }.`
      )
    );
  }
  if (spExplicit && STRENGTH[record.subdomainPolicy] < STRENGTH[record.policy]) {
    out.push(f("warn", "dmarc-sp-weaker", `Subdomains use sp=${record.subdomainPolicy}, which is weaker than p=${record.policy}: spoofed mail from subdomains is treated more leniently.`));
  }
  if (/(^|;)\s*pct\s*=/i.test(record.raw)) {
    out.push(f("info", "dmarc-pct", "A pct= tag is present. DMARCbis (RFC 9989, May 2026) removed pct, so receivers may ignore it and apply your policy to all mail."));
  }
  if (record.adkim === "s" || record.aspf === "s") {
    out.push(f("info", "dmarc-strict-alignment", "Strict alignment (adkim=s or aspf=s) is set. Mail from subdomains or providers that sign with a related domain will fail DMARC."));
  }
  return out;
}

export async function checkDmarc(domain: string, resolver: Resolver = createToolsResolver()): Promise<DmarcResult> {
  const r = await lookupDmarc(resolver, domain);
  const base = { domain, organizationalDomain: r.organizationalDomain } as const;

  if (r.status === "error") {
    return {
      ...base, state: "lookup-failed", complete: false, source: null, recordDomain: null, inherited: false, record: null, tags: null, grade: "unknown",
      reason: r.error ?? "DNS error", findings: [f("warn", "dmarc-lookup-failed", "The DNS lookup failed, so we cannot say whether a DMARC record exists. This is not the same as having no record.")],
    };
  }
  if (r.status === "none") {
    return {
      ...base, state: "no-record", complete: true, source: null, recordDomain: null, inherited: false, record: null, tags: null, grade: "missing",
      findings: [f("fail", "dmarc-missing", "No DMARC record at this domain or its parent domain. Gmail and Outlook expect one from bulk senders, and you get no reports about who sends as your domain.")],
    };
  }
  const recordDomain = r.foundAt?.replace(/^_dmarc\./, "") ?? domain;
  const source = r.inherited ? "organizational-domain" : "domain";
  if (r.status === "multiple") {
    return {
      ...base, state: "ok", complete: true, source, recordDomain, inherited: r.inherited, record: null, rawRecords: r.rawRecords, tags: null, grade: "invalid",
      findings: [f("fail", "dmarc-multiple", `${recordDomain} publishes ${r.rawRecords?.length ?? "several"} DMARC records. With more than one, DMARC does not apply at all (RFC 7489 §6.6.3). Keep exactly one.`)],
    };
  }
  const rec = r.record as DmarcRecord;
  const spExplicit = /(^|;)\s*sp\s*=/i.test(rec.raw);
  return {
    ...base, state: "ok", complete: true, source, recordDomain, inherited: r.inherited, record: rec.raw, grade: gradeDmarcPolicy(rec),
    tags: {
      p: rec.policy, sp: rec.subdomainPolicy, spExplicit, pct: rec.pct, pctPresent: /(^|;)\s*pct\s*=/i.test(rec.raw),
      rua: rec.rua, ruf: rec.ruf, adkim: rec.adkim, aspf: rec.aspf,
    },
    findings: dmarcFindings(domain, rec, r.inherited, recordDomain, spExplicit),
  };
}

// ── SPF ──────────────────────────────────────────────────────

const FATAL_MESSAGE_CODES: ReadonlySet<string> = new Set(["multiple-records", "lookup-limit", "void-lookup-limit", "mx-name-limit", "loop", "include-no-record", "redirect-no-record", "depth-limit", "syntax"]);

/** Every permerror sentence ends the same way: what receivers do with it. */
const PERMERROR = "receivers get a permanent error (permerror), which they treat as a fail or as no SPF";
/** RFC 7208 §4.6.4 and the analyzer both stop a redirect chain well before this. */
const MAX_REDIRECT_HOPS = 10;

type AllQualifier = "+" | "-" | "~" | "?";

interface EffectiveAll {
  /** The all qualifier that decides, or null when the chain ended without one. */
  qualifier: AllQualifier | null;
  /** The record that decided (the last one reached); the checked domain when nothing is followed. */
  from: string;
  /** The names redirect= led through, excluding the checked domain. */
  via: string[];
  /** False when the chain could not be followed to its end (loop, missing target, DNS error, macro, too long). */
  resolved: boolean;
  redirectLoop: string[] | null;
}

/** A resolver whose TXT answers are remembered, so the analyzer and the redirect walk share one lookup per name. */
function memoizeTxt(resolver: Resolver): Resolver {
  const seen = new Map<string, ReturnType<Resolver["txt"]>>();
  return {
    ...resolver,
    txt: (name) => {
      const key = normalizeName(name);
      let p = seen.get(key);
      if (!p) seen.set(key, (p = resolver.txt(name)));
      return p;
    },
  };
}

/**
 * The all mechanism that decides the verdict. A record with its own `all` ignores redirect= (RFC 7208 §6.1); without
 * one, the redirect target's record decides, and so on down the chain.
 */
async function effectiveAll(domain: string, raw: string, resolver: Resolver): Promise<EffectiveAll> {
  const chain = [normalizeName(domain)];
  let current = raw;
  for (;;) {
    const terms = parseSpfTerms(current);
    const all = terms.find((t) => t.kind === "mechanism" && t.name === "all");
    const here = chain[chain.length - 1];
    const via = chain.slice(1);
    if (all) return { qualifier: all.qualifier, from: here, via, resolved: true, redirectLoop: null };
    const redirect = terms.find((t) => t.kind === "modifier" && t.name === "redirect");
    if (!redirect) return { qualifier: null, from: here, via, resolved: true, redirectLoop: null };
    const target = redirect.value ? normalizeName(redirect.value) : "";
    const unresolved = { qualifier: null, from: here, via, resolved: false, redirectLoop: null };
    if (!target || target.includes("%") || chain.length > MAX_REDIRECT_HOPS) return unresolved;
    if (chain.includes(target)) return { ...unresolved, redirectLoop: [...chain, target] };
    const r = await resolver.txt(target);
    const spf = r.status === "error" ? [] : r.records.filter(isSpfRecord);
    if (spf.length !== 1) return unresolved; // none, several or a DNS error: the analyzer reports which
    chain.push(target);
    current = spf[0].trim();
  }
}

const verdictOf = (q: AllQualifier | null): NonNullable<SpfResult["verdict"]> => (q === "-" ? "strict" : q === "~" ? "soft" : q === null ? "missing" : "open");

/** The plain sentence for one fatal analyzer issue. The analyzer's own text quotes RFC sections, so it never reaches a finding. */
function fatalMessage(i: SpfIssueView, rootDomain: string, recordCount: number): string {
  const target = i.domain;
  switch (i.code) {
    case "multiple-records": {
      const n = i.domain === rootDomain ? recordCount : Number(/publishes (\d+)/.exec(i.message)?.[1] ?? 0);
      return `${target} publishes ${n > 1 ? n : "several"} SPF records, so ${PERMERROR}. Merge them into one record.`;
    }
    case "lookup-limit":
      return `Your record needs more than ${SPF_LOOKUP_LIMIT} DNS lookups, so ${PERMERROR}. Remove unused includes or move senders to their own subdomain.`;
    case "void-lookup-limit":
      return `More than ${SPF_VOID_LIMIT} of your SPF lookups find nothing (names that return no data), so ${PERMERROR}. Remove the dead include, a, mx or exists entries.`;
    case "mx-name-limit":
      return `An mx mechanism looks up ${target}, which has more than ${SPF_MX_NAME_LIMIT} mail servers, so ${PERMERROR}. List those servers with ip4: or ip6: instead.`;
    case "depth-limit":
      return `Your SPF record chains through includes or redirects too many levels deep, so ${PERMERROR}. Flatten it or remove includes.`;
    case "include-no-record":
      return `include:${target} points at ${target}, which publishes no SPF record, so receivers get a permanent error (permerror) for your whole record, which they treat as a fail or as no SPF. Remove it or fix it.`;
    case "redirect-no-record":
      return `redirect=${target} points at ${target}, which publishes no SPF record, so ${PERMERROR}.`;
    case "syntax":
      return `${i.message}, so ${PERMERROR}. Fix or remove it.`;
    default:
      return i.message;
  }
}

/** The finding for the all mechanism that decides. Null when the chain could not be followed (a permerror finding says why). */
function allFinding(e: EffectiveAll): Finding | null {
  if (!e.resolved) return null;
  const redirected = e.via.length > 0;
  const lead = redirected ? `Your record hands over to ${e.via.join(" then ")} (redirect=), and that record ` : "";
  const who = redirected ? "it does" : "you did";
  switch (e.qualifier) {
    case "-":
      return f("pass", "spf-all-strict", redirected ? `${lead}ends in -all: mail from servers it does not list is rejected.` : "-all: mail from servers you did not list is rejected.");
    case "~":
      return f("info", "spf-all-soft", `${lead ? `${lead}ends in ` : ""}~all: mail from servers ${who} not list is marked suspicious but usually still delivered. Fine if DMARC enforces; -all is stricter.`);
    case "+":
      return f("fail", "spf-all-open", redirected ? `${lead}ends in +all, which authorizes every server on the internet to send as your domain. Use ~all or -all.` : "+all authorizes every server on the internet to send as your domain. Use ~all or -all.");
    case "?":
      return f("warn", "spf-all-neutral", redirected
        ? `${lead}ends in ?all, which gives mail from servers it does not list a neutral result, so receivers treat it as if you had no SPF. Use ~all or -all.`
        : "?all gives mail from servers you did not list a neutral result, so receivers treat it as if you had no SPF. Use ~all or -all.");
    default:
      return f("warn", "spf-all-missing", redirected
        ? `${lead.replace(/and that record $/, "but that record ")}has no all mechanism and no redirect=, so mail from servers it does not list gets a neutral result: receivers treat it as if you had no SPF. End it with ~all or -all.`
        : `The record has no all mechanism and no redirect=, so mail from servers you did not list gets a neutral result: receivers treat it as if you had no SPF. End it with ~all or -all.`);
  }
}

/** The words for the lookup count: 10 of 10 is at the limit, not over it, so SPF still passes; one more lookup would make it fail. */
export function spfLookupMessage(n: number): string {
  const used = `${n} of ${SPF_LOOKUP_LIMIT} allowed DNS lookups used`;
  if (n > SPF_LOOKUP_LIMIT) return `${used}. That is over the limit: receivers get a permanent error (permerror), which they treat as a fail or as no SPF.`;
  if (n === SPF_LOOKUP_LIMIT) return `${used}. That is the limit, not over it, so SPF still passes, but one more lookup would make SPF fail.`;
  if (n >= 8) return `${used}. That is within the limit, with room for ${SPF_LOOKUP_LIMIT - n} more.`;
  return `${used}.`;
}

export async function checkSpf(domain: string, rawResolver: Resolver = createToolsResolver()): Promise<SpfResult> {
  const resolver = memoizeTxt(rawResolver);
  const a = await analyzeSpf(domain, resolver);
  const dnsErrors = a.issues.filter((i) => i.code === "dns-error");
  const complete = dnsErrors.length === 0;
  const common = {
    domain, lookupLimit: SPF_LOOKUP_LIMIT, voidLimit: SPF_VOID_LIMIT, totalLookups: a.lookupCount, voidLookups: a.voidLookupCount,
    includes: a.includes, issues: a.issues.map((i) => ({ code: i.code, domain: i.domain, message: i.message })),
    ...(a.rawRecords ? { rawRecords: a.rawRecords } : {}),
  };

  if (a.status === "none") {
    return {
      ...common, state: "no-record", complete: true, record: null, recordLength: 0, verdict: null, usesPtr: false, permError: null,
      findings: [f("fail", "spf-missing", "No SPF record at this domain. Without one, receivers have no list of servers allowed to send as you.")],
    };
  }
  if (a.status === "temperror") {
    return {
      ...common, state: "lookup-failed", complete: false, record: a.record?.raw ?? null, recordLength: a.record?.raw.length ?? 0, verdict: a.record?.verdict ?? null,
      usesPtr: false, permError: null, reason: dnsErrors[0]?.message ?? "DNS error",
      findings: [f("warn", "spf-lookup-failed", "A DNS lookup failed while reading your SPF record, so we cannot give a reliable answer. This is not the same as having no record.")],
    };
  }

  const findings: Finding[] = [];
  const rec = a.record;
  const eff = rec ? await effectiveAll(a.domain, rec.raw, resolver) : null;
  const fatal = a.issues.filter((i) => FATAL_MESSAGE_CODES.has(i.code));
  const fatalTexts: string[] = [];
  for (const i of fatal) {
    let text = fatalMessage(i, a.domain, a.rawRecords?.length ?? 0);
    if (i.code === "loop") {
      const path = /^SPF loop: (.*)$/.exec(i.message)?.[1] ?? "";
      const byRedirect = !!eff?.redirectLoop;
      text = `Your SPF ${byRedirect ? "redirects" : "includes"} in a loop (${eff?.redirectLoop?.join(" → ") ?? path}), so ${PERMERROR}.`;
    }
    fatalTexts.push(text);
    findings.push(f("fail", `spf-${i.code}`, text));
  }
  if (!complete) findings.push(f("warn", "spf-incomplete", "Some DNS lookups failed, so the lookup count below may be too low."));

  if (a.status === "ok") {
    const n = a.lookupCount;
    findings.push(f(n >= 8 ? "warn" : "pass", "spf-lookups", spfLookupMessage(n)));
  }
  if (a.voidLookupCount > 0 && !fatal.some((i) => i.code === "void-lookup-limit")) {
    findings.push(f("warn", "spf-void-lookups", `${a.voidLookupCount} of ${SPF_VOID_LIMIT} allowed void lookups used (names that return no data). A third makes SPF fail.`));
  }

  const usesPtr = !!rec?.terms.some((t) => t.kind === "mechanism" && t.name === "ptr");
  if (rec) {
    const allF = eff ? allFinding(eff) : null;
    if (allF) findings.push(allF);
    if (usesPtr) findings.push(f("warn", "spf-ptr", "The ptr mechanism is discouraged (slow and unreliable) and still counts as a lookup."));
    if (rec.raw.length > 450) findings.push(f("warn", "spf-long", `The record is ${rec.raw.length} characters. Long records risk exceeding DNS size limits; some providers need them split.`));
  }

  return {
    ...common, state: "ok", complete, record: rec?.raw ?? null, recordLength: rec?.raw.length ?? 0, verdict: eff?.resolved ? verdictOf(eff.qualifier) : rec?.verdict ?? null, usesPtr,
    ...(eff?.resolved && eff.qualifier ? { allQualifier: eff.qualifier } : {}),
    ...(eff?.resolved && eff.via.length > 0 ? { verdictFrom: eff.from } : {}),
    permError: a.status === "permerror" ? (fatalTexts[0] ?? "SPF permanent error") : null, findings,
  };
}

// ── Existence ────────────────────────────────────────────────

/**
 * Whether the checked name itself exists in public DNS. `false` only on a clear NXDOMAIN (DoH status 3) for an A query on
 * the name; a name with only TXT records answers NODATA, which is "exists". A failed lookup is `null`: unknown, never "does not exist".
 */
export async function domainExists(domain: string, resolver: Resolver = createToolsResolver()): Promise<boolean | null> {
  const r = await resolver.resolve(domain, "A");
  // A name that is a CNAME to a missing target also answers NXDOMAIN, but the name itself has a record: it exists.
  if (r.status === "nxdomain") return r.hasCname ? true : false;
  return r.status === "error" ? null : true;
}

// ── DKIM ─────────────────────────────────────────────────────

const SELECTOR_RE = /^[a-z0-9]([a-z0-9._-]{0,62})$/;

export type SelectorValidation = { ok: true; selector: string } | { ok: false; error: string };

export function validateSelector(input: string): SelectorValidation {
  const s = (input ?? "").trim().toLowerCase();
  if (!SELECTOR_RE.test(s) || s.split(".").some((label) => label.length === 0)) {
    return { ok: false, error: "Selector may only contain letters, digits, dots, hyphens and underscores (max 63 characters)." };
  }
  return { ok: true, selector: s };
}

/** Rough RSA modulus size from the base64 length of p= (DER overhead ~38 bytes), snapped to a common size. */
export function estimateRsaBits(p: string): number | null {
  const b64 = p.replace(/=+$/, "");
  if (!b64 || !/^[A-Za-z0-9+/]+$/.test(b64)) return null;
  const raw = (Math.floor((b64.length * 3) / 4) - 38) * 8;
  if (raw <= 0) return null;
  const sizes = [512, 768, 1024, 1536, 2048, 3072, 4096, 8192];
  return sizes.reduce((best, s) => (Math.abs(s - raw) < Math.abs(best - raw) ? s : best), sizes[0]);
}

function tag(raw: string, name: string): string | null {
  for (const part of raw.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    if (part.slice(0, i).trim().toLowerCase() === name) return part.slice(i + 1).replace(/\s+/g, "");
  }
  return null;
}

function selectorResult(l: DkimLookup): DkimSelectorResult {
  const base = { selector: l.selector, name: l.name };
  if (l.status === "error") return { ...base, state: "lookup-failed", record: null, keyBits: null, findings: [], reason: l.error ?? "DNS error" };
  if (l.status === "none" || !l.record) return { ...base, state: "not-found", record: null, keyBits: null, findings: [] };

  const raw = l.record.raw;
  const findings: Finding[] = [];
  let keyBits: number | null = null;
  const p = tag(raw, "p");
  if (l.record.revoked) {
    findings.push(f("fail", "dkim-revoked", "This DKIM key has been revoked (empty p=), so mail signed with this selector will fail DKIM."));
  } else if (p === null) {
    findings.push(f("fail", "dkim-no-key", "The DKIM record has no public key (p=), so signatures cannot be verified."));
  } else {
    const kind = l.record.keyType.toLowerCase();
    if (kind === "rsa") {
      keyBits = estimateRsaBits(p);
      if (keyBits === null) findings.push(f("warn", "dkim-key-unreadable", "The public key (p=) does not look like valid base64, so receivers may not be able to verify signatures."));
      else if (keyBits < 1024) findings.push(f("fail", "dkim-key-weak", `The RSA key looks like about ${keyBits} bits, which is too weak and may be rejected. Replace it with a 2048-bit key.`));
      else if (keyBits < 2048) findings.push(f("warn", "dkim-key-1024", "The RSA key looks like 1024 bits. Rotate to 2048 bits for stronger protection."));
      else findings.push(f("pass", "dkim-key-ok", `The RSA key looks like ${keyBits} bits, which is strong enough.`));
    } else if (kind === "ed25519") {
      findings.push(f("info", "dkim-ed25519", "Ed25519 key. Not every receiver can verify these, so keep an RSA signature as well."));
    } else {
      findings.push(f("warn", "dkim-key-type", `Unknown key type k=${kind}.`));
    }
    if ((tag(raw, "t") ?? "").toLowerCase().split(":").includes("y")) {
      findings.push(f("warn", "dkim-testing", "The key is in testing mode (t=y). Receivers may treat failures as if unsigned; remove t=y once DKIM works."));
    }
  }
  return { ...base, state: "found", record: raw, keyBits, findings };
}

export async function checkDkim(domain: string, selector?: string, resolver: Resolver = createToolsResolver()): Promise<DkimResult> {
  let names: readonly string[];
  const mode: DkimResult["mode"] = selector ? "selector" : "scan";
  if (selector) {
    const v = validateSelector(selector);
    if (!v.ok) throw new Error(v.error);
    names = [v.selector];
  } else {
    names = COMMON_DKIM_SELECTORS;
  }

  const results = (await Promise.all(names.map((s) => lookupDkim(resolver, domain, s)))).map(selectorResult);
  const found = results.filter((r) => r.state === "found");
  const failed = results.filter((r) => r.state === "lookup-failed");
  const complete = failed.length === 0;
  const findings: Finding[] = [];
  let state: DkimResult["state"];
  let reason: string | undefined;

  if (found.length > 0) {
    state = "ok";
    findings.push(f("pass", "dkim-found", `Found ${found.length} DKIM key${found.length === 1 ? "" : "s"}: ${found.map((x) => x.selector).join(", ")}.`));
    if (!complete) findings.push(f("warn", "dkim-incomplete", `${failed.length} selector lookup${failed.length === 1 ? "" : "s"} failed, so this scan is incomplete.`));
  } else if (failed.length > 0) {
    state = "lookup-failed";
    reason = failed[0].reason;
    findings.push(f("warn", "dkim-lookup-failed", "DNS lookups failed, so we cannot say whether a DKIM key exists. This is not the same as having none."));
  } else {
    state = "no-record";
    findings.push(
      mode === "scan"
        ? f("warn", "dkim-none-scanned", `No key found among ${names.length} common selectors. That does not prove DKIM is missing: selectors cannot be listed through DNS, and your sender may use a different one. Read s= in the DKIM-Signature header of a real email.`)
        : f("fail", "dkim-none", `No DKIM key at ${results[0].name}. Check the selector name in your sending service.`)
    );
  }

  return { state, domain, complete, mode, scanned: names.length, foundCount: found.length, failedCount: failed.length, selectors: results, findings, ...(reason ? { reason } : {}) };
}
