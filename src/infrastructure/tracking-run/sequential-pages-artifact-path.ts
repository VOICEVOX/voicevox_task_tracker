import { resolve } from "node:path";

/** run IDごとに分離した直列Pages artifactの保存先を返す。 */
export function sequentialPagesArtifactPath(
  repositoryPath: string,
  runId: string,
  phase: "initial" | "notification-history",
  kind: "build" | "deployment",
): string {
  if (!/^tracker-run:[0-9a-f]{64}$/u.test(runId)) {
    throw new TypeError("直列Pages artifactのrun IDが不正です");
  }
  return resolve(
    repositoryPath,
    "artifacts/workflow/sequential-pages",
    runId.slice("tracker-run:".length),
    `${phase}-${kind}.json`,
  );
}
