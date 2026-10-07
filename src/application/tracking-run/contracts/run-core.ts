import type { Sha256Hash } from "../../../canonical-json/sha256.js";
import type { Config } from "../../../config/schema.js";
import type { StageProofFor } from "./proofs.js";
import type { AnalysisPreviousState } from "./previous-state.js";
import type { RunExecutionPolicy, RunIdentity } from "../request.js";
import type { AiBudgetLedgerSnapshot } from "./ai-budget-ledger.js";
import type { HistoricalAiSnapshotInput } from "./evidence-closure.js";
import { z } from "zod";

export const baseStateRevisionSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("missing") }),
  z.strictObject({ status: z.literal("present"), revision: z.string().min(1) }),
]);

/** 固定したstate branchの先頭revision。 */
export type BaseStateRevision = z.output<typeof baseStateRevisionSchema>;

/** 固定revisionから現行形式へ正規化した前回state。 */
export type PreparedBaseState = Readonly<{
  revision: BaseStateRevision;
  snapshot:
    | Readonly<{ status: "missing_branch" | "operations_only" }>
    | Readonly<{ status: "available"; snapshot: object }>;
  history: readonly Readonly<{ events: readonly unknown[] }>[];
  aiCache: AnalysisPreviousState["aiCache"];
  personalReminderAiCache: AnalysisPreviousState["personalReminderAiCache"];
  notificationLedger: AnalysisPreviousState["notificationLedger"];
  previousState: AnalysisPreviousState;
}>;

/** run開始時に固定するAI予算の初期残量。 */
export type InitialAiBudgetLedger = AiBudgetLedgerSnapshot & Readonly<{ sequence: 0 }>;

/** 前処理で確定しinventory遷移まで保持する値。 */
export type PreparedRunCore = Readonly<{
  identity: RunIdentity;
  executionPolicy: RunExecutionPolicy;
  config: Config;
  configDigest: Sha256Hash;
  baseState: PreparedBaseState;
  aiBudget: InitialAiBudgetLedger;
}>;

/** 解析段階へ引き継ぐ設定と前回stateの必要な投影。 */
export type AnalysisRunCore = Readonly<{
  identity: RunIdentity;
  executionPolicy: RunExecutionPolicy;
  config: Config;
  configDigest: Sha256Hash;
  baseRevision: BaseStateRevision;
  aiBudget: InitialAiBudgetLedger;
  previousState: AnalysisPreviousState;
}>;

/** 汎用AI採用後のグラフ統合に必要な設定と前回観測。 */
export type GraphReconciliationInput = Readonly<{
  config: Pick<Config, "ai" | "maintainers" | "labels" | "staleness" | "importance" | "attention">;
  previousSnapshot: AnalysisPreviousState["snapshot"];
}>;

/** 個人催促の前回値と実行条件へ渡す必要な投影。 */
export type PersonalReminderPlanningInput = Readonly<{
  config: Pick<Config, "ai" | "labels" | "staleness">;
  previousAiSnapshot: HistoricalAiSnapshotInput;
  previousBaseSnapshot: Readonly<{
    items: readonly Pick<
      Extract<AnalysisPreviousState["snapshot"], { status: "available" }>["trackedItems"][number],
      "nodeId" | "repositoryId" | "personalReminderCauses" | "evidence"
    >[];
    relations: readonly Pick<
      Extract<AnalysisPreviousState["snapshot"], { status: "available" }>["relations"][number],
      "id" | "fromNodeId" | "toNodeId" | "evidence"
    >[];
  }>;
  previousItems: readonly Pick<
    Extract<AnalysisPreviousState["snapshot"], { status: "available" }>["trackedItems"][number],
    | "nodeId"
    | "observedAt"
    | "repositoryId"
    | "labels"
    | "state"
    | "personalReminderCauses"
    | "personalReminderCausePlanning"
    | "inputEvents"
    | "evidence"
  >[];
  previousRelations: Extract<
    AnalysisPreviousState["snapshot"],
    { status: "available" }
  >["relations"];
  aiCache: AnalysisPreviousState["personalReminderAiCache"];
}>;

/** 汎用AI計画以後へ渡すrun識別と予算の投影。 */
export type GenericAiRunCore = Readonly<{
  identity: RunIdentity;
  executionPolicy: RunExecutionPolicy;
  configDigest: Sha256Hash;
  baseRevision: BaseStateRevision;
  aiBudget: AiBudgetLedgerSnapshot;
  graphInput: GraphReconciliationInput;
  personalReminderInput: PersonalReminderPlanningInput;
}>;

/** グラフ統合後に必要なrun識別と予算だけを持つcore。 */
export type GraphReconciledRunCore = Omit<GenericAiRunCore, "graphInput">;

/** 個人催促確定後に前回観測とcacheを破棄したcore。 */
export type PersonalReminderFinalizedRunCore = Omit<
  GraphReconciledRunCore,
  "personalReminderInput"
>;

/** 実装済み段階と段階ごとのcore型の唯一の対応表。 */
export type CoreByStage = Readonly<{
  prepared: PreparedRunCore;
  inventory_collected: AnalysisRunCore;
  collected: AnalysisRunCore;
  deterministically_analyzed: AnalysisRunCore;
  generic_ai_planned: GenericAiRunCore;
  generic_ai_executed: GenericAiRunCore;
  generic_ai_adopted: GenericAiRunCore;
  graph_reconciled: GraphReconciledRunCore;
  personal_reminder_planned: GraphReconciledRunCore;
  personal_reminder_executed: GraphReconciledRunCore;
  personal_reminder_finalized: PersonalReminderFinalizedRunCore;
}>;

