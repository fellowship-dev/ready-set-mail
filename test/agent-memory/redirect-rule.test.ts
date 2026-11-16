import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// A guard on the SOURCE of the redirect rule (the behaviour is in test/mcp/redirect-problem.test.ts): an `http:` redirect address may only pass through
// `isLoopbackHost`, and that function may name nothing but this computer. A change that lets http through for another host, or widens "this computer",
// fails here before anyone reads a diff. ADR 0015.
const source = readFileSync(join(__dirname, '../../src/mcp/registration.ts'), 'utf8');
const body = (name: string) => { const start = source.indexOf(`function ${name}`); expect(start, `function ${name}`).toBeGreaterThan(-1); return source.slice(start, source.indexOf('\n}\n', start) + 2); };

describe('the redirect rule keeps http for this computer', () => {
  it('the http branch of redirectProblem decides by isLoopbackHost, and only that', () => {
    const rule = body('redirectProblem');
    const http = rule.split('\n').filter(l => l.includes("'http:'"));
    expect(http).toHaveLength(1);
    expect(http[0]).toContain('isLoopbackHost(url.hostname) ? null');
    expect(http[0]).not.toMatch(/\|\||&&|true|\? null : null/);
  });
  it('isLoopbackHost names localhost, 127.0.0.1 and [::1] and nothing else', () => {
    const line = source.split('\n').find(l => l.includes('isLoopbackHost = '))!;
    expect(line).toBeTruthy();
    expect([...line.matchAll(/'([^']+)'/g)].map(m => m[1]).sort()).toEqual(['127.0.0.1', '[::1]', 'localhost']);
    expect(line).not.toMatch(/startsWith|endsWith|includes|test\(|match\(|RegExp|\.\*/);
  });
  it('is the only place that lets an http address through: no other http: protocol branch in the registration check', () => {
    expect(source.split('\n').filter(l => /protocol\s*===\s*'http:'/.test(l))).toHaveLength(1);
  });
});
