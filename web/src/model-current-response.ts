import type {
  PublicItemSummaryDto,
  PublicPersonalReminderResponseDto,
  PublicSummaryDto,
} from "../../src/pages/public-dto-contracts.js";
import { assertNonNullable, UnreachableError } from "../../src/util/index.js";
import type {
  CurrentResponseResponsible,
  CurrentResponseRole,
  CurrentResponseSubject,
  CurrentResponseSubjectRow,
} from "./model-contracts.js";
import { currentResponseRoleLabel } from "./model-labels.js";
import { formatStallDuration, parseTimestamp } from "./model-time.js";
import { compareStrings } from "./model-values.js";
import { resolveCurrentRole } from "./model-waiting-on.js";

/** 現在の対応者を大文字小文字を区別しないキーへ変換する。 */
export function currentResponseSubjectKey(subject: CurrentResponseSubject): string {
  switch (subject.kind) {
    case "user":
      return `user:${subject.login.toLowerCase()}`;
    case "team":
      return `team:${subject.teamId.toLowerCase()}`;
    default:
      throw new UnreachableError(subject);
  }
}

function currentResponseSubjectLabel(subject: CurrentResponseSubject): string {
  switch (subject.kind) {
    case "user":
      return `@${subject.login}`;
    case "team":
      return `チーム ${subject.teamId}`;
    default:
      throw new UnreachableError(subject);
  }
}

function currentResponseRoleDisplayLabel(
  role: CurrentResponseRole,
  item: PublicItemSummaryDto,
): string {
  const roleName = currentResponseRoleLabel(role);
  const resolution = resolveCurrentRole(role, item);
  switch (resolution.kind) {
    case "accounts":
      return `${roleName} ${resolution.logins.map((login) => `@${login}`).join("、")}`;
    case "deleted_account":
      return `${roleName} アカウント削除済み`;
    case "unassigned":
      return `${roleName} 未割り当て`;
    case "unresolved":
      return `${roleName}の役割`;
    default:
      throw new UnreachableError(resolution);
  }
}

/** 現在の対応者を項目の確定情報を含む表示文字列へ変換する。 */
export function currentResponseResponsibleLabel(
  responsible: CurrentResponseResponsible,
  item: PublicItemSummaryDto,
): string {
  const responsibleKind = responsible.kind;
  switch (responsibleKind) {
    case "user":
      return `@${responsible.candidateId} ${currentResponseRoleLabel(responsible.role)}`;
    case "team":
      return `チーム ${responsible.candidateId} ${currentResponseRoleLabel(responsible.role)}`;
    case "role":
      return currentResponseRoleDisplayLabel(responsible.role, item);
    default:
      throw new UnreachableError(responsibleKind);
  }
}

export function formatCurrentResponseText(item: PublicItemSummaryDto): string {
  return item.currentResponses
    .flatMap((response) =>
      response.responsible.map((responsible) => currentResponseResponsibleLabel(responsible, item)),
    )
    .join("\n");
}

function currentResponseSubjectFromResponsible(
  responsible: CurrentResponseResponsible,
): CurrentResponseSubject | undefined {
  switch (responsible.kind) {
    case "user":
      return { kind: "user", login: responsible.candidateId };
    case "team":
      return { kind: "team", teamId: responsible.candidateId };
    case "role":
      return undefined;
  }
}

type CurrentResponseSubjectMembership =
  "verified" | "unverified_displayed" | "unverified_missing" | "absent";

type CurrentResponseSubjectSupport = Readonly<{
  subject: CurrentResponseSubject;
  verified: boolean;
}>;

interface CurrentResponseSubjectRowAccumulator {
  subject: CurrentResponseSubject;
  label: string;
  itemCount: number;
  hasUnverifiedDisplayedMembership: boolean;
  currentItemNodeIds: Set<string>;
  longestStallSince: string;
  longestMembershipVerified: boolean;
  stalenessUnverified: boolean;
}

type PotentialCurrentResponseSubjectItem = Readonly<{
  nodeId: string;
  stallTimestamp: number;
  stalenessUnverified: boolean;
}>;

type CurrentResponseSubjectChange = Extract<
  PublicItemSummaryDto["currentResponseSubjectChanges"],
  Readonly<{ scope: "bounded" }>
>["addableSubjects"][number];

function currentResponseSubjectFromChange(
  subject: CurrentResponseSubjectChange,
): CurrentResponseSubject {
  switch (subject.kind) {
    case "user":
      return { kind: "user", login: subject.candidateId };
    case "team":
      return { kind: "team", teamId: subject.candidateId };
    default:
      throw new UnreachableError(subject);
  }
}

