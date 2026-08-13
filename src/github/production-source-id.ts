import { z } from "zod";

import { buildSourceId, type SourceId } from "../domain/index.js";

const productionSourceIdKindSchema = z.enum([
  "github_actor",
  "github_user",
  "github_team",
  "github_item",
  "github_issue_comment",
  "github_commit",
  "github_timeline_event",
  "github_label",
  "github_inbound_cross_reference",
  "github_pull_request_review",
  "github_pull_request_review_comment",
  "github_pull_request_review_thread",
  "github_review_request",
  "github_native_closing_issue",
  "github_native_dependency",
  "github_native_hierarchy",
  "github_check_run",
  "github_commit_status",
  "github_status_check_rollup",
  "github_auto_merge_request",
  "github_merge_queue_entry",
  "github_item_detail",
  "github_item_body",
  "github_user_content_edit",
]);

/** 本番のGitHub収集で生成するsource IDの種別。 */
export type ProductionSourceIdKind = z.output<typeof productionSourceIdKindSchema>;

/** 本番のGitHub収集で生成するsource IDの全種別。 */
export const PRODUCTION_SOURCE_ID_KINDS = Object.freeze(productionSourceIdKindSchema.options);
const productionSourceIdKindSet = new Set<string>(PRODUCTION_SOURCE_ID_KINDS);

/** 本番のGitHub収集で生成するsource IDを組み立てる。 */
export function buildProductionSourceId(
  kind: ProductionSourceIdKind,
  originalId: string,
): SourceId {
  return buildSourceId(kind, originalId);
}

/** source IDの種別が本番のGitHub収集で生成されるかを返す。 */
export function isProductionSourceIdKind(kind: string): kind is ProductionSourceIdKind {
  return productionSourceIdKindSet.has(kind);
}
