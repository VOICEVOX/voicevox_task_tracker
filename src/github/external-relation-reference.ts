import { z } from "zod";

import { type RelationTextReference } from "../graph/extract-relation-candidates.js";
import { type GitHubClient } from "./client.js";
import { GitHubResponseSchemaValidationError, GitHubResponseValidationError } from "./errors.js";
import { normalizeReferencedItem, referencedItemSchema } from "./item-detail-collection.js";
import { createGitHubRelationReferenceQuery } from "./item-detail-queries.js";
import { type GitHubReferencedItem } from "./item-detail-types.js";

type Graphql = GitHubClient["graphql"];
type RawReferencedItem = z.output<typeof referencedItemSchema>;

const relationReferenceResponseSchema = z.object({
  repository: z
    .object({
      issue: referencedItemSchema.nullable().optional(),
      pullRequest: referencedItemSchema.nullable().optional(),
      issueOrPullRequest: referencedItemSchema.nullable().optional(),
    })
    .nullable(),
});

type RawRelationReferenceResponse = z.output<typeof relationReferenceResponseSchema>;

/** GitHub relation参照の公開metadata解決結果。 */
export type GitHubRelationReferenceResult =
  | Readonly<{
      status: "public";
      item: GitHubReferencedItem;
    }>
  | Readonly<{
      status: "unverified";
    }>;

export type ResolveGitHubRelationReferenceOptions = Readonly<{
  reference: RelationTextReference;
  graphql: Graphql;
}>;

function createResponseValidationError(message: string): GitHubResponseValidationError {
  return new GitHubResponseValidationError("GitHubの関係参照", {
    cause: new TypeError(message),
  });
}

function assertResponseFields(
  response: RawRelationReferenceResponse,
  itemType: RelationTextReference["itemType"],
): void {
  const repository = response.repository;
  if (repository == null) {
    return;
  }
  const hasIssue = Object.hasOwn(repository, "issue");
  const hasPullRequest = Object.hasOwn(repository, "pullRequest");
  const hasIssueOrPullRequest = Object.hasOwn(repository, "issueOrPullRequest");
  if (
    (itemType == null && !hasIssueOrPullRequest) ||
    (itemType === "issue" && !hasIssue) ||
    (itemType === "pull_request" && !hasPullRequest)
  ) {
    throw createResponseValidationError("要求したGraphQL fieldが応答にありません");
  }
}

function assertResponseFieldType(
  item: RawReferencedItem | null | undefined,
  expectedType: "Issue" | "PullRequest",
): void {
  if (item != null && item.__typename !== expectedType) {
    throw createResponseValidationError("GraphQL fieldの項目種別が一致しません");
  }
}

function selectResponseItem(
  response: RawRelationReferenceResponse,
  itemType: RelationTextReference["itemType"],
): RawReferencedItem | null {
  const repository = response.repository;
  if (repository == null) {
    return null;
  }
  if (itemType == null) {
    return repository.issueOrPullRequest ?? null;
  }
  const issue = repository.issue;
  const pullRequest = repository.pullRequest;
  if (issue != null && pullRequest != null) {
    throw createResponseValidationError("IssueとPull Requestが同時に返されました");
  }
  assertResponseFieldType(issue, "Issue");
  assertResponseFieldType(pullRequest, "PullRequest");
  if (issue != null) {
    if (itemType === "pull_request") {
      throw createResponseValidationError("要求した項目種別と応答項目種別が一致しません");
    }
    return issue;
  }
  if (pullRequest != null) {
    if (itemType === "issue") {
      throw createResponseValidationError("要求した項目種別と応答項目種別が一致しません");
    }
    return pullRequest;
  }
  return null;
}

function assertReferenceNumberMatchesItem(
  reference: RelationTextReference,
  item: RawReferencedItem,
): void {
  if (item.number !== reference.number) {
    throw createResponseValidationError("応答項目の番号が要求値と一致しません");
  }
}

function createUnverifiedResult(): GitHubRelationReferenceResult {
  return Object.freeze({ status: "unverified" });
}

function normalizePublicResponse(
  reference: RelationTextReference,
  item: RawReferencedItem,
): GitHubRelationReferenceResult {
  assertReferenceNumberMatchesItem(reference, item);
  if (
    item.repository.visibility !== "PUBLIC" ||
    item.repository.isArchived ||
    item.repository.isDisabled
  ) {
    return createUnverifiedResult();
  }
  return Object.freeze({
    status: "public",
    item: normalizeReferencedItem(item),
  });
}

/** GitHub relation参照を個別取得し、公開metadataだけを返す。 */
export async function resolveGitHubRelationReference(
  options: ResolveGitHubRelationReferenceOptions,
): Promise<GitHubRelationReferenceResult> {
  const { reference } = options;
  const response = await options.graphql(createGitHubRelationReferenceQuery(reference.itemType), {
    owner: reference.repositoryOwner,
    name: reference.repositoryName,
    number: reference.number,
  });
  const parsedResponse = relationReferenceResponseSchema.safeParse(response);
  if (!parsedResponse.success) {
    throw new GitHubResponseSchemaValidationError("GitHubの関係参照", parsedResponse.error);
  }
  assertResponseFields(parsedResponse.data, reference.itemType);
  const item = selectResponseItem(parsedResponse.data, reference.itemType);
  return item == null ? createUnverifiedResult() : normalizePublicResponse(reference, item);
}
