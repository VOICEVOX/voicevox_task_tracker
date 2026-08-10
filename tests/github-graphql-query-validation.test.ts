import { readFileSync } from "node:fs";

import { buildSchema, parse, validate } from "graphql";
import { describe, expect, it } from "vitest";

import { ITEM_IDENTIFIER_QUERY } from "../src/github/item-enumeration-queries.js";
import {
  CHECK_CONTEXT_PAGE_QUERY,
  CLOSING_ISSUE_PAGE_QUERY,
  COMMENT_PAGE_QUERY,
  createItemDetailQuery,
  createNativeDependencyPageQuery,
  createTimelinePageQuery,
  ITEM_DETAIL_CAPABILITIES_QUERY,
  PULL_REQUEST_HEAD_COMMIT_QUERY,
  REVIEW_PAGE_QUERY,
  REVIEW_REQUEST_PAGE_QUERY,
  REVIEW_THREAD_COMMENT_PAGE_QUERY,
  REVIEW_THREAD_PAGE_QUERY,
  SUB_ISSUE_PAGE_QUERY,
} from "../src/github/item-detail-queries.js";
import { type GitHubItemDetailCapabilities } from "../src/github/item-detail-types.js";

type QueryCase = Readonly<{
  name: string;
  query: string;
}>;

const schema = buildSchema(
  readFileSync(new URL("../schemas/github-graphql.schema.graphql", import.meta.url), "utf8"),
  {
    assumeValid: true,
    assumeValidSDL: true,
  },
);
const capabilityAvailabilities = [
  "available",
  "unavailable",
] satisfies readonly GitHubItemDetailCapabilities["nativeDependencies"][];
const itemTypes = ["issue", "pull_request"] satisfies readonly ("issue" | "pull_request")[];
const dependencyDirections = ["blockedBy", "blocking"] satisfies readonly (
  "blockedBy" | "blocking"
)[];
const fixedQueryCases = [
  {
    name: "項目識別",
    query: ITEM_IDENTIFIER_QUERY,
  },
  {
    name: "詳細取得能力",
    query: ITEM_DETAIL_CAPABILITIES_QUERY,
  },
  {
    name: "Pull Request head commit取得",
    query: PULL_REQUEST_HEAD_COMMIT_QUERY,
  },
  {
    name: "コメント次ページ",
    query: COMMENT_PAGE_QUERY,
  },
  {
    name: "レビュー次ページ",
    query: REVIEW_PAGE_QUERY,
  },
  {
    name: "レビュースレッド次ページ",
    query: REVIEW_THREAD_PAGE_QUERY,
  },
  {
    name: "レビュースレッドコメント次ページ",
    query: REVIEW_THREAD_COMMENT_PAGE_QUERY,
  },
  {
    name: "レビュー依頼次ページ",
    query: REVIEW_REQUEST_PAGE_QUERY,
  },
  {
    name: "closing対象Issue次ページ",
    query: CLOSING_ISSUE_PAGE_QUERY,
  },
  {
    name: "サブIssue次ページ",
    query: SUB_ISSUE_PAGE_QUERY,
  },
  {
    name: "チェックコンテキスト次ページ",
    query: CHECK_CONTEXT_PAGE_QUERY,
  },
] satisfies readonly QueryCase[];
const itemDetailQueryCases = capabilityAvailabilities.flatMap((nativeDependencies) =>
  capabilityAvailabilities.map((nativeHierarchy) => ({
    name: `詳細 依存関係${nativeDependencies} 階層${nativeHierarchy}`,
    query: createItemDetailQuery({
      nativeDependencies,
      nativeHierarchy,
    }),
  })),
);
const timelineQueryCases = itemTypes.map((itemType) => ({
  name: `タイムライン ${itemType}`,
  query: createTimelinePageQuery(itemType),
}));
const dependencyQueryCases = dependencyDirections.map((direction) => ({
  name: `依存関係次ページ ${direction}`,
  query: createNativeDependencyPageQuery(direction),
}));
const queryCases: readonly QueryCase[] = [
  ...fixedQueryCases,
  ...itemDetailQueryCases,
  ...timelineQueryCases,
  ...dependencyQueryCases,
];

describe("GitHub GraphQLクエリ", () => {
  it("送信しうる19件を列挙する", () => {
    expect(fixedQueryCases).toHaveLength(11);
    expect(itemDetailQueryCases).toHaveLength(4);
    expect(timelineQueryCases).toHaveLength(2);
    expect(dependencyQueryCases).toHaveLength(2);
    expect(queryCases).toHaveLength(19);
  });

  it.each(queryCases)("$nameを公式schemaで検証できる", ({ query }) => {
    const errors = validate(schema, parse(query));

    expect(errors.map((error) => error.toString())).toEqual([]);
  });
});
