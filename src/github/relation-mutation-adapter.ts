import {
  extractRelationMutations,
  type RelationMutationHistory,
  type RelationMutationResult,
} from "../graph/relation-mutation.js";
import {
  type GitHubIssueComment,
  type GitHubItemDetail,
  type GitHubUserContentEditCollection,
} from "./item-detail-types.js";
import { type UtcIsoDateTime } from "../domain/index.js";

type GitHubRelationMutationContentSource = Readonly<{
  contentSourceId: GitHubItemDetail["bodySourceId"];
  contentCreatedAt: UtcIsoDateTime;
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
      }>);

export type GitHubRelationMutationSourceResult = Readonly<{
  kind: GitHubRelationMutationSource["kind"];
  contentSourceId: GitHubRelationMutationSource["contentSourceId"];
  result: RelationMutationResult;
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
  source: GitHubRelationMutationSource,
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

/** GitHub item detailの本文とIssue commentをrelation mutationへ変換する。 */
export function adaptGitHubItemDetailRelationMutations(
  detail: GitHubItemDetail,
  itemCreatedAt: UtcIsoDateTime,
): readonly GitHubRelationMutationSourceResult[] {
  const results: GitHubRelationMutationSourceResult[] = [
    adaptGitHubRelationMutationSource({
      kind: "item_body",
      contentSourceId: detail.bodySourceId,
      contentCreatedAt: itemCreatedAt,
      currentMarkdown: detail.body,
      history: detail.bodyUserContentEdits,
    }),
    ...detail.comments.map((comment) =>
      adaptGitHubRelationMutationSource(createIssueCommentSource(comment)),
    ),
  ];
  return Object.freeze(results);
}
