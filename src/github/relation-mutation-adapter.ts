import {
  extractRelationMutations,
  type RelationMutationHistory,
  type RelationMutationResult,
} from "../graph/relation-mutation.js";
import {
  type GitHubIssueComment,
  type GitHubItemDetail,
  type GitHubPullRequestReviewComment,
  type GitHubUserContentEditCollection,
} from "./item-detail-types.js";
import { type UtcIsoDateTime } from "../domain/index.js";

type GitHubRelationMutationContentSource = Readonly<{
  contentSourceId: GitHubItemDetail["bodySourceId"];
  contentCreatedAt: UtcIsoDateTime | null;
  currentMarkdown: string;
  history: GitHubUserContentEditCollection;
}>;

/** GitHub detailからrelation mutationへ変換する本文の種別。 */
export type GitHubRelationMutationSource =
  | (GitHubRelationMutationContentSource &
      Readonly<{
        kind: "item_body";
      }>)
  | (GitHubRelationMutationContentSource &
      Readonly<{
        kind: "issue_comment";
      }>)
  | (GitHubRelationMutationContentSource &
      Readonly<{
        kind: "pull_request_review_comment";
      }>);

/** relation sourceではないPull Request review commentを抑止した結果。 */
export type GitHubSuppressedRelationMutation = Readonly<{
  status: "suppressed";
  contentSourceId: GitHubPullRequestReviewComment["sourceId"];
  reason: "pull_request_review_comment";
}>;

export type GitHubRelationMutationSourceResult = Readonly<{
  kind: GitHubRelationMutationSource["kind"];
  contentSourceId: GitHubRelationMutationSource["contentSourceId"];
  result: RelationMutationResult | GitHubSuppressedRelationMutation;
}>;

function adaptHistory(collection: GitHubUserContentEditCollection): RelationMutationHistory {
  if (collection.availability === "unavailable") {
    return Object.freeze({
      availability: "unavailable",
      reason: "connection_unavailable",
    });
  }
  return Object.freeze({
    availability: "available",
    edits: Object.freeze(
      collection.edits.map((edit) =>
        Object.freeze({
          sourceId: edit.sourceId,
          editedAt: edit.editedAt,
          sequence: edit.sequence,
          createdAt: edit.createdAt,
          diff: edit.diff,
          deletedAt: edit.deletedAt,
        }),
      ),
    ),
  });
}

function createContentSourceResult(
  source: GitHubRelationMutationContentSource &
    Readonly<{
      kind: "item_body" | "issue_comment";
    }>,
): GitHubRelationMutationSourceResult {
  return Object.freeze({
    kind: source.kind,
    contentSourceId: source.contentSourceId,
    result: extractRelationMutations({
      contentSourceId: source.contentSourceId,
      contentCreatedAt: source.contentCreatedAt,
      currentMarkdown: source.currentMarkdown,
      history: adaptHistory(source.history),
    }),
  });
}

/** GitHub detailの本文またはコメントをrelation mutationへ変換する。 */
export function adaptGitHubRelationMutationSource(
  source: GitHubRelationMutationSource,
): GitHubRelationMutationSourceResult {
  if (source.kind === "pull_request_review_comment") {
    return Object.freeze({
      kind: source.kind,
      contentSourceId: source.contentSourceId,
      result: Object.freeze({
        status: "suppressed",
        contentSourceId: source.contentSourceId,
        reason: "pull_request_review_comment",
      }),
    });
  }
  return createContentSourceResult(source);
}

function createIssueCommentSource(comment: GitHubIssueComment): GitHubRelationMutationSource {
  return Object.freeze({
    kind: "issue_comment",
    contentSourceId: comment.sourceId,
    contentCreatedAt: comment.createdAt,
    currentMarkdown: comment.body,
    history: comment.userContentEdits,
  });
}

/** GitHub item detailのrelation対象本文だけをmutation結果へ変換する。 */
export function adaptGitHubItemDetailRelationMutations(
  detail: GitHubItemDetail,
): readonly GitHubRelationMutationSourceResult[] {
  const results: GitHubRelationMutationSourceResult[] = [
    adaptGitHubRelationMutationSource({
      kind: "item_body",
      contentSourceId: detail.bodySourceId,
      contentCreatedAt: null,
      currentMarkdown: detail.body,
      history: detail.bodyUserContentEdits,
    }),
    ...detail.comments.map((comment) =>
      adaptGitHubRelationMutationSource(createIssueCommentSource(comment)),
    ),
  ];
  return Object.freeze(results);
}
