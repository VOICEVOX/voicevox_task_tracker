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
  if (
    (itemType == null && (!hasIssue || !hasPullRequest)) ||
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
  const issue = repository.issue;
  const pullRequest = repository.pullRequest;
  if (issue != null && pullRequest != null) {
    throw createResponseValidationError("IssueとPull Requestが同時に返されました");
  }
  assertResponseFieldType(issue, "Issue");
  assertResponseFieldType(pullRequest, "PullRequest");
  if (issue != null) {
    return itemType === "pull_request" ? null : issue;
  }
  if (pullRequest != null) {
    return itemType === "issue" ? null : pullRequest;
  }
  return null;
}

function assertReferenceMatchesItem(
  reference: RelationTextReference,
  item: RawReferencedItem,
): void {
  if (
    item.repository.owner.login.toLowerCase() !== reference.repositoryOwner.toLowerCase() ||
    item.repository.name.toLowerCase() !== reference.repositoryName.toLowerCase() ||
    item.number !== reference.number
  ) {
    throw createResponseValidationError("要求した参照と応答metadataが一致しません");
  }
}

function createUnverifiedResult(): GitHubRelationReferenceResult {
  return Object.freeze({ status: "unverified" });
}

function normalizePublicResponse(
  reference: RelationTextReference,
  item: RawReferencedItem,
): GitHubRelationReferenceResult {
  assertReferenceMatchesItem(reference, item);
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
