import { describe, expect, it } from "vitest";
import { buildSpfRecord, existingQualifier, extractIncludes, extractOtherMechanisms, spfPtrWarning, validateSpfRecord } from "../src/spf-record";

/** What the wizard proposes from a live record with `add` selected on top of its includes. */
const propose = (record: string, add: string[] = []) => buildSpfRecord([...new Set([...extractIncludes(record), ...add])], existingQualifier(record), extractOtherMechanisms(record));

describe("validateSpfRecord: one all, or one redirect= and no all", () => {
  it.each([
    ["v=spf1 include:mail.test -all", null],
    ["v=spf1 include:mail.test ~all", null],
    ["v=spf1 redirect=_spf.x.test", null],
    ["v=spf1 include:mail.test redirect=_spf.x.test", null],
    ["  v=spf1 include:mail.test -all  ", null],
  ])("accepts %s", (r, want) => expect(validateSpfRecord(r)).toBe(want));
  it.each([
    ["v=spf1 include:allmail.com", /must end with an all mechanism or a redirect= modifier/],
    ["v=spf1 include:mail.test", /must end with/],
    ["v=spf1 include:a.test +all", /must not use \+all/],
    ["v=spf1 include:a.test ?all", /must not use \?all/],
    ["v=spf1 ~all -all", /more than one all/],
    ["v=spf1 redirect=a.test redirect=b.test", /redirect= appears more than once/],
    ["v=spf1 redirect=", /"redirect=" is not a valid modifier/],
    ["spf1 -all", /must start with v=spf1/],
    // Folded in from the apply route (one rule for both): an ignored redirect=, ptr, bad addresses, all not last.
    ["v=spf1 include:a.test -all redirect=x.test", /both an all mechanism and redirect=/],
    ["v=spf1 ptr -all", /must not use ptr/],
    ["v=spf1 ip4:1.2.3.4/33 -all", /not a valid IPv4/],
    ["v=spf1 ip6:2001:db8::/129 -all", /not a valid IPv6/],
    ["v=spf1 -all include:a.test", /must end with its all mechanism/],
    ['v=spf1 include:"a.test" -all', /without quotes/],
  ])("refuses %s", (r, why) => expect(validateSpfRecord(r)).toMatch(why));
  it("every record the builder proposes from a valid live record is valid", () => {
    for (const live of ["v=spf1 redirect=icann.org", "v=spf1 include:a.test -all", "v=spf1 include:a.test +all", "v=spf1 include:a.test", "v=spf1 mx redirect=x.test"]) expect(validateSpfRecord(propose(live, ["b.test"]))).toBeNull();
  });
});

describe("ptr: never added, kept when the live record has it", () => {
  const live = "v=spf1 ptr include:a.test ~all";
  it("a record that keeps the live ptr is valid, and gets the warning", () => {
    expect(validateSpfRecord("v=spf1 include:a.test include:b.test ptr ~all", live)).toBeNull();
    expect(spfPtrWarning("v=spf1 include:a.test include:b.test ptr ~all")).toBe("Your record uses ptr, which receivers may skip. Replace it with ip4:, ip6: or include: when you can.");
  });
  it("adding a ptr is refused, also next to a kept one", () => {
    expect(validateSpfRecord("v=spf1 include:a.test ptr ~all", "v=spf1 include:a.test ~all")).toMatch(/must not use ptr/);
    expect(validateSpfRecord("v=spf1 include:a.test ptr ptr:x.test ~all", live)).toMatch(/must not use ptr/);
    expect(validateSpfRecord("v=spf1 include:a.test ptr ~all")).toMatch(/must not use ptr/);
  });
  it("the builder keeps the live ptr when a provider is added, and the result is accepted against the live record", () => {
    const next = buildSpfRecord([...extractIncludes(live), "b.test"], existingQualifier(live), extractOtherMechanisms(live));
    expect(next).toBe("v=spf1 include:a.test include:b.test ptr ~all");
    expect(validateSpfRecord(next, live)).toBeNull();
  });
  it("no warning without ptr", () => expect(spfPtrWarning("v=spf1 include:a.test ~all")).toBeNull());
});

describe("buildSpfRecord: never voids a redirect, never weakens -all (RFC 7208 section 6.1)", () => {
  it("redirect only: unchanged, no all added", () => {
    expect(propose("v=spf1 redirect=icann.org")).toBe("v=spf1 redirect=icann.org");
    expect(existingQualifier("v=spf1 redirect=icann.org")).toBeNull();
  });

  it("redirect plus includes: includes first, redirect last, no all", () => {
    expect(propose("v=spf1 redirect=_spf.example.com include:a.test", ["b.test"])).toBe("v=spf1 include:a.test include:b.test redirect=_spf.example.com");
    expect(propose("v=spf1 redirect=x.test", ["mail.test"])).not.toMatch(/all/);
  });

  it("a record with both all and redirect keeps its all and drops the redirect receivers already ignore (the record means the same, and the apply route accepts it)", () => {
    expect(propose("v=spf1 include:a.test -all redirect=x.test")).toBe("v=spf1 include:a.test -all");
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
