import type { ContentDigestPort } from "../contracts/content-digest-port.js";
import { assertNonNullable } from "../../../util/assert-non-nullable.js";
import { createGenericAiAdoptedStageProof } from "../contracts/proofs.js";
import type { StageState } from "../contracts/run-core.js";
import type { GenericAiExecutedRun } from "./generic-ai-execution.js";
import type { GenericAiItemAdoption } from "./generic-ai-adoption-contracts.js";
import { adoptGenericAiInputFailure, adoptGenericAiItem } from "./generic-ai-adoption-item.js";

/** 採用値、保持値、現在性と要素別依存が確定したrun。 */
export type GenericAiAdoptedRun = StageState<
  "generic_ai_adopted",
  Readonly<{
    approvedRepositories: GenericAiExecutedRun["data"]["approvedRepositories"];
    allowlistDigest: GenericAiExecutedRun["data"]["allowlistDigest"];
    collection: GenericAiExecutedRun["data"]["collection"];
    sourceCatalog: GenericAiExecutedRun["data"]["sourceCatalog"];
    facts: GenericAiExecutedRun["data"]["facts"];
    items: readonly GenericAiItemAdoption[];
    snapshotPlan: GenericAiExecutedRun["data"]["snapshotPlan"];
  }>
>;

/** 汎用AIの計画と実行結果から要素別の採用段階を確定する。 */
export function adoptGenericAi(
  executed: GenericAiExecutedRun,
  digest: ContentDigestPort,
): GenericAiAdoptedRun {
  const { minimumConfidence, aiEnabled } = executed.data.plan;
  if (!Number.isFinite(minimumConfidence) || minimumConfidence < 0 || minimumConfidence > 1) {
    throw new TypeError("汎用AI採用の最低confidenceが不正です");
  }
  const analyses = new Map(
    executed.data.facts.items.map((analysis) => [analysis.item.nodeId, analysis]),
  );
  if (analyses.size !== executed.data.facts.items.length) {
    throw new TypeError("汎用AI採用の項目IDが重複しています");
  }
  const outcomes = new Map(executed.data.outcomes.map((outcome) => [outcome.item.nodeId, outcome]));
  const failures = new Map(
    executed.data.plan.failures.map((failure) => [failure.candidateId, failure]),
  );
  if (
    outcomes.size !== executed.data.outcomes.length ||
    failures.size !== executed.data.plan.failures.length ||
    outcomes.size + failures.size !== analyses.size
  ) {
    throw new TypeError("汎用AI採用の結果と入力検証失敗が確定分析と一致しません");
  }
  const items = executed.data.facts.items.map((analysis) => {
    const nodeId = analysis.item.nodeId;
    const outcome = outcomes.get(nodeId);
    const failure = failures.get(nodeId);
    if ((outcome == null) === (failure == null)) {
      throw new TypeError(`汎用AIの結果と入力検証失敗を特定できません。対象: ${nodeId}`);
    }
    if (outcome != null) {
      return adoptGenericAiItem(outcome, analysis, minimumConfidence, digest, aiEnabled);
    }
    assertNonNullable(failure, `汎用AIの入力検証失敗がありません。対象: ${nodeId}`);
    return adoptGenericAiInputFailure(failure);
  });
  return Object.freeze({
    stage: "generic_ai_adopted",
    core: executed.core,
    data: Object.freeze({
      approvedRepositories: executed.data.approvedRepositories,
      allowlistDigest: executed.data.allowlistDigest,
      collection: executed.data.collection,
      sourceCatalog: executed.data.sourceCatalog,
      facts: executed.data.facts,
      items: Object.freeze(items),
      snapshotPlan: executed.data.snapshotPlan,
    }),
    proof: createGenericAiAdoptedStageProof(),
  });
}
