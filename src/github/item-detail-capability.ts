import { GitHubResponseValidationError } from "./errors.js";
import { parseGraphqlResponse } from "./item-detail-connection.js";
import { ITEM_DETAIL_CAPABILITIES_QUERY } from "./item-detail-queries.js";
import type { Graphql } from "./item-detail-response-schema.js";
import { capabilityResponseSchema } from "./item-detail-response-schema.js";
import { type GitHubItemDetailCapabilities } from "./item-detail-types.js";
import { type EnumeratedGitHubItem } from "./item-enumeration.js";

function detectFeatureAvailability(
  fieldNames: ReadonlySet<string>,
  requiredFieldNames: readonly string[],
  context: string,
): "available" | "unavailable" {
  const availableFieldCount = requiredFieldNames.filter((fieldName) =>
    fieldNames.has(fieldName),
  ).length;
  if (availableFieldCount === 0) {
    return "unavailable";
  }
  if (availableFieldCount !== requiredFieldNames.length) {
    throw new GitHubResponseValidationError(context, {
      cause: new TypeError("必要なGraphQL fieldの一部だけが提供されています"),
    });
  }
  return "available";
}

export async function discoverCapabilities(
  graphql: Graphql,
): Promise<GitHubItemDetailCapabilities> {
  const response = await graphql(ITEM_DETAIL_CAPABILITIES_QUERY, {});
  const parsed = parseGraphqlResponse(
    capabilityResponseSchema,
    response,
    "Issue detail GraphQL capabilities",
  );
  if (parsed.issueType == null) {
    throw new GitHubResponseValidationError("Issue detail GraphQL capabilities", {
      cause: new TypeError("Issue型のschema情報がありません"),
    });
  }
  const fieldNames = new Set(parsed.issueType.fields.map((field) => field.name));
  return Object.freeze({
    nativeDependencies: detectFeatureAvailability(
      fieldNames,
      ["blockedBy", "blocking"],
      "native issue dependency GraphQL capabilities",
    ),
    nativeHierarchy: detectFeatureAvailability(
      fieldNames,
      ["parent", "subIssues"],
      "native sub-issue GraphQL capabilities",
    ),
  });
}

export function assertItemResponseType(
  actualType: "Issue" | "PullRequest",
  item: EnumeratedGitHubItem,
  context: string,
): void {
  const expectedType = item.type === "issue" ? "Issue" : "PullRequest";
  if (actualType !== expectedType) {
    throw new GitHubResponseValidationError(context, {
      cause: new TypeError("列挙時と詳細取得時のitem種別が一致しません"),
    });
  }
}
