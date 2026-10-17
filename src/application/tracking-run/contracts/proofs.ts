import type { AnalysisRunStageName } from "./closed-values.js";

const stageProofBrand: unique symbol = Symbol("stageProof");
const checkpointBindingProofBrand: unique symbol = Symbol("checkpointBindingProof");
const resumeBindingProofBrand: unique symbol = Symbol("resumeBindingProof");
const receiptChainProofBrand: unique symbol = Symbol("receiptChainProof");

class StageProofToken<StageName extends AnalysisRunStageName> {
  readonly [stageProofBrand]: StageName;

  private constructor(stageName: StageName) {
    this[stageProofBrand] = stageName;
  }

  public static prepared(): StageProofToken<"prepared"> {
    return new StageProofToken("prepared");
  }

  public static inventoryCollected(): StageProofToken<"inventory_collected"> {
    return new StageProofToken("inventory_collected");
  }

  public static collected(): StageProofToken<"collected"> {
    return new StageProofToken("collected");
  }

  public static deterministicallyAnalyzed(): StageProofToken<"deterministically_analyzed"> {
    return new StageProofToken("deterministically_analyzed");
  }

  public static genericAiPlanned(): StageProofToken<"generic_ai_planned"> {
    return new StageProofToken("generic_ai_planned");
  }

  public static genericAiExecuted(): StageProofToken<"generic_ai_executed"> {
    return new StageProofToken("generic_ai_executed");
  }

  public static genericAiAdopted(): StageProofToken<"generic_ai_adopted"> {
    return new StageProofToken("generic_ai_adopted");
  }

  public static graphReconciled(): StageProofToken<"graph_reconciled"> {
    return new StageProofToken("graph_reconciled");
  }

  public static personalReminderPlanned(): StageProofToken<"personal_reminder_planned"> {
    return new StageProofToken("personal_reminder_planned");
  }

  public static personalReminderExecuted(): StageProofToken<"personal_reminder_executed"> {
    return new StageProofToken("personal_reminder_executed");
  }

  public static personalReminderFinalized(): StageProofToken<"personal_reminder_finalized"> {
    return new StageProofToken("personal_reminder_finalized");
  }
}

class CheckpointBindingProofToken {
  readonly [checkpointBindingProofBrand]: true;

  private constructor() {
    this[checkpointBindingProofBrand] = true;
  }
}

class ResumeBindingProofToken {
  readonly [resumeBindingProofBrand]: true;

  private constructor() {
    this[resumeBindingProofBrand] = true;
  }
}

class ReceiptChainProofToken {
  readonly [receiptChainProofBrand]: true;

  private constructor() {
    this[receiptChainProofBrand] = true;
  }
}

type StageProofByStage = {
  [StageName in AnalysisRunStageName]: StageProofToken<StageName>;
};

/** 段階ごとの検証を通過した証明。 */
export type StageProofFor<StageName extends AnalysisRunStageName> = StageProofByStage[StageName];

/** ingress検証を終えたrunの準備段階を証明する。 */
export function createPreparedStageProof(): StageProofFor<"prepared"> {
  return StageProofToken.prepared();
}

/** 公開repository一覧とdigestが確定した段階を証明する。 */
export function createInventoryCollectedStageProof(): StageProofFor<"inventory_collected"> {
  return StageProofToken.inventoryCollected();
}

/** 正規化済みsourceと評価時刻が確定した段階を証明する。 */
export function createCollectedStageProof(): StageProofFor<"collected"> {
  return StageProofToken.collected();
}

/** 決定論的な候補と判定を確定した段階を証明する。 */
export function createDeterministicallyAnalyzedStageProof(): StageProofFor<"deterministically_analyzed"> {
  return StageProofToken.deterministicallyAnalyzed();
}

/** 汎用AIの要素選択と入力対応を確認した段階を証明する。 */
export function createGenericAiPlannedStageProof(): StageProofFor<"generic_ai_planned"> {
  return StageProofToken.genericAiPlanned();
}

/** 汎用AIの計画と実行結果を照合した段階を証明する。 */
export function createGenericAiExecutedStageProof(): StageProofFor<"generic_ai_executed"> {
  return StageProofToken.genericAiExecuted();
}

/** 汎用AIの要素別採用と現在性を照合した段階を証明する。 */
export function createGenericAiAdoptedStageProof(): StageProofFor<"generic_ai_adopted"> {
  return StageProofToken.genericAiAdopted();
}

/** 最終graphと項目値の確定を証明する。 */
export function createGraphReconciledStageProof(): StageProofFor<"graph_reconciled"> {
  return StageProofToken.graphReconciled();
}

/** 個人催促の原因と厳密入力の計画を証明する。 */
export function createPersonalReminderPlannedStageProof(): StageProofFor<"personal_reminder_planned"> {
  return StageProofToken.personalReminderPlanned();
}

/** 個人催促の計画と原因別実行結果の照合を証明する。 */
export function createPersonalReminderExecutedStageProof(): StageProofFor<"personal_reminder_executed"> {
  return StageProofToken.personalReminderExecuted();
}

/** 個人催促の採用、根拠、時計、最終項目値の確定を証明する。 */
export function createPersonalReminderFinalizedStageProof(): StageProofFor<"personal_reminder_finalized"> {
  return StageProofToken.personalReminderFinalized();
}

/** checkpointと保存先の結合を検証した証明。 */
export type CheckpointBindingProof = CheckpointBindingProofToken;

/** 再開入力の結合を検証した証明。 */
export type ResumeBindingProof = ResumeBindingProofToken;

/** receiptの連鎖を検証した証明。 */
export type ReceiptChainProof = ReceiptChainProofToken;
