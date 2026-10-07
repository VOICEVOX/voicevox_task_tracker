import { z } from "zod";

import { type GitHubNodeId } from "../domain/index.js";
import { GitHubResponseSchemaValidationError, GitHubResponseValidationError } from "./errors.js";
import type { GitHubItemDetailTarget } from "./item-detail-collection-contracts.js";
import type { RawPageInfo } from "./item-detail-response-schema.js";
import { type EnumeratedGitHubItem } from "./item-enumeration.js";
import {
  type PublicRepository,
  type PublicRepositoryAllowlist,
} from "./public-repository-allowlist.js";

export function parseGraphqlResponse<Schema extends z.ZodType>(
  schema: Schema,
  value: unknown,
  context: string,
): z.output<Schema> {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new GitHubResponseSchemaValidationError(context, result.error);
  }
  return result.data;
}

export function requireGraphqlNode<Value>(
  value: Value | null,
  expectedNodeId: GitHubNodeId,
  getNodeId: (node: Value) => string,
  context: string,
): Value {
  if (value == null) {
    throw new GitHubResponseValidationError(context, {
      cause: new TypeError("要求したGraphQL nodeがありません"),
    });
  }
  if (getNodeId(value) !== expectedNodeId) {
    throw new GitHubResponseValidationError(context, {
      cause: new TypeError("要求したGraphQL node IDと応答が一致しません"),
    });
  }
  return value;
}

export function requireConnectionCursor(
  pageInfo: RawPageInfo,
  context: string,
): string | undefined {
  if (!pageInfo.hasNextPage) {
    return undefined;
  }
  if (pageInfo.endCursor == null) {
    throw new GitHubResponseValidationError(context, {
      cause: new TypeError("次ページのcursorがありません"),
    });
  }
  return pageInfo.endCursor;
}

export function assertNoDuplicateNodeIds(nodeIds: readonly string[], context: string): void {
  if (new Set(nodeIds).size !== nodeIds.length) {
    throw new GitHubResponseValidationError(context, {
      cause: new TypeError("同じnode IDがconnection内で重複しています"),
    });
  }
}

export function validateDetailTargets(
  allowlist: PublicRepositoryAllowlist,
  targets: readonly GitHubItemDetailTarget[],
): void {
  const itemNodeIds = new Set<GitHubNodeId>();
  for (const { item } of targets) {
    allowlist.require(item.repositoryId);
    if (itemNodeIds.has(item.nodeId)) {
      throw new TypeError(`詳細取得対象のitem node IDが重複しています。対象: ${item.nodeId}`);
    }
    itemNodeIds.add(item.nodeId);
  }
}

export function validateItemRepositoryAlias(
  item: EnumeratedGitHubItem,
  repository: PublicRepository,
): void {
  const expectedDisplayReference =
    `${repository.owner}/${repository.name}#${item.number.toString()}`.toLowerCase();
  if (item.displayReference.toLowerCase() !== expectedDisplayReference) {
    throw new GitHubResponseValidationError("詳細取得対象のrepository alias", {
      cause: new TypeError("allowlistとitemの表示用別名が一致しません"),
    });
  }
}
