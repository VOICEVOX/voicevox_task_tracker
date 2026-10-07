import { isTerminalStatus } from "../../src/domain/status.js";
import type {
  PublicDetailsDto,
  PublicItemDetailsDto,
  PublicSummaryDto,
} from "../../src/pages/public-dto-contracts.js";
import { assertNonNullable, UnreachableError } from "../../src/util/index.js";
import { hasItemAiUnverifiedValue } from "./model-ai-presentation.js";
import type {
  GitHubUrlResult,
  ItemSort,
  ItemSortKey,
  ItemTableRow,
  PublicActor,
  TableFilterKey,
  TableFilterOption,
  TableFilterOptions,
  TableFilters,
} from "./model-contracts.js";
import {
  currentResponseResponsibleLabel,
  formatCurrentResponseText,
} from "./model-current-response.js";
import {
  AI_ANALYSIS_FILTER_OPTIONS,
  CURRENT_RESPONSE_STATUS_LABELS,
  currentResponseStatusLabel,
  DEADLINE_LEVEL_SORT_SCORES,
  IMPORTANCE_LEVEL_LABELS,
  ITEM_TYPE_LABELS,
  STALL_FILTER_DEFINITIONS,
  STATUS_LABELS,
} from "./model-labels.js";
import { parseTimestamp } from "./model-time.js";
import { compareStrings } from "./model-values.js";
import { waitingOnLabel } from "./model-waiting-on.js";

function createPresentTableFilterOptions(
  labels: Readonly<Record<string, string>>,
  presentValues: ReadonlySet<string>,
): readonly TableFilterOption[] {
  return Object.entries(labels)
    .filter(([value]) => presentValues.has(value))
    .map(([value, label]) => ({ label, value }));
}

/** 公開summaryに実在する一覧表の選択肢を作る。 */
export function createTableFilterOptions(summary: PublicSummaryDto): TableFilterOptions {
  const repositoriesById = new Map(
    summary.repositories.map((repository) => [repository.id, repository]),
  );
  const repositoryValues = new Set<string>();
  const typeValues = new Set<string>();
  const statusValues = new Set<string>();
  const importanceValues = new Set<string>();
  const responseStatusValues = new Set<string>();

  for (const item of summary.items) {
    const repository = repositoriesById.get(item.repositoryId);
    assertNonNullable(repository, `項目 ${item.nodeId} のrepositoryがありません`);
    repositoryValues.add(repository.fullName);
    typeValues.add(item.type);
    statusValues.add(item.status);
    importanceValues.add(item.importance.level);
    for (const response of item.currentResponses) {
      responseStatusValues.add(response.status);
    }
  }

  return {
    repository: [...repositoryValues]
      .sort(compareStrings)
      .map((value) => ({ label: value, value })),
    type: createPresentTableFilterOptions(ITEM_TYPE_LABELS, typeValues),
    status: [
      { label: "すべて", value: "all" },
      ...createPresentTableFilterOptions(STATUS_LABELS, statusValues),
    ],
    importance: createPresentTableFilterOptions(IMPORTANCE_LEVEL_LABELS, importanceValues),
    responseStatus: createPresentTableFilterOptions(
      CURRENT_RESPONSE_STATUS_LABELS,
      responseStatusValues,
    ),
    stall: STALL_FILTER_DEFINITIONS.map(({ label, value }) => ({ label, value })),
    aiAnalysis: AI_ANALYSIS_FILTER_OPTIONS,
  };
}

/** URLがhttps://github.com配下かを検証する。 */
export function validateGitHubUrl(value: string): GitHubUrlResult {
  if (!URL.canParse(value)) {
    return {
      allowed: false,
    };
  }
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.hostname !== "github.com" ||
    url.port !== "" ||
    url.username !== "" ||
    url.password !== ""
  ) {
    return {
      allowed: false,
    };
  }
  return {
    allowed: true,
    url: url.toString(),
  };
}

/** 公開summaryから一覧表の表示行を作る。 */
export function createItemTableRows(summary: PublicSummaryDto, now: Date): readonly ItemTableRow[] {
  const repositoriesById = new Map(
    summary.repositories.map((repository) => [repository.id, repository]),
  );

  return summary.items.map((item) => {
    const repository = repositoriesById.get(item.repositoryId);
    assertNonNullable(repository, `項目 ${item.nodeId} のrepositoryがありません`);
    const stallDurationMilliseconds = now.getTime() - parseTimestamp(item.stallSince);
    if (stallDurationMilliseconds < 0) {
      throw new RangeError("stallSinceは現在時刻より後にできません");
    }
    return {
      item,
      repositoryText: repository.fullName,
      currentResponseText: formatCurrentResponseText(item),
      stallDurationMilliseconds,
    };
  });
}

