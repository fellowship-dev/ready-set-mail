// What a refresh tells the rest of the product. Emitted only on a transition (a change, a problem that is new or different, a recovery):
// a quiet run says nothing, so a consumer never has to tell "again" from "still".
//
// Two ways to consume it (docs/spf-flattening.md, "Telling the owner"):
//  - the stored facts, which the state-based lifecycle emails read: `spf_flatten_config.last_flattened_at` (a change; its value is the period),
//    `problem_kind` and `problem_since` (a problem; `problem_since` is the period), and `scope.spf.noticesSince` (src/db scope);
//  - this typed event, handed to `SpfDeps.onEvent` (the default sends the analytics event of src/product-analytics/steps.ts spfRefreshed).

import type { SPF_PROBLEMS } from '../product-analytics/events';

export type SpfProblemKind = (typeof SPF_PROBLEMS)[number];

export type SpfRefreshEvent =
  | { type: 'spf.changed'; workspaceId: string; domainId: number; domain: string; at: number; ipCount: number }
  | { type: 'spf.problem'; workspaceId: string; domainId: number; domain: string; at: number; problem: SpfProblemKind; since: number; /** the kind is new for this streak */ first: boolean }
  | { type: 'spf.recovered'; workspaceId: string; domainId: number; domain: string; at: number };
