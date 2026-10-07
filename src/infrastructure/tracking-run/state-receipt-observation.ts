import type { PerformanceDetailObserver } from "../../application/tracking-run/contracts/performance-detail-observation.js";
import { RUN_TRANSACTION_MARKER_STATE_PATH_V1 } from "../../application/tracking-run/contracts/recovery-paths.js";
import {
  observeStateCommitReceipt,
  type ObservedStateCommitPosition,
  type StateCommitReceiptEvidence,
} from "../../application/tracking-run/observed-state-commit.js";
import { verifyReceiptChain } from "../../application/tracking-run/receipt-chain.js";
import type {
  InitialStateCommitReceipt,
  NotificationSettlementReceipt,
  RunFinalizationReceipt,
} from "../../application/tracking-run/receipt-schema.js";
import { serializeCanonicalJson } from "../../canonical-json/value.js";
import {
  type StateBranchAdapter,
  type StateFileReadResult,
  type StatePersistenceConfiguration,
} from "../../persistence/branch-adapter.js";
import {
  verifyStateCommitChain,
  type StateCommitChainResult,
} from "../../persistence/state-commit-chain-verification.js";
import {
  beginExactStateValidationRun,
  endExactStateValidationRun,
  exactStateValidationSession,
  exactStateValidationOrigin,
} from "../../persistence/exact-state-validation-session.js";
import { assertPublishedStateCommit } from "../../persistence/state-cas-observation.js";
import {
  finalizedHistoryDigest,
  finalizedRunReportDigest,
} from "../../persistence/state-transaction-finalization.js";
import {
  verifyRunTransactionFiles,
  type VerifiedRunTransactionFiles,
} from "../../persistence/state-transaction-files.js";
import { nodeContentDigestPort } from "./content-digest.js";
import {
  assertPostSaveExactReadDependencies,
  assertPostSaveExactReadTree,
  type PostSaveExactReadFootprint,
} from "../../persistence/exact-state-read-footprint.js";

const postSaveExactProofBrand: unique symbol = Symbol("postSaveExactProof");

/** 公開済みrevisionの完全検証と読込元だけを保持する短命証明。 */
type PostSaveExactProof = Readonly<{
  [postSaveExactProofBrand]: true;
  recordDigest: string;
  markerDigest: string;
  chain: StateCommitChainResult;
}>;

type ProofRun = Readonly<{
  runId: string;
  token: symbol;
  adapter: StateBranchAdapter;
  proofs: ReadonlyMap<string, PostSaveExactProof>;
}>;
type PostSaveExactProofScope = Readonly<{
  createStateBranchAdapter: () => StateBranchAdapter;
  beginRun: (runId: string) => void;
  endRun: (runId: string) => void;
}>;
type ProofDetails = Readonly<{
  scope: PostSaveExactProofScope;
  runToken: symbol;
  adapter: StateBranchAdapter;
  revision: string;
  configuration: string;
  footprint: PostSaveExactReadFootprint;
}>;

const adapterScopes = new WeakMap<StateBranchAdapter, PostSaveExactProofScope>();
const scopeRuns = new WeakMap<PostSaveExactProofScope, ProofRun>();
const issuedProofDetails = new WeakMap<PostSaveExactProof, ProofDetails>();

function bindStateBranchAdapter(source: StateBranchAdapter): StateBranchAdapter {
  return Object.freeze({
    resolveHead: source.resolveHead.bind(source),
    ...(source.resolveRepositoryRevision == null
      ? {}
      : { resolveRepositoryRevision: source.resolveRepositoryRevision.bind(source) }),
    ...(source.resolveOriginUrls == null
      ? {}
      : { resolveOriginUrls: source.resolveOriginUrls.bind(source) }),
    readFile: source.readFile.bind(source),
    readFiles: source.readFiles.bind(source),
    listFiles: source.listFiles.bind(source),
    readCommit: source.readCommit.bind(source),
    commit: source.commit.bind(source),
    publish: source.publish.bind(source),
  });
}