function currentResponseSubjectChangeMatches(
  subject: CurrentResponseSubjectChange,
  subjectKeys: ReadonlySet<string>,
): boolean {
  return subjectKeys.has(currentResponseSubjectKey(currentResponseSubjectFromChange(subject)));
}

function currentResponseSubjectCanBeAdded(
  item: PublicItemSummaryDto,
  subjectKeys: ReadonlySet<string>,
): boolean {
  const changes = item.currentResponseSubjectChanges;
  if (changes.scope === "unbounded") {
    return true;
  }
  return changes.addableSubjects.some((subject) =>
    currentResponseSubjectChangeMatches(subject, subjectKeys),
  );
}

function currentResponseSubjectMembershipFor(
  item: PublicItemSummaryDto,
  subjectKeys: ReadonlySet<string>,
): CurrentResponseSubjectMembership {
  let unverifiedDisplayed = false;
  for (const response of item.currentResponses) {
    if (
      !response.responsible.some((responsible) =>
        responseResponsibleMatchesSubjects(responsible, subjectKeys),
      )
    ) {
      continue;
    }
    if (!response.subjectMembershipUnverified) {
      return "verified";
    }
    unverifiedDisplayed = true;
  }
  if (unverifiedDisplayed) {
    return "unverified_displayed";
  }
  return currentResponseSubjectCanBeAdded(item, subjectKeys) ? "unverified_missing" : "absent";
}

/** 現在の対応者から、人物一覧へ表示する人とチームを重複なく返す。 */
export function resolveCurrentResponseSubjects(
  item: PublicItemSummaryDto,
): readonly CurrentResponseSubject[] {
  const subjects: CurrentResponseSubject[] = [];
  const subjectKeys = new Set<string>();
  for (const response of item.currentResponses) {
    for (const responsible of response.responsible) {
      const subject = currentResponseSubjectFromResponsible(responsible);
      if (subject == null) {
        continue;
      }
      const key = currentResponseSubjectKey(subject);
      if (subjectKeys.has(key)) {
        continue;
      }
      subjectKeys.add(key);
      subjects.push(subject);
    }
  }
  return subjects;
}

/** 公開summaryから現在の対応者のチーム識別子を昇順で集める。 */
export function collectCurrentResponseTeamIds(summary: PublicSummaryDto): readonly string[] {
  const teamIds = new Map<string, string>();
  for (const item of summary.items) {
    for (const subject of resolveCurrentResponseSubjects(item)) {
      if (subject.kind !== "team") {
        continue;
      }
      const key = currentResponseSubjectKey(subject);
      if (!teamIds.has(key)) {
        teamIds.set(key, subject.teamId);
      }
    }
  }
  return [...teamIds.values()].sort(compareStrings);
}

function hasCurrentResponseSubjectSetUnverified(
  summary: PublicSummaryDto,
  kind: CurrentResponseSubject["kind"] | undefined,
): boolean {
  const globalSupports = new Map<string, CurrentResponseSubjectSupport>();
  for (const item of summary.items) {
    if (item.currentResponseSubjectChanges.scope === "unbounded") {
      return true;
    }
    const itemSupports = currentResponseSubjectSupportsForItem(item);
    for (const [key, support] of itemSupports) {
      const previous = globalSupports.get(key);
      globalSupports.set(key, {
        subject: support.subject,
        verified: (previous?.verified ?? false) || support.verified,
      });
    }
  }
  for (const support of globalSupports.values()) {
    if ((kind == null || support.subject.kind === kind) && !support.verified) {
      return true;
    }
  }
  for (const item of summary.items) {
    if (item.currentResponseSubjectChanges.scope === "unbounded") {
      throw new TypeError("現在対応主体のunboundedな変化を集約後に処理できません");
    }
    for (const subjectChange of item.currentResponseSubjectChanges.addableSubjects) {
      const subject = currentResponseSubjectFromChange(subjectChange);
      if (kind != null && subject.kind !== kind) {
        continue;
      }
      if (!globalSupports.get(currentResponseSubjectKey(subject))?.verified) {
        return true;
      }
    }
    for (const subjectChange of item.currentResponseSubjectChanges.removableSubjects) {
      const subject = currentResponseSubjectFromChange(subjectChange);
      if (kind != null && subject.kind !== kind) {
        continue;
      }
      const support = globalSupports.get(currentResponseSubjectKey(subject));
      if (support != null && !support.verified) {
        return true;
      }
    }
  }
  return false;
}

