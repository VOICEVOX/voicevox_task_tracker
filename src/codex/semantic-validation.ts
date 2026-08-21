import {
  buildSourceId,
  createGitHubNodeId,
  isTerminalStatus,
  parseSourceId,
  validateDeadlineDate,
  type GitHubItemUrl,
  type SourceId,
} from "../domain/index.js";
import { type RelationAssessmentVerdict, type RelationCandidateId } from "../graph/index.js";
import { assertNonNullable } from "../util/index.js";
import { CodexOutputSemanticValidationError, type CodexOutputValidationIssue } from "./errors.js";
import { type CodexAnalysisInput } from "./input.js";
import {
  type SchemaValidCodexAnalysisOutput,
  type ValidatedCodexAnalysisOutput,
} from "./output-types.js";

const TARGET_ORGANIZATION = "VOICEVOX";
const URL_IN_TEXT_PATTERN = /https?:\/\/[^\s<>"']+/gu;
const URL_TRAILING_PUNCTUATION_PATTERN = /[),.;:!?、。！？）】]+$/u;

/** authoritative relationとCodex判定を比較するための制約。 */
export type NativeRelationConstraint = Readonly<{
  candidateId: string;
  verdict: RelationAssessmentVerdict;
}>;

type KnownSource = Readonly<{
  id: SourceId;
  occurredAt: number;
}>;

type TextField = Readonly<{
  path: string;
  value: string;
}>;

type NativeSignalDefinition = Readonly<{
  key: string;
  verdict: RelationAssessmentVerdict;
}>;

const nativeSignalDefinitions: readonly NativeSignalDefinition[] = Object.freeze([
  Object.freeze({
    key: "nativeBlockedBy",
    verdict: "current_is_blocked_by_target",
  }),
  Object.freeze({
    key: "nativeBlocking",
    verdict: "current_blocks_target",
  }),
  Object.freeze({
    key: "nativeParent",
    verdict: "current_is_subtask_of_target",
  }),
  Object.freeze({
    key: "nativeSubIssues",
    verdict: "target_is_subtask_of_current",
  }),
]);

function createIssue(path: string, code: string, message: string): CodexOutputValidationIssue {
  return Object.freeze({
    path,
    code,
    message,
  });
}

function createSourceId(value: string): SourceId {
  const parts = parseSourceId(value);
  return buildSourceId(parts.kind, parts.originalId);
}

function createRelationCandidateId(value: string): RelationCandidateId {
  if (!value.startsWith("rel:") || value.length === "rel:".length) {
    throw new TypeError("relation candidate IDはrel:で始めてください");
  }
  return `rel:${value.slice("rel:".length)}`;
}

function createGitHubItemUrl(value: string): GitHubItemUrl {
  const prefix = "https://github.com/";
  if (!value.startsWith(prefix) || value.length === prefix.length) {
    throw new TypeError("GitHub項目URLの形式が不正です");
  }
  return `https://github.com/${value.slice(prefix.length)}`;
}

function createKnownSources(input: CodexAnalysisInput): ReadonlyMap<string, KnownSource> {
  const sources = new Map<string, KnownSource>();
  for (const source of input.sources) {
    const occurredAt = Date.parse(source.createdAt);
    if (!Number.isFinite(occurredAt)) {
      throw new TypeError(`入力sourceの時刻が不正です。対象: ${source.id}`);
    }
    sources.set(
      source.id,
      Object.freeze({
        id: createSourceId(source.id),
        occurredAt,
      }),
    );
  }
  return sources;
}

function collectReferencedSourceIds(
  output: SchemaValidCodexAnalysisOutput,
): readonly Readonly<{ path: string; sourceId: string }>[] {
  const references: Readonly<{ path: string; sourceId: string }>[] = [];
  for (const [waitingOnIndex, waitingOn] of output.waitingOn.entries()) {
    for (const [sourceIndex, sourceId] of waitingOn.sourceIds.entries()) {
      references.push(
        Object.freeze({
          path: `/waitingOn/${waitingOnIndex.toString()}/sourceIds/${sourceIndex.toString()}`,
          sourceId,
        }),
      );
    }
  }
  for (const [relationIndex, relation] of output.relations.entries()) {
    for (const [sourceIndex, sourceId] of relation.sourceIds.entries()) {
      references.push(
        Object.freeze({
          path: `/relations/${relationIndex.toString()}/sourceIds/${sourceIndex.toString()}`,
          sourceId,
        }),
      );
    }
  }
  if (output.progress.latestMeaningfulSourceId != null) {
    references.push(
      Object.freeze({
        path: "/progress/latestMeaningfulSourceId",
        sourceId: output.progress.latestMeaningfulSourceId,
      }),
    );
  }
  for (const [evidenceIndex, evidence] of output.evidence.entries()) {
    references.push(
      Object.freeze({
        path: `/evidence/${evidenceIndex.toString()}/sourceId`,
        sourceId: evidence.sourceId,
      }),
    );
  }
  return Object.freeze(references);
}

