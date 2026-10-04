/** 最終stateから通知履歴Pagesの公開要否とbuild artifactを作る入力。 */
export type WorkflowNotificationHistoryPagesBuildInput = Readonly<{
  configPath: string;
  settlementReceiptPath: string;
  finalizationReceiptPath: string;
  buildArtifactPath: string;
  outputDirectory: string;
}>;

/** 通知履歴Pages action直前の正本と出力を検証する入力。 */
export type WorkflowNotificationHistoryPagesPreflightInput = Readonly<{
  configPath: string;
  settlementReceiptPath: string;
  finalizationReceiptPath: string;
  buildArtifactPath: string;
  previousOutcomePath: string;
  preflightPath: string;
  runAttempt: number;
}>;

/** 通知履歴Pages actionの実結果を記録する入力。 */
export type WorkflowNotificationHistoryPagesRecordInput = Readonly<{
  buildArtifactPath: string;
  preflightPath: string;
  outcomePath: string;
}>;
