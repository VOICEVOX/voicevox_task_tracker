import type { ContentDigestPort } from "./contracts/content-digest-port.js";
import { verifyReceiptChain, type VerifiedReceiptChain } from "./receipt-chain.js";
import type { ReceiptChainEntry } from "./receipt-chain-schema.js";
import { createReceipt } from "./receipt-codec.js";
import type { CompletionReceipt } from "./receipt-schema.js";

/** 全副作用receiptの検証後に確定したrun。 */
export type CompletedRun = Readonly<{
  status: "completed";
  finalStateRevision: string;
  receipt: CompletionReceipt;
  chain: VerifiedReceiptChain;
}>;

/** 履歴Pagesまで連続したreceiptから副作用のない完了receiptを作る。 */
export function completeTrackingRun(
  input: Readonly<{
    entries: readonly ReceiptChainEntry[];
    finalStateRevision: string;
    invocationId: string;
    observedAt: string;
  }>,
  digest: ContentDigestPort,
): CompletedRun {
  const verified = verifyReceiptChain(input.entries, digest);
  const initialCommit = verified.receipts[0];
  const initialBuild = verified.receipts[1];
  const initialDeployment = verified.receipts[2];
  const settlement = verified.receipts.at(-4);
  const finalization = verified.receipts.at(-3);
  const historyBuild = verified.receipts.at(-2);
  const previous = verified.receipts.at(-1);
  if (
    verified.receipts.length < 7 ||
    initialCommit?.receiptType !== "initial_state_commit" ||
    initialBuild?.receiptType !== "pages_build" ||
    initialBuild.phase !== "initial" ||
    initialDeployment?.receiptType !== "pages_deployment" ||
    initialDeployment.phase !== "initial" ||
    (initialDeployment.status !== "deployed" &&
      initialDeployment.status !== "replayed_same_content") ||
    settlement?.receiptType !== "notification_settlement" ||
    finalization?.receiptType !== "run_finalization" ||
    historyBuild?.receiptType !== "pages_build" ||
    historyBuild.phase !== "notification_history" ||
    previous?.receiptType !== "pages_deployment" ||
    previous.phase !== "notification_history" ||
    (previous.status !== "deployed" &&
      previous.status !== "replayed_same_content" &&
      previous.status !== "not_required") ||
    previous.expectedStateRevision !== input.finalStateRevision ||
    finalization.result.resultingStateRevision !== input.finalStateRevision ||
    initialBuild.result?.sourceStateRevision !== initialCommit.result.resultingStateRevision ||
    initialDeployment.result?.sourceStateRevision !== initialCommit.result.resultingStateRevision ||
    initialDeployment.result.deploymentIntentDigest !==
      initialBuild.result.deploymentIntentDigest ||
    initialDeployment.result.pagesContentDigest !== initialBuild.result.pagesContentDigest ||
    (historyBuild.status === "not_required") !== (previous.status === "not_required") ||
    verified.receipts
      .slice(3, -4)
      .some(
        (receipt) =>
          receipt.receiptType !== "notification_message" &&
          receipt.receiptType !== "manual_resolution",
      )
  ) {
    throw new TypeError("初回commitから通知履歴Pagesまで確定したreceipt chainが必要です");
  }
  const receipt = createReceipt(
    {
      schemaVersion: 1,
      receiptType: "completion",
      stage: "completed",
      phase: "completion",
      binding: previous.binding,
      logicalTarget: input.finalStateRevision,
      invocationId: input.invocationId,
      localAttemptIndex: 0,
      phaseSequence: previous.phaseSequence + 1,
      previousReceiptDigest: previous.receiptDigest,
      expectedStateRevision: input.finalStateRevision,
      receiptKind: "executed",
      observedAt: input.observedAt,
      status: "completed",
      effectCertainty: "no_effect",
      result: { finalStateRevision: input.finalStateRevision },
    },
    digest,
  );
  if (receipt.receiptType !== "completion") {
    throw new TypeError("完了receiptの種別が不正です");
  }
  const chain = verifyReceiptChain(
    [...input.entries, { receipt, evidence: { kind: "none" } }],
    digest,
  );
  return Object.freeze({
    status: "completed",
    finalStateRevision: input.finalStateRevision,
    receipt,
    chain,
  });
}
