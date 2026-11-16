// What a self-registered app may call itself, and which names no self-registered app may claim: ONE module, read by the registration
// check (src/mcp/registration.ts) and by the pages that show a name (src/mcp/connections.ts, src/mcp/consent.ts). The web dashboard
// does not keep a copy; the connect steps for each assistant are a different list (web/src/lib/agent-clients.ts).
//
// A self-registered name is a claim anyone can make, so it is never what a person is asked to trust: the pages lead with the address the
// app sends you back to, and show the name as "calls itself". This module only keeps the claim from being a deception:
//   - letters are NFKC-normalised; a name that mixes scripts (Latin with Cyrillic or Greek) is refused, because it reads as one thing and is another;
//   - a name that says it is verified, official, certified or carries a check mark is refused;
//   - a name that is, or contains, a well-known assistant or company (reserved below) is accepted but withheld: the app registers, its name is
//     not stored, and it is shown by its address only. Withholding rather than refusing keeps real Cursor and Claude Code registrations working.
import { cleanName } from '../auth/names';

export const MAX_NAME_LENGTH = 80;

/** Names a self-registered app cannot present as its own. Compared on the skeleton (see `skeleton`), so spacing, case, accents and look-alike letters do not get round it. */
export const RESERVED_APP_NAMES: readonly string[] = Object.freeze([
  'Claude', 'Claude Code', 'Anthropic', 'ChatGPT', 'OpenAI', 'Codex', 'Cursor', 'Anysphere', 'VS Code', 'Visual Studio Code', 'VSCode', 'Visual Studio',
  'Copilot', 'GitHub', 'Gemini', 'Google', 'Microsoft', 'Perplexity', 'Windsurf', 'Cloudflare', 'Ready Set Mail', 'ReadySetMail',
]);

/** Letters from other scripts that are written like Latin ones. Not complete: it covers what a person cannot tell apart on screen; mixed scripts are refused outright anyway. */
const LOOKALIKES: Readonly<Record<string, string>> = Object.freeze({
  'а': 'a', 'е': 'e', 'о': 'o', 'р': 'p', 'с': 'c', 'х': 'x', 'у': 'y', 'і': 'i', 'ј': 'j', 'ѕ': 's', 'ԁ': 'd', 'һ': 'h', 'к': 'k', 'м': 'm', 'н': 'h', 'т': 't', 'в': 'b', 'ӏ': 'l', 'ԛ': 'q', 'ԝ': 'w',
  'α': 'a', 'ε': 'e', 'ο': 'o', 'ρ': 'p', 'ν': 'v', 'ι': 'i', 'κ': 'k', 'τ': 't', 'υ': 'u', 'χ': 'x', 'η': 'n', 'β': 'b', 'μ': 'u',
  '0': 'o', '3': 'e', '4': 'a', '5': 's', '7': 't', '$': 's', '@': 'a',
});
/** A character that can stand for either of two letters: each is tried both ways. */
const EITHER: Readonly<Record<string, readonly [string, string]>> = Object.freeze({ '1': ['l', 'i'], '!': ['i', 'l'], '|': ['l', 'i'] });

/** What a name looks like once spacing, case, accents, symbols and look-alike letters are taken away; `either` picks the reading of a character that can be two letters (1: l or i). */
export function skeleton(name: string, either: 0 | 1 = 0): string {
  const folded = name.normalize('NFKC').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
  let out = '';
  for (const ch of folded) out += EITHER[ch]?.[either] ?? LOOKALIKES[ch] ?? ch;
  return out.replace(/[^\p{L}\p{N}]/gu, '');
}
const RESERVED_SKELETONS = RESERVED_APP_NAMES.map(n => skeleton(n));

/** Whether a name is, or contains, a reserved one. */
export const isReservedName = (name: string): boolean => ([0, 1] as const).some(either => { const s = skeleton(name, either); return RESERVED_SKELETONS.some(r => s.includes(r)); });

const SCRIPT = (ch: string): 'latin' | 'cyrillic' | 'greek' | 'other' | null => {
  if (/\p{Script=Latin}/u.test(ch)) return 'latin';
  if (/\p{Script=Cyrillic}/u.test(ch)) return 'cyrillic';
  if (/\p{Script=Greek}/u.test(ch)) return 'greek';
  return /\p{L}/u.test(ch) ? 'other' : null;
};
/** More than one script among the letters: "Сlaude" (Cyrillic С) reads as Claude and is not. */
export const mixesScripts = (name: string): boolean => new Set([...name].map(SCRIPT).filter(Boolean)).size > 1;

/** Words and marks that claim a check that was never made. Matched on the skeleton-free text, case-insensitively. */
const CLAIM_WORDS = /\b(?:verified|official|officially|certified|authenticated|trusted|authorized|authorised|approved by|endorsed)\b/i;
const CHECK_MARKS = /[✓✔✅☑❗\u{1F5F8}\u{1F6E1}\u{1F512}\u{1F510}\u{2B50}\u{1F31F}®™]/u;

export type NameVerdict = { ok: true; name: string | null; withheld?: 'reserved' } | { ok: false; reason: string };

/**
 * The name a self-registered app gave: `ok` with the cleaned name, `ok` with `name: null` when it is withheld, or refused with the sentence for the app.
 * An empty name is fine (the app is shown by its address).
 */
export function vetClientName(raw: string): NameVerdict {
  const typed = raw.normalize('NFKC').trim();
  if (!typed) return { ok: true, name: null };
  if (typed.length > MAX_NAME_LENGTH) return { ok: false, reason: `client_name must be at most ${MAX_NAME_LENGTH} characters.` };
  // Controls (a tab, a line break) are refused as typed; only runs of spaces are tidied.
  if (/[\p{C}\p{Zl}\p{Zp}<>&]/u.test(typed)) return { ok: false, reason: 'client_name must be plain text, without control characters, < > or &.' };
  const name = typed.replace(/ {2,}/g, ' ');
  if (/[a-z][a-z0-9+.-]*:\/\/|\bwww\./i.test(name)) return { ok: false, reason: 'client_name must be a name, not a web address.' };
  if (mixesScripts(name)) return { ok: false, reason: 'client_name must not mix alphabets (for example Latin and Cyrillic letters).' };
  if (CLAIM_WORDS.test(name) || CHECK_MARKS.test(name) || CHECK_MARKS.test(raw)) return { ok: false, reason: 'client_name must not claim to be verified, official or approved: this server does not check names.' };
  if (isReservedName(name)) return { ok: true, name: null, withheld: 'reserved' };
  return { ok: true, name };
}

/** A name to show a person as the app's own words: cleaned like every other name on a page, NFKC, and never empty. Null when there is none to show. */
export function describedName(raw: string | undefined | null): string | null {
  const cleaned = cleanName(raw ? raw.normalize('NFKC') : raw);
  return cleaned || null;
}
