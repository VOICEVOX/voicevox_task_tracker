import { serializeCanonicalJson } from "../canonical-json/value.js";
import type {
  StateBranchAdapter,
  StateBranchCommitInspection,
  StateBranchCommitRequest,
  StateFileReadResult,
} from "./branch-adapter.js";
import { createStateChangedPathManifest, digestStateManifest } from "./state-commit-metadata.js";

function presentFiles(
  paths: readonly string[],
  files: ReadonlyMap<string, StateFileReadResult>,
): Map<string, StateFileReadResult> {
  if (files.size !== paths.length) {
    throw new TypeError("exact state treeのファイル一覧と読み取り結果が一致しません");
  }
  const result = new Map<string, StateFileReadResult>();
  for (const path of paths) {
    const file = files.get(path);
    if (file?.status !== "present") {
      throw new TypeError("exact state treeの一覧にあるファイルを読み取れません");
    }
    result.set(path, file);
  }
  return result;
}

async function stateFiles(
  adapter: StateBranchAdapter,
  revision: string,
): Promise<Map<string, StateFileReadResult>> {
  const paths = await adapter.listFiles(revision, "state");
  return presentFiles(paths, await adapter.readFiles(revision, paths));
}

function sameFile(left: StateFileReadResult, right: StateFileReadResult): boolean {
  return (
    left.status === "present" &&
    right.status === "present" &&
    left.bytes.length === right.bytes.length &&
    left.bytes.every((byte, index) => byte === right.bytes[index])
  );
}

/** exact親と候補treeの全byteおよび差分manifestを公開前に照合する。 */
export async function verifyStateCasCandidate(
  adapter: StateBranchAdapter,
  inspection: StateBranchCommitInspection,
  request: Omit<StateBranchCommitRequest, "branch" | "expectedHead">,
): Promise<ReadonlyMap<string, StateFileReadResult>> {
  const [parent, candidate] = await Promise.all([
    inspection.parent.status === "missing"
      ? Promise.resolve(new Map<string, StateFileReadResult>())
      : stateFiles(adapter, inspection.parent.revision),
    stateFiles(adapter, inspection.revision),
  ]);
  const expected = new Map(parent);
  const changedPaths = [...request.updates.map((update) => update.path), ...request.deletions];
  if (new Set(changedPaths).size !== changedPaths.length) {
    throw new TypeError("CAS候補の変更pathが重複しています");
  }
  for (const update of request.updates) {
    expected.set(update.path, { status: "present", bytes: update.bytes });
  }
  for (const path of request.deletions) {
    if (!parent.has(path)) {
      throw new TypeError("CAS候補の削除pathが親treeにありません");
    }
    expected.delete(path);
  }
  if (
    candidate.size !== expected.size ||
    [...expected].some(([path, file]) => {
      const actual = candidate.get(path);
      return actual == null || !sameFile(file, actual);
    })
  ) {
    throw new TypeError("CAS候補に計画外のpathまたは異なるfile byteがあります");
  }
  const before = new Map<string, StateFileReadResult>();
  const after = new Map<string, StateFileReadResult>();
  for (const path of new Set([...parent.keys(), ...candidate.keys()])) {
    before.set(path, parent.get(path) ?? { status: "missing" });
    after.set(path, candidate.get(path) ?? { status: "missing" });
  }
  const manifest = createStateChangedPathManifest(before, after);
  if (
    serializeCanonicalJson(manifest) !== serializeCanonicalJson(inspection.changedPathManifest) ||
    digestStateManifest(manifest) !== inspection.metadata.changedPathManifestDigest ||
    inspection.metadata.operationId !== request.commitIdentity.operationId ||
    inspection.metadata.commitScope !== request.commitIdentity.commitScope ||
    inspection.metadata.runId !== request.commitIdentity.runId
  ) {
    throw new TypeError("CAS候補の実際の変更manifestとcommit metadataが一致しません");
  }
  return candidate;
}
