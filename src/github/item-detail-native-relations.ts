import { z } from "zod";

import { GitHubResponseValidationError } from "./errors.js";
import { normalizeReferencedItem } from "./item-detail-accounts.js";
import {
  assertNoDuplicateNodeIds,
  parseGraphqlResponse,
  requireConnectionCursor,
  requireGraphqlNode,
} from "./item-detail-connection.js";
import {
  CLOSING_ISSUE_PAGE_QUERY,
  createNativeDependencyPageQuery,
  SUB_ISSUE_PAGE_QUERY,
} from "./item-detail-pagination-queries.js";
import type {
  baseIssueSchema,
  Graphql,
  RawReferencedItem,
  referencedItemConnectionSchema,
} from "./item-detail-response-schema.js";
import {
  closingIssuePageResponseSchema,
  nativeDependencyPageResponseSchema,
  subIssuePageResponseSchema,
} from "./item-detail-response-schema.js";
import {
  type GitHubItemDetailCapabilities,
  type GitHubNativeClosingIssue,
  type GitHubNativeDependency,
  type GitHubNativeDependencyCollection,
  type GitHubNativeHierarchy,
  type GitHubNativeHierarchyCollection,
} from "./item-detail-types.js";
import { type EnumeratedGitHubItem } from "./item-enumeration.js";
import { buildProductionSourceId } from "./production-source-id.js";

export async function collectClosingIssueNodes(
  item: EnumeratedGitHubItem,
  initialConnection: z.output<typeof referencedItemConnectionSchema>,
  graphql: Graphql,
): Promise<readonly RawReferencedItem[]> {
  const nodes = [...initialConnection.nodes];
  let pageInfo = initialConnection.pageInfo;
  for (;;) {
    const cursor = requireConnectionCursor(pageInfo, "Pull Request closing issues");
    if (cursor == null) {
      break;
    }
    const response = await graphql(CLOSING_ISSUE_PAGE_QUERY, {
      itemId: item.nodeId,
      after: cursor,
    });
    const parsed = parseGraphqlResponse(
      closingIssuePageResponseSchema,
      response,
      "Pull Request closing issue page",
    );
    const responseItem = requireGraphqlNode(
      parsed.item,
      item.nodeId,
      (node) => node.id,
      "Pull Request closing issue page",
    );
    if (responseItem.closingIssuesReferences.nodes.length === 0) {
      throw new GitHubResponseValidationError("Pull Request closing issue page", {
        cause: new TypeError(
          "次ページとして空のclosingIssuesReferences connectionを受け取りました",
        ),
      });
    }
    nodes.push(...responseItem.closingIssuesReferences.nodes);
    pageInfo = responseItem.closingIssuesReferences.pageInfo;
  }
  assertNoDuplicateNodeIds(
    nodes.map((node) => node.id),
    "Pull Request closing issues",
  );
  return Object.freeze(nodes);
}

export function normalizeNativeClosingIssues(
  item: EnumeratedGitHubItem,
  nodes: readonly RawReferencedItem[],
): readonly GitHubNativeClosingIssue[] {
  return Object.freeze(
    nodes.map((relatedItem) => {
      if (relatedItem.__typename !== "Issue") {
        throw new GitHubResponseValidationError("Pull Request closing issues", {
          cause: new TypeError("closingIssuesReferencesにIssue以外が含まれています"),
        });
      }
      const normalizedItem = normalizeReferencedItem(relatedItem);
      return Object.freeze({
        sourceId: buildProductionSourceId(
          "github_native_closing_issue",
          `${item.nodeId}:${normalizedItem.nodeId}`,
        ),
        authoritative: true,
        provenance: "native",
        relatedItem: normalizedItem,
      } satisfies GitHubNativeClosingIssue);
    }),
  );
}

async function collectReferencedItemNodes(
  item: EnumeratedGitHubItem,
  initialConnection: z.output<typeof referencedItemConnectionSchema>,
  direction: "blockedBy" | "blocking",
  graphql: Graphql,
): Promise<readonly RawReferencedItem[]> {
  const nodes = [...initialConnection.nodes];
  let pageInfo = initialConnection.pageInfo;
  const query = createNativeDependencyPageQuery(direction);
  for (;;) {
    const cursor = requireConnectionCursor(pageInfo, `native dependency ${direction}`);
    if (cursor == null) {
      break;
    }
    const response = await graphql(query, {
      itemId: item.nodeId,
      after: cursor,
    });
    const parsed = parseGraphqlResponse(
      nativeDependencyPageResponseSchema,
      response,
      `native dependency ${direction} page`,
    );
    const responseItem = requireGraphqlNode(
      parsed.item,
      item.nodeId,
      (node) => node.id,
      `native dependency ${direction} page`,
    );
    const connection = direction === "blockedBy" ? responseItem.blockedBy : responseItem.blocking;
    if (connection == null) {
      throw new GitHubResponseValidationError(`native dependency ${direction} page`, {
        cause: new TypeError("要求したnative dependency connectionがありません"),
      });
    }
    if (connection.nodes.length === 0) {
      throw new GitHubResponseValidationError(`native dependency ${direction} page`, {
        cause: new TypeError("次ページとして空のdependency connectionを受け取りました"),
      });
    }
    nodes.push(...connection.nodes);
    pageInfo = connection.pageInfo;
  }
  assertNoDuplicateNodeIds(
    nodes.map((node) => node.id),
    `native dependency ${direction}`,
  );
  return Object.freeze(nodes);
}

