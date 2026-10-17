import { buildSourceId, parseSourceId } from "../../../domain/source-id.js";
import type { EvidenceUse } from "../contracts/evidence-closure.js";
import { RunCompletenessError } from "./run-completeness-error.js";

export type EvidenceUseSink = (
  sourceId: string,
  path: readonly (string | number)[],
  destination: EvidenceUse["destination"],
  purpose: string,
  requiredCurrentness: EvidenceUse["requiredCurrentness"],
  allowedOwnerNodeIds: readonly string[],
  allowedRelationIds: readonly string[],
) => void;

/** 種別と利用先を失わずに参照を正規化して並べる。 */
export function collectEvidenceUses(walk: (emit: EvidenceUseSink) => void): readonly EvidenceUse[] {
  const uses: EvidenceUse[] = [];
  const emit: EvidenceUseSink = (
    rawSourceId,
    path,
    destination,
    purpose,
    requiredCurrentness,
    allowedOwnerNodeIds,
    allowedRelationIds,
  ) => {
    if (rawSourceId.startsWith("codex_source:")) {
      throw new RunCompletenessError("transport_alias", rawSourceId, path, undefined);
    }
    let sourceId;
    try {
      const parts = parseSourceId(rawSourceId);
      sourceId = buildSourceId(parts.kind, parts.originalId);
    } catch (error: unknown) {
      throw new RunCompletenessError("invalid_reference", rawSourceId, path, undefined, error);
    }
    uses.push(
      Object.freeze({
        sourceId,
        path: Object.freeze([...path]),
        destination,
        purpose,
        requiredCurrentness,
        allowedOwnerNodeIds: Object.freeze([...new Set(allowedOwnerNodeIds)].sort()),
        allowedRelationIds: Object.freeze([...new Set(allowedRelationIds)].sort()),
      }),
    );
  };
  walk(emit);
  return Object.freeze(
    uses.sort((left, right) => {
      const leftKey = JSON.stringify([left.sourceId, left.path, left.destination, left.purpose]);
      const rightKey = JSON.stringify([
        right.sourceId,
        right.path,
        right.destination,
        right.purpose,
      ]);
      return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
    }),
  );
}
