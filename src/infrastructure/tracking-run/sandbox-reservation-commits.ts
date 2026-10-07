import type { GitStateBranchAdapter } from "../../persistence/index.js";
import { createStateCommitOperationId } from "../../persistence/state-commit-metadata.js";

/** 元送達操作のreservation CASが同じrunへ一度だけ適用されたか数える。 */
export async function countSandboxReservationCommits(
  adapter: GitStateBranchAdapter,
  headRevision: string,
  initialStateRevision: string,
  runId: string,
  deliveryOperationId: string,
  attemptId: string,
): Promise<number> {
  const reservationOperationId = createStateCommitOperationId({
    kind: "notification_message",
    deliveryOperationId,
    deliveryAttemptId: attemptId,
    transition: "reservation",
  });
  let count = 0;
  let revision = headRevision;
  for (let index = 0; index < 200; index += 1) {
    if (revision === initialStateRevision) {
      return count;
    }
    const commit = await adapter.readCommit(revision);
    if (commit.metadata.operationId === reservationOperationId) {
      if (commit.metadata.runId !== runId) {
        throw new TypeError("元送達操作のrun IDが一致しません");
      }
      count += 1;
    }
    if (commit.parent.status !== "present") {
      throw new TypeError("元送達操作のGit祖先が初回stateへ到達しません");
    }
    revision = commit.parent.revision;
  }
  throw new TypeError("元送達操作のGit祖先探索が上限を超えました");
}
