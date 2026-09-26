import type { DailyTransactionDependencies } from "../../daily-transaction.js";
import type {
  CodexAnalysis,
  CollectedItems,
  DeterministicAnalysis,
  ProductionTypes,
  ReducedAnalysis,
  RepositoryInventory,
  RuntimeConfiguration,
  RuntimeState,
} from "../contracts.js";
import { reconcileCurrentGraph } from "../graph/stage.js";
import { reduceAnalysisPass } from "./item-reduction.js";

function reduceAllAnalyses(
  configuration: RuntimeConfiguration,
  state: RuntimeState,
  inventory: RepositoryInventory,
  collection: CollectedItems,
  deterministicAnalysis: DeterministicAnalysis,
  codexAnalysis: CodexAnalysis,
): ReducedAnalysis {
  const initialReduction = reduceAnalysisPass(
    configuration,
    state,
    inventory,
    collection,
    deterministicAnalysis,
    codexAnalysis,
    undefined,
  );
  const provisionalGraph = reconcileCurrentGraph(
    configuration,
    state,
    collection,
    initialReduction,
  );
  return reduceAnalysisPass(
    configuration,
    state,
    inventory,
    collection,
    deterministicAnalysis,
    codexAnalysis,
    provisionalGraph,
  );
}

/** 解析結果の統合段階を作る。 */
export function createReduceAnalysisStage(): DailyTransactionDependencies<ProductionTypes>["reduceAnalysis"] {
  return ({ configuration, collection, deterministicAnalysis, codexAnalysis }) =>
    Promise.resolve(
      reduceAllAnalyses(
        configuration,
        deterministicAnalysis.state,
        deterministicAnalysis.inventory,
        collection,
        deterministicAnalysis,
        codexAnalysis,
      ),
    );
}
