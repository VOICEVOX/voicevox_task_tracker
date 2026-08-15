import { TaskTrackerError } from "../util/index.js";
import type { PublicGitHubRelationItem } from "./relation-candidate-types.js";

export type RelationReferenceConflictKind = "node_id" | "repository_number";

type UnvaluedRelationReferenceField =
  "nodeId" | "repositoryOwner" | "repositoryName" | "number" | "url";

type UnvaluedRelationReferenceMismatch = {
  [Field in UnvaluedRelationReferenceField]: Readonly<{
    field: Field;
  }>;
}[UnvaluedRelationReferenceField];

export type RelationReferenceMismatch =
  | UnvaluedRelationReferenceMismatch
  | Readonly<{
      field: "type";
      existingValue: "issue" | "pull_request";
      incomingValue: "issue" | "pull_request";
    }>
  | Readonly<{
      field: "state";
      existingValue: "open" | "closed" | "merged";
      incomingValue: "open" | "closed" | "merged";
    }>
  | Readonly<{
      field: "repositoryArchived" | "repositoryDisabled";
      existingValue: boolean;
      incomingValue: boolean;
    }>;

/** 関係参照indexで公開参照項目が衝突したことを表す。 */
export class RelationReferenceConflictError extends TaskTrackerError {
  public readonly conflictKind: RelationReferenceConflictKind;
  public readonly existing: PublicGitHubRelationItem;
  public readonly incoming: PublicGitHubRelationItem;
  public readonly mismatches: readonly RelationReferenceMismatch[];
  public readonly isStateOnlyConflict: boolean;

  public constructor(
    conflictKind: RelationReferenceConflictKind,
    existing: PublicGitHubRelationItem,
    incoming: PublicGitHubRelationItem,
    mismatches: readonly RelationReferenceMismatch[],
  ) {
    super(
      `公開参照項目が衝突しています。衝突種別: ${conflictKind}、食い違い: ${mismatches.map((mismatch) => mismatch.field).join(", ")}`,
      {},
    );
    this.conflictKind = conflictKind;
    this.existing = Object.freeze({ ...existing });
    this.incoming = Object.freeze({ ...incoming });
    this.mismatches = Object.freeze(mismatches.map((mismatch) => Object.freeze({ ...mismatch })));
    this.isStateOnlyConflict =
      conflictKind === "node_id" && mismatches.length === 1 && mismatches[0]?.field === "state";
  }
}
