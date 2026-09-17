import {
  createLabelEffectsResolver,
  createUtcIsoDateTime,
  currentPersonalReminderAssessment,
  determineDeadlineLevel,
  isTerminalStatus,
  PERSONAL_REMINDER_CAUSE_PLANNING_VERSION,
  PERSONAL_REMINDER_ASSESSMENT_RULES_VERSION,
  type AiAnalysisDependency,
  type CurrentPersonalReminderAssessment,
  type Evidence,
  type LabelRule,
  type NaturalLanguageDeadlineAssessmentState,
  type PersonalReminderCause,
  type Relation,
  type TrackedItem,
  type SourceId,
  type UtcIsoDateTime,
} from "../domain/index.js";
import {
  analyzeGraph,
  type AnalyzeGraphResult,
  type GraphAnalysisNode,
  type ReconciledGraphEdge,
  type RelationCandidateId,
} from "../graph/index.js";
import {
  createStateSnapshot,
  parseStateHistoryRecords,
  serializeStateHistoryRecords,
  snapshotEffectiveGraphStateByNodeId,
  type SnapshotRepository,
  type StateHistoryRecord,
  type StateHistoryResponsibility,
  type StateSnapshot,
} from "../persistence/index.js";
import { assertNonNullable, UnreachableError } from "../util/index.js";
import {
  createEvidenceSourceUrlMap,
  resolveEvidenceSourceUrlForItem,
  type EvidenceSourceUrlMap,
} from "./evidence-source-url.js";
import { PublicDtoSemanticError } from "./errors.js";
import {
  createPublicDetailsDto,
  createPublicNotificationHistoryDto,
  comparePublicNotificationHistoryEntries,
  createPublicSummaryDto,
  PUBLIC_DTO_SCHEMA_VERSION,
  type PublicCurrentResponseSubjectChangesDto,
  type PublicCurrentResponseSubjectDto,
  type PublicDetailsDto,
  type PublicGraphEdgeDto,
  type PublicGraphNodeDto,
  type PublicItemHistoryEventDto,
  type PublicNotificationHistoryDto,
  type PublicItemSummaryDto,
  type PublicPersonalReminderResponseDto,
  type PublicPersonalReminderUnknownReason,
  type PublicSummaryDto,
} from "./public-dto.js";
import { assertPagesPublicSafety, type PagesPublicSafetyInput } from "./public-safety.js";
import { assertPublicSummarySize, type PublicSummarySizeMeasurement } from "./summary-size.js";

/** 初期表示へ含めるgraph node数の既定値。 */
export const DEFAULT_INITIAL_GRAPH_NODE_LIMIT = 500;

/** 公開DTO生成時のtimezone、ラベルルール、初期graph、summaryサイズ設定。 */
export type PublicDtoGenerationOptions = Readonly<{
  confidenceThresholds: PublicSummaryDto["confidenceThresholds"];
  labelRules: readonly LabelRule[];
  maxInitialGraphNodes: number;
  maxSummaryGzipBytes: number;
  timezone: PublicSummaryDto["timezone"];
}>;

/** 永続化済みstateから公開DTOを生成する入力。 */
export type GeneratePublicDataInput = PagesPublicSafetyInput &
  Readonly<{
    options: PublicDtoGenerationOptions;
  }>;

/** 初期表示用と詳細用に分割した公開DTOとsummary実測値。 */
export type GeneratedPublicData = Readonly<{
  summary: PublicSummaryDto;
  details: PublicDetailsDto;
  notificationHistory: PublicNotificationHistoryDto;
  summarySize: PublicSummarySizeMeasurement;
}>;

type ResponsibilityHistoryValue = Extract<
  PublicItemHistoryEventDto,
  Readonly<{ kind: "responsibility_changed" }>
>["before"];
type PublicWaitingOn = PublicItemSummaryDto["waitingOn"][number];
type PublicCurrentImplementation = PublicItemSummaryDto["currentImplementations"][number];
type PublicPersonalReminderCausePlanningStatus =
  PublicItemSummaryDto["personalReminderCausePlanningStatus"];
type PublicPersonalReminderResponse = PublicPersonalReminderResponseDto;
type PublicPersonalReminderUnverifiedValue =
  PublicPersonalReminderResponse["unverifiedValues"][number];
type PublicPersonalReminderResponses = Readonly<{
  responses: readonly PublicPersonalReminderResponse[];
  currentResponsesUnverified: boolean;
  currentResponseSubjectChanges: PublicCurrentResponseSubjectChangesDto;
}>;
type EvidenceSourceItem = Readonly<Pick<TrackedItem, "nodeId" | "url">>;
type EvidenceBySourceId = ReadonlyMap<SourceId, readonly Evidence[]>;

type PublicHistory = Readonly<{
  itemEventsByNodeId: ReadonlyMap<string, readonly PublicItemHistoryEventDto[]>;
}>;

type PublicGraph = Readonly<{
  analysis: AnalyzeGraphResult;
  nodes: readonly PublicGraphNodeDto[];
  edges: readonly PublicGraphEdgeDto[];
}>;

type PublicAiAnalysis = PublicItemSummaryDto["aiAnalysis"];
type PublicUnverifiedValue = PublicAiAnalysis["unverifiedValues"][number];
type PublicAiCurrentness = PublicGraphEdgeDto["aiCurrentness"];
type PublicBlockerUnverifiedReason =
  PublicDetailsDto["items"][number]["blockerUnverifiedReasons"][number]["reasons"][number];
type PublicBlockerUnverifiedReasonEntry = Readonly<{
  nodeId: string;
  reasons: readonly PublicBlockerUnverifiedReason[];
}>;

const PUBLIC_BLOCKER_UNVERIFIED_REASON_ORDER: readonly PublicBlockerUnverifiedReason[] = [
  "relation_support",
  "retained_waiting",
  "waiting_value",
];

function isUnverifiedAiDependency(dependency: AiAnalysisDependency): boolean {
  switch (dependency.status) {
    case "not_dependent":
    case "current":
      return false;
    case "unverified":
    case "unknown":
      return true;
    default:
      throw new UnreachableError(dependency);
  }
}

function hasUnverifiedAiDependency(dependencies: readonly AiAnalysisDependency[]): boolean {
  let unverified = false;
  for (const dependency of dependencies) {
    if (isUnverifiedAiDependency(dependency)) {
      unverified = true;
    }
  }
  return unverified;
}

function createPersonalReminderUnverifiedValues(
  cause: PersonalReminderCause,
  assessment: CurrentPersonalReminderAssessment,
  hasCurrentAssessmentEvidence: boolean,
): PublicPersonalReminderResponse["unverifiedValues"] {
  const values: PublicPersonalReminderUnverifiedValue[] = [];
  const statusDependencies = [cause.aiDependencies.presence];
  if (assessment.status === "available") {
    statusDependencies.push(cause.currentInput.aiDependency);
  }
  if (hasUnverifiedAiDependency(statusDependencies)) {
    values.push("status");
  }
  if (isUnverifiedAiDependency(cause.aiDependencies.responsible)) {
    values.push("responsible");
  }
  if (isUnverifiedAiDependency(cause.aiDependencies.action)) {
    values.push("action");
  }
  if (
    isUnverifiedAiDependency(cause.aiDependencies.evidence) ||
    (hasCurrentAssessmentEvidence && isUnverifiedAiDependency(cause.currentInput.aiDependency))
  ) {
    values.push("evidence");
  }
  if (
    assessment.status === "available" &&
    assessment.result.verdict === "waiting" &&
    isUnverifiedAiDependency(cause.currentInput.aiDependency)
  ) {
    values.push("waitingFor");
  }
  return values;
}

function personalReminderMembershipAssessmentUnverified(
  cause: PersonalReminderCause,
  assessment: CurrentPersonalReminderAssessment,
): boolean {
  switch (cause.responseMembershipAssessmentRequirement.status) {
    case "not_required":
      return false;
    case "required":
      return assessment.status !== "available";
    case "unknown":
      return true;
    default:
      throw new UnreachableError(cause.responseMembershipAssessmentRequirement);
  }
}

function personalReminderResponseMembershipUnverified(
  cause: PersonalReminderCause,
  assessment: CurrentPersonalReminderAssessment,
): boolean {
  return (
    personalReminderMembershipAssessmentUnverified(cause, assessment) ||
    hasUnverifiedAiDependency([
      cause.aiDependencies.presence,
      cause.aiDependencies.responseMembership,
      cause.aiDependencies.responsible,
    ])
  );
}

function createPersonalReminderSubjectMembershipUnverified(
  cause: PersonalReminderCause,
  assessment: CurrentPersonalReminderAssessment,
): boolean {
  return (
    cause.responsible.some((responsible) => responsible.kind !== "role") &&
    personalReminderResponseMembershipUnverified(cause, assessment)
  );
}