function normalizedSearchText(value: string): string {
  return value.normalize("NFKC").toLowerCase();
}

/** summaryとdetailsの項目を検証してnode IDで引けるようにする。 */
export function createItemDetailsMap(
  summary: PublicSummaryDto,
  details: PublicDetailsDto,
): ReadonlyMap<string, PublicItemDetailsDto> {
  if (summary.runId !== details.runId || summary.generatedAt !== details.generatedAt) {
    throw new TypeError("summaryとdetailsの生成runが一致しません");
  }
  const summaryByNodeId = new Map(summary.items.map((item) => [item.nodeId, item]));
  const detailsByNodeId = new Map<string, PublicItemDetailsDto>();
  for (const itemDetails of details.items) {
    if (detailsByNodeId.has(itemDetails.summary.nodeId)) {
      throw new TypeError(`detailsの項目 ${itemDetails.summary.nodeId} が重複しています`);
    }
    const summaryItem = summaryByNodeId.get(itemDetails.summary.nodeId);
    assertNonNullable(
      summaryItem,
      `detailsの項目 ${itemDetails.summary.nodeId} がsummaryにありません`,
    );
    if (JSON.stringify(summaryItem) !== JSON.stringify(itemDetails.summary)) {
      throw new TypeError(`summaryとdetailsの項目 ${itemDetails.summary.nodeId} が一致しません`);
    }
    detailsByNodeId.set(itemDetails.summary.nodeId, itemDetails);
  }
  for (const item of summary.items) {
    if (!detailsByNodeId.has(item.nodeId)) {
      throw new TypeError(`summaryの項目 ${item.nodeId} がdetailsにありません`);
    }
  }
  return detailsByNodeId;
}

function actorSearchName(actor: PublicActor): string {
  return actor.type === "system" ? actor.name : actor.login;
}

/** 公開DTO内のリポジトリ、番号、タイトル、アクター、team、ラベルを検索する。 */
export function searchItemNodeIds(
  summary: PublicSummaryDto,
  detailsByNodeId: ReadonlyMap<string, PublicItemDetailsDto>,
  query: string,
): readonly string[] {
  const tokens = normalizedSearchText(query).trim().split(/\s+/u);
  if (tokens.length === 1 && tokens[0] === "") {
    return summary.items.map((item) => item.nodeId);
  }
  const repositoriesById = new Map(
    summary.repositories.map((repository) => [repository.id, repository]),
  );
  return summary.items
    .filter((item) => {
      const repository = repositoriesById.get(item.repositoryId);
      const details = detailsByNodeId.get(item.nodeId);
      assertNonNullable(repository, `項目 ${item.nodeId} のrepositoryがありません`);
      assertNonNullable(details, `項目 ${item.nodeId} のdetailsがありません`);
      const searchText = normalizedSearchText(
        [
          repository.fullName,
          repository.name,
          item.number.toString(),
          `#${item.number.toString()}`,
          item.displayReference,
          item.title,
          ...item.waitingOn.flatMap((waitingOn) => [
            waitingOnLabel(waitingOn, item, summary),
            waitingOn.candidateId,
            waitingOn.reasonSummary,
          ]),
          ...item.currentResponses.flatMap((response) => [
            currentResponseStatusLabel(response.status),
            response.action.summary,
            ...response.responsible.flatMap((responsible) => [
              currentResponseResponsibleLabel(responsible, item),
              responsible.candidateId,
            ]),
            ...response.evidence.map((evidence) => evidence.summary),
            ...(response.status === "waiting" ? [response.waitingFor.action] : []),
          ]),
          ...(item.author.status === "identified" ? [item.author.actor.login] : []),
          ...(details.latestEventActor.status === "present"
            ? [actorSearchName(details.latestEventActor.actor)]
            : []),
          ...item.assignees.map((assignee) => assignee.login),
          ...details.labels,
        ].join("\n"),
      );
      return tokens.every((token) => searchText.includes(token));
    })
    .map((item) => item.nodeId);
}

