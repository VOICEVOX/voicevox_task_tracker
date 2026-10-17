import type { StateFileValidation } from "./state-file-validation.js";
import { serializeCanonicalJson } from "../canonical-json/value.js";
import type {
  StateBranchAdapter,
  StateBranchCommitInspection,
  StateBranchCommitRequest,
  StateFileReadResult,
  StatePersistenceConfiguration,
} from "./branch-adapter.js";
import { createStateChangedPathManifest, digestStateManifest } from "./state-commit-metadata.js";
import {
  verifyCurrentRunTransactionFiles,
  verifyRunTransactionFiles,
  type VerifiedRunTransactionFiles,
} from "./state-transaction-files.js";

const verifiedCandidateBrand: unique symbol = Symbol("verifiedStateCasCandidate");
const verifiedCandidateTreeBrand: unique symbol = Symbol("verifiedStateCasCandidateTree");

/** 公開前の一つのCAS候補で親、完成byte、変更manifestを照合した結果。 */
export type VerifiedStateCasCandidate = Readonly<{
  [verifiedCandidateBrand]: true;
  revision: string;
  parentRevision: string;
  files: ReadonlyMap<string, StateFileReadResult>;
  before: ReadonlyMap<string, StateFileReadResult>;
  after: ReadonlyMap<string, StateFileReadResult>;
  changedPathManifest: ReturnType<typeof createStateChangedPathManifest>;
}>;

/** 同じ公開前候補のfileとtransactionを結び付けたchain先頭。 */
export type VerifiedStateCasCandidateTree = VerifiedStateCasCandidate &
  Readonly<{
    [verifiedCandidateTreeBrand]: true;
    transaction: VerifiedRunTransactionFiles;
  }>;

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
): Promise<VerifiedStateCasCandidate> {
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
  return Object.freeze({
    [verifiedCandidateBrand]: true,
    revision: inspection.revision,
    parentRevision: inspection.parent.status === "present" ? inspection.parent.revision : "unborn",
    files: candidate,
    before,
    after,
    changedPathManifest: manifest,
  } satisfies VerifiedStateCasCandidate);
}

/** 同じ候補treeを一度だけtransaction schemaとsemanticへ通す。 */
export function verifyStateCasCandidateTransaction(
  candidate: VerifiedStateCasCandidate,
  configuration: StatePersistenceConfiguration,
  current: boolean,
  validation?: StateFileValidation,
): VerifiedStateCasCandidateTree | undefined {
  const transaction = current
    ? verifyCurrentRunTransactionFiles(candidate.files, configuration, validation)
    : verifyRunTransactionFiles(candidate.files, configuration, validation);
  if (transaction == null) {
    return undefined;
  }
  return Object.freeze({
    ...candidate,
    [verifiedCandidateTreeBrand]: true,
    transaction,
  } satisfies VerifiedStateCasCandidateTree);
}

/** 候補固有検査がアクセスしたfileだけを複製する一時view。 */
class CandidateInspectionFiles implements ReadonlyMap<string, StateFileReadResult> {
  public readonly [Symbol.toStringTag] = "Map";
  readonly #source: VerifiedStateCasCandidate;
  readonly #copies = new Map<string, StateFileReadResult>();

  public constructor(candidate: VerifiedStateCasCandidate) {
    this.#source = candidate;
  }

  public get size(): number {
    return this.#source.files.size;
  }

  public get(path: string): StateFileReadResult | undefined {
    const copied = this.#copies.get(path);
    if (copied != null) {
      return copied;
    }
    const file = this.#source.files.get(path);
    if (file == null) {
      return undefined;
    }
    if (file.status !== "present") {
      throw new TypeError("CAS候補の検証済みfileが欠落しています");
    }
    const result = Object.freeze({
      status: "present",
      bytes: Uint8Array.from(file.bytes),
    } satisfies StateFileReadResult);
    this.#copies.set(path, result);
    return result;
  }

  public has(path: string): boolean {
    return this.#source.files.has(path);
  }

  public *entries(): MapIterator<[string, StateFileReadResult]> {
    for (const path of this.#source.files.keys()) {
      const file = this.get(path);
      if (file == null) {
        throw new TypeError("CAS候補の検証済みfileが欠落しています");
      }
      yield [path, file];
    }
  }

  public keys(): MapIterator<string> {
    return this.#source.files.keys();
  }

  public *values(): MapIterator<StateFileReadResult> {
    for (const [, file] of this.entries()) {
      yield file;
    }
  }

  public forEach(
    callback: (
      value: StateFileReadResult,
      key: string,
      map: ReadonlyMap<string, StateFileReadResult>,
    ) => void,
    thisArg?: unknown,
  ): void {
    for (const [path, file] of this.entries()) {
      callback.call(thisArg, file, path, this);
    }
  }

  public [Symbol.iterator](): MapIterator<[string, StateFileReadResult]> {
    return this.entries();
  }

  public assertUnchanged(candidate: VerifiedStateCasCandidate): void {
    if (this.#source !== candidate) {
      throw new TypeError("候補固有検査中にCAS候補のfile byteが変化しました");
    }
    for (const [path, file] of this.#copies) {
      const original = candidate.files.get(path);
      if (original == null || !sameFile(original, file)) {
        throw new TypeError("候補固有検査中にCAS候補のfile byteが変化しました");
      }
    }
  }
}

/** 候補固有検査へ渡すbyteをCASとchainの証明から分離する。 */
export function copyStateCasCandidateFiles(
  candidate: VerifiedStateCasCandidate,
): CandidateInspectionFiles {
  return new CandidateInspectionFiles(candidate);
}

/** 候補固有検査が受け取ったfileが証明済み候補と同じbyteか照合する。 */
export function assertStateCasCandidateFilesUnchanged(
  candidate: VerifiedStateCasCandidate,
  inspectedFiles: CandidateInspectionFiles,
): void {
  inspectedFiles.assertUnchanged(candidate);
}

/** chainに渡された先頭treeが公開前CAS候補の証明か判定する。 */
export function isVerifiedStateCasCandidateTree(
  tree: object,
): tree is VerifiedStateCasCandidateTree {
  return verifiedCandidateTreeBrand in tree;
}
