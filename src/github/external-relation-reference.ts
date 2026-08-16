import { z } from "zod";

import { type RelationTextReference } from "../graph/extract-relation-candidates.js";
import { type GitHubClient } from "./client.js";
import { GitHubResponseSchemaValidationError, GitHubResponseValidationError } from "./errors.js";
import { normalizeReferencedItem, referencedItemSchema } from "./item-detail-collection.js";
import { createGitHubRelationReferenceQuery } from "./item-detail-queries.js";
import { type GitHubReferencedItem } from "./item-detail-types.js";

type Graphql = GitHubClient["graphql"];
type RawReferencedItem = z.output<typeof referencedItemSchema>;

const relationReferenceResponseSchema = z.strictObject({
  repository: z
    .strictObject({
      issueOrPullRequest: referencedItemSchema.nullable(),
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

function selectResponseItem(response: RawRelationReferenceResponse): RawReferencedItem | null {
  const repository = response.repository;
  if (repository == null) {
    return null;
  }
  return repository.issueOrPullRequest;
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
  const normalizedItem = normalizeReferencedItem(item);
  if (
    reference.itemType != null &&
    ((reference.itemType === "issue" && item.__typename !== "Issue") ||
      (reference.itemType === "pull_request" && item.__typename !== "PullRequest"))
  ) {
    return createUnverifiedResult();
  }
  return Object.freeze({
    status: "public",
    item: normalizedItem,
  });
}

/** GitHub relation参照を個別取得し、公開metadataだけを返す。 */
export async function resolveGitHubRelationReference(
  options: ResolveGitHubRelationReferenceOptions,
): Promise<GitHubRelationReferenceResult> {
  const { reference } = options;
  const response = await options.graphql(createGitHubRelationReferenceQuery(), {
    owner: reference.repositoryOwner,
    name: reference.repositoryName,
    number: reference.number,
  });
  const parsedResponse = relationReferenceResponseSchema.safeParse(response);
  if (!parsedResponse.success) {
    throw new GitHubResponseSchemaValidationError("GitHubの関係参照", parsedResponse.error);
  }
  const item = selectResponseItem(parsedResponse.data);
  return item == null ? createUnverifiedResult() : normalizePublicResponse(reference, item);
}
