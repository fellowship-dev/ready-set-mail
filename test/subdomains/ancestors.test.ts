// B9 (audit): a subdomain's parent_id looked one label up only, so cf-bounce.app.example.com with no app.example.com row became a sibling
// root although example.com is listed. The nearest listed ancestor, up to the organizational domain (never a public suffix), is its parent.
import { describe, expect, it } from 'vitest';
import { forWorkspace } from '@ready-set-mail/db';
import { createMigratedD1 } from '@ready-set-mail/db/testing';

function world() {
  const db = createMigratedD1();
  db.sqlite.prepare("INSERT INTO workspaces (id, name) VALUES ('ws_a', 'A')").run();
  return { db, q: () => forWorkspace(db as unknown as D1Database, 'ws_a') };
}
const parentOf = (db: ReturnType<typeof world>['db'], name: string) => (db.sqlite.prepare('SELECT p.domain AS parent FROM domains d LEFT JOIN domains p ON p.id = d.parent_id WHERE d.domain = ?').get(name) as { parent: string | null }).parent;

describe('B9: parent_id is the nearest listed ancestor', () => {
  it('skips a middle label with no row: cf-bounce.app.example.com hangs under example.com', async () => {
    const { db, q } = world();
    await q().domains.insert({ domain: 'example.com', rua_address: 'r@x' });
    await q().domains.insert({ domain: 'cf-bounce.app.example.com', rua_address: 'r@x' });
    expect(parentOf(db, 'cf-bounce.app.example.com')).toBe('example.com');
  });
  it('prefers the nearest listed ancestor', async () => {
    const { db, q } = world();
    await q().domains.insert({ domain: 'example.com', rua_address: 'r@x' });
    await q().domains.insert({ domain: 'app.example.com', rua_address: 'r@x' });
    await q().domains.insert({ domain: 'cf-bounce.app.example.com', rua_address: 'r@x' });
    expect(parentOf(db, 'cf-bounce.app.example.com')).toBe('app.example.com');
  });
  it('never reaches above the organizational domain: a name under a public suffix has no parent', async () => {
    const { db, q } = world();
    await q().domains.insert({ domain: 'github.io', rua_address: 'r@x' });
    await q().domains.insert({ domain: 'alice.github.io', rua_address: 'r@x' });
    expect(parentOf(db, 'alice.github.io')).toBeNull();
  });
});
