import { hashCanonicalJson, serializeCanonicalJson, type Sha256Hash } from "./canonical-json.js";
import { type AiCacheIdentity } from "./cache.js";
import { type CodexAnalysisInput } from "./input.js";
import {
  createGitHubNodeId,
  createGitHubRepositoryId,
  type GitHubNodeId,
  type GitHubRepositoryId,
} from "../domain/index.js";

/** AI実行とcache再現性を固定する実行設定とversion情報。 */
export type AiAnalysisRunIdentity = Omit<AiCacheIdentity, "inputHash">;

/** Codex分析候補の決定論的な確定状態。 */
export type DeterministicAnalysisResolution = "high_confidence" | "ambiguous";

/** Codex分析の再実行と旧結果再利用を判定するhash一式。 */
export type AiAnalysisFingerprint = Readonly<{
  sourceHash: Sha256Hash;
  inputHash: Sha256Hash;
  graphNeighborhoodHash: Sha256Hash;
  identityHash: Sha256Hash;
}>;

/** 前回のCodex分析fingerprint。 */
export type PreviousAiAnalysisFingerprint =
  | Readonly<{
      status: "unavailable";
    }>
  | Readonly<{
      status: "available";
      fingerprint: AiAnalysisFingerprint;
    }>;

/** 予算不足時のCodex分析優先順位。 */
export type AiAnalysisPriority = Readonly<{
  previouslyDeferred: boolean;
  severityCandidate: boolean;
  ownerUnknown: boolean;
  changedBlocker: boolean;
  downstreamImpact: Readonly<{
    openNodeCount: number;
    repositoryCount: number;
  }>;
}>;

/** Codexへ送る可能性がある項目。 */
export type AiAnalysisCandidate = Readonly<{
  id: string;
  repository: Readonly<{
    repositoryId: string;
    owner: string;
    name: string;
  }>;
  deterministicResolution: DeterministicAnalysisResolution;
  input: CodexAnalysisInput;
  graphNeighborhood: unknown;
  previousFingerprint: PreviousAiAnalysisFingerprint;
  priority: AiAnalysisPriority;
  estimatedCostUsd: number;
}>;

/** hashと入力文字数を確定したCodex分析候補。 */
export type PreparedAiAnalysisCandidate = Omit<AiAnalysisCandidate, "id" | "repository"> &
  Readonly<{
    id: GitHubNodeId;
    repository: Readonly<{
      repositoryId: GitHubRepositoryId;
      owner: string;
      name: string;
    }>;
    fingerprint: AiAnalysisFingerprint;
    normalizedInput: string;
    inputCharacters: number;
  }>;

/** Codexへ送らない理由。 */
export type AiAnalysisSkipReason = "determined_with_high_confidence" | "unchanged";

/** Codex呼び出し対象の純粋な選別結果。 */
export type AiAnalysisSelection = Readonly<{
  selected: readonly PreparedAiAnalysisCandidate[];
  skipped: readonly Readonly<{
    candidate: PreparedAiAnalysisCandidate;
    reason: AiAnalysisSkipReason;
  }>[];
}>;

function countUnicodeCharacters(value: string): number {
  let count = 0;
  for (const character of value) {
    if (character.length === 0) {
      throw new TypeError("空のUnicode文字を検出しました");
    }
    count += 1;
  }
  return count;
}

function validateCandidateRepository(
  candidate: AiAnalysisCandidate,
): PreparedAiAnalysisCandidate["repository"] {
  if (candidate.repository.owner.length === 0 || candidate.repository.name.length === 0) {
    throw new TypeError("Codex分析候補のrepository ownerとnameは空にできません");
  }
  return Object.freeze({
    repositoryId: createGitHubRepositoryId(candidate.repository.repositoryId),
    owner: candidate.repository.owner,
    name: candidate.repository.name,
  });
}

/** run開始時刻を除いたinput hash値を生成する。 */
function createInputHashValue(input: CodexAnalysisInput): unknown {
  const { now: excludedRunStartTime, ...inputHashValue } = input;
  void excludedRunStartTime;
  return Object.freeze(inputHashValue);
}

/** Codex分析候補の正規化入力、source、グラフ隣接hashを生成する。 */
export function prepareAiAnalysisCandidate(
  candidate: AiAnalysisCandidate,
  identity: AiAnalysisRunIdentity,
): PreparedAiAnalysisCandidate {
  const id = createGitHubNodeId(candidate.id);
  if (candidate.input.item.nodeId !== id) {
    throw new TypeError("Codex分析候補IDが入力項目のnode IDと一致しません");
  }
  const repository = validateCandidateRepository(candidate);
  const normalizedInput = `${serializeCanonicalJson(candidate.input)}\n`;
  const graphNeighborhoodHash = hashCanonicalJson(candidate.graphNeighborhood);
  const fingerprint = Object.freeze({
    sourceHash: hashCanonicalJson(candidate.input.sources),
    inputHash: hashCanonicalJson({
      graphNeighborhood: candidate.graphNeighborhood,
      input: createInputHashValue(candidate.input),
    }),
    graphNeighborhoodHash,
    identityHash: hashCanonicalJson(identity),
  });
  return Object.freeze({
    ...candidate,
    id,
    repository,
    fingerprint,
    normalizedInput,
    inputCharacters: countUnicodeCharacters(normalizedInput),
  });
}

function shouldSelectCandidate(candidate: PreparedAiAnalysisCandidate): boolean {
  if (candidate.deterministicResolution === "high_confidence") {
    return false;
  }
  if (candidate.previousFingerprint.status === "unavailable") {
    return true;
  }
  return (
    candidate.fingerprint.inputHash !== candidate.previousFingerprint.fingerprint.inputHash ||
    candidate.fingerprint.graphNeighborhoodHash !==
      candidate.previousFingerprint.fingerprint.graphNeighborhoodHash ||
    candidate.fingerprint.identityHash !== candidate.previousFingerprint.fingerprint.identityHash
  );
}

function determineSkipReason(candidate: PreparedAiAnalysisCandidate): AiAnalysisSkipReason {
  if (candidate.deterministicResolution === "high_confidence") {
    return "determined_with_high_confidence";
  }
  return "unchanged";
}

/** 高信頼の確定項目と未変更項目を除き、曖昧な変更項目だけを選ぶ。 */
export function selectAiAnalysisCandidates(
  candidates: readonly PreparedAiAnalysisCandidate[],
): AiAnalysisSelection {
  const candidateIds = new Set<string>();
  const selected: PreparedAiAnalysisCandidate[] = [];
  const skipped: {
    candidate: PreparedAiAnalysisCandidate;
    reason: AiAnalysisSkipReason;
  }[] = [];

  for (const candidate of candidates) {
    if (candidateIds.has(candidate.id)) {
      throw new TypeError(`Codex分析候補IDが重複しています。対象: ${candidate.id}`);
    }
    candidateIds.add(candidate.id);
    if (shouldSelectCandidate(candidate)) {
      selected.push(candidate);
    } else {
      skipped.push({
        candidate,
        reason: determineSkipReason(candidate),
      });
    }
  }

  return Object.freeze({
    selected: Object.freeze(selected),
    skipped: Object.freeze(skipped.map((value) => Object.freeze(value))),
  });
}
