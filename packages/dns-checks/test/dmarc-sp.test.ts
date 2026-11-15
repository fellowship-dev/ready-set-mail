import { describe, expect, it } from "vitest";
import { parseDmarcRecord } from "../src/dmarc";

// RFC 7489 section 6.6.3 (step 6): an invalid sp= means the record is not applied as written.
describe("an invalid sp= (RFC 7489 section 6.6.3)", () => {
  it("with a valid rua=, receivers act as if the record were p=none, for the domain and its subdomains", () => {
    const r = parseDmarcRecord("v=DMARC1; p=reject; sp=bogus; rua=mailto:a@b.test");
    expect([r.policy, r.subdomainPolicy, r.valid]).toEqual(["none", "none", true]);
    expect(r.issues).toContain('Invalid sp= value "bogus"');
  });
  it("without a valid rua=, no DMARC applies", () => {
    expect(parseDmarcRecord("v=DMARC1; p=reject; sp=bogus").valid).toBe(false);
  });
  it("a valid sp= is unchanged", () => {
    const r = parseDmarcRecord("v=DMARC1; p=reject; sp=quarantine");
    expect([r.policy, r.subdomainPolicy, r.valid]).toEqual(["reject", "quarantine", true]);
  });
});
