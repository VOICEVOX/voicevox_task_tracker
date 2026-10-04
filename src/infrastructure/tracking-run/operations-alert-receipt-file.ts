import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

import {
  decodePublicFailureArtifact,
  type PublicFailureArtifact,
} from "../../application/tracking-run/failure-artifact.js";
import { selectPrimaryFailureArtifact } from "../../application/tracking-run/failure-primary.js";
import type { OperationsAlertReceipt } from "../../application/tracking-run/receipt-schema.js";
import { nodeContentDigestPort } from "./content-digest.js";
import {
  assertSameOperationsIncident,
  decodeOperationsAlertReceiptForFailure,
} from "./operations-alert-receipt.js";

const dailyFailureJobs = new Set([
  "quality",
  "bootstrap",
  "prepare-runtime",
  "analyze",
  "commit-initial-state",
  "initial-pages",
  "settle-notifications",
  "finalize-run",
  "notification-history-pages",
  "complete",
  "recovery-router",
  "tracking",
  "notify-operations",
  "report-workflow",
]);
const manualFailureJobs = new Set(["resolve-delivery", "notify-operations", "report-workflow"]);

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function artifactAttempt(name: string, prefix: string): number {
  if (!name.startsWith(prefix)) {
    throw new TypeError("以前の運用障害通知artifact名が不正です");
  }
  const source = name.slice(prefix.length);
  const attempt = Number(source);
  if (!/^[1-9][0-9]*$/u.test(source) || !Number.isSafeInteger(attempt)) {
    throw new TypeError("以前の運用障害通知artifactのattemptが不正です");
  }
  return attempt;
}

async function readPreviousFailure(
  directory: string,
  workflowRunId: string,
  attempt: number,
  currentAttempt: number,
  workflowKind: "daily" | "manual",
): Promise<PublicFailureArtifact> {
  const entries = await readdir(directory, { withFileTypes: true });
  const artifactPrefix = `${workflowKind}-failure-${workflowRunId}-`;
  const attemptPrefix = `${artifactPrefix}${attempt.toString()}-`;
  const allowedJobs = workflowKind === "daily" ? dailyFailureJobs : manualFailureJobs;
  const failures: PublicFailureArtifact[] = [];
  const filenames = new Set<string>();
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith(artifactPrefix)) {
      throw new TypeError("以前の公開失敗artifactの取得先が不正です");
    }
    if (!entry.name.startsWith(attemptPrefix)) {
      const suffix = entry.name.slice(artifactPrefix.length);
      const separator = suffix.indexOf("-");
      if (separator < 0) {
        throw new TypeError("以前の公開失敗artifactのattemptが不正です");
      }
      const otherAttempt = Number(suffix.slice(0, separator));
      if (
        !/^[1-9][0-9]*$/u.test(suffix.slice(0, separator)) ||
        !Number.isSafeInteger(otherAttempt) ||
        otherAttempt > currentAttempt ||
        !allowedJobs.has(suffix.slice(separator + 1))
      ) {
        throw new TypeError("以前の公開失敗artifact名が不正です");
      }
      continue;
    }
    const job = entry.name.slice(attemptPrefix.length);
    if (!allowedJobs.has(job)) {
      throw new TypeError("以前の公開失敗artifactのjob名が不正です");
    }
    const files = await readdir(join(directory, entry.name), { withFileTypes: true });
    if (files.length === 0) {
      throw new TypeError("以前の公開失敗artifactが空です");
    }
    for (const file of files) {
      if (
        !file.isFile() ||
        (!/^[0-9a-f-]{36}\.json$/u.test(file.name) &&
          !/^(?:[0-9a-f]{64}|analyze)-[a-z-]+-attempt-[1-9][0-9]*\.json$/u.test(file.name))
      ) {
        throw new TypeError("以前の公開失敗artifactのファイル名が不正です");
      }
      if (filenames.has(file.name)) {
        throw new TypeError("以前の公開失敗artifactが重複しています");
      }
      filenames.add(file.name);
      const artifact = decodePublicFailureArtifact(
        await readFile(join(directory, entry.name, file.name)),
        nodeContentDigestPort,
      );
      if (
        file.name !== `${artifact.failure.invocationId}.json` &&
        !file.name.startsWith(
          `${artifact.failure.runId?.slice("tracker-run:".length) ?? "analyze"}-`,
        )
      ) {
        throw new TypeError("以前の公開失敗artifactのファイル名とinvocationが一致しません");
      }
      failures.push(artifact);
    }
  }
  if (failures.length === 0) {
    throw new TypeError("以前の運用障害通知receiptに対応する公開失敗artifactがありません");
  }
  return selectPrimaryFailureArtifact(failures);
}

/** 同じworkflow runの既存receiptを同attemptの失敗主因と照合して読む。 */
export async function readPriorOperationsAlertReceipts(
  outputPath: string,
  receiptDirectory: string,
  failureDirectory: string,
  workflowRunId: string,
  workflowRunAttempt: number,
  workflowKind: "daily" | "manual",
  current: PublicFailureArtifact,
  incidentId: string,
): Promise<readonly OperationsAlertReceipt[]> {
  const receipts: OperationsAlertReceipt[] = [];
  try {
    receipts.push(
      decodeOperationsAlertReceiptForFailure(await readFile(outputPath), current, incidentId),
    );
  } catch (error: unknown) {
    if (!isMissingFile(error)) {
      throw error;
    }
  }
  let entries;
  try {
    entries = await readdir(receiptDirectory, { withFileTypes: true });
  } catch (error: unknown) {
    if (isMissingFile(error)) {
      return Object.freeze(receipts);
    }
    throw error;
  }
  const prefix = `operations-alert-receipt-${workflowRunId}-`;
  const digests = new Set(receipts.map((receipt) => receipt.receiptDigest));
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isDirectory()) {
      throw new TypeError("以前の運用障害通知receiptの取得先が不正です");
    }
    const attempt = artifactAttempt(entry.name, prefix);
    if (attempt >= workflowRunAttempt) {
      throw new TypeError("以前の運用障害通知receiptのattemptが今回以降です");
    }
    const files = await readdir(join(receiptDirectory, entry.name), { withFileTypes: true });
    if (
      files.length !== 1 ||
      files[0]?.name !== "operations-alert-receipt.json" ||
      !files[0].isFile()
    ) {
      throw new TypeError("以前の運用障害通知receiptのpathが不正です");
    }
    const previous = await readPreviousFailure(
      failureDirectory,
      workflowRunId,
      attempt,
      workflowRunAttempt,
      workflowKind,
    );
    assertSameOperationsIncident(previous, current, workflowRunId, incidentId);
    const receipt = decodeOperationsAlertReceiptForFailure(
      await readFile(join(receiptDirectory, entry.name, "operations-alert-receipt.json")),
      previous,
      incidentId,
    );
    if (digests.has(receipt.receiptDigest)) {
      throw new TypeError("以前の運用障害通知receiptが重複しています");
    }
    digests.add(receipt.receiptDigest);
    receipts.push(receipt);
  }
  return Object.freeze(receipts);
}