function validateUniqueSourceIds(
  sourceIds: readonly string[],
  path: string,
  issues: CodexOutputValidationIssue[],
): void {
  const usedSourceIds = new Set<string>();
  for (const [index, sourceId] of sourceIds.entries()) {
    if (usedSourceIds.has(sourceId)) {
      issues.push(
        createIssue(
          `${path}/${index.toString()}`,
          "duplicate_source_id",
          "source IDが重複しています",
        ),
      );
    }
    usedSourceIds.add(sourceId);
  }
}

function validateSourceIdUniqueness(
  output: SchemaValidCodexAnalysisOutput,
  issues: CodexOutputValidationIssue[],
): void {
  for (const [index, waitingOn] of output.waitingOn.entries()) {
    validateUniqueSourceIds(
      waitingOn.sourceIds,
      `/waitingOn/${index.toString()}/sourceIds`,
      issues,
    );
  }
  for (const [index, relation] of output.relations.entries()) {
    validateUniqueSourceIds(relation.sourceIds, `/relations/${index.toString()}/sourceIds`, issues);
  }
}

function collectInputStrings(value: unknown, strings: Set<string>): void {
  if (typeof value === "string") {
    strings.add(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      collectInputStrings(entry, strings);
    }
    return;
  }
  if (typeof value !== "object" || value == null) {
    return;
  }
  for (const entry of Object.values(value)) {
    collectInputStrings(entry, strings);
  }
}

function validateSourceReferences(
  output: SchemaValidCodexAnalysisOutput,
  input: CodexAnalysisInput,
  knownSources: ReadonlyMap<string, KnownSource>,
  issues: CodexOutputValidationIssue[],
): void {
  const evaluatedAt = Date.parse(input.now);
  if (!Number.isFinite(evaluatedAt)) {
    throw new TypeError("Codex入力の判定時刻が不正です");
  }
  let inputStrings: ReadonlySet<string> | undefined;

  for (const reference of collectReferencedSourceIds(output)) {
    const source = knownSources.get(reference.sourceId);
    if (source == null) {
      if (inputStrings == null) {
        const collectedInputStrings = new Set<string>();
        collectInputStrings(input, collectedInputStrings);
        inputStrings = collectedInputStrings;
      }
      const sourceIdAppearsInInput = inputStrings.has(reference.sourceId);
      issues.push(
        createIssue(
          reference.path,
          sourceIdAppearsInInput
            ? "unknown_source_id_present_in_input"
            : "unknown_source_id_absent_from_input",
          sourceIdAppearsInInput
            ? "sourcesには存在せず入力の別領域にあるsource IDを参照しています"
            : "入力に一度も現れないsource IDを参照しています",
        ),
      );
      continue;
    }
    if (source.occurredAt > evaluatedAt) {
      issues.push(
        createIssue(
          reference.path,
          "source_time_out_of_range",
          "参照したsourceの時刻が入力の判定時刻より後です",
        ),
      );
    }
  }
}

function validateWaitingOnCandidates(
  output: SchemaValidCodexAnalysisOutput,
  input: CodexAnalysisInput,
  issues: CodexOutputValidationIssue[],
): void {
  const candidateIds = new Set(input.candidates.waitingOn.map((candidate) => candidate.id));
  const usedCandidateIds = new Set<string>();
  for (const [index, waitingOn] of output.waitingOn.entries()) {
    const path = `/waitingOn/${index.toString()}/candidateId`;
    if (!candidateIds.has(waitingOn.candidateId)) {
      issues.push(
        createIssue(
          path,
          "unknown_waiting_on_candidate",
          "入力のwaitingOn候補集合にない対象を参照しています",
        ),
      );
    }
    if (usedCandidateIds.has(waitingOn.candidateId)) {
      issues.push(
        createIssue(path, "duplicate_waiting_on_candidate", "waitingOn候補が重複しています"),
      );
    }
    usedCandidateIds.add(waitingOn.candidateId);

    const candidateKind = waitingOn.candidateId.split(":").at(0);
    if (
      candidateKind != null &&
      ["user", "team", "role", "item", "automation", "unknown"].includes(candidateKind) &&
      candidateKind !== waitingOn.kind
    ) {
      issues.push(
        createIssue(
          `/waitingOn/${index.toString()}/kind`,
          "waiting_on_kind_mismatch",
          "candidate IDの種別とwaitingOnの種別が一致しません",
        ),
      );
    }
  }
}

