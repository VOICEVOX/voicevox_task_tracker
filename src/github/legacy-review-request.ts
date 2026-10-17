import { z } from "zod";

import { createGitHubNodeId, createGitHubRepositoryId } from "../domain/types.js";
import { parseSourceId, type SourceId } from "../domain/source-id.js";
import { GitHubPublicBoundaryViolationError, GitHubResponseValidationError } from "./errors.js";
import { parseGraphqlResponse, requireGraphqlNode } from "./item-detail-connection.js";
import type { LegacyReviewRequestInspection } from "./item-detail-types.js";
import { appendRequiredFragments } from "./item-detail-query-fragments.js";
import type { Graphql } from "./item-detail-response-schema.js";
import { reviewRequestTargetSchema } from "./item-detail-response-schema.js";
import type { PublicRepositoryAllowlist } from "./public-repository-allowlist.js";

const legacyReviewRequestResponseSchema = z.object({
  node: z
    .object({
      __typename: z.literal("ReviewRequest"),
      id: z.string().min(1),
      pullRequest: z.object({
        id: z.string().min(1),
        repository: z.object({
          id: z.string().min(1),
          visibility: z.enum(["PUBLIC", "PRIVATE", "INTERNAL"]),
          isArchived: z.boolean(),
          isDisabled: z.boolean(),
        }),
      }),
      requestedReviewer: reviewRequestTargetSchema.nullable(),
    })
    .nullable(),
});

const LEGACY_REVIEW_REQUEST_QUERY = appendRequiredFragments(`
  query GitHubLegacyReviewRequest($requestId: ID!) {
    node(id: $requestId) {
      __typename
      ... on ReviewRequest {
        id
        pullRequest {
          id
          repository {
            id
            visibility
            isArchived
            isDisabled
          }
        }
        requestedReviewer {
          ...DetailReviewRequestTargetFields
        }
      }
    }
  }
`);

/** 旧review request nodeを公開リポジトリ内で読み取り、所有情報だけを返す。 */
export async function inspectLegacyReviewRequests(
  sourceIds: readonly SourceId[],
  allowlist: PublicRepositoryAllowlist,
  graphql: Graphql,
): Promise<readonly LegacyReviewRequestInspection[]> {
  if (new Set(sourceIds).size !== sourceIds.length) {
    throw new TypeError("旧review requestのsource IDが重複しています");
  }
  const inspections: LegacyReviewRequestInspection[] = [];
  for (const sourceId of sourceIds) {
    const parsed = parseSourceId(sourceId);
    if (parsed.kind !== "github_review_request") {
      throw new TypeError("旧review request以外のsource IDを指定できません");
    }
    const response = await graphql(LEGACY_REVIEW_REQUEST_QUERY, {
      requestId: parsed.originalId,
    });
    const result = parseGraphqlResponse(
      legacyReviewRequestResponseSchema,
      response,
      "旧review request node",
    );
    const node = requireGraphqlNode(
      result.node,
      createGitHubNodeId(parsed.originalId),
      (value) => value.id,
      "旧review request node",
    );
    const repository = node.pullRequest.repository;
    if (repository.visibility !== "PUBLIC" || repository.isArchived || repository.isDisabled) {
      throw new GitHubPublicBoundaryViolationError(1);
    }
    const repositoryId = createGitHubRepositoryId(repository.id);
    allowlist.require(repositoryId);
    const target = node.requestedReviewer;
    if (target == null) {
      throw new GitHubResponseValidationError("旧review request node", {
        cause: new TypeError("旧review requestの依頼先がありません"),
      });
    }
    if (target.__typename !== "Team" && target.__typename !== "User") {
      throw new GitHubResponseValidationError("旧review request node", {
        cause: new TypeError("旧review requestの依頼先が人間のuserまたはteamではありません"),
      });
    }
    inspections.push(
      Object.freeze({
        sourceId,
        ownerNodeId: createGitHubNodeId(node.pullRequest.id),
        repositoryId,
        target: Object.freeze(
          target.__typename === "Team"
            ? {
                kind: "team",
                nodeId: createGitHubNodeId(target.id),
                candidateId: `${target.organization.login}/${target.slug}`,
              }
            : {
                kind: "user",
                nodeId: createGitHubNodeId(target.id),
                candidateId: target.login,
              },
        ),
      }),
    );
  }
  return Object.freeze(inspections);
}
