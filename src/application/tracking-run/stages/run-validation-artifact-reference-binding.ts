import { serializeCanonicalJson } from "../../../canonical-json/value.js";
import { createGitHubNodeId } from "../../../domain/types.js";
import type { EvidenceUse, ResolvedEvidenceUse } from "../contracts/evidence-closure.js";
import { collectEvidenceUses } from "./evidence-closure-walk-common.js";
import type {
  MaterializedEvidenceReference,
  MaterializedReferenceValues,
} from "./run-validation-reference-contracts.js";
import { RunCompletenessError } from "./run-completeness-error.js";
import { assertEventBasisReference, referenceContext } from "./run-validation-reference-context.js";
import { isRecord, valueAtPath } from "./run-validation-reference-scope.js";
import type { PreviousPendingCauseContext } from "./run-validation-previous-ledger-history.js";

export type MaterializedSourceUse = Readonly<{
  reference: MaterializedEvidenceReference;
  use: EvidenceUse;
  annotation?: Readonly<{ supports: string; summary: string }>;
}>;

function annotationAt(
  reference: MaterializedEvidenceReference,
  values: MaterializedReferenceValues,
): MaterializedSourceUse["annotation"] {
  const record = valueAtPath(values, reference.path.slice(0, -1));
  if (
    !isRecord(record) ||
    typeof record["supports"] !== "string" ||
    typeof record["summary"] !== "string"
  )
    return undefined;
  return Object.freeze({ supports: record["supports"], summary: record["summary"] });
}

/** 保存参照の用途、現在性、所有範囲、annotationを一つの目録へ復元する。 */
export function collectMaterializedSourceUses(
  references: readonly MaterializedEvidenceReference[],
  values: MaterializedReferenceValues,
  previousPendingCauses: readonly PreviousPendingCauseContext[],
): readonly MaterializedSourceUse[] {
  const contexts = references.map((reference) =>
    referenceContext(reference, values, previousPendingCauses),
  );
  for (const reference of references) assertEventBasisReference(reference, values);
  const uses = collectEvidenceUses((emit) => {
    for (const [index, reference] of references.entries()) {
      const context = contexts[index];
      if (context == null)
        throw new RunCompletenessError(
          "missing_value",
          reference.sourceId,
          reference.path,
          undefined,
        );
      emit(
        reference.sourceId,
        reference.path,
        reference.owner.kind === "item"
          ? { kind: "item", itemNodeId: createGitHubNodeId(reference.owner.id) }
          : { kind: "relation", relationId: reference.owner.id },
        context.purpose,
        context.currentness,
        context.ownerNodeIds,
        context.relationIds,
      );
    }
  });
  const referencesByPath = new Map(
    references.map((reference) => [serializeCanonicalJson(reference.path), reference]),
  );
  if (referencesByPath.size !== references.length)
    throw new RunCompletenessError(
      "duplicate_id",
      "source_reference",
      ["materializedReferences"],
      undefined,
    );
  return Object.freeze(
    uses.map((use) => {
      const reference = referencesByPath.get(serializeCanonicalJson(use.path));
      if (reference == null)
        throw new RunCompletenessError("missing_value", use.sourceId, use.path, use);
      const annotation = annotationAt(reference, values);
      return Object.freeze({ reference, use, ...(annotation == null ? {} : { annotation }) });
    }),
  );
}

/** 保存値の全参照と解決済みuseを同じpathで一対一照合する。 */
export function assertMaterializedReferenceBindings(
  sourceUses: readonly MaterializedSourceUse[],
  resolvedUses: readonly ResolvedEvidenceUse[],
): void {
  const actual = resolvedUses.map((resolved) => resolved.use);
  const expected = sourceUses.map((entry) => entry.use);
  if (serializeCanonicalJson(actual) !== serializeCanonicalJson(expected)) {
    const mismatch =
      expected.find(
        (use, index) =>
          actual[index] == null ||
          serializeCanonicalJson(use) !== serializeCanonicalJson(actual[index]),
      ) ?? actual[expected.length];
    throw new RunCompletenessError(
      "invalid_reference",
      mismatch?.sourceId ?? "source_reference",
      mismatch?.path ?? ["materializedReferences"],
      mismatch,
    );
  }
}
