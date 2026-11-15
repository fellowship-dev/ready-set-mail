// DoH wiring for public reports, ported from ready-set-mail-website frontend/lib/tools/resolver.ts: Cloudflare first, Google on an error,
// at most 8 lookups in flight and 80 per check, so a hostile SPF tree cannot fan out inside one Worker request.
import {
  createResolver,
  type DnsRecordType,
  type DnsResponse,
  type FetchLike,
  type Resolver,
  type TxtResult,
} from "@ready-set-mail/dns-checks";

// Site-side wiring for the vendored dns-checks package: which DoH hosts to use, a fallback, a concurrency cap and a
// per-check query budget. None of the check logic lives here.

export type { FetchLike };

export const PRIMARY_DOH = "https://cloudflare-dns.com/dns-query";
export const FALLBACK_DOH = "https://dns.google/resolve";

const DEFAULT_TIMEOUT_MS = 4000;
/** In-flight DoH requests per check (the DKIM scan fires 36 at once otherwise). */
const MAX_CONCURRENCY = 8;
/** Hard cap on DoH requests per check, so a hostile SPF tree cannot fan out. Over it, lookups report an error. */
const MAX_QUERIES = 80;

export interface ToolsResolverOptions {
  /** Tests inject a fake DoH; production uses the global fetch. */
  fetch?: FetchLike;
  timeoutMs?: number;
}

/**
 * A Resolver that asks Cloudflare first and Google second. It falls back ONLY when the first answer is an error:
 * `nodata` and `nxdomain` are authoritative answers and are never second-guessed.
 */
export function createToolsResolver(options: ToolsResolverOptions = {}): Resolver {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fetchImpl = options.fetch;
  const primary = createResolver({ endpoint: PRIMARY_DOH, timeoutMs, ...(fetchImpl ? { fetch: fetchImpl } : {}) });
  const secondary = createResolver({ endpoint: FALLBACK_DOH, timeoutMs, ...(fetchImpl ? { fetch: fetchImpl } : {}) });

  let active = 0;
  let queries = 0;
  const waiting: (() => void)[] = [];
  const acquire = async () => {
    if (active >= MAX_CONCURRENCY) await new Promise<void>((resolve) => waiting.push(resolve));
    active++;
  };
  const release = () => {
    active--;
    waiting.shift()?.();
  };

  async function guarded<T extends { status: string }>(run: () => Promise<T>, overBudget: () => T): Promise<T> {
    await acquire();
    try {
      if (queries >= MAX_QUERIES) return overBudget();
      queries++;
      return await run();
    } finally {
      release();
    }
  }

  const budgetError = "too many DNS queries for one check";

  async function resolve(name: string, type: DnsRecordType): Promise<DnsResponse> {
    const first = await guarded(() => primary.resolve(name, type), () => ({ status: "error" as const, answers: [], error: budgetError }));
    if (first.status !== "error" || first.error === budgetError) return first;
    const second = await guarded(() => secondary.resolve(name, type), () => first);
    return second.status === "error" ? first : second;
  }

  async function txt(name: string): Promise<TxtResult> {
    const first = await guarded(() => primary.txt(name), () => ({ status: "error" as const, records: [], error: budgetError }));
    if (first.status !== "error" || first.error === budgetError) return first;
    const second = await guarded(() => secondary.txt(name), () => first);
    return second.status === "error" ? first : second;
  }

  return { resolve, txt, fetch: primary.fetch };
}
