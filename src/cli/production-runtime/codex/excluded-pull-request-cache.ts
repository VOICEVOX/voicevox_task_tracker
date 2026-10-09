import { parseSha256Hash } from "../../../canonical-json/index.js";
import {
  AI_ANALYSIS_ELEMENT_REVISIONS,
  createAiCacheKey,
  type AiAnalysisRunIdentity,
  type AiCacheStore,
  type PreparedAiAnalysisCandidate,
} from "../../../codex/index.js";
import { affectedIssueNodeId } from "../excluded-pull-request.js";

/** 接続していたIssueの通常AI cache読取だけを迂回する。 */
export function aiCacheWithoutAffectedIssueReads(
  cache: AiCacheStore,
  candidates: readonly PreparedAiAnalysisCandidate[],
  identity: AiAnalysisRunIdentity,
): AiCacheStore {
  const issue = candidates.find((candidate) => candidate.id === affectedIssueNodeId);
  if (issue == null) {
    return cache;
  }
  // 旧Pull Request由来の関係sourceはcache keyに入らないため、対象Issueのreadだけ抑止する。
  const ignoredKeys = new Set(
    issue.selectedElements.map((element) =>
      createAiCacheKey({
        ...identity,
        element: element.element,
        revision: AI_ANALYSIS_ELEMENT_REVISIONS[element.element],
        inputFingerprint: parseSha256Hash(element.inputFingerprint),
        executionFingerprint: parseSha256Hash(element.executionFingerprint),
      }),
    ),
  );
  return Object.freeze({
    read: (key) =>
      ignoredKeys.has(key) ? Promise.resolve(Object.freeze({ status: "miss" })) : cache.read(key),
    write: (entry) => cache.write(entry),
  });
}