function createPublicAiAnalysis(
  item: StateSnapshot["items"][number],
  effectiveBlockerNodeIds: readonly string[],
  retainedOnlyBlockerNodeIds: readonly string[],
): PublicAiAnalysis {
  const applications = [
    item.aiAnalysis.applications.status,
    item.aiAnalysis.applications.waitingOn,
    item.aiAnalysis.applications.nextAction,
    item.aiAnalysis.applications.relations,
    item.aiAnalysis.applications.progress,
    item.aiAnalysis.applications.importance,
    item.aiAnalysis.applications.deadline,
    item.aiAnalysis.applications.notification,
    item.aiAnalysis.applications.selfCommitment,
  ];
  const notRequiredApplicationCount = applications.filter(
    (application) => application.status === "not_required",
  ).length;
  let omission: PublicAiAnalysis["omission"];
  if (notRequiredApplicationCount === 0) {
    omission = "none";
  } else if (notRequiredApplicationCount === applications.length) {
    omission = "all";
  } else {
    omission = "partial";
  }

  const unverifiedValues: PublicUnverifiedValue[] = [];
  const dependencies = item.aiDependencies;
  const primaryWaitingOn = item.waitingOn[0];
  const primaryBlockerRetainedOnly =
    item.status === "waiting_for_unblock" &&
    primaryWaitingOn?.kind === "item" &&
    primaryWaitingOn.role === "dependency" &&
    retainedOnlyBlockerNodeIds.includes(primaryWaitingOn.candidateId);
  if (
    hasUnverifiedAiDependency([dependencies.status]) ||
    (retainedOnlyBlockerNodeIds.length > 0 && effectiveBlockerNodeIds.length === 0)
  ) {
    unverifiedValues.push("status");
  }
  if (
    hasUnverifiedAiDependency([dependencies.waitingOn]) ||
    retainedOnlyBlockerNodeIds.length > 0
  ) {
    unverifiedValues.push("waitingOn");
  }
  if (hasUnverifiedAiDependency([dependencies.primaryWaitingOn]) || primaryBlockerRetainedOnly) {
    unverifiedValues.push("primaryWaitingOn");
  }
  if (hasUnverifiedAiDependency([dependencies.nextAction]) || primaryBlockerRetainedOnly) {
    unverifiedValues.push("nextAction");
  }
  if (hasUnverifiedAiDependency([dependencies.confidence])) {
    unverifiedValues.push("confidence");
  }
  if (hasUnverifiedAiDependency([dependencies.evidence])) {
    unverifiedValues.push("evidence");
  }
  if (hasUnverifiedAiDependency([dependencies.uncertainties])) {
    unverifiedValues.push("uncertainties");
  }
  if (hasUnverifiedAiDependency([dependencies.deadline, dependencies.deadlineLevel])) {
    unverifiedValues.push("deadline");
  }
  if (hasUnverifiedAiDependency([dependencies.stallSince])) {
    unverifiedValues.push("staleness");
  }
  if (hasUnverifiedAiDependency([dependencies.downstreamImpact])) {
    unverifiedValues.push("downstreamImpact");
  }
  if (hasUnverifiedAiDependency([dependencies.importance])) {
    unverifiedValues.push("importance");
  }
  if (hasUnverifiedAiDependency([dependencies.attention])) {
    unverifiedValues.push("attention");
  }
  if (hasUnverifiedAiDependency([dependencies.blockers])) {
    unverifiedValues.push("blockers");
  }
  if (hasUnverifiedAiDependency([dependencies.relationSet])) {
    unverifiedValues.push("relations");
  }
  return {
    runStatus: item.aiAnalysis.status,
    omission,
    unverifiedValues,
  };
}

function compareStrings(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}

interface PublicCurrentResponseSubjectChangesAccumulator {
  addableSubjects: Map<string, PublicCurrentResponseSubjectDto>;
  removableSubjects: Map<string, PublicCurrentResponseSubjectDto>;
  unbounded: boolean;
}

function publicCurrentResponseSubjectKey(subject: PublicCurrentResponseSubjectDto): string {
  return `${subject.kind}\u0000${subject.candidateId.toLowerCase()}`;
}

function addPublicCurrentResponseSubject(
  accumulator: PublicCurrentResponseSubjectChangesAccumulator,
  change: "addable" | "removable",
  subject: PublicCurrentResponseSubjectDto,
): void {
  const subjects =
    change === "addable" ? accumulator.addableSubjects : accumulator.removableSubjects;
  const key = publicCurrentResponseSubjectKey(subject);
  const existing = subjects.get(key);
  if (existing == null || compareStrings(subject.candidateId, existing.candidateId) < 0) {
    subjects.set(key, subject);
  }
}

function createPublicCurrentResponseSubjectChangesAccumulator(
  changes: PublicCurrentResponseSubjectChangesDto,
): PublicCurrentResponseSubjectChangesAccumulator {
  const accumulator: PublicCurrentResponseSubjectChangesAccumulator = {
    addableSubjects: new Map(),
    removableSubjects: new Map(),
    unbounded: changes.scope === "unbounded",
  };
  if (changes.scope === "unbounded") {
    return accumulator;
  }
  for (const subject of changes.addableSubjects) {
    addPublicCurrentResponseSubject(accumulator, "addable", subject);
  }
  for (const subject of changes.removableSubjects) {
    addPublicCurrentResponseSubject(accumulator, "removable", subject);
  }
  return accumulator;
}

function addResponsibleCurrentResponseSubjectChanges(
  accumulator: PublicCurrentResponseSubjectChangesAccumulator,
  change: "addable" | "removable",
  responsibleValues: PersonalReminderCause["responsible"],
): void {
  for (const responsible of responsibleValues) {
    const responsibleKind = responsible.kind;
    switch (responsibleKind) {
      case "user":
      case "team":
        addPublicCurrentResponseSubject(accumulator, change, {
          kind: responsibleKind,
          candidateId: responsible.candidateId,
        });
        break;
      case "role":
        break;
      default:
        throw new UnreachableError(responsibleKind);
    }
  }
}

function finalizePublicCurrentResponseSubjectChanges(
  accumulator: PublicCurrentResponseSubjectChangesAccumulator,
  responses: readonly PublicPersonalReminderResponse[],
): PublicCurrentResponseSubjectChangesDto {
  if (accumulator.unbounded) {
    return {
      scope: "unbounded",
    };
  }
  const verifiedSubjectKeys = new Set<string>();
  for (const response of responses) {
    if (response.subjectMembershipUnverified) {
      continue;
    }
    for (const responsible of response.responsible) {
      if (responsible.kind === "role") {
        continue;
      }
      verifiedSubjectKeys.add(
        publicCurrentResponseSubjectKey({
          kind: responsible.kind,
          candidateId: responsible.candidateId,
        }),
      );
    }
  }
  for (const key of verifiedSubjectKeys) {
    accumulator.removableSubjects.delete(key);
  }
  const compareSubjects = (
    left: PublicCurrentResponseSubjectDto,
    right: PublicCurrentResponseSubjectDto,
  ): number =>
    compareStrings(publicCurrentResponseSubjectKey(left), publicCurrentResponseSubjectKey(right));
  return {
    scope: "bounded",
    addableSubjects: [...accumulator.addableSubjects.values()].sort(compareSubjects),
    removableSubjects: [...accumulator.removableSubjects.values()].sort(compareSubjects),
  };
}

function compareHistoryRecords(left: StateHistoryRecord, right: StateHistoryRecord): number {
  const recordedAtOrder = compareStrings(left.recordedAt, right.recordedAt);
  if (recordedAtOrder !== 0) {
    return recordedAtOrder;
  }
  return compareStrings(left.runId, right.runId);
}

function validateOptions(options: PublicDtoGenerationOptions): void {
  if (!Number.isInteger(options.maxInitialGraphNodes) || options.maxInitialGraphNodes <= 0) {
    throw new PublicDtoSemanticError("maxInitialGraphNodesは正の整数にしてください");
  }
}

function validateHistoryRecords(
  records: readonly StateHistoryRecord[],
  generatedAt: string,
): readonly StateHistoryRecord[] {
  if (records.length === 0) {
    return Object.freeze([]);
  }
  const validated = parseStateHistoryRecords(serializeStateHistoryRecords(records));
  const runIds = validated.map((record) => record.runId);
  if (new Set(runIds).size !== runIds.length) {
    throw new PublicDtoSemanticError("history recordのrun IDが重複しています");
  }
  if (validated.some((record) => record.recordedAt > generatedAt)) {
    throw new PublicDtoSemanticError("snapshot生成後のhistory recordを公開できません");
  }
  return Object.freeze([...validated].sort(compareHistoryRecords));
}

function publicDtoGeneratedAt(
  records: readonly StateHistoryRecord[],
  snapshot: StateSnapshot,
): UtcIsoDateTime {
  let generatedAt = snapshot.generatedAt;
  for (const record of records) {
    for (const event of record.events) {
      if (event.kind !== "notification_sent") {
        continue;
      }
      if (record.runId !== snapshot.run.id) {
        if (event.sentAt > snapshot.generatedAt) {
          throw new PublicDtoSemanticError(
            "別runの通知送信時刻がsnapshot生成時刻より新しくなっています",
          );
        }
        continue;
      }
      if (event.sentAt > generatedAt) {
        generatedAt = createUtcIsoDateTime(event.sentAt);
      }
    }
  }
  return generatedAt;
}