function validateRelationCandidates(
  output: SchemaValidCodexAnalysisOutput,
  input: CodexAnalysisInput,
  issues: CodexOutputValidationIssue[],
): void {
  const candidateIds = new Set(input.candidates.relations.map((candidate) => candidate.id));
  const verdictCounts = new Map<string, number>();

  for (const [index, relation] of output.relations.entries()) {
    const path = `/relations/${index.toString()}/candidateId`;
    if (!candidateIds.has(relation.candidateId)) {
      issues.push(
        createIssue(
          path,
          "unknown_relation_candidate",
          "入力のrelation候補集合にない対象を参照しています",
        ),
      );
    }
    verdictCounts.set(relation.candidateId, (verdictCounts.get(relation.candidateId) ?? 0) + 1);
  }

  for (const candidateId of candidateIds) {
    const count = verdictCounts.get(candidateId) ?? 0;
    if (count === 0) {
      issues.push(
        createIssue(
          "/relations",
          "missing_relation_verdict",
          `relation候補のverdictがありません。対象: ${candidateId}`,
        ),
      );
    } else if (count > 1) {
      issues.push(
        createIssue(
          "/relations",
          "duplicate_relation_verdict",
          `relation候補のverdictが重複しています。対象: ${candidateId}`,
        ),
      );
    }
  }
}

function normalizedUrl(value: string): string | null {
  try {
    const url = new URL(value);
    url.hash = "";
    const normalized = url.toString();
    return normalized.endsWith("/") ? normalized.slice(0, -1) : normalized;
  } catch (error: unknown) {
    if (!(error instanceof TypeError)) {
      throw error;
    }
    return null;
  }
}

function organizationFromUrl(value: string): string | null {
  const normalized = normalizedUrl(value);
  if (normalized == null) {
    return null;
  }
  const url = new URL(normalized);
  if (url.protocol !== "https:" || url.hostname.toLowerCase() !== "github.com") {
    return null;
  }
  const organization = url.pathname.split("/").find((segment) => segment.length > 0);
  return organization ?? null;
}

function collectTextFields(output: SchemaValidCodexAnalysisOutput): readonly TextField[] {
  const fields: TextField[] = [
    Object.freeze({
      path: "/nextAction",
      value: output.nextAction,
    }),
    Object.freeze({
      path: "/progress/reasonSummary",
      value: output.progress.reasonSummary,
    }),
    Object.freeze({
      path: "/importance/rationale",
      value: output.importance.rationale,
    }),
    Object.freeze({
      path: "/deadline/rationale",
      value: output.deadline.rationale,
    }),
    Object.freeze({
      path: "/notification/reasonSummary",
      value: output.notification.reasonSummary,
    }),
  ];
  for (const [index, waitingOn] of output.waitingOn.entries()) {
    fields.push(
      Object.freeze({
        path: `/waitingOn/${index.toString()}/reasonSummary`,
        value: waitingOn.reasonSummary,
      }),
    );
  }
  for (const [index, relation] of output.relations.entries()) {
    fields.push(
      Object.freeze({
        path: `/relations/${index.toString()}/reasonSummary`,
        value: relation.reasonSummary,
      }),
    );
  }
  for (const [index, evidence] of output.evidence.entries()) {
    fields.push(
      Object.freeze({
        path: `/evidence/${index.toString()}/summary`,
        value: evidence.summary,
      }),
    );
  }
  for (const [index, uncertainty] of output.uncertainties.entries()) {
    fields.push(
      Object.freeze({
        path: `/uncertainties/${index.toString()}`,
        value: uncertainty,
      }),
    );
  }
  return Object.freeze(fields);
}

