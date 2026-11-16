// Operator allow-settings of the hosted service: the one parser and the one "is this the operator's own workspace" test.
//
// Two settings use it: HOSTED_CONNECT_REPORTS (who may connect reports to the shared address; src/hosted/fixed-address.ts) and
// HOSTED_SPF_FLATTENING (who may use SPF flattening; src/hosted/plan-limits.ts addOnAccess). The words are the same:
//   `owner`   the workspaces owned by the OWNER_EMAIL account (the operator's own)
//   `all`     every workspace
//   `ws_...`  one workspace by id (a comma list, with or without `owner`); only where the setting takes ids
// A value that is not understood admits nobody beyond the default and is reported by the owner's setup check (`valid: false`).

import { forWorkspace } from '@ready-set-mail/db';
import type { BoundEnv } from '../index';

export interface Allow {
  all: boolean;
  owner: boolean;
  ids: ReadonlySet<string>;
  /** False when something in the value was not understood (it was ignored). */
  valid: boolean;
}

const WORKSPACE_ID = /^ws_[a-z0-9]+$/;

/**
 * `raw` is the setting. Unset or empty: `fallback` ('owner' admits the operator's workspaces, 'off' nobody). `ids`: whether `ws_...` words are
 * accepted. Unknown words are ignored and make the value invalid; an invalid value never admits more than its understood words.
 */
export function parseAllow(raw: string | undefined, opts: { fallback: 'owner' | 'off'; ids: boolean }): Allow {
  const words = (raw ?? '').split(',').map(w => w.trim().toLowerCase()).filter(Boolean);
  if (words.length === 0) return { all: false, owner: opts.fallback === 'owner', ids: new Set(), valid: true };
  // A setting that takes one word (no ids) does not take a list: `all,owner` is not understood, as before.
  if (!opts.ids && words.length > 1) return { all: false, owner: opts.fallback === 'owner', ids: new Set(), valid: false };
  const out = { all: false, owner: false, ids: new Set<string>(), valid: true };
  for (const w of words) {
    if (w === 'all') out.all = true;
    else if (w === 'owner') out.owner = true;
    else if (opts.ids && WORKSPACE_ID.test(w)) out.ids.add(w);
    else out.valid = false;
  }
  // Nothing understood: the default, so a typo never opens a setting that is meant to be closed.
  if (!out.all && !out.owner && out.ids.size === 0) return { all: false, owner: opts.fallback === 'owner', ids: new Set(), valid: false };
  return out;
}

/** Is this workspace owned by the person who runs the instance (a team member with role `owner` whose email is OWNER_EMAIL)? */
export async function workspaceIsOperators(env: Pick<BoundEnv, 'OWNER_EMAIL' | 'DB'>, workspaceId: string): Promise<boolean> {
  const owner = env.OWNER_EMAIL?.trim().toLowerCase();
  if (!owner) return false;
  const team = await forWorkspace(env.DB, workspaceId).team.list();
  return team.some(m => m.role === 'owner' && m.email.toLowerCase() === owner);
}

/** May this workspace through the allow-setting? */
export async function allowed(setting: Allow, env: Pick<BoundEnv, 'OWNER_EMAIL' | 'DB'>, workspaceId: string): Promise<boolean> {
  if (setting.all || setting.ids.has(workspaceId.toLowerCase())) return true;
  return setting.owner && (await workspaceIsOperators(env, workspaceId));
}
