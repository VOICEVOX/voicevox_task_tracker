import { hashCanonicalJson, type Sha256Hash } from "./canonical-json.js";
import type { AiAnalysisRunIdentity } from "./analysis-selection.js";
import { assertNonNullable } from "../util/assert-non-nullable.js";

/** 設定で指定できるプロンプト変更の適用範囲。 */
export const PROMPT_UPDATE_SCOPES = ["all", "existing_deadline", "open_unassigned_issue"] as const;

/** プロンプトの意味上の変更と、その変更が適用される範囲。 */
export type PromptUpdateScope = (typeof PROMPT_UPDATE_SCOPES)[number];

/** 連続するプロンプトversion間の意味上の変更。 */
export type PromptUpdate = Readonly<{
  fromVersion: string;
  toVersion: string;
  scope: PromptUpdateScope;
}>;

/** プロンプト変更の適用範囲を判定するための項目状態。 */
export type PromptUpdateContext = Readonly<{
  type: "issue" | "pull_request";
  state: "open" | "closed" | "merged";
  hasAssignees: boolean;
  deadline:
    | Readonly<{
        status: "unavailable";
      }>
    | Readonly<{
        status: "available";
        date: string | null;
      }>;
}>;

/** 現在のprompt versionと前回identityの適用関係。 */
export type PromptUpdateAssessment =
  | Readonly<{
      status: "current";
    }>
  | Readonly<{
      status: "unknown";
    }>
  | Readonly<{
      status: "affected";
    }>
  | Readonly<{
      status: "compatible";
      identity: AiAnalysisRunIdentity;
    }>;

function isPromptUpdateOutOfScope(
  update: PromptUpdate,
  contexts: readonly PromptUpdateContext[],
): boolean {
  switch (update.scope) {
    case "all":
      return false;
    case "existing_deadline":
      return !contexts.some(
        (context) => context.deadline.status === "available" && context.deadline.date != null,
      );
    case "open_unassigned_issue":
      return !contexts.some(
        (context) => context.type === "issue" && context.state === "open" && !context.hasAssignees,
      );
  }
}

function identityForPromptVersion(
  currentIdentity: AiAnalysisRunIdentity,
  promptVersion: string,
): AiAnalysisRunIdentity {
  return Object.freeze({
    ...currentIdentity,
    promptVersion,
  });
}

/** 設定schemaで検証済みの更新履歴について前回identityから現在までの適用関係を判定する。 */
export function assessPromptUpdates(
  currentIdentity: AiAnalysisRunIdentity,
  updates: readonly PromptUpdate[],
  previousIdentityHash: Sha256Hash,
  contexts: readonly PromptUpdateContext[],
): PromptUpdateAssessment {
  if (contexts.length === 0) {
    throw new TypeError("プロンプト更新の適用判定にはcontextが必要です");
  }

  const currentIdentityHash = hashCanonicalJson(currentIdentity);
  if (currentIdentityHash === previousIdentityHash) {
    return Object.freeze({
      status: "current",
    });
  }

  if (updates.length === 0) {
    return Object.freeze({
      status: "unknown",
    });
  }

  const previousVersionIndex = updates.findIndex(
    (update) =>
      hashCanonicalJson(identityForPromptVersion(currentIdentity, update.fromVersion)) ===
      previousIdentityHash,
  );
  if (previousVersionIndex < 0) {
    return Object.freeze({
      status: "unknown",
    });
  }

  for (const update of updates.slice(previousVersionIndex)) {
    if (!isPromptUpdateOutOfScope(update, contexts)) {
      return Object.freeze({
        status: "affected",
      });
    }
  }

  const previousUpdate = updates[previousVersionIndex];
  assertNonNullable(previousUpdate, "前回prompt versionに対応する更新履歴がありません");
  return Object.freeze({
    status: "compatible",
    identity: identityForPromptVersion(currentIdentity, previousUpdate.fromVersion),
  });
}
