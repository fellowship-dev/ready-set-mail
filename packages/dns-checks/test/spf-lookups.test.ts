import { describe, expect, it } from "vitest";
import { SPF_LOOKUP_LIMIT as CHECKS_LIMIT } from "../src/spf";
import { SPF_LOOKUP_LIMIT, spfLookupJudgement } from "../src/spf-record";

describe("spfLookupJudgement (RFC 7208 section 4.6.4)", () => {
  it("is the one limit the resolver checks use too", () => {
    expect(CHECKS_LIMIT).toBe(SPF_LOOKUP_LIMIT);
    expect(SPF_LOOKUP_LIMIT).toBe(10);
  });

  it.each([
    [0, "ok", "pass"],
    [7, "ok", "pass"],
    [8, "near", "warn"],
    [9, "near", "warn"],
    [10, "at", "warn"],
    [11, "over", "fail"],
    [25, "over", "fail"],
  ] as const)("%i lookups: %s", (n, level, status) => {
    const j = spfLookupJudgement(n);
    expect([j.level, j.status]).toEqual([level, status]);
    expect(j.label.length).toBeGreaterThan(0);
    expect(j.detail).toMatch(/\.$/);
    if (n <= 10) expect(j.detail).not.toMatch(/permanent error, so SPF fails/);
  });
});
