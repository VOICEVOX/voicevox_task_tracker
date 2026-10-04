import { serializeCanonicalJson } from "../../../canonical-json/value.js";
import type {
  MaterializedEvidenceReference,
  MaterializedReferenceValues,
} from "./run-validation-reference-contracts.js";
import { RunCompletenessError } from "./run-completeness-error.js";

type SourcePath = Readonly<{ sourceId: string; path: readonly (string | number)[] }>;

function walkSourcePaths(
  value: unknown,
  path: readonly (string | number)[],
  paths: SourcePath[],
): void {
  if (Array.isArray(value)) {
    for (const [index, entry] of value.entries()) walkSourcePaths(entry, [...path, index], paths);
    return;
  }
  if (typeof value !== "object" || value == null) return;
  for (const [key, entry] of Object.entries(value)) {
    const fieldPath = [...path, key];
    if (key === "sourceId" || key === "latestMeaningfulSourceId") {
      if (key === "latestMeaningfulSourceId" && entry == null) continue;
      if (typeof entry !== "string") {
        throw new RunCompletenessError("invalid_reference", key, fieldPath, undefined);
      }
      paths.push({ sourceId: entry, path: fieldPath });
    } else if (key === "sourceIds" || key === "evidenceSourceIds") {
      if (!Array.isArray(entry)) {
        throw new RunCompletenessError("invalid_reference", key, fieldPath, undefined);
      }
      const auditOnly =
        key === "sourceIds" && "source" in value && value.source === "reconfirmed_observation";
      for (const [index, sourceId] of entry.entries()) {
        if (typeof sourceId !== "string") {
          throw new RunCompletenessError(
            "invalid_reference",
            key,
            [...fieldPath, index],
            undefined,
          );
        }
        if (!auditOnly) paths.push({ sourceId, path: [...fieldPath, index] });
      }
    } else if (/sourceids?$/iu.test(key)) {
      throw new RunCompletenessError("invalid_reference", key, fieldPath, undefined);
    } else {
      walkSourcePaths(entry, fieldPath, paths);
    }
  }
}

/** 公開値のsource名を走査し、型付き目録に未収録の参照を拒否する。 */
export function assertSourceReferenceCoverage(
  values: MaterializedReferenceValues,
  references: readonly MaterializedEvidenceReference[],
): void {
  const found: SourcePath[] = [];
  walkSourcePaths(
    {
      snapshot: values.snapshot,
      historyInputEvents: values.historyInputEvents,
      aiCacheAdditions: values.aiCacheAdditions,
      personalReminderAiCacheAdditions: values.personalReminderAiCacheAdditions,
      previousNotificationLedger: values.previousNotificationLedger,
      notificationLedger: values.notificationLedger,
      notificationSelection: values.notificationSelection,
    },
    [],
    found,
  );
  const sort = (entries: readonly SourcePath[]): readonly string[] =>
    entries.map(serializeCanonicalJson).sort();
  const catalogPaths = references.map(({ sourceId, path }) => ({ sourceId, path }));
  if (serializeCanonicalJson(sort(found)) !== serializeCanonicalJson(sort(catalogPaths))) {
    const indexed = new Set(
      references.map((reference) =>
        serializeCanonicalJson({ sourceId: reference.sourceId, path: reference.path }),
      ),
    );
    const missing = found.find((entry) => !indexed.has(serializeCanonicalJson(entry)));
    throw new RunCompletenessError(
      "invalid_reference",
      missing?.sourceId ?? "source_reference",
      missing?.path ?? ["materializedReferences"],
      undefined,
    );
  }
}