function createPublicWaitingOn(waitingOn: PublicWaitingOn): PublicWaitingOn {
  return {
    kind: waitingOn.kind,
    candidateId: waitingOn.candidateId,
    role: waitingOn.role,
    reasonSummary: waitingOn.reasonSummary,
    confidence: waitingOn.confidence,
  };
}

function responsibilityHistoryValue(
  value: StateHistoryResponsibility | undefined,
): ResponsibilityHistoryValue {
  if (value == null) {
    return {
      state: "absent",
    };
  }
  return {
    state: "present",
    value: {
      status: value.status,
      waitingOn: value.waitingOn.map((waitingOn) => ({
        kind: waitingOn.kind,
        candidateId: waitingOn.candidateId,
        role: waitingOn.role,
      })),
    },
  };
}

function createPublicLatestEventActor(
  latestEventActor: StateSnapshot["items"][number]["latestEventActor"],
): PublicDetailsDto["items"][number]["latestEventActor"] {
  if (latestEventActor.status === "absent") {
    return {
      status: latestEventActor.status,
    };
  }
  if (latestEventActor.actor.type === "system") {
    return {
      status: latestEventActor.status,
      actor: {
        type: latestEventActor.actor.type,
        name: latestEventActor.actor.name,
      },
    };
  }
  return {
    status: latestEventActor.status,
    actor: {
      type: latestEventActor.actor.type,
      login: latestEventActor.actor.login,
    },
  };
}

function appendItemHistoryEvent(
  eventsByNodeId: Map<string, PublicItemHistoryEventDto[]>,
  nodeId: string,
  event: PublicItemHistoryEventDto,
): void {
  const events = eventsByNodeId.get(nodeId);
  if (events == null) {
    eventsByNodeId.set(nodeId, [event]);
    return;
  }
  events.push(event);
}

function createPublicHistory(records: readonly StateHistoryRecord[]): PublicHistory {
  const responsibilities = new Map<string, StateHistoryResponsibility>();
  const itemEventsByNodeId = new Map<string, PublicItemHistoryEventDto[]>();

  for (const record of records) {
    for (const event of record.events) {
      switch (event.kind) {
        case "responsibility_set": {
          const before = responsibilities.get(event.nodeId);
          const historyEvent: PublicItemHistoryEventDto = {
            kind: "responsibility_changed",
            recordedAt: record.recordedAt,
            before: responsibilityHistoryValue(before),
            after: responsibilityHistoryValue(event.value),
          };
          responsibilities.set(event.nodeId, event.value);
          appendItemHistoryEvent(itemEventsByNodeId, event.nodeId, historyEvent);
          break;
        }
        case "responsibility_removed": {
          const before = responsibilities.get(event.nodeId);
          if (before == null) {
            throw new PublicDtoSemanticError(
              `責務履歴の削除対象がありません。node ID: ${event.nodeId}`,
            );
          }
          const historyEvent: PublicItemHistoryEventDto = {
            kind: "responsibility_changed",
            recordedAt: record.recordedAt,
            before: responsibilityHistoryValue(before),
            after: responsibilityHistoryValue(undefined),
          };
          responsibilities.delete(event.nodeId);
          appendItemHistoryEvent(itemEventsByNodeId, event.nodeId, historyEvent);
          break;
        }
        case "severity_set":
        case "severity_removed":
        case "edge_set":
        case "edge_removed": {
          break;
        }
        case "repository_excluded": {
          break;
        }
        case "notification_sent": {
          break;
        }
      }
    }
  }

  return Object.freeze({
    itemEventsByNodeId: new Map(
      [...itemEventsByNodeId.entries()].map(([nodeId, events]) => [
        nodeId,
        Object.freeze([...events]),
      ]),
    ),
  });
}

function createPublicNotificationHistory(
  records: readonly StateHistoryRecord[],
  repositoryAllowlist: PagesPublicSafetyInput["repositoryAllowlist"],
  repositoryInventory: readonly PagesPublicSafetyInput["repositoryInventory"][number][],
  runId: string,
  generatedAt: UtcIsoDateTime,
): PublicNotificationHistoryDto {
  const allowlistById = new Map<string, PagesPublicSafetyInput["repositoryAllowlist"][number]>(
    repositoryAllowlist.map((repository) => [repository.id, repository]),
  );
  if (allowlistById.size !== repositoryAllowlist.length) {
    throw new PublicDtoSemanticError("通知履歴の公開allowlistにrepository IDの重複があります");
  }
  const inventoryById = new Map<string, PagesPublicSafetyInput["repositoryInventory"][number]>(
    repositoryInventory.map((repository) => [repository.id, repository]),
  );
  if (inventoryById.size !== repositoryInventory.length) {
    throw new PublicDtoSemanticError("通知履歴のrepository inventoryにIDの重複があります");
  }
  const notifications: PublicNotificationHistoryDto["notifications"] = [];
  for (const record of records) {
    for (const event of record.events) {
      if (event.kind !== "notification_sent") {
        continue;
      }
      if (event.waitingOn.status === "not_recorded") {
        continue;
      }
      if (event.reasons.some((reason) => reason.threshold.status === "not_recorded")) {
        continue;
      }
      const repository = inventoryById.get(event.repositoryId);
      if (repository == null) {
        throw new PublicDtoSemanticError(
          `通知履歴のrepository ${event.repositoryId}をinventoryから解決できません`,
        );
      }
      if (repository.visibility !== "public" || repository.archived || repository.disabled) {
        throw new PublicDtoSemanticError(
          `通知履歴のrepository ${event.repositoryId}は公開対象ではありません`,
        );
      }
      const allowlistedRepository = allowlistById.get(event.repositoryId);
      if (allowlistedRepository == null) {
        throw new PublicDtoSemanticError(
          `通知履歴のrepository ${event.repositoryId}が公開allowlistにありません`,
        );
      }
      if (
        allowlistedRepository.owner !== repository.owner ||
        allowlistedRepository.name !== repository.name
      ) {
        throw new PublicDtoSemanticError(
          `通知履歴のrepository ${event.repositoryId}のidentityが一致しません`,
        );
      }
      notifications.push({
        item: {
          nodeId: event.itemNodeId,
          type: event.type,
          repositoryId: event.repositoryId,
          displayReference: event.displayReference,
          number: event.number,
          title: event.title,
          url: event.url,
        },
        waitingOn: event.waitingOn.values.map((waitingOn) => ({ ...waitingOn })),
        reasons: [...event.reasons],
        personalReminders: event.personalReminders.map((personalReminder) => ({
          ...personalReminder,
        })),
        sentAt: event.sentAt,
      });
    }
  }
  notifications.sort(comparePublicNotificationHistoryEntries);
  return createPublicNotificationHistoryDto({
    schemaVersion: "5",
    runId,
    generatedAt,
    notifications,
  });
}

function analysisEdgeId(index: number): RelationCandidateId {
  return `rel:public-dto:${index.toString()}`;
}

function createAnalysisEdge(relation: Relation, index: number): ReconciledGraphEdge {
  const fields = {
    id: analysisEdgeId(index),
    fromNodeId: relation.fromNodeId,
    toNodeId: relation.toNodeId,
    type: relation.type,
    provenance: relation.provenance,
    confidence: relation.confidence,
    evidence: relation.evidence,
    authoritative: relation.provenance === "native",
    contradictions: relation.contradictions.map((contradiction) => ({
      verdict: contradiction.verdict,
      confidence: contradiction.confidence,
      evidence: [],
    })),
    firstSeenAt: relation.firstSeenAt,
    lastConfirmedAt: relation.lastConfirmedAt,
    aiDependency: relation.aiDependency,
  };
  if (relation.active) {
    return {
      ...fields,
      active: true,
    };
  }
  return {
    ...fields,
    active: false,
    removedAt: relation.removedAt,
  };
}

function createPublicEvidenceEntry(
  entry: Evidence,
  currentSourceItem: EvidenceSourceItem,
  allSourceItems: readonly EvidenceSourceItem[],
  sourceOwnersById: EvidenceSourceUrlMap,
): PublicDetailsDto["items"][number]["evidence"][number] {
  return {
    summary: entry.summary,
    sourceUrl: resolveEvidenceSourceUrlForItem(
      entry.sourceId,
      currentSourceItem,
      allSourceItems,
      sourceOwnersById,
    ),
  };
}

type PublicEvidence = PublicDetailsDto["items"][number]["evidence"][number];

function publicEvidenceIdentity(evidence: PublicEvidence): string {
  return JSON.stringify([evidence.summary, evidence.sourceUrl]);
}

