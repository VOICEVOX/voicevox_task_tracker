import { parse, visit } from "graphql";

import {
  DETAIL_ACTOR_FIELDS_FRAGMENT,
  DETAIL_ASSIGNEE_FIELDS_FRAGMENT,
  DETAIL_CHECK_CONTEXT_FIELDS_FRAGMENT,
  DETAIL_HEAD_COMMIT_FIELDS_FRAGMENT,
  DETAIL_ISSUE_COMMENT_FIELDS_FRAGMENT,
  DETAIL_REFERENCED_ITEM_FIELDS_FRAGMENT,
  DETAIL_REVIEW_COMMENT_FIELDS_FRAGMENT,
  DETAIL_REVIEW_FIELDS_FRAGMENT,
  DETAIL_REVIEW_REQUEST_TARGET_FIELDS_FRAGMENT,
  DETAIL_REVIEW_THREAD_FIELDS_FRAGMENT,
} from "./item-detail-query-base-fragments.js";
import {
  DETAIL_ISSUE_TIMELINE_FIELDS_FRAGMENT,
  DETAIL_PULL_REQUEST_TIMELINE_FIELDS_FRAGMENT,
} from "./item-detail-query-timeline-fragments.js";

const GRAPHQL_FRAGMENT_SOURCES: ReadonlyMap<string, string> = new Map([
  ["DetailActorFields", DETAIL_ACTOR_FIELDS_FRAGMENT],
  ["DetailReviewRequestTargetFields", DETAIL_REVIEW_REQUEST_TARGET_FIELDS_FRAGMENT],
  ["DetailAssigneeFields", DETAIL_ASSIGNEE_FIELDS_FRAGMENT],
  ["DetailReferencedItemFields", DETAIL_REFERENCED_ITEM_FIELDS_FRAGMENT],
  ["DetailIssueCommentFields", DETAIL_ISSUE_COMMENT_FIELDS_FRAGMENT],
  ["DetailReviewFields", DETAIL_REVIEW_FIELDS_FRAGMENT],
  ["DetailReviewCommentFields", DETAIL_REVIEW_COMMENT_FIELDS_FRAGMENT],
  ["DetailReviewThreadFields", DETAIL_REVIEW_THREAD_FIELDS_FRAGMENT],
  ["DetailCheckContextFields", DETAIL_CHECK_CONTEXT_FIELDS_FRAGMENT],
  ["DetailHeadCommitFields", DETAIL_HEAD_COMMIT_FIELDS_FRAGMENT],
  ["DetailIssueTimelineFields", DETAIL_ISSUE_TIMELINE_FIELDS_FRAGMENT],
  ["DetailPullRequestTimelineFields", DETAIL_PULL_REQUEST_TIMELINE_FIELDS_FRAGMENT],
]);

function collectFragmentSpreadNames(source: string): readonly string[] {
  const fragmentNames = new Set<string>();
  visit(parse(source), {
    FragmentSpread(node): void {
      fragmentNames.add(node.name.value);
    },
  });
  return Object.freeze([...fragmentNames]);
}

const GRAPHQL_FRAGMENT_DEPENDENCIES: ReadonlyMap<string, readonly string[]> = new Map(
  [...GRAPHQL_FRAGMENT_SOURCES].map(
    ([fragmentName, fragmentSource]) =>
      [fragmentName, collectFragmentSpreadNames(fragmentSource)] as const,
  ),
);
const GRAPHQL_QUERY_CACHE = new Map<string, string>();

function collectRequiredFragmentSources(
  fragmentNames: readonly string[],
  resolvedFragmentNames: Set<string>,
  fragmentSources: string[],
): void {
  for (const fragmentName of fragmentNames) {
    if (resolvedFragmentNames.has(fragmentName)) {
      continue;
    }
    const fragmentSource = GRAPHQL_FRAGMENT_SOURCES.get(fragmentName);
    const dependencies = GRAPHQL_FRAGMENT_DEPENDENCIES.get(fragmentName);
    if (fragmentSource == null || dependencies == null) {
      throw new Error(`未定義のGraphQLフラグメントを参照しています: ${fragmentName}`);
    }
    resolvedFragmentNames.add(fragmentName);
    fragmentSources.push(fragmentSource);
    collectRequiredFragmentSources(dependencies, resolvedFragmentNames, fragmentSources);
  }
}

export function appendRequiredFragments(querySource: string): string {
  const cachedQuery = GRAPHQL_QUERY_CACHE.get(querySource);
  if (cachedQuery != null) {
    return cachedQuery;
  }
  const fragmentSources: string[] = [];
  collectRequiredFragmentSources(
    collectFragmentSpreadNames(querySource),
    new Set<string>(),
    fragmentSources,
  );
  const query = [querySource, ...fragmentSources].join("\n");
  GRAPHQL_QUERY_CACHE.set(querySource, query);
  return query;
}
