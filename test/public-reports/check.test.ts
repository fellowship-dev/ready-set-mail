// Ported from ready-set-mail-website frontend/__tests__/tools/checks.test.ts: the same expectations, run against packages/dns-checks
// itself, so a stored public report and the website checker say the same thing.
import { afterEach, describe, expect, it, vi } from "vitest";
import { checkDkim, checkDmarc, checkSpf, estimateRsaBits, validateSelector } from "../../src/public-reports/check";
import { COMMON_DKIM_SELECTORS } from "@ready-set-mail/dns-checks";
import { installFakeDns, resetFakeDns, setDnsFetch, setDnsTimeoutMs } from "./fake-dns";

vi.mock("../../src/public-reports/resolver", async (importOriginal) => (await import("./fake-dns")).fakeResolverModule(importOriginal));

afterEach(resetFakeDns);

const txt = (...t: string[]) => ({ txt: t });
const codes = (r: { findings: { code: string }[] }) => r.findings.map((x) => x.code);

describe("DMARC", () => {
  it("reports a found record with tags and grade", async () => {
    installFakeDns({ "_dmarc.example.com/TXT": txt("v=DMARC1; p=reject; rua=mailto:r@example.com") });
    const r = await checkDmarc("example.com");
    expect(r).toMatchObject({ state: "ok", complete: true, source: "domain", inherited: false, grade: "strict" });
    expect(r.tags).toMatchObject({ p: "reject", sp: "reject", spExplicit: false, rua: ["mailto:r@example.com"] });
    expect(codes(r)).toEqual(expect.arrayContaining(["dmarc-policy-reject", "dmarc-rua-ok"]));
  });

  it("falls back to the organizational domain with the public suffix list (never co.uk)", async () => {
    const dns = installFakeDns({ "_dmarc.example.co.uk/TXT": txt("v=DMARC1; p=quarantine; sp=reject; rua=mailto:r@example.co.uk") });
    const r = await checkDmarc("mail.example.co.uk");
    expect(dns.names()).toEqual(["_dmarc.mail.example.co.uk", "_dmarc.example.co.uk"]);
    expect(dns.names()).not.toContain("_dmarc.co.uk");
    expect(r).toMatchObject({ state: "ok", source: "organizational-domain", recordDomain: "example.co.uk", inherited: true });
  });

  it("explains that sp= applies when the record is inherited", async () => {
    installFakeDns({ "_dmarc.example.com/TXT": txt("v=DMARC1; p=quarantine; sp=reject; rua=mailto:r@example.com") });
    const r = await checkDmarc("app.example.com");
    const inherited = r.findings.find((x) => x.code === "dmarc-inherited");
    expect(inherited?.message).toMatch(/sp=reject on example\.com's record applies to it/);
    expect(r.tags?.spExplicit).toBe(true);
  });

  it("explains that p= applies to an inherited record without sp=", async () => {
    installFakeDns({ "_dmarc.example.com/TXT": txt("v=DMARC1; p=none; rua=mailto:r@example.com") });
    const r = await checkDmarc("app.example.com");
    expect(r.findings.find((x) => x.code === "dmarc-inherited")?.message).toMatch(/p=none on example\.com's record applies to it \(that record has no sp= tag that applies\)/);
  });

  it("warns when sp= is weaker than p=", async () => {
    installFakeDns({ "_dmarc.example.com/TXT": txt("v=DMARC1; p=reject; sp=none; rua=mailto:r@example.com") });
    expect(codes(await checkDmarc("example.com"))).toContain("dmarc-sp-weaker");
  });

  it("flags multiple records as a failure, not as no record", async () => {
    installFakeDns({ "_dmarc.example.com/TXT": txt("v=DMARC1; p=none", "v=DMARC1; p=reject") });
    const r = await checkDmarc("example.com");
    expect(r.state).toBe("ok");
    expect(r.rawRecords).toHaveLength(2);
    expect(codes(r)).toContain("dmarc-multiple");
  });

  it("reports no-record only when DNS answered", async () => {
    installFakeDns({});
    expect(await checkDmarc("example.com")).toMatchObject({ state: "no-record", complete: true });
  });

  it.each(["servfail", "refused", "http500", "badjson", "network", "hang"] as const)("%s is lookup-failed, never no-record", async (kind) => {
    installFakeDns({ "_dmarc.example.com/TXT": kind });
    const r = await checkDmarc("example.com");
    expect(r.state).toBe("lookup-failed");
    expect(r.complete).toBe(false);
    expect(r.reason).toBeTruthy();
  });

  it("does not fall back to the parent when the first lookup errored", async () => {
    const dns = installFakeDns({ "_dmarc.sub.example.com/TXT": "servfail", "_dmarc.example.com/TXT": txt("v=DMARC1; p=reject") });
    const r = await checkDmarc("sub.example.com");
    expect(r.state).toBe("lookup-failed");
    expect(dns.names()).not.toContain("_dmarc.example.com");
  });

  it("notes that pct is removed by DMARCbis", async () => {
    installFakeDns({ "_dmarc.example.com/TXT": txt("v=DMARC1; p=quarantine; pct=50; rua=mailto:r@example.com") });
    expect(codes(await checkDmarc("example.com"))).toContain("dmarc-pct");
  });
});

describe("resolver fallback", () => {
  it("asks Google only after Cloudflare errored, and trusts an authoritative Cloudflare no-record", async () => {
    const dns = installFakeDns({}, { "cloudflare-dns.com": { "_dmarc.a.com/TXT": "servfail" }, "dns.google": { "_dmarc.a.com/TXT": txt("v=DMARC1; p=none; rua=mailto:x@a.com") } });
    expect((await checkDmarc("a.com")).state).toBe("ok");
    expect(dns.calls.map((c) => c.host)).toEqual(["cloudflare-dns.com", "dns.google"]);

    const dns2 = installFakeDns({});
    expect((await checkDmarc("b.com")).state).toBe("no-record");
    expect(dns2.calls.every((c) => c.host === "cloudflare-dns.com")).toBe(true);
  });
});

describe("SPF", () => {
  it("counts lookups and passes under the limit", async () => {
    installFakeDns({
      "example.com/TXT": txt("v=spf1 include:_spf.google.com -all"),
      "_spf.google.com/TXT": txt("v=spf1 ip4:203.0.113.0/24 ~all"),
    });
    const r = await checkSpf("example.com");
    expect(r).toMatchObject({ state: "ok", totalLookups: 1, verdict: "strict", permError: null, complete: true });
    expect(r.includes).toEqual(["_spf.google.com"]);
    expect(codes(r)).toContain("spf-all-strict");
  });

  it("fails over 10 lookups with a permerror", async () => {
    const zone: Record<string, ReturnType<typeof txt>> = { "example.com/TXT": txt(`v=spf1 ${Array.from({ length: 11 }, (_, i) => `include:s${i}.example.org`).join(" ")} -all`) };
    for (let i = 0; i < 11; i++) zone[`s${i}.example.org/TXT`] = txt("v=spf1 ip4:203.0.113.1 -all");
    installFakeDns(zone);
    const r2 = await checkSpf("example.com");
    expect(r2.state).toBe("ok");
    expect(r2.permError).toMatch(/10/);
    expect(codes(r2)).toContain("spf-lookup-limit");
  });

  it("fails on more than 2 void lookups", async () => {
    installFakeDns({ "example.com/TXT": txt("v=spf1 a:v1.example.org a:v2.example.org a:v3.example.org -all") });
    const r = await checkSpf("example.com");
    expect(r.voidLookups).toBeGreaterThan(2);
    expect(codes(r)).toContain("spf-void-lookup-limit");
    expect(r.permError).toBeTruthy();
  });

  it("fails when an MX mechanism resolves more than 10 hosts", async () => {
    installFakeDns({
      "example.com/TXT": txt("v=spf1 mx -all"),
      "example.com/MX": { answers: Array.from({ length: 11 }, (_, i) => ({ type: 15, data: `10 mx${i}.example.com.` })) },
    });
    const r = await checkSpf("example.com");
    expect(codes(r)).toContain("spf-mx-name-limit");
    expect(r.permError).toBeTruthy();
  });

  it("flags multiple SPF records as a permerror", async () => {
    installFakeDns({ "example.com/TXT": txt("v=spf1 -all", "v=spf1 ~all") });
    const r = await checkSpf("example.com");
    expect(r).toMatchObject({ state: "ok" });
    expect(r.rawRecords).toHaveLength(2);
    expect(codes(r)).toContain("spf-multiple-records");
    expect(r.permError).toBeTruthy();
  });

  it("detects include loops", async () => {
    installFakeDns({ "example.com/TXT": txt("v=spf1 include:a.example.org -all"), "a.example.org/TXT": txt("v=spf1 include:example.com -all") });
    expect(codes(await checkSpf("example.com"))).toContain("spf-loop");
  });

  it("reports no-record only when DNS answered", async () => {
    installFakeDns({});
    expect(await checkSpf("example.com")).toMatchObject({ state: "no-record", complete: true });
  });

  it.each(["servfail", "network", "hang"] as const)("a %s on the root lookup is lookup-failed, never no-record", async (kind) => {
    installFakeDns({ "example.com/TXT": kind });
    expect(await checkSpf("example.com")).toMatchObject({ state: "lookup-failed", complete: false });
  });

  it("marks the result incomplete when only an include fails", async () => {
    installFakeDns({ "example.com/TXT": txt("v=spf1 include:flaky.example.org -all"), "flaky.example.org/TXT": "servfail" });
    const r = await checkSpf("example.com");
    expect(r.complete).toBe(false);
    expect(r.state).not.toBe("no-record");
  });

  it("warns about +all/?all", async () => {
    installFakeDns({ "example.com/TXT": txt("v=spf1 +all") });
    expect(codes(await checkSpf("example.com"))).toContain("spf-all-open");
  });
});

describe("SPF effective all (redirect=)", () => {
  const msg = (r: { findings: { code: string; message: string }[] }, code: string) => r.findings.find((x) => x.code === code)?.message;
  const noRedirectWording = "no all mechanism";

  it("a redirect-only record is decided by the target's -all, and the redirect counts as a lookup", async () => {
    installFakeDns({ "iana.org/TXT": txt("v=spf1 redirect=icann.org"), "icann.org/TXT": txt("v=spf1 ip4:203.0.113.0/24 -all") });
    const r = await checkSpf("iana.org");
    expect(r).toMatchObject({ state: "ok", verdict: "strict", allQualifier: "-", verdictFrom: "icann.org", totalLookups: 1, permError: null });
    expect(codes(r)).not.toContain("spf-all-missing");
    expect(r.findings.map((x) => x.message).join(" ")).not.toContain(noRedirectWording);
    expect(msg(r, "spf-all-strict")).toBe("Your record hands over to icann.org (redirect=), and that record ends in -all: mail from servers it does not list is rejected.");
  });

  it("follows a chain and counts every redirect", async () => {
    installFakeDns({ "a.example/TXT": txt("v=spf1 redirect=b.example"), "b.example/TXT": txt("v=spf1 include:c.example redirect=d.example"), "c.example/TXT": txt("v=spf1 ip4:203.0.113.1 -all"), "d.example/TXT": txt("v=spf1 -all") });
    const r = await checkSpf("a.example");
    expect(r).toMatchObject({ verdict: "strict", verdictFrom: "d.example", totalLookups: 3 });
  });

  it("a redirect to a ~all record is soft", async () => {
    installFakeDns({ "example.com/TXT": txt("v=spf1 redirect=_spf.example.net"), "_spf.example.net/TXT": txt("v=spf1 ip4:203.0.113.1 ~all") });
    const r = await checkSpf("example.com");
    expect(r).toMatchObject({ verdict: "soft", verdictFrom: "_spf.example.net" });
    expect(msg(r, "spf-all-soft")).toMatch(/^Your record hands over to _spf\.example\.net \(redirect=\), and that record ends in ~all: mail from servers it does not list/);
  });

  it("a redirect to +all and to ?all are different findings", async () => {
    installFakeDns({ "p.example/TXT": txt("v=spf1 redirect=t1.example"), "t1.example/TXT": txt("v=spf1 +all"), "q.example/TXT": txt("v=spf1 redirect=t2.example"), "t2.example/TXT": txt("v=spf1 ?all") });
    const plus = await checkSpf("p.example");
    expect(msg(plus, "spf-all-open")).toBe("Your record hands over to t1.example (redirect=), and that record ends in +all, which authorizes every server on the internet to send as your domain. Use ~all or -all.");
    const q = await checkSpf("q.example");
    expect(q.findings.find((x) => x.code === "spf-all-neutral")?.severity).toBe("warn");
    expect(msg(q, "spf-all-neutral")).toMatch(/ends in \?all, which gives mail from servers it does not list a neutral result/);
  });

  it("a redirect target with no all and no redirect= warns, naming the target", async () => {
    installFakeDns({ "example.com/TXT": txt("v=spf1 redirect=t.example"), "t.example/TXT": txt("v=spf1 ip4:203.0.113.1") });
    const r = await checkSpf("example.com");
    expect(r.verdict).toBe("missing");
    expect(msg(r, "spf-all-missing")).toMatch(/^Your record hands over to t\.example \(redirect=\), but that record has no all mechanism and no redirect=, so/);
  });

  it("redirect= is ignored when the record has its own all (RFC 7208 section 6.1)", async () => {
    const dns = installFakeDns({ "example.com/TXT": txt("v=spf1 ip4:203.0.113.1 ~all redirect=t.example"), "t.example/TXT": txt("v=spf1 -all") });
    const r = await checkSpf("example.com");
    expect(r).toMatchObject({ verdict: "soft", totalLookups: 0 });
    expect(r.verdictFrom).toBeUndefined();
    expect(dns.names()).not.toContain("t.example");
  });

  it("asks DNS once per name", async () => {
    const dns = installFakeDns({ "iana.org/TXT": txt("v=spf1 redirect=icann.org"), "icann.org/TXT": txt("v=spf1 -all") });
    await checkSpf("iana.org");
    expect(dns.calls.filter((c) => c.name === "icann.org" && c.type === "TXT")).toHaveLength(1);
  });

  it("a redirect loop is a plain permerror with the real chain", async () => {
    installFakeDns({ "a.example/TXT": txt("v=spf1 redirect=b.example"), "b.example/TXT": txt("v=spf1 redirect=a.example") });
    const r = await checkSpf("a.example");
    expect(msg(r, "spf-loop")).toBe("Your SPF redirects in a loop (a.example → b.example → a.example), so receivers get a permanent error (permerror), which they treat as a fail or as no SPF.");
    expect(r.permError).toBe(msg(r, "spf-loop"));
    expect(codes(r)).not.toContain("spf-all-missing");
  });

  it("an include loop says includes, not redirects", async () => {
    installFakeDns({ "a.example/TXT": txt("v=spf1 include:b.example -all"), "b.example/TXT": txt("v=spf1 include:a.example -all") });
    expect(msg(await checkSpf("a.example"), "spf-loop")).toMatch(/^Your SPF includes in a loop \(a\.example → b\.example → a\.example\), so receivers get a permanent error/);
  });

  it("a redirect to a name with no SPF record is a plain permerror", async () => {
    installFakeDns({ "example.com/TXT": txt("v=spf1 redirect=gone.example") });
    const r = await checkSpf("example.com");
    expect(msg(r, "spf-redirect-no-record")).toBe("redirect=gone.example points at gone.example, which publishes no SPF record, so receivers get a permanent error (permerror), which they treat as a fail or as no SPF.");
    expect(r.findings.find((x) => x.code === "spf-redirect-no-record")?.severity).toBe("fail");
    expect(codes(r)).not.toContain("spf-all-missing");
  });

  it("an include of a name with no SPF record is a plain permerror", async () => {
    installFakeDns({ "example.com/TXT": txt("v=spf1 include:gone.example -all") });
    const r = await checkSpf("example.com");
    expect(msg(r, "spf-include-no-record")).toBe("include:gone.example points at gone.example, which publishes no SPF record, so receivers get a permanent error (permerror) for your whole record, which they treat as a fail or as no SPF. Remove it or fix it.");
  });

  it("+all alone fails and ?all alone warns, with their own sentences", async () => {
    installFakeDns({ "p.example/TXT": txt("v=spf1 +all"), "q.example/TXT": txt("v=spf1 ?all") });
    const plus = await checkSpf("p.example");
    expect(plus.findings.find((x) => x.code === "spf-all-open")).toMatchObject({ severity: "fail", message: "+all authorizes every server on the internet to send as your domain. Use ~all or -all." });
    const q = await checkSpf("q.example");
    expect(q.findings.find((x) => x.code === "spf-all-neutral")).toMatchObject({ severity: "warn", message: "?all gives mail from servers you did not list a neutral result, so receivers treat it as if you had no SPF. Use ~all or -all." });
    expect(q.verdict).toBe("open");
  });

  it("no all and no redirect= warns", async () => {
    installFakeDns({ "example.com/TXT": txt("v=spf1 ip4:203.0.113.1") });
    const r = await checkSpf("example.com");
    expect(r.findings.find((x) => x.code === "spf-all-missing")).toMatchObject({
      severity: "warn",
      message: "The record has no all mechanism and no redirect=, so mail from servers you did not list gets a neutral result: receivers treat it as if you had no SPF. End it with ~all or -all.",
    });
  });

  it("says no SPF record at the name, and what that does and does not mean", async () => {
    installFakeDns({});
    expect(msg(await checkSpf("example.com"), "spf-missing")).toMatch(/^No SPF record at example\.com\. SPF is checked at the return-path \(MAIL FROM\) domain of each message/);
  });

  it("several records is a plain permerror with the count", async () => {
    installFakeDns({ "example.com/TXT": txt("v=spf1 -all", "v=spf1 ~all", "v=spf1 +all") });
    expect(msg(await checkSpf("example.com"), "spf-multiple-records")).toBe("example.com publishes 3 SPF records, so receivers get a permanent error (permerror), which they treat as a fail or as no SPF. Merge them into one record.");
  });

  const includes = (n: number) => {
    const zone: Record<string, ReturnType<typeof txt>> = { "example.com/TXT": txt(`v=spf1 ${Array.from({ length: n }, (_, i) => `include:s${i}.example.org`).join(" ")} -all`) };
    for (let i = 0; i < n; i++) zone[`s${i}.example.org/TXT`] = txt("v=spf1 ip4:203.0.113.1 -all");
    installFakeDns(zone);
  };

  it("exactly 10 lookups passes with the at-limit wording", async () => {
    includes(10);
    const r = await checkSpf("example.com");
    expect(r).toMatchObject({ state: "ok", totalLookups: 10, permError: null });
    expect(r.findings.find((x) => x.code === "spf-lookups")).toMatchObject({ severity: "warn", message: expect.stringContaining("That is the limit, not over it, so SPF still passes") });
    expect(codes(r)).not.toContain("spf-lookup-limit");
  });

  it("11 lookups is a plain permerror", async () => {
    includes(11);
    const r = await checkSpf("example.com");
    expect(msg(r, "spf-lookup-limit")).toBe("Your record needs more than 10 DNS lookups, so receivers get a permanent error (permerror), which they treat as a fail or as no SPF. Remove unused includes or move senders to their own subdomain.");
    expect(r.permError).toBe(msg(r, "spf-lookup-limit"));
  });

  it("no finding quotes the analyzer's RFC text", async () => {
    installFakeDns({
      "example.com/TXT": txt("v=spf1 a:v1.example.org a:v2.example.org a:v3.example.org mx -all"),
      "example.com/MX": { answers: Array.from({ length: 11 }, (_, i) => ({ type: 15, data: `10 mx${i}.example.com.` })) },
    });
    const r = await checkSpf("example.com");
    expect(codes(r)).toEqual(expect.arrayContaining(["spf-void-lookup-limit", "spf-mx-name-limit"]));
    for (const x of r.findings) expect(x.message).not.toMatch(/RFC 7208/);
    expect(r.permError).not.toMatch(/RFC 7208/);
  });
});

describe("DKIM", () => {
  const key2048 = "A".repeat(392);

  it("checks a given selector", async () => {
    installFakeDns({ "s1._domainkey.example.com/TXT": txt(`v=DKIM1; k=rsa; p=${key2048}`) });
    const r = await checkDkim("example.com", "S1");
    expect(r).toMatchObject({ state: "ok", mode: "selector", foundCount: 1 });
    expect(r.selectors[0]).toMatchObject({ selector: "s1", state: "found", keyBits: 2048 });
  });

  it("flags a revoked key", async () => {
    installFakeDns({ "s1._domainkey.example.com/TXT": txt("v=DKIM1; p=") });
    const r = await checkDkim("example.com", "s1");
    expect(r.selectors[0].findings.map((x) => x.code)).toContain("dkim-revoked");
  });

  it("scans all 36 package selectors and is honest when none are found", async () => {
    const dns = installFakeDns({});
    const r = await checkDkim("example.com");
    expect(COMMON_DKIM_SELECTORS).toHaveLength(36);
    expect(r).toMatchObject({ state: "no-record", mode: "scan", scanned: 36, foundCount: 0 });
    expect(dns.names()).toHaveLength(36);
    expect(r.findings[0].message).toMatch(/does not prove DKIM is missing/);
  });

  it("finds a key during a scan, and flags an incomplete scan", async () => {
    installFakeDns({ "google._domainkey.example.com/TXT": txt(`v=DKIM1; k=rsa; p=${key2048}`), "mail._domainkey.example.com/TXT": "servfail" });
    const r = await checkDkim("example.com");
    expect(r).toMatchObject({ state: "ok", foundCount: 1, failedCount: 1, complete: false });
  });

  it("is lookup-failed when every probe fails", async () => {
    installFakeDns(Object.fromEntries(COMMON_DKIM_SELECTORS.map((s) => [`${s}._domainkey.example.com/TXT`, "servfail" as const])));
    expect(await checkDkim("example.com")).toMatchObject({ state: "lookup-failed", complete: false });
  });

  it("validates selectors and estimates RSA size", () => {
    expect(validateSelector("Good-1")).toEqual({ ok: true, selector: "good-1" });
    expect(validateSelector("bad sel").ok).toBe(false);
    expect(validateSelector("a..b").ok).toBe(false);
    expect(estimateRsaBits("A".repeat(216))).toBe(1024);
    expect(estimateRsaBits("A".repeat(392))).toBe(2048);
    expect(estimateRsaBits("not base64!")).toBeNull();
  });
});

describe("resolver limits", () => {
  it("never has more than 8 DoH requests in flight (DKIM scan fires 36 probes)", async () => {
    let inFlight = 0;
    let peak = 0;
    setDnsTimeoutMs(1000);
    setDnsFetch((async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return { ok: true, status: 200, headers: { get: () => null }, text: async () => "", json: async () => ({ Status: 3 }) };
    }) as never);
    const r = await checkDkim("example.com");
    expect(r.scanned).toBe(36);
    expect(peak).toBeLessThanOrEqual(8);
    expect(peak).toBeGreaterThan(1);
  });

  it("caps the DoH requests of one check, and reports the cut-off as a failure, not as no record", async () => {
    let calls = 0;
    setDnsTimeoutMs(1000);
    setDnsFetch((async (url: string) => {
      calls++;
      const name = new URL(url).searchParams.get("name") ?? "";
      const body = name === "example.com" ? { Status: 0, Answer: [{ name, type: 16, TTL: 1, data: `"v=spf1 ${Array.from({ length: 9 }, (_, i) => `a:h${i}.example.org`).join(" ")} -all"` }] } : { Status: 2 };
      return { ok: true, status: 200, headers: { get: () => null }, text: async () => "", json: async () => body };
    }) as never);
    const r = await checkSpf("example.com");
    expect(calls).toBeLessThanOrEqual(80);
    expect(r.state).not.toBe("no-record");
  });
});
