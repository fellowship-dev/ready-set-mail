import { describe, expect, it } from "vitest";
import { buildSpfRecord, existingQualifier, extractIncludes, extractOtherMechanisms } from "../src/spf-record";

/** What the wizard proposes from a live record with `add` selected on top of its includes. */
const propose = (record: string, add: string[] = []) => buildSpfRecord([...new Set([...extractIncludes(record), ...add])], existingQualifier(record), extractOtherMechanisms(record));

describe("buildSpfRecord: never voids a redirect, never weakens -all (RFC 7208 section 6.1)", () => {
  it("redirect only: unchanged, no all added", () => {
    expect(propose("v=spf1 redirect=icann.org")).toBe("v=spf1 redirect=icann.org");
    expect(existingQualifier("v=spf1 redirect=icann.org")).toBeNull();
  });

  it("redirect plus includes: includes first, redirect last, no all", () => {
    expect(propose("v=spf1 redirect=_spf.example.com include:a.test", ["b.test"])).toBe("v=spf1 include:a.test include:b.test redirect=_spf.example.com");
    expect(propose("v=spf1 redirect=x.test", ["mail.test"])).not.toMatch(/all/);
  });

  it("a record with both all and redirect keeps its all (the redirect is already ignored; nothing changes)", () => {
    expect(propose("v=spf1 include:a.test -all redirect=x.test")).toBe("v=spf1 include:a.test -all redirect=x.test");
  });

  it("include with no all: gets the softfail default", () => {
    expect(propose("v=spf1 include:a.test")).toBe("v=spf1 include:a.test ~all");
  });

  it("+all and ?all are replaced by ~all (they let anyone send)", () => {
    expect(propose("v=spf1 include:a.test +all")).toBe("v=spf1 include:a.test ~all");
    expect(propose("v=spf1 include:a.test ?all")).toBe("v=spf1 include:a.test ~all");
  });

  it("an existing ~all and -all are kept as they are", () => {
    expect(propose("v=spf1 include:a.test ~all")).toBe("v=spf1 include:a.test ~all");
    expect(propose("v=spf1 include:a.test -all", ["b.test"])).toBe("v=spf1 include:a.test include:b.test -all");
    expect(propose("v=spf1 ip4:192.0.2.1 -ALL")).toBe("v=spf1 ip4:192.0.2.1 -all");
  });
});
