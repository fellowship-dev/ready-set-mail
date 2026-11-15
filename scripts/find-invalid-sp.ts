// Which of these names publish a DMARC record with an invalid sp=? Reads domain names on stdin (one per line; blank lines
// and anything after whitespace are ignored), reads `_dmarc.<name>` from public DNS (DoH, the same resolver the Worker
// uses) and prints `<name>\t<record>` for each whose record has an sp= that is not none, quarantine or reject, judged by
// the dashboard's own rule (packages/dns-checks/src/dmarc-problem.ts). Read-only. Names it could not read go to stderr.
//
//   npm run wrangler -- d1 execute DB --remote --json --command "SELECT DISTINCT COALESCE(dmarc_inherited_from, domain) AS record_at FROM domains WHERE evicted_at IS NULL AND dns_checked_at IS NOT NULL" \
//     | jq -r '.[0].results[].record_at' | npx tsx scripts/find-invalid-sp.ts
//
// See packages/db/UPGRADING.md ("Domains with an invalid sp=").

import { pathToFileURL } from 'node:url';
import { createResolver, isDmarcRecord, type Resolver } from '@ready-set-mail/dns-checks';
import { dmarcBreakOf } from '@ready-set-mail/dns-checks/dmarc-problem';

export interface InvalidSp {
  name: string;
  record: string;
}

/** The names among `names` whose single DMARC record has an invalid sp=, and the names that could not be read. */
export async function findInvalidSp(names: Iterable<string>, resolver: Resolver = createResolver()): Promise<{ found: InvalidSp[]; failed: string[] }> {
  const found: InvalidSp[] = [];
  const failed: string[] = [];
  const seen = new Set<string>();
  for (const raw of names) {
    const name = raw.trim().split(/\s+/)[0]?.toLowerCase().replace(/\.$/, '') ?? '';
    if (!name || seen.has(name)) continue;
    seen.add(name);
    const r = await resolver.txt(`_dmarc.${name}`);
    if (r.status === 'error') {
      failed.push(name);
      continue;
    }
    // Several v=DMARC1 records are a different problem (receivers ignore all of them); only a single record is judged here.
    const records = r.records.map((t) => t.trim()).filter(isDmarcRecord);
    if (records.length !== 1) continue;
    const record = records[0]!;
    if (dmarcBreakOf(record)?.issue === 'invalid_sp') found.push({ name, record });
  }
  return { found, failed };
}

async function main() {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  const { found, failed } = await findInvalidSp(input.split('\n'));
  for (const f of found) process.stdout.write(`${f.name}\t${f.record}\n`);
  for (const n of failed) process.stderr.write(`could not read _dmarc.${n}\n`);
  process.exitCode = failed.length ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) void main();
