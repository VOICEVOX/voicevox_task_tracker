import { serializeCanonicalJson } from "../../../canonical-json/value.js";
import { AI_ANALYSIS_ELEMENT_REVISIONS } from "../../../codex/generic-ai-definition.js";
import type { AiAnalysisRunIdentity } from "../../../codex/analysis-selection.js";
import { CODEX_BACKEND_VERSION } from "../../../codex/backend-version.js";
import type { Config } from "../../../config/schema.js";
import { AI_ANALYSIS_ELEMENT_SCHEMA_VERSION } from "../../../domain/ai-analysis-elements.js";
import { ISSUE_DETERMINISTIC_RULES_VERSION } from "../../../domain/issue-state-contracts.js";
import { PULL_REQUEST_DETERMINISTIC_RULES_VERSION } from "../../../domain/pull-request-state-contracts.js";
import type { EnumeratedGitHubItem, Sha256Fingerprint } from "../../../github/item-enumeration.js";
import type { ContentDigestPort } from "../contracts/content-digest-port.js";

/** AI解析の実行識別情報を作る。 */
export function createAiAnalysisRunIdentity(config: Config): AiAnalysisRunIdentity {
  return Object.freeze({
    model: config.ai.model,
    reasoningEffort: config.ai.execution.reasoningEffort,
    backendVersion: CODEX_BACKEND_VERSION,
    schemaVersion: AI_ANALYSIS_ELEMENT_SCHEMA_VERSION,
  });
}

/** 項目の解析計画fingerprintを作る。 */
export function analysisPlanFingerprintForItem(
  item: EnumeratedGitHubItem,
  identity: AiAnalysisRunIdentity,
  digest: ContentDigestPort,
): Sha256Fingerprint {
  const deterministicRulesVersion =
    item.type === "issue"
      ? ISSUE_DETERMINISTIC_RULES_VERSION
      : PULL_REQUEST_DETERMINISTIC_RULES_VERSION;
  return digest.sha256Utf8(
    serializeCanonicalJson({
      itemType: item.type,
      deterministicRulesVersion,
      elementRevisions: AI_ANALYSIS_ELEMENT_REVISIONS,
      execution: {
        model: identity.model,
        reasoningEffort: identity.reasoningEffort,
        backendVersion: identity.backendVersion,
        schemaVersion: identity.schemaVersion,
      },
    }),
  );
}
