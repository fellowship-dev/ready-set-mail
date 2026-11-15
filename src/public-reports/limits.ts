// The limits on public reports, in one place: the request limits (src/public-reports/routes.ts), the storage budgets (also read by the
// daily job and the instance preflight) and how a client's network is counted.

export const PUBLIC_REPORT_LIMITS = {
  /** Reports an hour from one client: one IPv4 address, or one IPv6 /64 (a single host usually holds a whole /64). */
  perClientPerHour: 30,
  /** Reports an hour and a day from one network: an IPv4 /24 or an IPv6 /48. */
  perNetworkPerHour: 100,
  perNetworkPerDay: 200,
  /** New reports a UTC day for the whole instance (PUBLIC_REPORTS_DAILY_CAP). */
  dailyCap: 2000,
  dedupeSeconds: 60,
  /** One stored report at most (PUBLIC_REPORTS_MAX_REPORT_BYTES); ordinary reports measure 6.4 to 8.4 KB. */
  maxReportBytes: 32 * 1024,
  /** Bytes of new reports a UTC day (PUBLIC_REPORTS_DAILY_BYTES). */
  dailyBytes: 50 * 1024 * 1024,
  /** Bytes of all stored reports (PUBLIC_REPORTS_TOTAL_BYTES); past it no report is made until some are deleted. */
  totalBytes: 1024 * 1024 * 1024,
  /** The share of totalBytes at which the operator is told (a log line, and the instance preflight). */
  warnShare: 0.8,
  maxBodyBytes: 2048,
} as const;

export interface PublicReportEnv {
  PUBLIC_REPORTS_ENABLED?: string;
  PUBLIC_REPORTS_DAILY_CAP?: string;
  PUBLIC_REPORTS_MAX_REPORT_BYTES?: string;
  PUBLIC_REPORTS_DAILY_BYTES?: string;
  PUBLIC_REPORTS_TOTAL_BYTES?: string;
}

export interface StorageBudget {
  dailyCap: number;
  /** Never more than the daily or the total budget, so one report always fits an empty store. */
  maxReportBytes: number;
  dailyBytes: number;
  totalBytes: number;
  /** warnShare of totalBytes, in bytes. */
  warnBytes: number;
}

const positive = (raw: string | undefined, fallback: number) => {
  const n = Number(raw);
  return raw !== undefined && raw.trim() !== '' && Number.isSafeInteger(n) && n > 0 ? n : fallback;
};

/** The budgets as configured: a positive integer overrides a default, anything else keeps it. */
export function storageBudget(env: PublicReportEnv): StorageBudget {
  const totalBytes = positive(env.PUBLIC_REPORTS_TOTAL_BYTES, PUBLIC_REPORT_LIMITS.totalBytes);
  const dailyBytes = positive(env.PUBLIC_REPORTS_DAILY_BYTES, PUBLIC_REPORT_LIMITS.dailyBytes);
  return {
    dailyCap: positive(env.PUBLIC_REPORTS_DAILY_CAP, PUBLIC_REPORT_LIMITS.dailyCap),
    maxReportBytes: Math.min(positive(env.PUBLIC_REPORTS_MAX_REPORT_BYTES, PUBLIC_REPORT_LIMITS.maxReportBytes), dailyBytes, totalBytes),
    dailyBytes,
    totalBytes,
    warnBytes: Math.floor(totalBytes * PUBLIC_REPORT_LIMITS.warnShare),
  };
}

/** The UTC day of a time in ms, YYYY-MM-DD. */
export const utcDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** How one request is counted: its client (an IPv4 address or an IPv6 /64) and the network around it (an IPv4 /24 or an IPv6 /48). */
export interface ClientNetwork {
  client: string;
  network: string;
}

function ipv4Octets(s: string): number[] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
  if (!m) return null;
  const o = m.slice(1).map(Number);
  return o.every((n) => n <= 255) ? o : null;
}

/** The eight 16-bit groups of an IPv6 address (with "::" and a dotted IPv4 tail expanded), or null when it is not one. */
function ipv6Groups(raw: string): number[] | null {
  let s = raw.toLowerCase();
  if (!s.includes(':') || s.includes('%')) return null;
  let tail: number[] = [];
  const dotted = /(\d{1,3}(?:\.\d{1,3}){3})$/.exec(s);
  if (dotted) {
    const o = ipv4Octets(dotted[1]!);
    if (!o) return null;
    tail = [(o[0]! << 8) | o[1]!, (o[2]! << 8) | o[3]!];
    s = s.slice(0, -dotted[1]!.length);
    if (!s.endsWith('::')) s = s.slice(0, -1);
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const words = (part: string) => (part === '' ? [] : part.split(':'));
  const head = words(halves[0]!);
  const rest = halves.length === 2 ? words(halves[1]!) : [];
  if (![...head, ...rest].every((w) => /^[0-9a-f]{1,4}$/.test(w))) return null;
  const known = head.length + rest.length + tail.length;
  const gap = halves.length === 2 ? 8 - known : 0;
  if ((halves.length === 2 && gap < 1) || (halves.length === 1 && known !== 8)) return null;
  return [...head.map((w) => parseInt(w, 16)), ...Array<number>(gap).fill(0), ...rest.map((w) => parseInt(w, 16)), ...tail];
}

const hex = (groups: number[]) => groups.map((g) => g.toString(16)).join(':');

/**
 * The client and network a request is counted under, from the address Cloudflare saw (cf-connecting-ip). Null when there is no
 * usable address: such a request is refused, never pooled into one shared bucket.
 */
export function clientNetwork(ip: string | null | undefined): ClientNetwork | null {
  if (!ip) return null;
  const v4 = ipv4Octets(ip.trim());
  if (v4) return { client: `ip4:${v4.join('.')}`, network: `ip4:${v4.slice(0, 3).join('.')}.0/24` };
  const g = ipv6Groups(ip.trim());
  if (!g) return null;
  // An IPv4-mapped address (::ffff:a.b.c.d) is that IPv4 client.
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) {
    const o = [g[6]! >> 8, g[6]! & 255, g[7]! >> 8, g[7]! & 255];
    return { client: `ip4:${o.join('.')}`, network: `ip4:${o.slice(0, 3).join('.')}.0/24` };
  }
  return { client: `ip6:${hex(g.slice(0, 4))}::/64`, network: `ip6:${hex(g.slice(0, 3))}::/48` };
}