function uniquePublicEvidence(evidence: readonly PublicEvidence[]): PublicEvidence[] {
  const evidenceByIdentity = new Map<string, PublicEvidence>();
  for (const entry of evidence) {
    evidenceByIdentity.set(publicEvidenceIdentity(entry), entry);
  }
  return [...evidenceByIdentity.entries()]
    .sort(([left], [right]) => compareStrings(left, right))
    .map(([, entry]) => entry);
}

function createPublicEvidence(
  evidence: readonly Evidence[],
  currentSourceItem: EvidenceSourceItem,
  allSourceItems: readonly EvidenceSourceItem[],
  sourceOwnersById: EvidenceSourceUrlMap,
): PublicDetailsDto["items"][number]["evidence"] {
  return uniquePublicEvidence(
    evidence.map((entry) =>
      createPublicEvidenceEntry(entry, currentSourceItem, allSourceItems, sourceOwnersById),
    ),
  );
}

function createEvidenceBySourceId(snapshot: StateSnapshot): EvidenceBySourceId {
  const evidenceBySourceId = new Map<SourceId, Evidence[]>();
  for (const evidence of [
    ...snapshot.items.flatMap((item) => item.evidence),
    ...snapshot.relations.flatMap((relation) => relation.evidence),
  ]) {
    const existing = evidenceBySourceId.get(evidence.sourceId);
    if (existing == null) {
      evidenceBySourceId.set(evidence.sourceId, [evidence]);
      continue;
    }
    existing.push(evidence);
  }
  return new Map(
    [...evidenceBySourceId.entries()].map(([sourceId, evidence]) => [
      sourceId,
      Object.freeze([...evidence]),
    ]),
  );
}

function createPersonalReminderResponseEvidence(
  sourceIds: readonly SourceId[],
  assessmentReferences:
    | Readonly<{
        sourceIds: readonly SourceId[];
        reasonSummary: string;
      }>
    | undefined,
  currentSourceItem: StateSnapshot["items"][number],
  allSourceItems: readonly EvidenceSourceItem[],
  sourceOwnersById: EvidenceSourceUrlMap,
  evidenceBySourceId: EvidenceBySourceId,
): PublicPersonalReminderResponse["evidence"] {
  const uniqueSourceIds = [...new Set(sourceIds)].sort(compareStrings);
  return uniquePublicEvidence(
    uniqueSourceIds.map((sourceId) => {
      if (assessmentReferences?.sourceIds.includes(sourceId) === true) {
        const sourceEvidence = evidenceBySourceId.get(sourceId);
        if (sourceEvidence == null || sourceEvidence.length === 0) {
          throw new PublicDtoSemanticError(
            `personal reminder causeのassessment evidence sourceを公開根拠へ解決できません。対象: ${sourceId}`,
          );
        }
        return createPublicEvidenceEntry(
          {
            sourceId,
            supports: "notification",
            summary: assessmentReferences.reasonSummary,
          },
          currentSourceItem,
          allSourceItems,
          sourceOwnersById,
        );
      }
      const currentEvidence = currentSourceItem.evidence.find(
        (evidence) => evidence.sourceId === sourceId,
      );
      const fallbackEvidence = evidenceBySourceId.get(sourceId)?.[0];
      const evidence = currentEvidence ?? fallbackEvidence;
      if (evidence == null) {
        throw new PublicDtoSemanticError(
          `personal reminder causeのevidence sourceを公開根拠へ解決できません。対象: ${sourceId}`,
        );
      }
      return createPublicEvidenceEntry(
        evidence,
        currentSourceItem,
        allSourceItems,
        sourceOwnersById,
      );
    }),
  );
}

function personalReminderUnknownReason(
  cause: PersonalReminderCause,
): PublicPersonalReminderUnknownReason {
  switch (cause.latestAttempt.status) {
    case "not_evaluated":
      return "not_evaluated";
    case "failed":
      return cause.currentInput.rulesVersion === PERSONAL_REMINDER_ASSESSMENT_RULES_VERSION &&
        cause.latestAttempt.inputFingerprint === cause.currentInput.fingerprint &&
        cause.latestAttempt.rulesVersion === cause.currentInput.rulesVersion
        ? "failed"
        : "input_mismatch";
    case "deferred":
      return cause.currentInput.rulesVersion === PERSONAL_REMINDER_ASSESSMENT_RULES_VERSION &&
        cause.latestAttempt.inputFingerprint === cause.currentInput.fingerprint &&
        cause.latestAttempt.rulesVersion === cause.currentInput.rulesVersion
        ? "deferred"
        : "input_mismatch";
    case "completed":
      return "input_mismatch";
  }
}

function createPersonalReminderResponseBase(
  cause: PersonalReminderCause,
  evidence: PublicPersonalReminderResponse["evidence"],
): Omit<
  PublicPersonalReminderResponse,
  "status" | "waitingFor" | "reason" | "unverifiedValues" | "subjectMembershipUnverified"
> {
  return {
    causeId: cause.causeId,
    responsible: cause.responsible.map((responsible) => ({
      kind: responsible.kind,
      candidateId: responsible.candidateId,
      role: responsible.role,
    })),
    action: {
      kind: cause.action.kind,
      summary: cause.action.summary,
    },
    evidence,
  };
}

function createPersonalReminderResponse(
  cause: PersonalReminderCause,
  assessment: CurrentPersonalReminderAssessment,
  currentSourceItem: StateSnapshot["items"][number],
  allSourceItems: readonly EvidenceSourceItem[],
  sourceOwnersById: EvidenceSourceUrlMap,
  evidenceBySourceId: EvidenceBySourceId,
): PublicPersonalReminderResponse | undefined {
  if (assessment.status === "available") {
    if (assessment.result.verdict === "duplicate" || assessment.result.verdict === "not_required") {
      return undefined;
    }
  }
  const assessmentReferences =
    assessment.status === "available" &&
    assessment.result.verdict !== "duplicate" &&
    assessment.result.verdict !== "not_required"
      ? assessment.result.references
      : undefined;
  const evidence = createPersonalReminderResponseEvidence(
    [...cause.evidenceSourceIds, ...(assessmentReferences?.sourceIds ?? [])],
    assessmentReferences,
    currentSourceItem,
    allSourceItems,
    sourceOwnersById,
    evidenceBySourceId,
  );
  const hasCurrentAssessmentEvidence =
    assessmentReferences != null && assessmentReferences.sourceIds.length > 0;
  const unverifiedValues = createPersonalReminderUnverifiedValues(
    cause,
    assessment,
    hasCurrentAssessmentEvidence,
  );
  const subjectMembershipUnverified = createPersonalReminderSubjectMembershipUnverified(
    cause,
    assessment,
  );
  const base = createPersonalReminderResponseBase(cause, evidence);
  if (assessment.status !== "available") {
    return {
      ...base,
      status: "unknown",
      reason: personalReminderUnknownReason(cause),
      unverifiedValues,
      subjectMembershipUnverified,
    };
  }
  switch (assessment.result.verdict) {
    case "actionable":
      return {
        ...base,
        status: "actionable",
        unverifiedValues,
        subjectMembershipUnverified,
      };
    case "waiting":
      return {
        ...base,
        status: "waiting",
        waitingFor: {
          itemNodeId: assessment.result.waitingFor.itemNodeId,
          action: assessment.result.waitingFor.action,
        },
        unverifiedValues,
        subjectMembershipUnverified,
      };
    case "unknown":
      return {
        ...base,
        status: "unknown",
        reason: assessment.result.reason,
        unverifiedValues,
        subjectMembershipUnverified,
      };
    case "duplicate":
    case "not_required":
      return undefined;
  }
}

function personalReminderCausePlanningStatus(
  item: StateSnapshot["items"][number],
): PublicPersonalReminderCausePlanningStatus {
  if (
    item.personalReminderCausePlanning.planningVersion !== PERSONAL_REMINDER_CAUSE_PLANNING_VERSION
  ) {
    return "pending";
  }
  return item.personalReminderCausePlanning.status;
}

