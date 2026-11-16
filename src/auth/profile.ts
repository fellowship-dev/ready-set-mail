// What a person says about themselves on the second sign-up screen ("Tell us about yourself"), and where it is kept.
//
// Held with the pending sign-up attempt (codes.ts, key `prof`) until the emailed code is right, then written once to the account
// (a row in the existing verifications table, like `code-proven:` and `device-epoch:`: no migration) and the display name.
// It is profile text and nothing more: never an instruction, never a permission, never shown to anyone but the person and,
// as the account's name, their teammates. Every field is bounded and cleaned (names.ts cleanName) before it is stored.
import type { AuthEnv } from './config';
import { cleanName } from './names';

/** Whose email the person is setting up. The only answer that changes the flow. */
export const WHOSE_EMAIL = ['company', 'clients', 'looking'] as const;
export type WhoseEmail = (typeof WHOSE_EMAIL)[number];

/** The optional role select. */
export const ROLES = ['founder', 'developer', 'it', 'marketing', 'agency', 'other'] as const;
export type Role = (typeof ROLES)[number];

/** Longest values kept, in characters. The organization name is bounded by the workspace name rule (80) because it becomes one. */
export const PROFILE_LIMITS = { name: 100, organization: 80, heard_about: 200 } as const;

export interface SignupProfile {
  name: string;
  organization: string;
  whose_email: WhoseEmail;
  /** Absent when not given. */
  role?: Role;
  /** Absent when not given. Free text, stored as profile text only. */
  heard_about?: string;
}

export type ProfileCheck = { ok: true; profile: SignupProfile } | { ok: false; field: string; message: string };

const tooLong = (raw: string, max: number) => [...raw.trim()].length > max;

/**
 * Validate what the form sent. Strict: wrong types, unknown enum values and values over their bounds are refused (never silently
 * cut), required fields must be present, and unknown keys are ignored (never stored).
 */
export function checkProfile(body: unknown): ProfileCheck {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const text = (key: 'name' | 'organization' | 'heard_about', required: boolean, label: string): { value: string } | { field: string; message: string } => {
    const raw = b[key];
    if (raw === undefined || raw === null || raw === '') return required ? { field: key, message: `${label} is required` } : { value: '' };
    if (typeof raw !== 'string') return { field: key, message: `${label} must be text` };
    if (tooLong(raw, PROFILE_LIMITS[key])) return { field: key, message: `${label} must be at most ${PROFILE_LIMITS[key]} characters` };
    const value = cleanName(raw, PROFILE_LIMITS[key]);
    return value || !required ? { value } : { field: key, message: `${label} is required` };
  };
  const name = text('name', true, 'Your name');
  if ('field' in name) return { ok: false, ...name };
  const organization = text('organization', true, 'Organization name');
  if ('field' in organization) return { ok: false, ...organization };
  const whose = b.whose_email;
  if (typeof whose !== 'string' || !(WHOSE_EMAIL as readonly string[]).includes(whose)) return { ok: false, field: 'whose_email', message: 'Choose whose email you are setting up' };
  const roleRaw = b.role;
  if (roleRaw !== undefined && roleRaw !== null && roleRaw !== '' && (typeof roleRaw !== 'string' || !(ROLES as readonly string[]).includes(roleRaw))) return { ok: false, field: 'role', message: 'Choose one of the roles listed' };
  const heard = text('heard_about', false, 'Where you heard about us');
  if ('field' in heard) return { ok: false, ...heard };
  return {
    ok: true,
    profile: {
      name: name.value,
      organization: organization.value,
      whose_email: whose as WhoseEmail,
      ...(typeof roleRaw === 'string' && roleRaw ? { role: roleRaw as Role } : {}),
      ...(heard.value ? { heard_about: heard.value } : {}),
    },
  };
}

/** A stored profile, re-validated on the way out (a row is data, not trusted): null when it is not a valid profile. */
export function readProfile(value: unknown): SignupProfile | null {
  const c = checkProfile(value);
  return c.ok ? c.profile : null;
}

const identifier = (userId: string) => `account-profile:${userId}`;

/** Written 20 years ahead, like the other per-account rows kept in `verifications`. */
const KEEP_SECONDS = 20 * 365 * 86400;

/** Store the profile on the account (replacing any earlier one) and the person's name on the user. */
export async function applyProfile(env: AuthEnv, userId: string, profile: SignupProfile): Promise<void> {
  const db = env.DB as D1Database;
  await db.batch([
    db.prepare('DELETE FROM verifications WHERE identifier = ?1').bind(identifier(userId)),
    db.prepare('INSERT INTO verifications (id, identifier, value, expires_at) VALUES (?1, ?2, ?3, ?4)')
      .bind(crypto.randomUUID(), identifier(userId), JSON.stringify(profile), Math.floor(Date.now() / 1000) + KEEP_SECONDS),
    db.prepare('UPDATE users SET name = ?1 WHERE id = ?2').bind(profile.name, userId),
  ]);
}

/** The account's profile, or null (an account made by an invite, an OAuth login, self-host setup, or before this existed). */
export async function accountProfile(env: AuthEnv, userId: string): Promise<SignupProfile | null> {
  const row = await (env.DB as D1Database).prepare('SELECT value FROM verifications WHERE identifier = ?1 ORDER BY created_at DESC LIMIT 1').bind(identifier(userId)).first<{ value: string }>();
  if (!row) return null;
  try {
    return readProfile(JSON.parse(row.value));
  } catch {
    return null;
  }
}
