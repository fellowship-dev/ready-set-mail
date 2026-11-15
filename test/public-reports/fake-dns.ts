// Fake DoH answers for the public-report checks (ported from the website's __tests__/tools/helpers.ts).
import type { FetchLike } from "@ready-set-mail/dns-checks";

/**
 * What the next resolver uses: the src resolver takes options instead of module state, so the test files that need a fake DoH mock
 * `createToolsResolver` to read these (see `fakeResolverModule`).
 */
export const dnsHooks: { fetch: FetchLike | null; timeoutMs: number | null } = { fetch: null, timeoutMs: null };
export function setDnsFetch(impl: FetchLike | null): void {
  dnsHooks.fetch = impl;
}
export function setDnsTimeoutMs(ms: number | null): void {
  dnsHooks.timeoutMs = ms;
}

/** For `vi.mock("../../src/public-reports/resolver", fakeResolverModule)`: the real module, with the hooks above as defaults. */
export async function fakeResolverModule(importOriginal: () => Promise<unknown>) {
  const real = (await importOriginal()) as typeof import("../../src/public-reports/resolver");
  return {
    ...real,
    createToolsResolver: (o: Parameters<typeof real.createToolsResolver>[0] = {}) =>
      real.createToolsResolver({ ...(dnsHooks.fetch ? { fetch: dnsHooks.fetch } : {}), ...(dnsHooks.timeoutMs ? { timeoutMs: dnsHooks.timeoutMs } : {}), ...o }),
  };
}

export type Rec =
  | { txt: string[] }
  | { answers: { type: number; data: string }[] }
  | "nodata"
  | "nxdomain"
  | "servfail"
  | "refused"
  | "http500"
  | "badjson"
  | "network"
  | "hang";

export interface FakeDns {
  /** Every request as `host name type`. */
  calls: { host: string; name: string; type: string }[];
  /** Distinct DNS names asked, in first-seen order. */
  names(): string[];
}

/** Install a fake fetch answering from `zone` ("name/TYPE" keys; unknown names are NXDOMAIN). */
export function installFakeDns(zone: Record<string, Rec>, perHost?: Record<string, Record<string, Rec>>): FakeDns {
  const calls: FakeDns["calls"] = [];
  const impl: FetchLike = async (input, init) => {
    const url = new URL(input);
    const name = url.searchParams.get("name") ?? "";
    const type = url.searchParams.get("type") ?? "";
    calls.push({ host: url.host, name, type });
    const rec: Rec = perHost?.[url.host]?.[`${name}/${type}`] ?? zone[`${name}/${type}`] ?? "nxdomain";
    const json = (body: unknown, status = 200) => ({ status, ok: status === 200, json: async () => body }) as unknown as Response;
    if (rec === "network") throw new Error("boom");
    if (rec === "hang") {
      return new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      });
    }
    if (rec === "http500") return json({}, 500);
    if (rec === "badjson") return { status: 200, ok: true, json: async () => { throw new Error("bad"); } } as unknown as Response;
    if (rec === "nxdomain") return json({ Status: 3 });
    if (rec === "servfail") return json({ Status: 2 });
    if (rec === "refused") return json({ Status: 5 });
    if (rec === "nodata") return json({ Status: 0, Authority: [] });
    if ("answers" in rec) {
      return json({ Status: 0, Answer: rec.answers.map((a) => ({ name: `${name}.`, type: a.type, TTL: 300, data: a.data })) });
    }
    return json({
      Status: 0,
      Answer: rec.txt.map((t) => ({ name: `${name}.`, type: 16, TTL: 300, data: `"${t}"` })),
    });
  };
  setDnsFetch(impl);
  setDnsTimeoutMs(50);
  return { calls, names: () => [...new Set(calls.map((c) => c.name))] };
}

export function resetFakeDns(): void {
  setDnsFetch(null);
  setDnsTimeoutMs(null);
}
