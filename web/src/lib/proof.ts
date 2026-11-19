import type { Domain } from './types';

/** The part of a domain row the proven rule reads (so callers type what they pass without naming the column). */
export type ProofShape = Pick<Domain, 'verified_via'>;
/** What a caller may pass when it holds the domain row only in part (the verdict reads a row; a bare name has no proof to judge). */
export type ProofState = Partial<Pick<Domain, 'verified_via' | 'proof_lost_at'>>;
/** A domain the workspace holds but cannot show it controls (the ownership module's rule, `verified_via` legacy). */
export const isUnproven = (d: Partial<ProofShape>): boolean => d.verified_via === 'legacy';
/** Unproven because a proof that was made lapsed (as opposed to one that never was). */
export const proofLapsed = (d: ProofState): boolean => d.proof_lost_at != null;
