import { parseSourceId, type SourceId, type TrackedItemInputEvent } from "../domain/index.js";
import type { FreshObservedGitHubItem, GitHubItemDetail } from "../github/index.js";
import { assertNonNullable } from "../util/index.js";

type InputEventAnalysis = Readonly<{
  item: FreshObservedGitHubItem;
  detail: GitHubItemDetail;
}>;

function inputCommentUrl(
  analysis: InputEventAnalysis,
  sourceId: SourceId,
): TrackedItemInputEvent["url"] {
  const sourceKind = parseSourceId(sourceId).kind;
  if (sourceKind === "github_issue_comment") {
    const comment = analysis.detail.comments.find((candidate) => candidate.sourceId === sourceId);
    assertNonNullable(comment, `Issue commentのURLがありません。対象: ${sourceId}`);
    return comment.url;
  }
  if (sourceKind === "github_pull_request_review_comment") {
    if (analysis.detail.type !== "pull_request") {
      throw new TypeError(`IssueにPull Request review commentがあります。対象: ${sourceId}`);
    }
    const comment = analysis.detail.reviewThreads
      .flatMap((thread) => thread.comments)
      .find((candidate) => candidate.sourceId === sourceId);
    assertNonNullable(comment, `Pull Request review commentのURLがありません。対象: ${sourceId}`);
    return comment.url;
  }
  throw new TypeError(`commentイベントのsource ID種別が不正です。対象: ${sourceId}`);
}

function inputReviewUrl(
  analysis: InputEventAnalysis,
  sourceId: SourceId,
): TrackedItemInputEvent["url"] {
  if (parseSourceId(sourceId).kind !== "github_pull_request_review") {
    throw new TypeError(`reviewイベントのsource ID種別が不正です。対象: ${sourceId}`);
  }
  if (analysis.detail.type !== "pull_request") {
    throw new TypeError(`IssueにPull Request reviewがあります。対象: ${sourceId}`);
  }
  const review = analysis.detail.reviews.find((candidate) => candidate.sourceId === sourceId);
  assertNonNullable(review, `Pull Request reviewのURLがありません。対象: ${sourceId}`);
  return review.url;
}

function trackedItemInputEventUrl(
  analysis: InputEventAnalysis,
  event: FreshObservedGitHubItem["events"][number],
): TrackedItemInputEvent["url"] {
  switch (event.kind) {
    case "comment":
      return inputCommentUrl(analysis, event.sourceId);
    case "review":
      return inputReviewUrl(analysis, event.sourceId);
    default:
      return analysis.item.url;
  }
}

/** 追跡項目の入力イベントと参照URLを構築する。 */
export function trackedItemInputEvents(
  analysis: InputEventAnalysis,
): readonly TrackedItemInputEvent[] {
  return Object.freeze(
    analysis.item.events.map((event) =>
      Object.freeze({
        sourceId: event.sourceId,
        url: trackedItemInputEventUrl(analysis, event),
      }),
    ),
  );
}