function createPersonalReminderResponses(
  item: StateSnapshot["items"][number],
  allSourceItems: readonly EvidenceSourceItem[],
  sourceOwnersById: EvidenceSourceUrlMap,
  evidenceBySourceId: EvidenceBySourceId,
): PublicPersonalReminderResponses {
  const planning = item.personalReminderCausePlanning;
  if (
    planning.status !== "completed" ||
    planning.planningVersion !== PERSONAL_REMINDER_CAUSE_PLANNING_VERSION
  ) {
    const currentResponseSubjectChanges: PublicCurrentResponseSubjectChangesDto = {
      scope: "bounded",
      addableSubjects: [],
      removableSubjects: [],
    };
    return Object.freeze({
      responses: Object.freeze([]),
      currentResponsesUnverified: false,
      currentResponseSubjectChanges,
    });
  }
  const responses: PublicPersonalReminderResponse[] = [];
  let currentResponsesUnverified = isUnverifiedAiDependency(planning.causeSetAiDependency);
  const subjectChanges = createPublicCurrentResponseSubjectChangesAccumulator(
    planning.causeSetSubjectChanges,
  );
  for (const cause of item.personalReminderCauses) {
    const assessment = currentPersonalReminderAssessment(cause);
    const responseMembershipUnverified = personalReminderResponseMembershipUnverified(
      cause,
      assessment,
    );
    if (responseMembershipUnverified) {
      currentResponsesUnverified = true;
    }
    const response = createPersonalReminderResponse(
      cause,
      assessment,
      item,
      allSourceItems,
      sourceOwnersById,
      evidenceBySourceId,
    );
    if (response != null) {
      responses.push(response);
      if (response.subjectMembershipUnverified) {
        addResponsibleCurrentResponseSubjectChanges(subjectChanges, "removable", cause.responsible);
      }
      if (isUnverifiedAiDependency(cause.aiDependencies.responsible)) {
        subjectChanges.unbounded = true;
      }
      continue;
    }
    if (responseMembershipUnverified) {
      addResponsibleCurrentResponseSubjectChanges(subjectChanges, "addable", cause.responsible);
      if (isUnverifiedAiDependency(cause.aiDependencies.responsible)) {
        subjectChanges.unbounded = true;
      }
    }
  }
  const sortedResponses = responses.sort((left, right) =>
    compareStrings(left.causeId, right.causeId),
  );
  return Object.freeze({
    responses: Object.freeze(sortedResponses),
    currentResponsesUnverified,
    currentResponseSubjectChanges: finalizePublicCurrentResponseSubjectChanges(
      subjectChanges,
      sortedResponses,
    ),
  });
}

function createPublicAiCurrentness(relation: Relation): PublicAiCurrentness {
  if (relation.provenance === "native" && relation.aiDependency.status !== "not_dependent") {
    throw new PublicDtoSemanticError(
      `native relation ${relation.id}のAI依存はnot_dependentでなければなりません`,
    );
  }
  switch (relation.aiDependency.status) {
    case "not_dependent":
      return "not_dependent";
    case "current":
      return "current";
    case "unverified":
    case "unknown":
      return "unverified";
    default:
      throw new UnreachableError(relation.aiDependency);
  }
}

function createPublicGraphEdge(relation: Relation): PublicGraphEdgeDto {
  const fields = {
    id: relation.id,
    fromNodeId: relation.fromNodeId,
    toNodeId: relation.toNodeId,
    type: relation.type,
    provenance: relation.provenance,
    confidence: relation.confidence,
    aiCurrentness: createPublicAiCurrentness(relation),
  };
  if (relation.active) {
    return {
      ...fields,
      active: true,
    };
  }
  return {
    ...fields,
    active: false,
  };
}

function createPublicGraph(
  snapshot: StateSnapshot,
  effectiveStateByNodeId: ReadonlyMap<string, TrackedItem["state"]>,
): PublicGraph {
  const graphNodeIds = new Set([
    ...snapshot.items.map((item) => item.nodeId),
    ...snapshot.externalReferences.map((reference) => reference.nodeId),
  ]);
  for (const relation of snapshot.relations) {
    if (!graphNodeIds.has(relation.fromNodeId) || !graphNodeIds.has(relation.toNodeId)) {
      throw new PublicDtoSemanticError(
        `relation ${relation.id}がsnapshotにないnodeを参照しています`,
      );
    }
  }

  const analysisEdges = snapshot.relations.map(createAnalysisEdge);
  const analysisNodes: GraphAnalysisNode[] = [
    ...snapshot.items.map((item) => {
      const state = effectiveStateByNodeId.get(item.nodeId);
      assertNonNullable(state, `graph node ${item.nodeId}のeffective stateがありません`);
      return Object.freeze({
        kind: item.type,
        nodeId: item.nodeId,
        repositoryId: item.repositoryId,
        state,
        directNotification: "eligible",
      } satisfies GraphAnalysisNode);
    }),
    ...snapshot.externalReferences.map((reference) =>
      Object.freeze({
        kind: reference.kind,
        nodeId: reference.nodeId,
        repositoryFullName: reference.repositoryFullName,
        state: reference.state,
        directNotification: reference.directNotification,
      } satisfies GraphAnalysisNode),
    ),
  ];
  const analysis = analyzeGraph({
    current: {
      nodes: analysisNodes,
      edges: analysisEdges,
    },
    previous: {
      availability: "unavailable",
    },
  });
  const nodes: PublicGraphNodeDto[] = snapshot.items.map((item) => {
    const state = effectiveStateByNodeId.get(item.nodeId);
    assertNonNullable(state, `公開graph node ${item.nodeId}のeffective stateがありません`);
    return {
      nodeId: item.nodeId,
      kind: item.type,
      repositoryId: item.repositoryId,
      state,
      status: item.status,
      severity: item.severity,
    };
  });
  nodes.push(
    ...snapshot.externalReferences.map((reference) => ({
      nodeId: reference.nodeId,
      kind: reference.kind,
      repositoryFullName: reference.repositoryFullName,
      displayReference: `${reference.repositoryFullName}#${reference.number.toString()}`,
      url: reference.url,
      title: reference.title,
      state: reference.state,
    })),
  );
  const edges = snapshot.relations.map(createPublicGraphEdge);

  return Object.freeze({
    analysis,
    nodes: Object.freeze(nodes),
    edges: Object.freeze(edges),
  });
}

type PublicBlockerLists = Readonly<{
  blockerNodeIdsByNodeId: ReadonlyMap<string, readonly string[]>;
  blockerUnverifiedReasonsByNodeId: ReadonlyMap<
    string,
    readonly PublicBlockerUnverifiedReasonEntry[]
  >;
  effectiveBlockerNodeIdsByNodeId: ReadonlyMap<string, readonly string[]>;
  retainedOnlyBlockerNodeIdsByNodeId: ReadonlyMap<string, readonly string[]>;
}>;