function addPotentialCurrentResponseSubjectItem(
  itemsBySubjectKey: Map<string, PotentialCurrentResponseSubjectItem[]>,
  subject: CurrentResponseSubject,
  item: PotentialCurrentResponseSubjectItem,
): void {
  const key = currentResponseSubjectKey(subject);
  const items = itemsBySubjectKey.get(key);
  if (items == null) {
    itemsBySubjectKey.set(key, [item]);
    return;
  }
  if (!items.some((candidate) => candidate.nodeId === item.nodeId)) {
    items.push(item);
  }
}

function potentialCurrentResponseSubjectItem(
  item: PublicItemSummaryDto,
): PotentialCurrentResponseSubjectItem {
  return {
    nodeId: item.nodeId,
    stallTimestamp: parseTimestamp(item.stallSince),
    stalenessUnverified: item.aiAnalysis.unverifiedValues.includes("staleness"),
  };
}

function currentResponseSubjectSupportsForItem(
  item: PublicItemSummaryDto,
): ReadonlyMap<string, CurrentResponseSubjectSupport> {
  const supports = new Map<string, CurrentResponseSubjectSupport>();
  for (const response of item.currentResponses) {
    for (const responsible of response.responsible) {
      const subject = currentResponseSubjectFromResponsible(responsible);
      if (subject == null) {
        continue;
      }
      const key = currentResponseSubjectKey(subject);
      const previous = supports.get(key);
      supports.set(key, {
        subject,
        verified: (previous?.verified ?? false) || !response.subjectMembershipUnverified,
      });
    }
  }
  return supports;
}

/** 現在の対応者一覧に現在入力で未検証の人物またはチームがあるかを返す。 */
export function hasCurrentResponseSubjectListingUnverified(summary: PublicSummaryDto): boolean {
  return hasCurrentResponseSubjectSetUnverified(summary, undefined);
}

/** 所属チームの選択肢に現在入力で未検証のチームがあるかを返す。 */
export function hasCurrentResponseTeamOptionsUnverified(summary: PublicSummaryDto): boolean {
  return hasCurrentResponseSubjectSetUnverified(summary, "team");
}

/** 公開summaryから現在の対応者ごとの集計行を作る。 */
export function collectCurrentResponseSubjectRows(
  summary: PublicSummaryDto,
  now: Date,
): readonly CurrentResponseSubjectRow[] {
  const accumulators = new Map<string, CurrentResponseSubjectRowAccumulator>();
  const addableItemsBySubjectKey = new Map<string, PotentialCurrentResponseSubjectItem[]>();
  const unboundedItems: PotentialCurrentResponseSubjectItem[] = [];
  for (const item of summary.items) {
    const potentialItem = potentialCurrentResponseSubjectItem(item);
    const changes = item.currentResponseSubjectChanges;
    if (changes.scope === "unbounded") {
      unboundedItems.push(potentialItem);
    } else {
      for (const subjectChange of changes.addableSubjects) {
        addPotentialCurrentResponseSubjectItem(
          addableItemsBySubjectKey,
          currentResponseSubjectFromChange(subjectChange),
          potentialItem,
        );
      }
    }
    const itemSupports = currentResponseSubjectSupportsForItem(item);
    for (const [key, support] of itemSupports) {
      const membershipVerified = support.verified;
      const stalenessUnverified = item.aiAnalysis.unverifiedValues.includes("staleness");
      const accumulator = accumulators.get(key);
      if (accumulator == null) {
        accumulators.set(key, {
          subject: support.subject,
          label: currentResponseSubjectLabel(support.subject),
          itemCount: 1,
          hasUnverifiedDisplayedMembership: !membershipVerified,
          currentItemNodeIds: new Set([item.nodeId]),
          longestStallSince: item.stallSince,
          longestMembershipVerified: membershipVerified,
          stalenessUnverified,
        });
        continue;
      }
      accumulator.itemCount += 1;
      accumulator.hasUnverifiedDisplayedMembership ||= !membershipVerified;
      accumulator.currentItemNodeIds.add(item.nodeId);
      accumulator.stalenessUnverified ||= stalenessUnverified;
      const stallTimestamp = parseTimestamp(item.stallSince);
      const longestTimestamp = parseTimestamp(accumulator.longestStallSince);
      if (stallTimestamp < longestTimestamp) {
        accumulator.longestStallSince = item.stallSince;
        accumulator.longestMembershipVerified = membershipVerified;
      } else if (stallTimestamp === longestTimestamp) {
        accumulator.longestMembershipVerified ||= membershipVerified;
      }
    }
  }

  return [...accumulators.values()]
    .map((accumulator) => {
      const addableItems = new Map<string, PotentialCurrentResponseSubjectItem>();
      for (const item of unboundedItems) {
        if (!accumulator.currentItemNodeIds.has(item.nodeId)) {
          addableItems.set(item.nodeId, item);
        }
      }
      const subjectKey = currentResponseSubjectKey(accumulator.subject);
      for (const item of addableItemsBySubjectKey.get(subjectKey) ?? []) {
        if (!accumulator.currentItemNodeIds.has(item.nodeId)) {
          addableItems.set(item.nodeId, item);
        }
      }
      const longestTimestamp = parseTimestamp(accumulator.longestStallSince);
      const addableMembershipCanChangeLongest = [...addableItems.values()].some(
        (item) => item.stalenessUnverified || item.stallTimestamp < longestTimestamp,
      );
      return {
        subject: accumulator.subject,
        label: accumulator.label,
        itemCount: accumulator.itemCount,
        itemCountUnverified: addableItems.size > 0 || accumulator.hasUnverifiedDisplayedMembership,
        longestStallDuration: formatStallDuration(accumulator.longestStallSince, now),
        longestStallUnverified:
          addableMembershipCanChangeLongest ||
          !accumulator.longestMembershipVerified ||
          accumulator.stalenessUnverified,
      };
    })
    .sort((left, right) => {
      const itemCountOrder = right.itemCount - left.itemCount;
      return itemCountOrder === 0 ? compareStrings(left.label, right.label) : itemCountOrder;
    });
}

