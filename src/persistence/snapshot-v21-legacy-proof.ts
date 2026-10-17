import { Ajv2020 } from "ajv/dist/2020.js";

import snapshotVersion20Schema from "../../schemas/snapshot-v20.schema.json" with { type: "json" };
import snapshotVersion19Schema from "../../schemas/snapshot.schema.json" with { type: "json" };
import {
  AI_ANALYSIS_ELEMENT_INPUT_PROJECTION_VERSIONS,
  AI_ANALYSIS_ELEMENT_REVISIONS,
} from "../codex/generic-ai-definition.js";
import { AI_ANALYSIS_ELEMENTS } from "../domain/ai-analysis-elements.js";
import { StateSnapshotSchemaError, StateSnapshotSemanticError } from "./errors.js";

type LegacyVerifiedProof = Readonly<{
  status: "verified";
  revision: number;
  inputProjectionVersion: number;
}>;

type LegacyAdopted = Readonly<{
  origin: "current" | "migration";
  reuseProof: LegacyVerifiedProof | Readonly<{ status: "unknown" }>;
}>;

type LegacyItem = Readonly<{
  nodeId: string;
  aiAnalysis: Readonly<{
    applications: Readonly<Record<string, Readonly<{ status: string }>>>;
    adoptedElements: Readonly<Record<string, LegacyAdopted>>;
  }>;
}>;

type LegacySnapshot = Readonly<{
  items: readonly LegacyItem[];
  collection: Readonly<{ repositories: readonly Readonly<{ items: readonly LegacyItem[] }>[] }>;
}>;

export type LegacyProofKeys = Readonly<{
  tracked: ReadonlySet<string>;
  collection: ReadonlySet<string>;
}>;

const ajv = new Ajv2020({
  allErrors: true,
  coerceTypes: false,
  removeAdditional: false,
  strict: true,
  useDefaults: false,
});
ajv.addFormat("date-time", {
  type: "string",
  validate: (value: string) =>
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u.test(value) &&
    !Number.isNaN(Date.parse(value)),
});
ajv.addSchema(snapshotVersion19Schema);
const validateVersion19 = ajv.getSchema<LegacySnapshot>(snapshotVersion19Schema.$id);
const validateVersion20 = ajv.compile<LegacySnapshot>(snapshotVersion20Schema);

/** 旧版の採用証明を当時の版で検証し、移行が必要な要素を集める。 */
export function collectLegacyProofsForMigration(
  value: unknown,
  version: "19" | "20",
): LegacyProofKeys {
  const validate = version === "19" ? validateVersion19 : validateVersion20;
  if (validate == null) {
    throw new StateSnapshotSchemaError(1);
  }
  if (!validate(value)) {
    throw new StateSnapshotSchemaError(validate.errors?.length ?? 1);
  }
  const tracked = new Set<string>();
  const collection = new Set<string>();
  function collectItem(item: LegacyItem, keys: Set<string>): void {
    for (const element of AI_ANALYSIS_ELEMENTS) {
      const application = item.aiAnalysis.applications[element];
      if (application == null) {
        throw new StateSnapshotSchemaError(1);
      }
      if (application.status !== "current_ai") {
        continue;
      }
      const adopted = item.aiAnalysis.adoptedElements[element];
      if (adopted?.origin !== "current" || adopted.reuseProof.status !== "verified") {
        throw new StateSnapshotSemanticError(
          `旧snapshotの${element}に検証済み採用結果がありません`,
        );
      }
      if (
        adopted.reuseProof.revision === AI_ANALYSIS_ELEMENT_REVISIONS[element] &&
        adopted.reuseProof.inputProjectionVersion ===
          AI_ANALYSIS_ELEMENT_INPUT_PROJECTION_VERSIONS[element]
      ) {
        continue;
      }
      if (adopted.reuseProof.inputProjectionVersion !== 1) {
        throw new StateSnapshotSemanticError(`旧snapshotの${element}の入力投影versionが不正です`);
      }
      keys.add(JSON.stringify([item.nodeId, element]));
    }
  }
  for (const item of value.items) {
    collectItem(item, tracked);
  }
  for (const repository of value.collection.repositories) {
    for (const item of repository.items) {
      collectItem(item, collection);
    }
  }
  return { tracked, collection };
}