/** 日次runごとに保存と観測が共有するadapterを固定する。 */
export function createPostSaveExactProofScope(
  createSource: () => StateBranchAdapter,
  observePerformanceDetail?: PerformanceDetailObserver,
): PostSaveExactProofScope {
  const scope: PostSaveExactProofScope = Object.freeze({
    createStateBranchAdapter: (): StateBranchAdapter =>
      scopeRuns.get(scope)?.adapter ?? bindStateBranchAdapter(createSource()),
    beginRun: (runId: string): void => {
      const previous = scopeRuns.get(scope);
      if (previous != null) endExactStateValidationRun(previous.adapter, previous.runId);
      const adapter = bindStateBranchAdapter(createSource());
      adapterScopes.set(adapter, scope);
      beginExactStateValidationRun(adapter, runId, observePerformanceDetail);
      scopeRuns.set(scope, {
        runId,
        token: Symbol("postSaveExactProofRun"),
        adapter,
        proofs: new Map(),
      });
    },
    endRun: (runId: string): void => {
      const run = scopeRuns.get(scope);
      if (run?.runId === runId) {
        endExactStateValidationRun(run.adapter, runId);
        scopeRuns.delete(scope);
      }
    },
  });
  return scope;
}

function activePostSaveExactProofDetails(proof: PostSaveExactProof): ProofDetails {
  const details = issuedProofDetails.get(proof);
  const run = details == null ? undefined : scopeRuns.get(details.scope);
  if (
    details == null ||
    run?.proofs.get(details.revision) !== proof ||
    run.token !== details.runToken ||
    run.adapter !== details.adapter
  ) {
    throw new TypeError("公開済みexact revisionの証明が現在のrunに属していません");
  }
  return details;
}

/** 同じrunと設定で保持した公開済みrevisionの証明を返す。 */
export function postSaveExactProof(
  adapter: StateBranchAdapter,
  configuration: StatePersistenceConfiguration,
  revision: string,
): PostSaveExactProof | undefined {
  adapter = exactStateValidationOrigin(adapter);
  const scope = adapterScopes.get(adapter);
  const proof = scope == null ? undefined : scopeRuns.get(scope)?.proofs.get(revision);
  if (proof == null) {
    return undefined;
  }
  const details = activePostSaveExactProofDetails(proof);
  return details.revision === revision &&
    details.configuration === serializeCanonicalJson(configuration) &&
    details.adapter === adapter
    ? proof
    : undefined;
}

function issueAndRetainPostSaveExactProof(
  scope: PostSaveExactProofScope,
  runToken: symbol,
  configuration: StatePersistenceConfiguration,
  revision: string,
  transaction: VerifiedRunTransactionFiles,
  footprint: PostSaveExactReadFootprint,
  chain: StateCommitChainResult,
): void {
  const run = scopeRuns.get(scope);
  if (
    run?.token !== runToken ||
    transaction.marker.runId !== run.runId ||
    transaction.snapshotSchemaVersion !== "23"
  ) {
    throw new TypeError("公開済みexact revisionの証明入力が現在のrunに一致しません");
  }
  const proof = Object.freeze({
    [postSaveExactProofBrand]: true,
    recordDigest: transaction.record.recordDigest,
    markerDigest: nodeContentDigestPort.sha256Utf8(serializeCanonicalJson(transaction.marker)),
    chain,
  } satisfies PostSaveExactProof);
  issuedProofDetails.set(
    proof,
    Object.freeze({
      scope,
      runToken,
      adapter: run.adapter,
      revision,
      configuration: serializeCanonicalJson(configuration),
      footprint,
    }),
  );
  scopeRuns.set(scope, { ...run, proofs: new Map([...run.proofs, [revision, proof]]) });
}

/** freshなpath、byte列を完全検証時の同じexact treeへ照合する。 */
export function assertPostSaveExactTree(
  proof: PostSaveExactProof,
  paths: readonly string[],
  files: ReadonlyMap<string, StateFileReadResult>,
): void {
  const details = activePostSaveExactProofDetails(proof);
  assertPostSaveExactReadTree(details.footprint, details.revision, paths, files);
}

type ObservedCommit<T> = Readonly<{
  receipt: T;
  evidence: StateCommitReceiptEvidence;
}>;

type StateCommitObservation = Readonly<{
  invocationId: string;
  observedAt: string;
  position: ObservedStateCommitPosition;
}>;

type VerifiedTree = Readonly<{
  files: ReadonlyMap<string, StateFileReadResult>;
  transaction: VerifiedRunTransactionFiles;
}>;