function createBlockerLists(
  snapshot: StateSnapshot,
  effectiveStateByNodeId: ReadonlyMap<string, TrackedItem["state"]>,
): PublicBlockerLists {
  const itemByNodeId = new Map<string, TrackedItem>(
    snapshot.items.map((item) => [item.nodeId, item]),
  );
  const supportsByMeaning = new Map<string, Relation[]>();
  for (const relation of snapshot.relations) {
    if (!relation.active || relation.type !== "blocks") {
      continue;
    }
    const blockerState = effectiveStateByNodeId.get(relation.fromNodeId);
    const blockedState = effectiveStateByNodeId.get(relation.toNodeId);
    const blocked = itemByNodeId.get(relation.toNodeId);
    assertNonNullable(blockerState, `blocks relation ${relation.id}のblockerがありません`);
    assertNonNullable(blockedState, `blocks relation ${relation.id}のblocked状態がありません`);
    assertNonNullable(blocked, `blocks relation ${relation.id}のblocked itemがありません`);
    if (blockerState !== "open" || blockedState !== "open") {
      continue;
    }
    const meaningKey = JSON.stringify([relation.type, relation.fromNodeId, relation.toNodeId]);
    const existing = supportsByMeaning.get(meaningKey);
    if (existing == null) {
      supportsByMeaning.set(meaningKey, [relation]);
    } else {
      existing.push(relation);
    }
  }
  const blockersByNodeId = new Map<string, Set<string>>();
  const effectiveBlockersByNodeId = new Map<string, Set<string>>();
  const blockerUnverifiedReasonsByNodeId = new Map<
    string,
    Map<string, Set<PublicBlockerUnverifiedReason>>
  >();
  const retainedOnlyBlockersByNodeId = new Map<string, Set<string>>();
  const addBlockerUnverifiedReason = (
    blockedNodeId: string,
    blockerNodeId: string,
    reason: PublicBlockerUnverifiedReason,
  ): void => {
    let reasonsByBlockerNodeId = blockerUnverifiedReasonsByNodeId.get(blockedNodeId);
    if (reasonsByBlockerNodeId == null) {
      reasonsByBlockerNodeId = new Map();
      blockerUnverifiedReasonsByNodeId.set(blockedNodeId, reasonsByBlockerNodeId);
    }
    let reasons = reasonsByBlockerNodeId.get(blockerNodeId);
    if (reasons == null) {
      reasons = new Set();
      reasonsByBlockerNodeId.set(blockerNodeId, reasons);
    }
    reasons.add(reason);
  };
  const staleRepositoryIds = new Set(
    snapshot.repositories
      .filter((repository) => repository.freshness === "stale")
      .map((repository) => repository.id),
  );
  for (const supports of supportsByMeaning.values()) {
    const firstSupport = supports[0];
    assertNonNullable(firstSupport, "blocks supportがありません");
    const blockers = blockersByNodeId.get(firstSupport.toNodeId);
    if (blockers == null) {
      blockersByNodeId.set(firstSupport.toNodeId, new Set([firstSupport.fromNodeId]));
    } else {
      blockers.add(firstSupport.fromNodeId);
    }
    const effectiveBlockers = effectiveBlockersByNodeId.get(firstSupport.toNodeId);
    if (effectiveBlockers == null) {
      effectiveBlockersByNodeId.set(firstSupport.toNodeId, new Set([firstSupport.fromNodeId]));
    } else {
      effectiveBlockers.add(firstSupport.fromNodeId);
    }
    let allUnverified = true;
    for (const support of supports) {
      if (createPublicAiCurrentness(support) !== "unverified") {
        allUnverified = false;
      }
    }
    if (!allUnverified) {
      continue;
    }
    addBlockerUnverifiedReason(firstSupport.toNodeId, firstSupport.fromNodeId, "relation_support");
  }
  for (const item of snapshot.items) {
    if (item.status !== "waiting_for_unblock") {
      continue;
    }
    const effectiveBlockers = effectiveBlockersByNodeId.get(item.nodeId) ?? new Set<string>();
    const waitingOnUnverified = isUnverifiedAiDependency(item.aiDependencies.waitingOn);
    for (const waitingOn of item.waitingOn) {
      if (waitingOn.kind !== "item" || waitingOn.role !== "dependency") {
        continue;
      }
      if (!effectiveStateByNodeId.has(waitingOn.candidateId)) {
        throw new PublicDtoSemanticError(
          `waitingOn項目 ${waitingOn.candidateId}を公開項目またはexternal referenceへ解決できません`,
        );
      }
      const blockers = blockersByNodeId.get(item.nodeId);
      if (blockers == null) {
        blockersByNodeId.set(item.nodeId, new Set([waitingOn.candidateId]));
      } else {
        blockers.add(waitingOn.candidateId);
      }
      if (waitingOnUnverified) {
        addBlockerUnverifiedReason(item.nodeId, waitingOn.candidateId, "waiting_value");
      }
      if (effectiveBlockers.has(waitingOn.candidateId)) {
        continue;
      }
      if (!staleRepositoryIds.has(item.repositoryId)) {
        continue;
      }
      const retainedOnlyBlockers = retainedOnlyBlockersByNodeId.get(item.nodeId);
      if (retainedOnlyBlockers == null) {
        retainedOnlyBlockersByNodeId.set(item.nodeId, new Set([waitingOn.candidateId]));
      } else {
        retainedOnlyBlockers.add(waitingOn.candidateId);
      }
      addBlockerUnverifiedReason(item.nodeId, waitingOn.candidateId, "retained_waiting");
    }
  }
  const sortBlockerMap = (
    blockersByNode: ReadonlyMap<string, Set<string>>,
  ): ReadonlyMap<string, readonly string[]> =>
    new Map(
      [...blockersByNode.entries()].map(([nodeId, blockerNodeIds]) => [
        nodeId,
        Object.freeze([...blockerNodeIds].sort(compareStrings)),
      ]),
    );
  const sortedBlockerUnverifiedReasonsByNodeId = new Map(
    [...blockerUnverifiedReasonsByNodeId.entries()].map(([nodeId, reasonsByBlockerNodeId]) => [
      nodeId,
      Object.freeze(
        [...reasonsByBlockerNodeId.entries()]
          .sort(([leftNodeId], [rightNodeId]) => compareStrings(leftNodeId, rightNodeId))
          .map(([blockerNodeId, reasons]) =>
            Object.freeze({
              nodeId: blockerNodeId,
              reasons: Object.freeze(
                PUBLIC_BLOCKER_UNVERIFIED_REASON_ORDER.filter((reason) => reasons.has(reason)),
              ),
            }),
          ),
      ),
    ]),
  );
  return Object.freeze({
    blockerNodeIdsByNodeId: sortBlockerMap(blockersByNodeId),
    blockerUnverifiedReasonsByNodeId: sortedBlockerUnverifiedReasonsByNodeId,
    effectiveBlockerNodeIdsByNodeId: sortBlockerMap(effectiveBlockersByNodeId),
    retainedOnlyBlockerNodeIdsByNodeId: sortBlockerMap(retainedOnlyBlockersByNodeId),
  });
}

function createDisplayReferencesByNodeId(snapshot: StateSnapshot): ReadonlyMap<string, string> {
  const displayReferencesByNodeId = new Map<string, string>();
  for (const item of snapshot.items) {
    displayReferencesByNodeId.set(item.nodeId, item.displayReference);
  }
  for (const reference of snapshot.externalReferences) {
    displayReferencesByNodeId.set(
      reference.nodeId,
      `${reference.repositoryFullName}#${reference.number.toString()}`,
    );
  }
  return displayReferencesByNodeId;
}

function createPublicNextAction(
  item: Pick<StateSnapshot["items"][number], "nextAction" | "waitingOn">,
  displayReferencesByNodeId: ReadonlyMap<string, string>,
): string {
  const candidateIds = [
    ...new Set(
      item.waitingOn
        .filter((waitingOn) => waitingOn.kind === "item")
        .map((waitingOn) => waitingOn.candidateId),
    ),
  ].sort((left, right) => right.length - left.length || compareStrings(left, right));
  let nextAction = item.nextAction;
  for (const candidateId of candidateIds) {
    if (!nextAction.includes(candidateId)) {
      continue;
    }
    const displayReference = displayReferencesByNodeId.get(candidateId);
    if (displayReference == null) {
      throw new PublicDtoSemanticError(
        `nextActionのwaitingOn項目 ${candidateId}をdisplayReferenceへ解決できません`,
      );
    }
    nextAction = nextAction.split(candidateId).join(displayReference);
  }
  return nextAction;
}

function createCurrentImplementationsByIssueNodeId(
  snapshot: StateSnapshot,
  repositoriesById: ReadonlyMap<string, SnapshotRepository>,
  displayReferencesByNodeId: ReadonlyMap<string, string>,
): ReadonlyMap<string, readonly PublicCurrentImplementation[]> {
  const itemsByNodeId = new Map<string, StateSnapshot["items"][number]>(
    snapshot.items.map((item) => [item.nodeId, item]),
  );
  const externalNodeIds = new Set<string>(
    snapshot.externalReferences.map((reference) => reference.nodeId),
  );
  const implementationsByIssueNodeId = new Map<string, Map<string, PublicCurrentImplementation>>();
  for (const relation of snapshot.relations) {
    if (!relation.active || relation.type !== "implements" || relation.provenance !== "native") {
      continue;
    }
    if (externalNodeIds.has(relation.fromNodeId) || externalNodeIds.has(relation.toNodeId)) {
      continue;
    }
    const implementation = itemsByNodeId.get(relation.fromNodeId);
    const targetIssue = itemsByNodeId.get(relation.toNodeId);
    assertNonNullable(implementation, `implements relation ${relation.id}の実装項目がありません`);
    assertNonNullable(targetIssue, `implements relation ${relation.id}の対象項目がありません`);
    if (implementation.type !== "pull_request" || targetIssue.type !== "issue") {
      continue;
    }
    if (implementation.state === "open" && isTerminalStatus(implementation.status)) {
      throw new PublicDtoSemanticError(
        `implements relation ${relation.id}の実装PRはGitHub stateがopenなのにterminal statusです`,
      );
    }
    if (targetIssue.state === "open" && isTerminalStatus(targetIssue.status)) {
      throw new PublicDtoSemanticError(
        `implements relation ${relation.id}の対象IssueはGitHub stateがopenなのにterminal statusです`,
      );
    }
    if (implementation.state !== "open" || targetIssue.state !== "open") {
      continue;
    }
    const implementationRepository = repositoriesById.get(implementation.repositoryId);
    const targetRepository = repositoriesById.get(targetIssue.repositoryId);
    assertNonNullable(
      implementationRepository,
      `implements relation ${relation.id}の実装repositoryがありません`,
    );
    assertNonNullable(
      targetRepository,
      `implements relation ${relation.id}の対象repositoryがありません`,
    );
    if (implementationRepository.freshness !== "fresh" || targetRepository.freshness !== "fresh") {
      continue;
    }
    const implementations = implementationsByIssueNodeId.get(targetIssue.nodeId);
    const currentImplementation: PublicCurrentImplementation = {
      nodeId: implementation.nodeId,
      repositoryId: implementation.repositoryId,
      displayReference: implementation.displayReference,
      number: implementation.number,
      url: implementation.url,
      title: implementation.title,
      status: implementation.status,
      waitingOn: implementation.waitingOn.map(createPublicWaitingOn),
      nextAction: createPublicNextAction(implementation, displayReferencesByNodeId),
    };
    if (implementations == null) {
      implementationsByIssueNodeId.set(
        targetIssue.nodeId,
        new Map([[implementation.nodeId, currentImplementation]]),
      );
      continue;
    }
    if (!implementations.has(implementation.nodeId)) {
      implementations.set(implementation.nodeId, currentImplementation);
    }
  }
  return new Map(
    [...implementationsByIssueNodeId.entries()].map(([issueNodeId, implementations]) => [
      issueNodeId,
      Object.freeze(
        [...implementations.values()].sort((left, right) =>
          compareStrings(left.nodeId, right.nodeId),
        ),
      ),
    ]),
  );
}