function validateUrls(
  output: SchemaValidCodexAnalysisOutput,
  input: CodexAnalysisInput,
  issues: CodexOutputValidationIssue[],
): void {
  if (organizationFromUrl(input.item.url)?.toLowerCase() !== TARGET_ORGANIZATION.toLowerCase()) {
    throw new TypeError("Codex入力の対象項目がVOICEVOX Organization内ではありません");
  }
  if (output.item.url !== input.item.url) {
    issues.push(
      createIssue(
        "/item/url",
        "item_url_mismatch",
        "Codex出力の項目URLが入力の対象項目と一致しません",
      ),
    );
  }

  const allowedExternalUrls = new Set(
    input.candidates.relations
      .map((candidate) => normalizedUrl(candidate.targetUrl))
      .filter((url): url is string => url != null),
  );
  allowedExternalUrls.add(input.item.url);

  for (const field of collectTextFields(output)) {
    for (const match of field.value.matchAll(URL_IN_TEXT_PATTERN)) {
      const rawUrl = match[0].replace(URL_TRAILING_PUNCTUATION_PATTERN, "");
      const normalized = normalizedUrl(rawUrl);
      const organization = organizationFromUrl(rawUrl);
      if (
        normalized == null ||
        (organization?.toLowerCase() !== TARGET_ORGANIZATION.toLowerCase() &&
          !allowedExternalUrls.has(normalized))
      ) {
        issues.push(
          createIssue(
            field.path,
            "url_not_allowed",
            "URLは対象Organizationまたは入力で許可された外部候補を指してください",
          ),
        );
      }
    }
  }
}

function validateItemIdentity(
  output: SchemaValidCodexAnalysisOutput,
  input: CodexAnalysisInput,
  issues: CodexOutputValidationIssue[],
): void {
  if (output.item.nodeId !== input.item.nodeId) {
    issues.push(
      createIssue(
        "/item/nodeId",
        "item_node_id_mismatch",
        "Codex出力のnode IDが入力の対象項目と一致しません",
      ),
    );
  }
}

function validateStatusAndWaitingOn(
  output: SchemaValidCodexAnalysisOutput,
  issues: CodexOutputValidationIssue[],
): void {
  if (isTerminalStatus(output.status) && output.waitingOn.length !== 0) {
    issues.push(
      createIssue("/waitingOn", "terminal_waiting_on", "terminal状態にwaitingOnを設定できません"),
    );
  }
  if (!isTerminalStatus(output.status) && output.waitingOn.length === 0) {
    issues.push(
      createIssue(
        "/waitingOn",
        "non_terminal_without_waiting_on",
        "継続中の状態にはwaitingOnが1件以上必要です",
      ),
    );
  }
}

function validateDeadline(
  output: SchemaValidCodexAnalysisOutput,
  issues: CodexOutputValidationIssue[],
): void {
  try {
    validateDeadlineDate(output.deadline.date, "期限日");
  } catch (error: unknown) {
    if (!(error instanceof RangeError)) {
      throw error;
    }
    issues.push(
      createIssue(
        "/deadline/date",
        "invalid_deadline_date",
        "期限日は実在するYYYY-MM-DD形式の日付またはnullを指定してください",
      ),
    );
  }
}

function signalCandidateIds(input: CodexAnalysisInput, key: string): readonly string[] {
  const value = input.deterministicSignals[key];
  if (value == null) {
    return Object.freeze([]);
  }
  if (!Array.isArray(value) || !value.every((candidateId) => typeof candidateId === "string")) {
    throw new TypeError(`deterministicSignals.${key}はcandidate IDの配列にしてください`);
  }
  return Object.freeze([...value]);
}

/** Codex入力に含まれるnative relationのauthoritativeな向きを列挙する。 */
export function listNativeRelationConstraints(
  input: CodexAnalysisInput,
): readonly NativeRelationConstraint[] {
  const constraints = new Map<string, NativeRelationConstraint>();
  for (const definition of nativeSignalDefinitions) {
    for (const candidateId of signalCandidateIds(input, definition.key)) {
      const existing = constraints.get(candidateId);
      if (existing != null && existing.verdict !== definition.verdict) {
        throw new TypeError(`native relation ${candidateId}の向きが複数指定されています`);
      }
      constraints.set(
        candidateId,
        Object.freeze({
          candidateId,
          verdict: definition.verdict,
        }),
      );
    }
  }
  return Object.freeze([...constraints.values()]);
}

function validateNativeRelationReferences(
  input: CodexAnalysisInput,
  issues: CodexOutputValidationIssue[],
): void {
  const relationCandidateIds = new Set(input.candidates.relations.map((candidate) => candidate.id));
  for (const constraint of listNativeRelationConstraints(input)) {
    if (!relationCandidateIds.has(constraint.candidateId)) {
      issues.push(
        createIssue(
          "/relations",
          "unknown_native_relation",
          `native relationがrelation候補集合にありません。対象: ${constraint.candidateId}`,
        ),
      );
    }
  }
}

