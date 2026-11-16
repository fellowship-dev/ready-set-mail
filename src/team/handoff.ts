// "Hand setup to a teammate" (spec H1, H2, I1): an ordinary admin invite (src/api/router.ts POST /api/team/invite) that also says which
// domain the invitee is to finish. The invite itself is unchanged (7 days, owner-only for an admin, the same claim and accept paths).
// What it carries beyond that lives in one row of the existing verifications table, `invite-handoff:<invite token>` (no migration):
// the workspace, the domain's name, who asked, and where it was sent. The row outlives the invite so the inviter's dashboard can say
// where the hand-off stands; it is never read for anything but wording and routing, and grants nothing.
import type { AuthEnv } from '../auth/config';
import { cleanName } from '../auth/names';

const PREFIX = 'invite-handoff:';
/** The row is kept 30 days: the invite lasts 7, and the inviter's dashboard shows the rest until the records are live. */
export const HANDOFF_KEEP_SECONDS = 30 * 86400;
/** Most hand-offs waiting at once per workspace, and sent per day: a hand-off emails a person who has no account. */
export const MAX_OPEN_HANDOFFS = 5;
export const MAX_HANDOFFS_PER_DAY = 10;

export interface Handoff {
  token: string;
  workspaceId: string;
  /** The domain's name, as the workspace holds it (a domain, or a claim still waiting for proof). */
  domain: string;
  /** Who asked, shown to the invitee: cleaned name and address. */
  inviterName: string;
  inviterEmail: string;
  /** Where it was sent (lower-case). */
  email: string;
  /** Unix seconds. */
  sentAt: number;
}

type Stored = Omit<Handoff, 'token'>;

export async function saveHandoff(env: AuthEnv, h: Handoff): Promise<void> {
  const stored: Stored = { workspaceId: h.workspaceId, domain: h.domain, inviterName: cleanName(h.inviterName, 80), inviterEmail: h.inviterEmail, email: h.email, sentAt: h.sentAt };
  await (env.DB as D1Database).prepare('INSERT INTO verifications (id, identifier, value, expires_at) VALUES (?1, ?2, ?3, ?4)')
    .bind(crypto.randomUUID(), `${PREFIX}${h.token}`, JSON.stringify(stored), h.sentAt + HANDOFF_KEEP_SECONDS).run();
}

function parse(token: string, value: string): Handoff | null {
  try {
    const s = JSON.parse(value) as Partial<Stored>;
    if (typeof s.workspaceId !== 'string' || typeof s.domain !== 'string' || typeof s.email !== 'string' || typeof s.sentAt !== 'number') return null;
    return { token, workspaceId: s.workspaceId, domain: s.domain, inviterName: cleanName(s.inviterName, 80), inviterEmail: String(s.inviterEmail ?? ''), email: s.email, sentAt: s.sentAt };
  } catch {
    return null;
  }
}

/** The hand-off an invite token carries, or null (an ordinary invite). */
export async function handoffOf(env: AuthEnv, token: string): Promise<Handoff | null> {
  const row = await (env.DB as D1Database).prepare('SELECT value FROM verifications WHERE identifier = ?1 AND expires_at >= ?2').bind(`${PREFIX}${token}`, Math.floor(Date.now() / 1000)).first<{ value: string }>();
  return row ? parse(token, row.value) : null;
}

/** Every live hand-off of a workspace, newest first. */
export async function handoffsOf(env: AuthEnv, workspaceId: string): Promise<Handoff[]> {
  const rows = await (env.DB as D1Database).prepare("SELECT identifier, value FROM verifications WHERE identifier LIKE 'invite-handoff:%' AND expires_at >= ?1 AND json_extract(value, '$.workspaceId') = ?2")
    .bind(Math.floor(Date.now() / 1000), workspaceId).all<{ identifier: string; value: string }>();
  return (rows.results ?? []).map((r) => parse(r.identifier.slice(PREFIX.length), r.value)).filter((h): h is Handoff => !!h).sort((a, b) => b.sentAt - a.sentAt);
}

export async function deleteHandoff(env: AuthEnv, token: string): Promise<void> {
  await (env.DB as D1Database).prepare('DELETE FROM verifications WHERE identifier = ?1').bind(`${PREFIX}${token}`).run();
}