function createItemSummary(
  item: StateSnapshot["items"][number],
  repository: SnapshotRepository,
  currentImplementations: readonly PublicCurrentImplementation[],
  currentResponses: readonly PublicPersonalReminderResponse[],
  currentResponsesUnverified: boolean,
  currentResponseSubjectChanges: PublicCurrentResponseSubjectChangesDto,
  personalReminderCausePlanningStatus: PublicPersonalReminderCausePlanningStatus,
  displayReferencesByNodeId: ReadonlyMap<string, string>,
  blockerNodeIds: readonly string[],
  effectiveBlockerNodeIds: readonly string[],
  retainedOnlyBlockerNodeIds: readonly string[],
  downstreamImpact: AnalyzeGraphResult["downstreamImpacts"][number],
  priorityWeight: number,
  evaluatedAt: UtcIsoDateTime,
  timezone: string,
): PublicItemSummaryDto {
  return {
    nodeId: item.nodeId,
    type: item.type,
    repositoryId: item.repositoryId,
    displayReference: item.displayReference,
    number: item.number,
    url: item.url,
    title: item.title,
    deadline: createPublicDeadlineSummary(item.deadlineAssessment, evaluatedAt, timezone),
    state: item.state,
    author:
      item.author.status === "unavailable"
        ? {
            ...item.author,
          }
        : {
            ...item.author,
            actor: {
              ...item.author.actor,
            },
          },
    assignees: item.assignees.map((assignee) => ({
      ...assignee,
    })),
    status: item.status,
    waitingOn: item.waitingOn.map(createPublicWaitingOn),
    primaryWaitingOn: {
      ...item.primaryWaitingOn,
    },
    nextAction: createPublicNextAction(item, displayReferencesByNodeId),
    severity: item.severity,
    importance: {
      score: item.importance.score,
      level: item.importance.level,
    },
    attention: {
      score: item.attention.score,
      level: item.attention.level,
    },
    priorityWeight,
    aiAnalysis: createPublicAiAnalysis(item, effectiveBlockerNodeIds, retainedOnlyBlockerNodeIds),
    confidence: item.confidence,
    githubUpdatedAt: item.githubUpdatedAt,
    stallSince: item.stallSince,
    observedAt: item.observedAt,
    repositoryFreshness: repository.freshness,
    blockerNodeIds: [...blockerNodeIds],
    downstreamImpact: {
      ...downstreamImpact,
    },
    currentImplementations: [...currentImplementations],
    currentResponses: [...currentResponses],
    currentResponsesUnverified,
    currentResponseSubjectChanges:
      currentResponseSubjectChanges.scope === "unbounded"
        ? { scope: "unbounded" }
        : {
            scope: "bounded",
            addableSubjects: currentResponseSubjectChanges.addableSubjects.map((subject) => ({
              ...subject,
            })),
            removableSubjects: currentResponseSubjectChanges.removableSubjects.map((subject) => ({
              ...subject,
            })),
          },
    personalReminderCausePlanningStatus,
  };
}

function assertPublicSummaryDetailsCurrentResponses(
  summary: PublicSummaryDto,
  details: PublicDetailsDto,
): void {
  const detailsSummariesByNodeId = new Map<string, PublicItemSummaryDto>(
    details.items.map((item) => [item.summary.nodeId, item.summary]),
  );
  for (const item of summary.items) {
    const detailsSummary = detailsSummariesByNodeId.get(item.nodeId);
    assertNonNullable(detailsSummary, `item ${item.nodeId}のdetails summaryがありません`);
    if (item.currentResponsesUnverified !== detailsSummary.currentResponsesUnverified) {
      throw new PublicDtoSemanticError(
        `item ${item.nodeId}のsummaryとdetailsでcurrentResponsesUnverifiedが一致しません`,
      );
    }
    if (
      JSON.stringify(item.currentResponseSubjectChanges) !==
      JSON.stringify(detailsSummary.currentResponseSubjectChanges)
    ) {
      throw new PublicDtoSemanticError(
        `item ${item.nodeId}のsummaryとdetailsでcurrentResponseSubjectChangesが一致しません`,
      );
    }
    if (item.currentResponses.length !== detailsSummary.currentResponses.length) {
      throw new PublicDtoSemanticError(
        `item ${item.nodeId}のsummaryとdetailsでcurrentResponsesの件数が一致しません`,
      );
    }
    for (const response of item.currentResponses) {
      const detailsResponse: PublicPersonalReminderResponse | undefined =
        detailsSummary.currentResponses.find((candidate) => candidate.causeId === response.causeId);
      assertNonNullable(detailsResponse, `item ${item.nodeId}のdetails responseがありません`);
      if (
        response.causeId !== detailsResponse.causeId ||
        response.subjectMembershipUnverified !== detailsResponse.subjectMembershipUnverified
      ) {
        throw new PublicDtoSemanticError(
          `item ${item.nodeId}のsummaryとdetailsでcurrent responseが一致しません`,
        );
      }
    }
  }
}

function createPublicDeadlineSummary(
  assessment: NaturalLanguageDeadlineAssessmentState,
  evaluatedAt: UtcIsoDateTime,
  timezone: string,
): PublicItemSummaryDto["deadline"] {
  if (assessment.status === "not_available") {
    return {
      status: "not_available",
    };
  }
  return {
    status: "available",
    date: assessment.value.date,
    level: determineDeadlineLevel({
      deadlineDate: assessment.value.date,
      evaluatedAt,
      timezone,
    }),
  };
}

function createPublicDeadlineDetails(
  assessment: NaturalLanguageDeadlineAssessmentState,
  evaluatedAt: UtcIsoDateTime,
  timezone: string,
): PublicDetailsDto["items"][number]["deadline"] {
  if (assessment.status === "not_available") {
    return {
      status: "not_available",
    };
  }
  return {
    status: "available",
    date: assessment.value.date,
    level: determineDeadlineLevel({
      deadlineDate: assessment.value.date,
      evaluatedAt,
      timezone,
    }),
    rationale: assessment.value.rationale,
  };
}

function graphNodeAttentionScore(
  node: PublicGraphNodeDto,
  summaryByNodeId: ReadonlyMap<string, PublicItemSummaryDto>,
): number {
  if (node.kind === "external_reference") {
    return 0;
  }
  const summary = summaryByNodeId.get(node.nodeId);
  assertNonNullable(summary, `node ${node.nodeId}のsummaryがありません`);
  return summary.attention.score;
}

function graphNodeImpact(
  node: PublicGraphNodeDto,
  impactByNodeId: ReadonlyMap<string, AnalyzeGraphResult["downstreamImpacts"][number]>,
): Readonly<{
  openNodeCount: number;
  repositoryCount: number;
}> {
  const impact = impactByNodeId.get(node.nodeId);
  assertNonNullable(impact, `node ${node.nodeId}のimpactがありません`);
  return impact;
}

function requiredInitialGraphNodes(
  graph: PublicGraph,
  items: readonly PublicItemSummaryDto[],
): readonly PublicGraphNodeDto[] {
  const summaryItemNodeIds = new Set(items.map((item) => item.nodeId));
  const graphNodesByNodeId = new Map(graph.nodes.map((node) => [node.nodeId, node]));
  const waitingOnItemCandidateIds = new Set<string>();
  for (const item of items) {
    const waitingOnValues = [
      ...item.waitingOn,
      ...item.currentImplementations.flatMap((implementation) => implementation.waitingOn),
    ];
    for (const waitingOn of waitingOnValues) {
      if (waitingOn.kind === "item") {
        waitingOnItemCandidateIds.add(waitingOn.candidateId);
      }
    }
    for (const response of item.currentResponses) {
      if (response.status === "waiting") {
        waitingOnItemCandidateIds.add(response.waitingFor.itemNodeId);
      }
    }
  }
  const requiredNodes: PublicGraphNodeDto[] = [];
  for (const candidateId of waitingOnItemCandidateIds) {
    if (summaryItemNodeIds.has(candidateId)) {
      continue;
    }
    const graphNode = graphNodesByNodeId.get(candidateId);
    if (graphNode == null) {
      throw new PublicDtoSemanticError(`waitingOn項目 ${candidateId}の公開graph nodeがありません`);
    }
    if (graphNode.kind !== "external_reference") {
      throw new PublicDtoSemanticError(
        `waitingOn項目 ${candidateId}はexternal_referenceではありません`,
      );
    }
    requiredNodes.push(graphNode);
  }
  return Object.freeze(requiredNodes);
}