export async function normalizeNativeDependencies(
  item: EnumeratedGitHubItem,
  issue: z.output<typeof baseIssueSchema>,
  capabilities: GitHubItemDetailCapabilities,
  graphql: Graphql,
): Promise<GitHubNativeDependencyCollection> {
  if (capabilities.nativeDependencies === "unavailable") {
    return Object.freeze({
      availability: "unavailable",
      reason: "api_not_supported",
    });
  }
  if (issue.blockedBy == null || issue.blocking == null) {
    throw new GitHubResponseValidationError("native issue dependencies", {
      cause: new TypeError("利用可能なnative dependency connectionがありません"),
    });
  }
  const blockedByNodes = await collectReferencedItemNodes(
    item,
    issue.blockedBy,
    "blockedBy",
    graphql,
  );
  const blockingNodes = await collectReferencedItemNodes(item, issue.blocking, "blocking", graphql);
  const relations: GitHubNativeDependency[] = [
    ...blockedByNodes.map((relatedItem) => {
      const normalizedItem = normalizeReferencedItem(relatedItem);
      return Object.freeze({
        sourceId: buildProductionSourceId(
          "github_native_dependency",
          `${item.nodeId}:blocked_by:${normalizedItem.nodeId}`,
        ),
        authoritative: true,
        provenance: "native",
        direction: "blocked_by",
        relatedItem: normalizedItem,
      } satisfies GitHubNativeDependency);
    }),
    ...blockingNodes.map((relatedItem) => {
      const normalizedItem = normalizeReferencedItem(relatedItem);
      return Object.freeze({
        sourceId: buildProductionSourceId(
          "github_native_dependency",
          `${item.nodeId}:blocking:${normalizedItem.nodeId}`,
        ),
        authoritative: true,
        provenance: "native",
        direction: "blocking",
        relatedItem: normalizedItem,
      } satisfies GitHubNativeDependency);
    }),
  ];
  return Object.freeze({
    availability: "available",
    relations: Object.freeze(relations),
  });
}

async function collectSubIssueNodes(
  item: EnumeratedGitHubItem,
  initialConnection: z.output<typeof referencedItemConnectionSchema>,
  graphql: Graphql,
): Promise<readonly RawReferencedItem[]> {
  const nodes = [...initialConnection.nodes];
  let pageInfo = initialConnection.pageInfo;
  for (;;) {
    const cursor = requireConnectionCursor(pageInfo, "native sub-issues");
    if (cursor == null) {
      break;
    }
    const response = await graphql(SUB_ISSUE_PAGE_QUERY, {
      itemId: item.nodeId,
      after: cursor,
    });
    const parsed = parseGraphqlResponse(
      subIssuePageResponseSchema,
      response,
      "native sub-issue page",
    );
    const responseItem = requireGraphqlNode(
      parsed.item,
      item.nodeId,
      (node) => node.id,
      "native sub-issue page",
    );
    if (responseItem.subIssues.nodes.length === 0) {
      throw new GitHubResponseValidationError("native sub-issue page", {
        cause: new TypeError("次ページとして空のsubIssues connectionを受け取りました"),
      });
    }
    nodes.push(...responseItem.subIssues.nodes);
    pageInfo = responseItem.subIssues.pageInfo;
  }
  assertNoDuplicateNodeIds(
    nodes.map((node) => node.id),
    "native sub-issues",
  );
  return Object.freeze(nodes);
}

export async function normalizeNativeHierarchy(
  item: EnumeratedGitHubItem,
  issue: z.output<typeof baseIssueSchema>,
  capabilities: GitHubItemDetailCapabilities,
  graphql: Graphql,
): Promise<GitHubNativeHierarchyCollection> {
  if (capabilities.nativeHierarchy === "unavailable") {
    return Object.freeze({
      availability: "unavailable",
      reason: "api_not_supported",
    });
  }
  if (!Object.hasOwn(issue, "parent") || issue.subIssues == null) {
    throw new GitHubResponseValidationError("native sub-issue hierarchy", {
      cause: new TypeError("利用可能なnative hierarchy fieldがありません"),
    });
  }
  const subIssueNodes = await collectSubIssueNodes(item, issue.subIssues, graphql);
  const relations: GitHubNativeHierarchy[] = [];
  if (issue.parent != null) {
    const parent = normalizeReferencedItem(issue.parent);
    relations.push(
      Object.freeze({
        sourceId: buildProductionSourceId(
          "github_native_hierarchy",
          `${item.nodeId}:parent:${parent.nodeId}`,
        ),
        authoritative: true,
        provenance: "native",
        relationship: "parent",
        relatedItem: parent,
      }),
    );
  }
  for (const subIssueNode of subIssueNodes) {
    const subIssue = normalizeReferencedItem(subIssueNode);
    relations.push(
      Object.freeze({
        sourceId: buildProductionSourceId(
          "github_native_hierarchy",
          `${item.nodeId}:sub_issue:${subIssue.nodeId}`,
        ),
        authoritative: true,
        provenance: "native",
        relationship: "sub_issue",
        relatedItem: subIssue,
      }),
    );
  }
  return Object.freeze({
    availability: "available",
    relations: Object.freeze(relations),
  });
}