function knownSourceId(sourceIds: ReadonlyMap<string, KnownSource>, value: string): SourceId {
  const source = sourceIds.get(value);
  assertNonNullable(source, `検証済みのsource IDを取得できません。対象: ${value}`);
  return source.id;
}

function createSourceIdTuple(
  sourceIds: ReadonlyMap<string, KnownSource>,
  values: readonly string[],
): readonly [SourceId, ...SourceId[]] {
  const [firstValue, ...remainingValues] = values;
  assertNonNullable(firstValue, "source IDが1件もありません");
  return Object.freeze([
    knownSourceId(sourceIds, firstValue),
    ...remainingValues.map((value) => knownSourceId(sourceIds, value)),
  ]);
}

function createValidatedOutput(
  output: SchemaValidCodexAnalysisOutput,
  sources: ReadonlyMap<string, KnownSource>,
): ValidatedCodexAnalysisOutput {
  return Object.freeze({
    schemaVersion: output.schemaVersion,
    item: Object.freeze({
      nodeId: createGitHubNodeId(output.item.nodeId),
      url: createGitHubItemUrl(output.item.url),
    }),
    status: output.status,
    waitingOn: Object.freeze(
      output.waitingOn.map((waitingOn) =>
        Object.freeze({
          kind: waitingOn.kind,
          candidateId: waitingOn.candidateId,
          role: waitingOn.role,
          reasonSummary: waitingOn.reasonSummary,
          sourceIds: createSourceIdTuple(sources, waitingOn.sourceIds),
          confidence: waitingOn.confidence,
        }),
      ),
    ),
    nextAction: output.nextAction,
    relations: Object.freeze(
      output.relations.map((relation) =>
        Object.freeze({
          candidateId: createRelationCandidateId(relation.candidateId),
          verdict: relation.verdict,
          reasonSummary: relation.reasonSummary,
          sourceIds: createSourceIdTuple(sources, relation.sourceIds),
          confidence: relation.confidence,
        }),
      ),
    ),
    progress: Object.freeze({
      latestMeaningfulSourceId:
        output.progress.latestMeaningfulSourceId == null
          ? null
          : knownSourceId(sources, output.progress.latestMeaningfulSourceId),
      reasonSummary: output.progress.reasonSummary,
      confidence: output.progress.confidence,
    }),
    importance: Object.freeze({
      significantFeature: output.importance.significantFeature,
      futureRisk: output.importance.futureRisk,
      rationale: output.importance.rationale,
    }),
    deadline: Object.freeze({
      date: output.deadline.date,
      rationale: output.deadline.rationale,
    }),
    evidence: Object.freeze(
      output.evidence.map((evidence) =>
        Object.freeze({
          sourceId: knownSourceId(sources, evidence.sourceId),
          supports: evidence.supports,
          summary: evidence.summary,
        }),
      ),
    ),
    confidence: output.confidence,
    uncertainties: Object.freeze([...output.uncertainties]),
    notification: Object.freeze({
      recommended: output.notification.recommended,
      reasonCode: output.notification.reasonCode,
      reasonSummary: output.notification.reasonSummary,
    }),
  });
}

/** schema検証済みのCodex出力を入力候補とsourceの範囲でsemantic検証する。 */
export function validateCodexAnalysisSemantics(
  output: SchemaValidCodexAnalysisOutput,
  input: CodexAnalysisInput,
): ValidatedCodexAnalysisOutput {
  const validatedInput = input;
  const knownSources = createKnownSources(validatedInput);
  const issues: CodexOutputValidationIssue[] = [];

  validateItemIdentity(output, validatedInput, issues);
  validateStatusAndWaitingOn(output, issues);
  validateDeadline(output, issues);
  validateWaitingOnCandidates(output, validatedInput, issues);
  validateRelationCandidates(output, validatedInput, issues);
  validateSourceIdUniqueness(output, issues);
  validateSourceReferences(output, validatedInput, knownSources, issues);
  validateUrls(output, validatedInput, issues);
  validateNativeRelationReferences(validatedInput, issues);

  if (issues.length > 0) {
    throw new CodexOutputSemanticValidationError(issues);
  }
  return createValidatedOutput(output, knownSources);
}
