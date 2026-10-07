import { z } from "zod";

import { createGitHubNodeId } from "../domain/index.js";
import { GitHubResponseValidationError } from "./errors.js";
import { normalizeActor } from "./item-detail-accounts.js";
import { assertItemResponseType } from "./item-detail-capability.js";
import {
  assertNoDuplicateNodeIds,
  parseGraphqlResponse,
  requireConnectionCursor,
  requireGraphqlNode,
} from "./item-detail-connection.js";
import { COMMENT_PAGE_QUERY, createTimelinePageQuery } from "./item-detail-pagination-queries.js";
import type {
  commentConnectionSchema,
  Graphql,
  RawComment,
  RawTimelineNode,
  timelineConnectionSchema,
} from "./item-detail-response-schema.js";
import {
  itemCommentPageResponseSchema,
  itemTimelinePageResponseSchema,
} from "./item-detail-response-schema.js";
import { type GitHubIssueComment } from "./item-detail-types.js";
import { type EnumeratedGitHubItem } from "./item-enumeration.js";
import { buildProductionSourceId } from "./production-source-id.js";

export async function collectCommentNodes(
  item: EnumeratedGitHubItem,
  initialConnection: z.output<typeof commentConnectionSchema>,
  graphql: Graphql,
): Promise<readonly RawComment[]> {
  const nodes = [...initialConnection.nodes];
  let pageInfo = initialConnection.pageInfo;
  for (;;) {
    const cursor = requireConnectionCursor(pageInfo, "issue comments");
    if (cursor == null) {
      break;
    }
    const response = await graphql(COMMENT_PAGE_QUERY, {
      itemId: item.nodeId,
      after: cursor,
    });
    const parsed = parseGraphqlResponse(
      itemCommentPageResponseSchema,
      response,
      "issue comment page",
    );
    const responseItem = requireGraphqlNode(
      parsed.item,
      item.nodeId,
      (node) => node.id,
      "issue comment page",
    );
    assertItemResponseType(responseItem.__typename, item, "issue comment page");
    if (responseItem.comments.nodes.length === 0) {
      throw new GitHubResponseValidationError("issue comment page", {
        cause: new TypeError("次ページとして空のcomments connectionを受け取りました"),
      });
    }
    nodes.push(...responseItem.comments.nodes);
    pageInfo = responseItem.comments.pageInfo;
  }
  assertNoDuplicateNodeIds(
    nodes.map((node) => node.id),
    "issue comments",
  );
  return Object.freeze(nodes);
}

export function normalizeComments(nodes: readonly RawComment[]): readonly GitHubIssueComment[] {
  return Object.freeze(
    nodes.map((comment, sequence) => {
      const nodeId = createGitHubNodeId(comment.id);
      return Object.freeze({
        sourceId: buildProductionSourceId("github_issue_comment", nodeId),
        nodeId,
        sequence,
        author: normalizeActor(comment.author),
        body: comment.body,
        createdAt: comment.createdAt,
        updatedAt: comment.updatedAt,
        url: comment.url,
      } satisfies GitHubIssueComment);
    }),
  );
}

export async function collectTimelineNodes(
  item: EnumeratedGitHubItem,
  initialConnection: z.output<typeof timelineConnectionSchema>,
  graphql: Graphql,
): Promise<readonly RawTimelineNode[]> {
  const nodes = [...initialConnection.nodes];
  let pageInfo = initialConnection.pageInfo;
  const query = createTimelinePageQuery(item.type);
  for (;;) {
    const cursor = requireConnectionCursor(pageInfo, "timeline events");
    if (cursor == null) {
      break;
    }
    const response = await graphql(query, {
      itemId: item.nodeId,
      after: cursor,
    });
    const parsed = parseGraphqlResponse(
      itemTimelinePageResponseSchema,
      response,
      "timeline event page",
    );
    const responseItem = requireGraphqlNode(
      parsed.item,
      item.nodeId,
      (node) => node.id,
      "timeline event page",
    );
    assertItemResponseType(responseItem.__typename, item, "timeline event page");
    if (responseItem.timelineItems.nodes.length === 0) {
      throw new GitHubResponseValidationError("timeline event page", {
        cause: new TypeError("次ページとして空のtimeline connectionを受け取りました"),
      });
    }
    nodes.push(...responseItem.timelineItems.nodes);
    pageInfo = responseItem.timelineItems.pageInfo;
  }
  const nodeIds = nodes.map((node) => {
    const id = node["id"];
    if (typeof id !== "string") {
      throw new GitHubResponseValidationError("timeline events", {
        cause: new TypeError("timeline eventにnode IDがありません"),
      });
    }
    return id;
  });
  assertNoDuplicateNodeIds(nodeIds, "timeline events");
  return Object.freeze(nodes);
}