async function readVerifiedTree(
  adapter: StateBranchAdapter,
  configuration: StatePersistenceConfiguration,
  revision: string,
): Promise<VerifiedTree> {
  const paths = await adapter.listFiles(revision, "state");
  const files = await adapter.readFiles(revision, paths);
  if (files.size !== paths.length || paths.some((path) => files.get(path)?.status !== "present")) {
    throw new TypeError("観測対象のexact state file一覧が不足しています");
  }
  const proof = postSaveExactProof(adapter, configuration, revision);
  if (proof != null) {
    assertPostSaveExactTree(proof, paths, files);
  }
  const transaction = verifyRunTransactionFiles(
    files,
    configuration,
    exactStateValidationSession(adapter, configuration).validation,
  );
  if (transaction == null) {
    throw new TypeError("観測対象のexact stateにrun transactionがありません");
  }
  return { files, transaction };
}

async function observePublishedStateCommitAtRevision(
  adapter: StateBranchAdapter,
  currentConfiguration: StatePersistenceConfiguration,
  revision: string,
  initialStateRevision: string,
  receiptType: StateCommitReceiptEvidence["receiptType"],
  observation: StateCommitObservation,
  observePerformanceDetail: PerformanceDetailObserver | undefined,
): Promise<
  ObservedCommit<InitialStateCommitReceipt | NotificationSettlementReceipt | RunFinalizationReceipt>
> {
  const configuration = Object.freeze({ ...currentConfiguration });
  const configurationIdentity = serializeCanonicalJson(configuration);
  const proof = postSaveExactProof(adapter, configuration, revision);
  const originAdapter = exactStateValidationOrigin(adapter);
  const scope = adapterScopes.get(originAdapter);
  const proofRun = scope == null ? undefined : scopeRuns.get(scope);
  if (proofRun != null && proofRun.adapter !== originAdapter) {
    throw new TypeError("公開stateの読込adapterが現在のrunに属していません");
  }
  const source = scope == null ? bindStateBranchAdapter(adapter) : adapter;
  const session = exactStateValidationSession(source, configuration, observePerformanceDetail);
  const readingAdapter = session.adapter;
  const recording =
    proof == null && scope != null && proofRun != null
      ? { scope, runToken: proofRun.token, footprint: session.footprint }
      : undefined;
  const [tree, commit] = await Promise.all([
    readVerifiedTree(readingAdapter, configuration, revision),
    readingAdapter.readCommit(revision),
  ]);
  observePerformanceDetail?.({ step: "receipt_tree_read", count: tree.files.size });
  const { marker, record } = tree.transaction;
  let chain: StateCommitChainResult;
  if (proof == null) {
    chain = await verifyStateCommitChain(
      readingAdapter,
      configuration,
      revision,
      tree.transaction,
      initialStateRevision,
      { revision, files: tree.files, transaction: tree.transaction },
    );
  } else {
    if (
      proof.chain.initialStateRevision !== initialStateRevision ||
      proof.recordDigest !== tree.transaction.record.recordDigest ||
      proof.markerDigest !==
        nodeContentDigestPort.sha256Utf8(serializeCanonicalJson(tree.transaction.marker))
    )
      throw new TypeError("公開済みchain証明のtransaction結合が一致しません");
    const details = activePostSaveExactProofDetails(proof);
    await assertPostSaveExactReadDependencies(
      readingAdapter,
      details.footprint,
      revision,
      tree.files,
      commit,
    );
    activePostSaveExactProofDetails(proof);
    chain = proof.chain;
  }
  observePerformanceDetail?.({ step: "receipt_commit_chain_verified" });
  if (
    commit.revision !== revision ||
    commit.metadata.commitScope !== "tracking_run" ||
    commit.metadata.runId !== marker.runId ||
    commit.changedPathManifest.entries.every(
      (entry) => entry.path !== RUN_TRANSACTION_MARKER_STATE_PATH_V1,
    ) ||
    observation.invocationId === record.runIdentity.invocationId
  ) {
    throw new TypeError("state commitのmetadataまたは再観測試行が不正です");
  }
  const parentRevision = commit.parent.status === "present" ? commit.parent.revision : "unborn";
  if (
    receiptType === "initial_state_commit" &&
    (revision !== initialStateRevision || marker.phase !== "initial_state_committed")
  ) {
    throw new TypeError("初回state commitのrevisionまたはphaseが一致しません");
  }
  const { expectedTrackingStateRevision, interveningOperationsAlertCommits } = chain;
  const common = {
    marker,
    record: {
      runId: record.runIdentity.runId,
      checkpointDigest: record.checkpointDigest,
      checkpointFileDigest: record.checkpointFileDigest,
      runtimeIdentityDigest: nodeContentDigestPort.sha256Utf8(
        serializeCanonicalJson(record.runtimeIdentity),
      ),
      recordDigest: record.recordDigest,
      notificationAction: record.notificationOutbox.action,
    },
    commit: {
      revision,
      parentRevision,
      operationId: commit.metadata.operationId,
      runId: marker.runId,
      commitScope: commit.metadata.commitScope,
      changedPathManifestDigest: commit.metadata.changedPathManifestDigest,
    },
    expectedTrackingStateRevision,
    interveningOperationsAlertCommits: [...interveningOperationsAlertCommits],
    snapshotDigest: tree.transaction.snapshotDigest,
    notificationLedgerDigest: tree.transaction.notificationLedgerDigest,
  };
  let evidence: StateCommitReceiptEvidence;
  if (receiptType === "initial_state_commit") {
    evidence = { ...common, receiptType };
  } else if (receiptType === "notification_settlement") {
    evidence = {
      ...common,
      receiptType,
      notificationHistoryDigest: finalizedHistoryDigest(
        tree.files,
        configuration,
        marker,
        record,
        session.validation,
      ),
    };
  } else {
    evidence = {
      ...common,
      receiptType,
      runReportDigest: finalizedRunReportDigest(tree.files, configuration, marker, record),
    };
  }
  const receipt = observeStateCommitReceipt(evidence, observation, nodeContentDigestPort);
  verifyReceiptChain(
    [{ receipt, evidence: { kind: "state_commit", state: evidence } }],
    nodeContentDigestPort,
  );
  await assertPublishedStateCommit(readingAdapter, configuration, commit);
  if (
    adapterScopes.get(originAdapter) !== scope ||
    (scope != null && scopeRuns.get(scope)?.token !== proofRun?.token) ||
    serializeCanonicalJson(currentConfiguration) !== configurationIdentity ||
    (recording != null && marker.runId !== proofRun?.runId)
  ) {
    throw new TypeError("公開stateの観測中に生成元、runまたは設定が変化しました");
  }
  if (recording != null && tree.transaction.snapshotSchemaVersion === "23") {
    issueAndRetainPostSaveExactProof(
      recording.scope,
      recording.runToken,
      configuration,
      revision,
      tree.transaction,
      recording.footprint,
      chain,
    );
  }
  observePerformanceDetail?.({ step: "receipt_created" });
  return Object.freeze({ receipt, evidence });
}