function createInitialGraph(
  graph: PublicGraph,
  items: readonly PublicItemSummaryDto[],
  maxInitialGraphNodes: number,
): PublicSummaryDto["graph"] {
  const summaryByNodeId = new Map(items.map((item) => [item.nodeId, item]));
  const impactByNodeId = new Map<string, AnalyzeGraphResult["downstreamImpacts"][number]>(
    graph.analysis.downstreamImpacts.map((impact) => [impact.nodeId, impact]),
  );
  const requiredNodes = requiredInitialGraphNodes(graph, items);
  if (requiredNodes.length > maxInitialGraphNodes) {
    throw new PublicDtoSemanticError(
      `waitingOnの必須external_reference node数 ${requiredNodes.length.toString()} がinitial graph上限 ${maxInitialGraphNodes.toString()}を超えています`,
    );
  }
  const rankedNodes = [...graph.nodes].sort((left, right) => {
    const attentionOrder =
      graphNodeAttentionScore(right, summaryByNodeId) -
      graphNodeAttentionScore(left, summaryByNodeId);
    if (attentionOrder !== 0) {
      return attentionOrder;
    }
    const leftImpact = graphNodeImpact(left, impactByNodeId);
    const rightImpact = graphNodeImpact(right, impactByNodeId);
    const impactOrder = rightImpact.openNodeCount - leftImpact.openNodeCount;
    if (impactOrder !== 0) {
      return impactOrder;
    }
    const leftSummary = summaryByNodeId.get(left.nodeId);
    const rightSummary = summaryByNodeId.get(right.nodeId);
    if (left.kind === "external_reference" || right.kind === "external_reference") {
      if (left.kind === right.kind) {
        return compareStrings(left.nodeId, right.nodeId);
      }
      return left.kind === "external_reference" ? 1 : -1;
    }
    assertNonNullable(leftSummary, `node ${left.nodeId}のsummaryがありません`);
    assertNonNullable(rightSummary, `node ${right.nodeId}のsummaryがありません`);
    const stallOrder = compareStrings(leftSummary.stallSince, rightSummary.stallSince);
    if (stallOrder !== 0) {
      return stallOrder;
    }
    return compareStrings(left.nodeId, right.nodeId);
  });
  const requiredNodeIds = new Set(requiredNodes.map((node) => node.nodeId));
  const selectedNodes = [
    ...requiredNodes,
    ...rankedNodes
      .filter((node) => !requiredNodeIds.has(node.nodeId))
      .slice(0, maxInitialGraphNodes - requiredNodes.length),
  ].sort((left, right) => compareStrings(left.nodeId, right.nodeId));
  return {
    nodes: selectedNodes.map((node) =>
      node.kind === "external_reference"
        ? {
            nodeId: node.nodeId,
            kind: node.kind,
            displayReference: node.displayReference,
          }
        : {
            nodeId: node.nodeId,
            kind: node.kind,
          },
    ),
    maxNodes: maxInitialGraphNodes,
  };
}

function latestRepositoryObservedAt(repositories: readonly SnapshotRepository[]): string {
  const firstRepository = repositories[0];
  assertNonNullable(firstRepository, "公開DTOには1件以上のrepositoryが必要です");
  return repositories.reduce(
    (latest, repository) => (repository.observedAt > latest ? repository.observedAt : latest),
    firstRepository.observedAt,
  );
}

/** 永続化済みsnapshotと履歴から副作用なしで公開DTOを生成する。 */
export function generatePublicData(input: GeneratePublicDataInput): GeneratedPublicData {
  assertPagesPublicSafety(input);
  validateOptions(input.options);
  const snapshot = createStateSnapshot(input.snapshot);
  const historyRecords = validateHistoryRecords(input.historyRecords, snapshot.generatedAt);
  const generatedAt = publicDtoGeneratedAt(historyRecords, snapshot);
  const history = createPublicHistory(historyRecords);
  const notificationHistory = createPublicNotificationHistory(
    historyRecords,
    input.repositoryAllowlist,
    input.repositoryInventory,
    snapshot.run.id,
    generatedAt,
  );
  const sourceOwnersById = createEvidenceSourceUrlMap(
    snapshot.items.flatMap((item) =>
      item.inputEvents.map((event) => ({
        ...event,
        itemNodeId: item.nodeId,
        itemUrl: item.url,
      })),
    ),
  );
  const evidenceBySourceId = createEvidenceBySourceId(snapshot);
  const effectiveStateByNodeId = snapshotEffectiveGraphStateByNodeId(snapshot);
  const graph = createPublicGraph(snapshot, effectiveStateByNodeId);
  const repositoriesById = new Map(
    snapshot.repositories.map((repository) => [repository.id, repository]),
  );
  const displayReferencesByNodeId = createDisplayReferencesByNodeId(snapshot);
  const currentImplementationsByIssueNodeId = createCurrentImplementationsByIssueNodeId(
    snapshot,
    repositoriesById,
    displayReferencesByNodeId,
  );
  const blockerLists = createBlockerLists(snapshot, effectiveStateByNodeId);
  const resolveLabelEffects = createLabelEffectsResolver(input.options.labelRules);
  const impactByNodeId = new Map(
    graph.analysis.downstreamImpacts.map((impact) => [impact.nodeId, impact]),
  );
  const itemSummaries = snapshot.items.map((item) => {
    const repository = repositoriesById.get(item.repositoryId);
    const impact = impactByNodeId.get(item.nodeId);
    assertNonNullable(repository, `item ${item.nodeId}のrepositoryがありません`);
    assertNonNullable(impact, `item ${item.nodeId}のdownstream impactがありません`);
    const personalReminderResponses = createPersonalReminderResponses(
      item,
      snapshot.items,
      sourceOwnersById,
      evidenceBySourceId,
    );
    return createItemSummary(
      item,
      repository,
      currentImplementationsByIssueNodeId.get(item.nodeId) ?? Object.freeze([]),
      personalReminderResponses.responses,
      personalReminderResponses.currentResponsesUnverified,
      personalReminderResponses.currentResponseSubjectChanges,
      personalReminderCausePlanningStatus(item),
      displayReferencesByNodeId,
      blockerLists.blockerNodeIdsByNodeId.get(item.nodeId) ?? Object.freeze([]),
      blockerLists.effectiveBlockerNodeIdsByNodeId.get(item.nodeId) ?? Object.freeze([]),
      blockerLists.retainedOnlyBlockerNodeIdsByNodeId.get(item.nodeId) ?? Object.freeze([]),
      impact,
      resolveLabelEffects(`${repository.owner}/${repository.name}`, item.labels).priorityWeight,
      snapshot.generatedAt,
      input.options.timezone,
    );
  });
  const repositories = snapshot.repositories.map((repository) => ({
    id: repository.id,
    name: repository.name,
    fullName: `${repository.owner}/${repository.name}`,
    freshness: {
      status: repository.freshness,
    },
  }));
  const summary = createPublicSummaryDto({
    schemaVersion: PUBLIC_DTO_SCHEMA_VERSION,
    runId: snapshot.run.id,
    generatedAt,
    observedAt: latestRepositoryObservedAt(snapshot.repositories),
    timezone: input.options.timezone,
    ai: {
      ...snapshot.ai,
    },
    confidenceThresholds: {
      ...input.options.confidenceThresholds,
    },
    repositories,
    items: itemSummaries,
    graph: createInitialGraph(graph, itemSummaries, input.options.maxInitialGraphNodes),
  });
  const details = createPublicDetailsDto({
    schemaVersion: PUBLIC_DTO_SCHEMA_VERSION,
    runId: snapshot.run.id,
    generatedAt,
    items: snapshot.items.map((item, index) => {
      const summaryItem = itemSummaries[index];
      assertNonNullable(summaryItem, `item ${item.nodeId}のsummaryがありません`);
      return {
        summary: summaryItem,
        blockerUnverifiedReasons: (
          blockerLists.blockerUnverifiedReasonsByNodeId.get(item.nodeId) ?? Object.freeze([])
        ).map((entry) => ({
          nodeId: entry.nodeId,
          reasons: [...entry.reasons],
        })),
        deadline: createPublicDeadlineDetails(
          item.deadlineAssessment,
          snapshot.generatedAt,
          input.options.timezone,
        ),
        importanceFactors: item.importance.factors.map((factor) => ({
          ...factor,
        })),
        timestamps: {
          createdAt: item.createdAt,
          githubUpdatedAt: item.githubUpdatedAt,
          stallSince: item.stallSince,
        },
        latestEventActor: createPublicLatestEventActor(item.latestEventActor),
        labels: [...item.labels],
        reviewState: item.reviewState,
        checkState: item.checkState,
        evidence: createPublicEvidence(item.evidence, item, snapshot.items, sourceOwnersById),
        uncertainties: [...item.uncertainties],
        history: [...(history.itemEventsByNodeId.get(item.nodeId) ?? [])],
      };
    }),
    graph: {
      nodes: graph.nodes,
      edges: graph.edges,
      frontierNodeIds: [...graph.analysis.actionableFrontier],
    },
  });
  assertPublicSummaryDetailsCurrentResponses(summary, details);
  const summarySize = assertPublicSummarySize(summary, input.options.maxSummaryGzipBytes);

  return Object.freeze({
    summary,
    details,
    notificationHistory,
    summarySize,
  });
}
