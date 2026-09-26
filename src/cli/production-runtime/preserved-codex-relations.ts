import {
  CODEX_ELEMENT_OUTPUT_SCHEMA_VERSION,
  createCodexAnalysisInput,
  CodexOutputValidationError,
  validateCodexAnalysisOutput,
  type CodexAnalysisInput,
  type CodexPreservedElements,
} from "../../codex/index.js";
import type {
  AiAnalysisElement,
  AiAnalysisElementMigrationResult,
} from "../../domain/ai-analysis-elements.js";

/** 保存済み要素から入力と整合しない関係を除く。 */
export function preservedElementsWithCompatibleRelations(
  preservedElements: CodexPreservedElements,
  input: CodexAnalysisInput | undefined,
): CodexPreservedElements {
  const relations = preservedElements.relations;
  if (relations == null) {
    return preservedElements;
  }
  if (input != null) {
    const relationValidationInput = createCodexAnalysisInput({
      ...input,
      selectedElements: ["relations"],
      lockedElements: {},
    });
    try {
      validateCodexAnalysisOutput(
        {
          schemaVersion: CODEX_ELEMENT_OUTPUT_SCHEMA_VERSION,
          item: {
            nodeId: relationValidationInput.item.nodeId,
            url: relationValidationInput.item.url,
          },
          relations,
        },
        relationValidationInput,
      );
      return preservedElements;
    } catch (error: unknown) {
      if (!(error instanceof CodexOutputValidationError)) {
        throw error;
      }
    }
  }
  const compatibleElements: Partial<Record<AiAnalysisElement, AiAnalysisElementMigrationResult>> = {
    ...preservedElements,
  };
  delete compatibleElements.relations;
  return Object.freeze(compatibleElements);
}
