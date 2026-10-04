/** 検証済みworkflow artifactをstate branchへ保存する入力。 */
export type WorkflowInitialStateCommitInput = Readonly<{
  configPath: string;
  artifactPath: string;
  receiptPath: string;
}>;

/** 検証済みworkflow artifactからPages用データを生成する入力。 */
export type WorkflowInitialPagesBuildInput = Readonly<{
  configPath: string;
  initialStateReceiptPath: string;
  buildArtifactPath: string;
  outputDirectory: string;
}>;

/** Pages actionの直前にstateと出力を検証する入力。 */
export type WorkflowInitialPagesPreflightInput = Readonly<{
  configPath: string;
  initialStateReceiptPath: string;
  buildArtifactPath: string;
  previousOutcomePath: string;
  preflightPath: string;
  runAttempt: number;
}>;

/** Pages actionの実結果をreceiptへ記録する入力。 */
export type WorkflowInitialPagesRecordInput = Readonly<{
  buildArtifactPath: string;
  preflightPath: string;
  outcomePath: string;
}>;

/** 初回Pages成功後に通知settlementを確定する入力。 */
export type WorkflowNotificationSettlementInput = Readonly<{
  configPath: string;
  initialStateReceiptPath: string;
  buildArtifactPath: string;
  deploymentOutcomePath: string;
  settlementReceiptPath: string;
  manualResolutionReceiptPath?: string;
}>;

/** settlement済みrunの最終CASを確定する入力。 */
export type WorkflowRunFinalizationInput = Readonly<{
  configPath: string;
  initialStateReceiptPath: string;
  settlementReceiptPath: string;
  finalizationReceiptPath: string;
}>;