function rowMatchesTableFilter(row: ItemTableRow, key: TableFilterKey, value: string): boolean {
  switch (key) {
    case "repository":
      return row.repositoryText === value;
    case "type":
      return row.item.type === value;
    case "status":
      if (value === "all") {
        return true;
      }
      return row.item.status === value;
    case "importance":
      return row.item.importance.level === value;
    case "waitingOn":
      return normalizedSearchText(row.currentResponseText).includes(normalizedSearchText(value));
    case "responseStatus":
      return row.item.currentResponses.some((response) => response.status === value);
    case "stall": {
      const definition = STALL_FILTER_DEFINITIONS.find((candidate) => candidate.value === value);
      assertNonNullable(definition, `未対応の停滞時間の絞り込みです: ${value}`);
      return row.stallDurationMilliseconds >= definition.thresholdMilliseconds;
    }
    case "aiAnalysis":
      if (value === "unverified") {
        return hasItemAiUnverifiedValue(row.item);
      }
      if (value === "partial") {
        return row.item.aiAnalysis.omission === "partial";
      }
      if (value === "all") {
        return row.item.aiAnalysis.omission === "all";
      }
      throw new TypeError(`未対応のAI利用状況の絞り込みです: ${value}`);
    default:
      throw new UnreachableError(key);
  }
}

function compareDeadlineRows(
  left: ItemTableRow,
  right: ItemTableRow,
  direction: ItemSort["direction"],
): number {
  const leftDeadline = left.item.deadline;
  const rightDeadline = right.item.deadline;
  if (leftDeadline.status !== rightDeadline.status) {
    return leftDeadline.status === "not_available" ? 1 : -1;
  }
  if (leftDeadline.status === "not_available" || rightDeadline.status === "not_available") {
    return 0;
  }
  const directionMultiplier = direction === "ascending" ? 1 : -1;
  const levelOrder =
    (DEADLINE_LEVEL_SORT_SCORES[leftDeadline.level] -
      DEADLINE_LEVEL_SORT_SCORES[rightDeadline.level]) *
    directionMultiplier;
  if (levelOrder !== 0) {
    return levelOrder;
  }
  if (leftDeadline.date == null || rightDeadline.date == null) {
    return 0;
  }
  return compareStrings(leftDeadline.date, rightDeadline.date) * -directionMultiplier;
}

function compareTableRows(
  left: ItemTableRow,
  right: ItemTableRow,
  key: ItemSortKey,
  direction: ItemSort["direction"],
): number {
  switch (key) {
    case "attention":
      return left.item.attention.score - right.item.attention.score;
    case "importance":
      return left.item.importance.score - right.item.importance.score;
    case "stall":
      return left.stallDurationMilliseconds - right.stallDurationMilliseconds;
    case "deadline":
      return compareDeadlineRows(left, right, direction);
    default:
      throw new UnreachableError(key);
  }
}

function compareTableRowTieBreakers(
  left: ItemTableRow,
  right: ItemTableRow,
  key: ItemSortKey,
): number {
  switch (key) {
    case "attention": {
      const stallOrder = right.stallDurationMilliseconds - left.stallDurationMilliseconds;
      if (stallOrder !== 0) {
        return stallOrder;
      }
      break;
    }
    case "importance": {
      const attentionOrder = right.item.attention.score - left.item.attention.score;
      if (attentionOrder !== 0) {
        return attentionOrder;
      }
      break;
    }
    case "stall":
      break;
    case "deadline":
      break;
    default:
      throw new UnreachableError(key);
  }
  return compareStrings(left.item.nodeId, right.item.nodeId);
}

/** 一覧表の全列filterとsortを適用する。 */
export function filterAndSortTableRows(
  rows: readonly ItemTableRow[],
  filters: TableFilters,
  sort: ItemSort,
): readonly ItemTableRow[] {
  const filteredRows = rows.filter((row) =>
    Object.entries(filters).every(([key, value]) => {
      if (value.length === 0) {
        if (key === "status") {
          return !isTerminalStatus(row.item.status);
        }
        return true;
      }
      if (
        key !== "repository" &&
        key !== "type" &&
        key !== "status" &&
        key !== "importance" &&
        key !== "waitingOn" &&
        key !== "responseStatus" &&
        key !== "stall" &&
        key !== "aiAnalysis"
      ) {
        throw new TypeError(`未対応の表列です: ${key}`);
      }
      return rowMatchesTableFilter(row, key, value);
    }),
  );
  const direction = sort.direction === "ascending" ? 1 : -1;
  return filteredRows.sort((left, right) => {
    const order = compareTableRows(left, right, sort.key, sort.direction);
    if (order !== 0) {
      return sort.key === "deadline" ? order : order * direction;
    }
    return compareTableRowTieBreakers(left, right, sort.key);
  });
}