function currentResponseSubjectKeys(
  login: string,
  teamIds: readonly string[],
): ReadonlySet<string> {
  return new Set([
    currentResponseSubjectKey({ kind: "user", login }),
    ...teamIds.map((teamId) => currentResponseSubjectKey({ kind: "team", teamId })),
  ]);
}

function responseResponsibleMatchesSubjects(
  responsible: CurrentResponseResponsible,
  subjectKeys: ReadonlySet<string>,
): boolean {
  if (responsible.kind === "user") {
    return subjectKeys.has(
      currentResponseSubjectKey({ kind: "user", login: responsible.candidateId }),
    );
  }
  if (responsible.kind === "team") {
    return subjectKeys.has(
      currentResponseSubjectKey({ kind: "team", teamId: responsible.candidateId }),
    );
  }
  return false;
}

function currentResponseSelectedSubjectMembership(
  item: PublicItemSummaryDto,
  subjectKeys: ReadonlySet<string>,
): CurrentResponseSubjectMembership {
  return currentResponseSubjectMembershipFor(item, subjectKeys);
}

/** loginまたは所属teamの項目集合が現在入力で未検証かを返す。 */
export function hasCurrentResponseSubjectItemsUnverified(
  summary: PublicSummaryDto,
  login: string,
  teamIds: readonly string[],
): boolean {
  const subjectKeys = currentResponseSubjectKeys(login, teamIds);
  return summary.items.some((item) => {
    const membership = currentResponseSelectedSubjectMembership(item, subjectKeys);
    return membership === "unverified_displayed" || membership === "unverified_missing";
  });
}

/** loginまたは所属teamが現在の対応者に含まれる項目のnode ID集合を返す。 */
export function selectCurrentResponseSubjectItemNodeIds(
  summary: PublicSummaryDto,
  login: string,
  teamIds: readonly string[],
): ReadonlySet<string> {
  const subjectKeys = currentResponseSubjectKeys(login, teamIds);
  return new Set(
    summary.items
      .filter((item) =>
        item.currentResponses.some((response) =>
          response.responsible.some((responsible) =>
            responseResponsibleMatchesSubjects(responsible, subjectKeys),
          ),
        ),
      )
      .map((item) => item.nodeId),
  );
}

/** loginまたは所属teamに対応する現在のresponseを返す。 */
export function selectCurrentResponseSubjectPrimaryResponse(
  item: PublicItemSummaryDto,
  login: string,
  teamIds: readonly string[],
): PublicPersonalReminderResponseDto {
  const subjectKeys = currentResponseSubjectKeys(login, teamIds);
  const matchingResponses = item.currentResponses.filter((candidate) =>
    candidate.responsible.some((responsible) =>
      responseResponsibleMatchesSubjects(responsible, subjectKeys),
    ),
  );
  const response =
    matchingResponses.find((candidate) => !candidate.subjectMembershipUnverified) ??
    matchingResponses[0];
  assertNonNullable(response, `項目 ${item.nodeId} に選択中の現在の対応がありません`);
  return response;
}
