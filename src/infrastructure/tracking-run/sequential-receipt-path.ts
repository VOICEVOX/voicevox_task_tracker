import { resolve } from "node:path";

/** run IDで分離した直列receipt artifactの保存先を返す。 */
export function sequentialReceiptPath(repositoryPath: string, runId: string): string {
  if (!/^tracker-run:[0-9a-f]{64}$/u.test(runId)) {
    throw new TypeError("直列receipt artifactのrun IDが不正です");
  }
  return resolve(
    repositoryPath,
    "artifacts/workflow/sequential-receipts",
    `${runId.slice("tracker-run:".length)}.json`,
  );
}
