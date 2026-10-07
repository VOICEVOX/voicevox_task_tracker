import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { z } from "zod";

import { runtimeRecoveryInputV1Schema } from "../../application/tracking-run/contracts/runtime-recovery-v1.js";
import { runtimeRecoveryInputV2Schema } from "../../application/tracking-run/contracts/runtime-recovery-v2.js";
import { parseReceipt } from "../../application/tracking-run/receipt-codec.js";
import { serializeCanonicalJson, serializeCanonicalJsonLine } from "../../canonical-json/value.js";
import type { ResolveDiscordDeliveryCliCommand } from "./command-input.js";
import { nodeContentDigestPort as digest } from "./content-digest.js";
import { writeCliTextFile } from "./file-output.js";
import { launchRuntimeRecoveryV2 } from "./runtime-recovery-launcher-v2.js";
import { splitStagePaths } from "./split-stage-paths.js";
import { readSplitReceiptChain } from "./split-stage-receipts.js";

/** 手動workflowで選択済みの固定V2入口に一つの手動判断を渡す。 */
export async function resolveSelectedManualRuntimeV2(
  checkout: string,
  command: ResolveDiscordDeliveryCliCommand,
): Promise<void> {
  const source = await readFile("artifacts/workflow/manual-recovery-input.json", "utf8");
  const raw: unknown = JSON.parse(source);
  if (source !== serializeCanonicalJsonLine(raw)) {
    throw new TypeError("手動回復の固定入力がcanonical JSONではありません");
  }
  const selected = z.union([runtimeRecoveryInputV1Schema, runtimeRecoveryInputV2Schema]).parse(raw);
  if (selected.protocolVersion === 1) {
    throw new TypeError("手動送達の解決にはV2固定protocolが必要です");
  }
  if (selected.operation !== "inspect") {
    throw new TypeError("V2手動回復の選択入力がinspect以外です");
  }
  if (
    command.runId !== selected.runId ||
    command.configPath !== selected.configPath ||
    resolve(checkout, command.receiptPath) !==
      resolve(checkout, "artifacts/workflow/manual-resolution-receipt.json")
  ) {
    throw new TypeError("V2手動判断のrunまたは設定が選択済みruntimeと一致しません");
  }
  const input = runtimeRecoveryInputV2Schema.parse({
    ...selected,
    operation: "resolve_manual_delivery",
    invocationId: randomUUID(),
    target: {
      checkpointDigest: command.checkpointDigest,
      deliveryId: command.deliveryId,
      attemptId: command.attemptId,
      notificationKeys: command.notificationKeys,
      decision: command.resolution,
    },
  });
  const paths = splitStagePaths(checkout, selected.runId);
  const output = await launchRuntimeRecoveryV2(
    checkout,
    resolve(checkout, "artifacts/workflow/runtime"),
    input,
  );
  const receiptSource = await readFile(paths.manualResolutionReceipt, "utf8");
  const receiptRaw: unknown = JSON.parse(receiptSource);
  if (receiptSource !== serializeCanonicalJsonLine(receiptRaw)) {
    throw new TypeError("V2手動解決receiptがcanonical JSONではありません");
  }
  const receipt = parseReceipt(receiptRaw, digest);
  const entries = await readSplitReceiptChain(paths.receiptChain, selected.runId);
  if (
    output.status !== "manual_resolved" ||
    receipt.receiptType !== "manual_resolution" ||
    output.runId !== command.runId ||
    output.decision !== command.resolution ||
    output.stateRevision !== receipt.result.resultingStateRevision ||
    output.receiptKind !== receipt.receiptKind ||
    output.manualResolutionReceiptDigest !== receipt.receiptDigest ||
    output.receiptChainDigest !== digest.sha256Utf8(serializeCanonicalJson(entries)) ||
    output.workflowEffectAdapterIdentityDigest !==
      selected.expectedWorkflowEffectAdapterIdentityDigest ||
    receipt.binding.bindingKind !== "checkpoint" ||
    receipt.binding.runId !== command.runId ||
    receipt.binding.checkpointDigest !== command.checkpointDigest ||
    receipt.binding.runtimeIdentityDigest !== selected.expectedRuntimeIdentityDigest ||
    receipt.result.deliveryId !== command.deliveryId ||
    receipt.result.deliveryAttemptId !== command.attemptId ||
    receipt.result.decision !== command.resolution ||
    serializeCanonicalJson(receipt.result.notificationKeys) !==
      serializeCanonicalJson(command.notificationKeys)
  ) {
    throw new TypeError("V2手動判断の固定出力と同じrunのreceiptが一致しません");
  }
  await writeCliTextFile("artifacts/workflow/manual-resolution-receipt.json", receiptSource);
}
