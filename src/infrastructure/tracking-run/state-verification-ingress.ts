import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import {
  DURABLE_PUBLICATION_RECORD_STATE_PATH_V1,
  RUN_TRANSACTION_MARKER_STATE_PATH_V1,
} from "../../application/tracking-run/contracts/recovery-paths.js";
import { readRunTransactionMarkerRecoveryBootstrap } from "../../application/tracking-run/recovery-bootstrap.js";
import type {
  StateBranchAdapter,
  StateBranchHead,
  StatePersistenceConfiguration,
} from "../../persistence/branch-adapter.js";
import { GitStateBranchAdapter } from "../../persistence/git-state-branch-adapter.js";
import { assertStateCommitChain } from "../../persistence/state-commit-chain-verification.js";
import { verifyRunTransactionFiles } from "../../persistence/state-transaction-files.js";
import { readBaseStateIngress } from "./base-state-ingress.js";

function localRevisionAdapter(
  repositoryPath: string,
  branch: string,
  stateRevision: string,
): StateBranchAdapter {
  const git = new GitStateBranchAdapter({
    repositoryPath,
    gitExecutable: "git",
    authorName: "voicevox-task-tracker",
    authorEmail: "voicevox-task-tracker@users.noreply.github.com",
  });
  return Object.freeze({
    resolveHead: (requestedBranch: string): Promise<StateBranchHead> => {
      if (requestedBranch !== branch) {
        throw new TypeError("検証対象と異なるstate branchは読み取れません");
      }
      return Promise.resolve(Object.freeze({ status: "present", revision: stateRevision }));
    },
    readFile: git.readFile.bind(git),
    readFiles: git.readFiles.bind(git),
    listFiles: git.listFiles.bind(git),
    readCommit: git.readCommit.bind(git),
    commit: (): Promise<never> => {
      throw new TypeError("state検証ではcommitできません");
    },
    publish: (): Promise<never> => {
      throw new TypeError("state検証ではpublishできません");
    },
  });
}

async function verifyBootstrap(adapter: StateBranchAdapter, stateRevision: string): Promise<void> {
  const files = await adapter.readFiles(stateRevision, [
    RUN_TRANSACTION_MARKER_STATE_PATH_V1,
    DURABLE_PUBLICATION_RECORD_STATE_PATH_V1,
  ]);
  const marker = files.get(RUN_TRANSACTION_MARKER_STATE_PATH_V1);
  const record = files.get(DURABLE_PUBLICATION_RECORD_STATE_PATH_V1);
  if (marker == null || record == null) {
    throw new TypeError("state bootstrapの一括読取結果が不足しています");
  }
  if (marker.status === "missing" && record.status === "missing") {
    return;
  }
  if (marker.status === "missing" || record.status === "missing") {
    throw new TypeError("transaction markerとdurable recordの片方がありません");
  }
  const bootstrap = readRunTransactionMarkerRecoveryBootstrap(marker.bytes);
  if (bootstrap.phase !== "run_finalized") {
    throw new TypeError(
      "未完了runはcurrent runtimeで検証できません。固定bundleのexact runtimeで検証してください",
    );
  }
}

/** bootstrap、現行ingress、commit chainを同じGit revisionで検証する。 */
export async function withVerifiedStateRevision<Result>(
  stateDirectory: string,
  stateRevision: string,
  timezone: string,
  configuration: StatePersistenceConfiguration,
  verifyFiles: (directory: string) => Promise<Result>,
): Promise<Result> {
  const directory = resolve(stateDirectory);
  if (basename(directory) !== "state") {
    throw new TypeError("Git checkout内のstateディレクトリを指定してください");
  }
  const adapter = localRevisionAdapter(dirname(directory), configuration.branch, stateRevision);
  await verifyBootstrap(adapter, stateRevision);
  const paths = await adapter.listFiles(stateRevision, "state");
  const files = await adapter.readFiles(stateRevision, paths);
  const verified = verifyRunTransactionFiles(files, configuration);
  if (verified != null) {
    if (verified.marker.phase !== "run_finalized") {
      throw new TypeError("bootstrapと検証済みmarkerのphaseが一致しません");
    }
    await assertStateCommitChain(
      adapter,
      configuration,
      stateRevision,
      verified,
      verified.marker.initialStateRevision,
    );
  }
  await readBaseStateIngress(adapter, configuration, timezone, {
    status: "present",
    revision: stateRevision,
  });
  const temporaryRoot = await mkdtemp(join(tmpdir(), "voicevox-state-verification-"));
  try {
    for (const path of paths) {
      const file = files.get(path);
      if (file?.status !== "present") {
        throw new TypeError("一覧にあるstate fileをexact revisionから読み取れません");
      }
      const destination = join(temporaryRoot, path);
      await mkdir(dirname(destination), { recursive: true });
      await writeFile(destination, file.bytes);
    }
    await mkdir(join(temporaryRoot, configuration.historyDirectory), { recursive: true });
    return await verifyFiles(join(temporaryRoot, "state"));
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}