/** 段階名に対応したcoreとproofを持つ成果物。 */
export type StageState<StageName extends keyof CoreByStage, StageData> = Readonly<{
  stage: StageName;
  core: CoreByStage[StageName];
  data: Readonly<StageData>;
  proof: StageProofFor<StageName>;
}>;

/** 準備済みcoreから解析に必要な値だけを投影する。 */
export function projectAnalysisRunCore(prepared: PreparedRunCore): AnalysisRunCore {
  return Object.freeze({
    identity: prepared.identity,
    executionPolicy: prepared.executionPolicy,
    config: prepared.config,
    configDigest: prepared.configDigest,
    baseRevision: prepared.baseState.revision,
    aiBudget: prepared.aiBudget,
    previousState: prepared.baseState.previousState,
  });
}

/** 汎用AI計画へ必要なrun識別と予算だけを投影する。 */
export function projectGenericAiRunCore(analyzed: AnalysisRunCore): GenericAiRunCore {
  return Object.freeze({
    identity: analyzed.identity,
    executionPolicy: analyzed.executionPolicy,
    configDigest: analyzed.configDigest,
    baseRevision: analyzed.baseRevision,
    aiBudget: analyzed.aiBudget,
    graphInput: Object.freeze({
      config: Object.freeze({
        ai: analyzed.config.ai,
        maintainers: analyzed.config.maintainers,
        labels: analyzed.config.labels,
        staleness: analyzed.config.staleness,
        importance: analyzed.config.importance,
        attention: analyzed.config.attention,
      }),
      previousSnapshot: analyzed.previousState.snapshot,
    }),
    personalReminderInput: Object.freeze({
      config: Object.freeze({
        ai: analyzed.config.ai,
        labels: analyzed.config.labels,
        staleness: analyzed.config.staleness,
      }),
      previousBaseSnapshot: Object.freeze({
        items:
          analyzed.previousState.snapshot.status === "available"
            ? Object.freeze(
                analyzed.previousState.snapshot.trackedItems.map((item) =>
                  Object.freeze({
                    nodeId: item.nodeId,
                    repositoryId: item.repositoryId,
                    personalReminderCauses: item.personalReminderCauses,
                    evidence: item.evidence,
                  }),
                ),
              )
            : Object.freeze([]),
        relations:
          analyzed.previousState.snapshot.status === "available"
            ? Object.freeze(
                analyzed.previousState.snapshot.relations.map((relation) =>
                  Object.freeze({
                    id: relation.id,
                    fromNodeId: relation.fromNodeId,
                    toNodeId: relation.toNodeId,
                    evidence: relation.evidence,
                  }),
                ),
              )
            : Object.freeze([]),
      }),
      previousItems:
        analyzed.previousState.snapshot.status === "available"
          ? Object.freeze(
              analyzed.previousState.snapshot.trackedItems.map((item) =>
                Object.freeze({
                  nodeId: item.nodeId,
                  observedAt: item.observedAt,
                  repositoryId: item.repositoryId,
                  labels: item.labels,
                  state: item.state,
                  personalReminderCauses: item.personalReminderCauses,
                  personalReminderCausePlanning: item.personalReminderCausePlanning,
                  inputEvents: item.inputEvents,
                  evidence: item.evidence,
                }),
              ),
            )
          : Object.freeze([]),
      previousAiSnapshot: Object.freeze({
        trackedItems:
          analyzed.previousState.snapshot.status === "available"
            ? Object.freeze(
                analyzed.previousState.snapshot.trackedItems.map((item) =>
                  Object.freeze({
                    nodeId: item.nodeId,
                    repositoryId: item.repositoryId,
                    aiAnalysis: item.aiAnalysis,
                  }),
                ),
              )
            : Object.freeze([]),
        collectionRepositories:
          analyzed.previousState.snapshot.status === "available"
            ? Object.freeze(
                analyzed.previousState.snapshot.collectionRepositories.map((repository) =>
                  Object.freeze({
                    repositoryId: repository.repositoryId,
                    items: Object.freeze(
                      repository.items.map((item) =>
                        Object.freeze({
                          nodeId: item.nodeId,
                          repositoryId: item.repositoryId,
                          aiAnalysis: item.aiAnalysis,
                        }),
                      ),
                    ),
                  }),
                ),
              )
            : Object.freeze([]),
      }),
      previousRelations:
        analyzed.previousState.snapshot.status === "available"
          ? analyzed.previousState.snapshot.relations
          : Object.freeze([]),
      aiCache: analyzed.previousState.personalReminderAiCache,
    }),
  });
}

/** グラフ統合後に不要な前回観測と設定をcoreから除く。 */
export function projectGraphReconciledRunCore(adopted: GenericAiRunCore): GraphReconciledRunCore {
  return Object.freeze({
    identity: adopted.identity,
    executionPolicy: adopted.executionPolicy,
    configDigest: adopted.configDigest,
    baseRevision: adopted.baseRevision,
    aiBudget: adopted.aiBudget,
    personalReminderInput: adopted.personalReminderInput,
  });
}