/** 公開済み初回stateを完全検証して同じ日次runの証明を保持する。 */
export async function observeInitialPublishedStateCommit(
  adapter: StateBranchAdapter,
  configuration: StatePersistenceConfiguration,
  revision: string,
  observation: StateCommitObservation,
  observePerformanceDetail?: PerformanceDetailObserver,
): Promise<ObservedCommit<InitialStateCommitReceipt>> {
  const observed = await observePublishedStateCommitAtRevision(
    adapter,
    configuration,
    revision,
    revision,
    "initial_state_commit",
    observation,
    observePerformanceDetail,
  );
  if (observed.receipt.receiptType !== "initial_state_commit") {
    throw new TypeError("初回公開stateのreceipt種別が不正です");
  }
  return Object.freeze({ receipt: observed.receipt, evidence: observed.evidence });
}

/** 公開head、commit metadataと全marker遷移からstate receiptを再観測する。 */
export async function observeStateCommitAtRevision(
  adapter: StateBranchAdapter,
  configuration: StatePersistenceConfiguration,
  revision: string,
  initialStateRevision: string,
  receiptType: StateCommitReceiptEvidence["receiptType"],
  observation: StateCommitObservation,
  observePerformanceDetail?: PerformanceDetailObserver,
): Promise<
  ObservedCommit<InitialStateCommitReceipt | NotificationSettlementReceipt | RunFinalizationReceipt>
> {
  return observePublishedStateCommitAtRevision(
    adapter,
    configuration,
    revision,
    initialStateRevision,
    receiptType,
    observation,
    observePerformanceDetail,
  );
}
