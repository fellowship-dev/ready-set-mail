// The flattened record must give the same SPF result as the original, for every sender, and stay within the limits.
// Random SPF trees (seeded), an independent RFC 7208 evaluator (spf-eval.ts), the engine under test (src/spf-flatten.ts).
// CI runs PROP_TREES (default 2,000) trees; `scripts/spf-property.sh N` runs N and writes a JSON summary.
import { describe, it, expect } from 'vitest';
import { runProperty } from './spf-property';

declare const process: { env: Record<string, string | undefined> };

describe('flattening property test', () => {
  it('flattened record evaluates like the original for random senders, within the limits', async () => {
    const trees = Number(process.env.PROP_TREES ?? 2000);
    const seedStart = Number(process.env.PROP_SEED_START ?? 1);
    const summary = await runProperty({ trees, seedStart });
    const { failures: _examples, ...counts } = summary;
    console.log(`SPF_PROPERTY_SUMMARY ${JSON.stringify(counts)}`);
    // PROP_OUT: write the whole summary (with failure examples) there, as `scripts/spf-property.sh` asks.
    if (process.env.PROP_OUT) {
      const fs = await import('node:' + 'fs');
      fs.writeFileSync(process.env.PROP_OUT, JSON.stringify(summary, null, 1));
    }
    expect(summary.failures, JSON.stringify(summary.failureKinds)).toEqual([]);
  }, 3_600_000);
});
