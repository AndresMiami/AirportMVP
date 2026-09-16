/**
 * PROPOSAL / APPROVAL KERNEL — types.
 *
 *   AI / person / feature PROPOSES -> engine VALIDATES + PREVIEWS
 *   -> human REVIEWS -> human APPROVES -> canonical mutation
 *
 * A proposal is a pending request to change the model. It is not model
 * state; the canonical model and the export file never contain one. The
 * person approves not merely a mutation but a specific mutation for
 * specific reasons against a specific state of the world; when any of
 * the three changes, approval expires.
 */
import type { IntervalRequest } from "@/discovery/interval";
import type { PatternRef } from "@/discovery/cross-context";
import type { Revision } from "./revision";
import type { MutationStep } from "./registry";

/** WHO asked for the change: the operator, an AI adapter, or a
 *  deterministic feature. Never the modeled subject (that lives inside the
 *  mutation arguments), and never a source of information. */
export type ProposalAuthor =
  | { kind: "person"; actorId?: string }
  | { kind: "ai"; adapterId: string; conversationTurnId?: string }
  | { kind: "system_feature"; featureId: string };

/** Why the proposal exists. A basis is a reference, never proof. Every ref
 *  carries enough to RE-RESOLVE what the person saw (resolveBasis), so a
 *  change in the cited record, pattern, Explore comparison or catalogue
 *  question changes the review fingerprint. */
export type ProposalBasisRef =
  | { kind: "pattern"; ref: PatternRef; summary: string }
  /** The deterministic Explore comparison (occurrences vs contrasts) for a
   *  pattern; resolved by rerunning the existing engine under the model's
   *  current domain scope. */
  | { kind: "cross_context"; pattern: PatternRef; summary: string }
  | { kind: "observation"; id: string }
  | { kind: "event"; id: string }
  | { kind: "relationship"; id: string }
  | { kind: "hypothesis"; id: string }
  | { kind: "variable"; id: string }
  | { kind: "variable_history"; variableId: string; interval: IntervalRequest }
  | { kind: "user_statement"; text: string }
  /** A catalogue question that PROMPTED a draft (never evidence): resolved
   *  against the named domain version; `question` is the reviewed snapshot. */
  | { kind: "catalogue_prompt"; domainId: string; domainVersion: number; promptId: string; question: string };

export type ConsequenceClass = "ordinary" | "consequential";

export type MutationBatch = MutationStep[];

/** proposed -> reviewed -> applying -> applied is the successful sequence.
 *  failed leaves only through an EXPLICIT retry (never automatic), which
 *  lands on reviewed (review material unchanged) or stale (it changed). */
export type ProposalStatus = "proposed" | "reviewed" | "applying" | "applied" | "failed" | "rejected" | "stale" | "superseded";

export interface ReviewRecord {
  at: string;
  status: ProposalStatus;
  /** "person" for every human decision; "kernel" for revalidation and recovery. */
  by: "person" | "kernel";
  note: string;
}

export type EntityOp = "added" | "modified" | "removed";

/** One row of the mechanical before/after diff. */
export interface EntityChange {
  /** Top-level collection ("hypotheses", "variables", "collections.incomeSources", "profile.members", or a singleton like "profile"). */
  collection: string;
  id: string;
  op: EntityOp;
  before: unknown;
  after: unknown;
}

/** What a person reads. Built ON the mechanical diff, never beside it. */
export interface SemanticChange {
  verb: "create" | "record" | "link" | "change" | "retract" | "remove" | "archive" | "status";
  noun: string;
  summary: string;
  subject?: string;
  details: string[];
}

export interface DryRunResult {
  ok: boolean;
  errors: { step: number; message: string }[];
  changes: EntityChange[];
  semantic: SemanticChange[];
  /** "Nothing else changes." is emitted ONLY when the diff contains exactly the entities the steps name. */
  nothingElseChanges: boolean;
  /** Entities changed beyond the ones the steps name (derived shells, cascades), in words. */
  alsoChanged: string[];
  warnings: string[];
  affected: Record<string, string[]>;
  /** Ids the mutations still derive from state (history entry ids); part of what is reviewed. */
  expectedOutputs: Record<string, string>;
  consequenceClass: ConsequenceClass;
  resultRevision: Revision | null;
}

/** A basis ref resolved to the CONTENT the person saw, so a change to a
 *  cited record changes the review fingerprint. */
export interface ResolvedBasis {
  ref: ProposalBasisRef;
  /** Canonical content at resolution time, or null when the record no longer exists. */
  content: unknown;
}

export interface MutationProposal {
  id: string;
  modelId: string;
  /** As proposed (ids and clocks possibly implicit). */
  request: MutationBatch;
  /** As reviewed: every implicit value frozen. Reviewed = dry-run = approved. */
  materialized: MutationBatch;
  proposedBy: ProposalAuthor;
  createdAt: string;
  rationale: string;
  basis: ProposalBasisRef[];
  consequenceClass: ConsequenceClass;
  /** The model the proposer saw. Immutable. */
  createdAgainstRevision: Revision;
  /** Advances only after a harmless revalidation. */
  lastValidatedRevision: Revision;
  preview: DryRunResult;
  resolvedBasis: ResolvedBasis[];
  /** Everything the person materially reviewed, canonicalized. */
  reviewFingerprint: string;
  status: ProposalStatus;
  review: ReviewRecord[];
  /** Two-phase commit bookkeeping (item C). */
  commit: {
    expectedBaseRevision: Revision | null;
    expectedResultRevision: Revision | null;
    actualResultRevision: Revision | null;
    approvedAt: string | null;
    affectedIds: string[];
  } | null;
  /** Set when an edit produced a newer proposal. */
  supersededBy: string | null;
  /** A stale proposal keeps the preview the person last saw beside the new one. */
  previousPreview: DryRunResult | null;
  /** ... and the cited records as they read then, so the card can say what changed. */
  previousResolvedBasis: ResolvedBasis[] | null;
}
