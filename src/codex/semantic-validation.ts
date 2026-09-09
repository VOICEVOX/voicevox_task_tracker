import {
  buildSourceId,
  isTerminalStatus,
  parseSourceId,
  validateDeadlineDate,
  type SourceId,
} from "../domain/index.js";
import type {
  AiAnalysisElement,
  AiAnalysisElementMigrationResult,
  AiAnalysisRelation,
  AiAnalysisWaitingOn,
} from "../domain/ai-analysis-elements.js";
import type { RelationAssessmentVerdict } from "../graph/index.js";
import { CodexOutputSemanticValidationError, type CodexOutputValidationIssue } from "./errors.js";
import { type CodexAnalysisInput } from "./input.js";
import {
  validateCodexElementOutput,
  type SchemaValidCodexElementOutput,
} from "./element-output.js";

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

type SourceReference = Readonly<{
  path: string;
  sourceId: string;
}>;

/** 入力へ対応するsemantic検証済みの要素別Codex出力。 */
export type CodexElementOutput = SchemaValidCodexElementOutput;

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

function addResultEvidence(
  result: Pick<AiAnalysisElementMigrationResult, "evidence">,
  path: string,
  references: SourceReference[],
): void {
  for (const [index, evidence] of result.evidence.entries()) {
    references.push(
      Object.freeze({
        path: `${path}/evidence/${index.toString()}/sourceId`,
        sourceId: evidence.sourceId,
      }),
    );
  }
}

function collectReferencedSourceIds(
  output: SchemaValidCodexElementOutput,
): readonly SourceReference[] {
  const references: SourceReference[] = [];
  if (output.status != null) {
    addResultEvidence(output.status, "/status", references);
  }

  if (output.waitingOn != null) {
    addResultEvidence(output.waitingOn, "/waitingOn", references);
    for (const [index, candidate] of output.waitingOn.value.entries()) {
      for (const [sourceIndex, sourceId] of candidate.sourceIds.entries()) {
        references.push(
          Object.freeze({
            path: `/waitingOn/value/${index.toString()}/sourceIds/${sourceIndex.toString()}`,
            sourceId,
          }),
        );
      }
    }
  }

  if (output.nextAction != null) {
    addResultEvidence(output.nextAction, "/nextAction", references);
  }

  if (output.relations != null) {
    addResultEvidence(output.relations, "/relations", references);
    for (const [index, candidate] of output.relations.value.entries()) {
      for (const [sourceIndex, sourceId] of candidate.sourceIds.entries()) {
        references.push(
          Object.freeze({
            path: `/relations/value/${index.toString()}/sourceIds/${sourceIndex.toString()}`,
            sourceId,
          }),
        );
      }
    }
  }

  if (output.progress != null) {
    addResultEvidence(output.progress, "/progress", references);
    if (output.progress.value.latestMeaningfulSourceId != null) {
      references.push(
        Object.freeze({
          path: "/progress/value/latestMeaningfulSourceId",
          sourceId: output.progress.value.latestMeaningfulSourceId,
        }),
      );
    }
  }

  if (output.importance != null) {
    addResultEvidence(output.importance, "/importance", references);
  }

  if (output.deadline != null) {
    addResultEvidence(output.deadline, "/deadline", references);
  }

  if (output.notification != null) {
    addResultEvidence(output.notification, "/notification", references);
  }
  return Object.freeze(references);
}

function validateSourceReferences(
  output: SchemaValidCodexElementOutput,
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

function validateResultSourceIdUniqueness(
  output: SchemaValidCodexElementOutput,
  issues: CodexOutputValidationIssue[],
): void {
  if (output.waitingOn != null) {
    for (const [index, candidate] of output.waitingOn.value.entries()) {
      validateUniqueSourceIds(
        candidate.sourceIds,
        `/waitingOn/value/${index.toString()}/sourceIds`,
        issues,
      );
    }
  }
  if (output.relations != null) {
    for (const [index, candidate] of output.relations.value.entries()) {
      validateUniqueSourceIds(
        candidate.sourceIds,
        `/relations/value/${index.toString()}/sourceIds`,
        issues,
      );
    }
  }
}

function validateNoSelfCommitmentEvidence(
  result: Pick<AiAnalysisElementMigrationResult, "evidence"> | undefined,
  path: string,
  issues: CodexOutputValidationIssue[],
): void {
  if (result == null) {
    return;
  }
  for (const [index, evidence] of result.evidence.entries()) {
    if (evidence.supports === "self_commitment") {
      issues.push(
        createIssue(
          `${path}/evidence/${index.toString()}/supports`,
          "self_commitment_wrong_element",
          "self_commitmentの根拠はwaitingOn要素にだけ指定できます",
        ),
      );
    }
  }
}

function validateSelfCommitmentEvidence(
  output: SchemaValidCodexElementOutput,
  input: CodexAnalysisInput,
  issues: CodexOutputValidationIssue[],
): void {
  validateNoSelfCommitmentEvidence(output.status, "/status", issues);
  validateNoSelfCommitmentEvidence(output.nextAction, "/nextAction", issues);
  validateNoSelfCommitmentEvidence(output.relations, "/relations", issues);
  validateNoSelfCommitmentEvidence(output.progress, "/progress", issues);
  validateNoSelfCommitmentEvidence(output.importance, "/importance", issues);
  validateNoSelfCommitmentEvidence(output.deadline, "/deadline", issues);
  validateNoSelfCommitmentEvidence(output.notification, "/notification", issues);

  const waitingOn = output.waitingOn;
  if (waitingOn == null) {
    return;
  }
  for (const [index, evidence] of waitingOn.evidence.entries()) {
    if (evidence.supports !== "self_commitment") {
      continue;
    }
    const evidencePath = `/waitingOn/evidence/${index.toString()}`;
    const source = input.sources.find((candidate) => candidate.id === evidence.sourceId);
    if (source == null) {
      continue;
    }
    if (source.kind !== "comment") {
      issues.push(
        createIssue(
          `${evidencePath}/supports`,
          "self_commitment_source_kind",
          "self_commitmentの根拠はcomment sourceにだけ指定できます",
        ),
      );
    }
    if (source.actorType !== "human") {
      issues.push(
        createIssue(
          `${evidencePath}/supports`,
          "self_commitment_source_actor",
          "self_commitmentの根拠はhuman sourceにだけ指定できます",
        ),
      );
    }
    if (source.author.status !== "identified") {
      issues.push(
        createIssue(
          `${evidencePath}/supports`,
          "self_commitment_author_unavailable",
          "self_commitmentの根拠には識別済みのcomment authorが必要です",
        ),
      );
      continue;
    }
    if (waitingOn.value.length !== 1) {
      issues.push(
        createIssue(
          "/waitingOn/value",
          "self_commitment_multiple_waiting_on",
          "self_commitmentの根拠には唯一のwaitingOn候補が必要です",
        ),
      );
      continue;
    }
    const [waitingCandidate] = waitingOn.value;
    if (waitingCandidate == null) {
      throw new TypeError("self_commitmentのwaitingOn候補がありません");
    }
    if (waitingCandidate.kind !== "user") {
      issues.push(
        createIssue(
          "/waitingOn/value/0/kind",
          "self_commitment_waiting_on_kind",
          "self_commitmentの根拠にはuserのwaitingOn候補が必要です",
        ),
      );
    }
    if (waitingCandidate.candidateId !== source.author.candidateId) {
      issues.push(
        createIssue(
          "/waitingOn/value/0/candidateId",
          "self_commitment_author_mismatch",
          "self_commitmentの根拠のauthorとwaitingOn候補が一致しません",
        ),
      );
    }
    if (!waitingCandidate.sourceIds.includes(evidence.sourceId)) {
      issues.push(
        createIssue(
          "/waitingOn/value/0/sourceIds",
          "self_commitment_source_unlinked",
          "self_commitmentの根拠sourceがwaitingOn候補へ結び付いていません",
        ),
      );
    }
  }
}

function validateWaitingOnCandidates(
  values: readonly Pick<AiAnalysisWaitingOn, "kind" | "candidateId">[],
  input: CodexAnalysisInput,
  path: string,
  issues: CodexOutputValidationIssue[],
): void {
  const candidateIds = new Set(input.candidates.waitingOn.map((candidate) => candidate.id));
  const usedCandidateIds = new Set<string>();
  for (const [index, waitingOn] of values.entries()) {
    const candidatePath = `${path}/value/${index.toString()}/candidateId`;
    if (!candidateIds.has(waitingOn.candidateId)) {
      issues.push(
        createIssue(
          candidatePath,
          "unknown_waiting_on_candidate",
          "入力のwaitingOn候補集合にない対象を参照しています",
        ),
      );
    }
    if (usedCandidateIds.has(waitingOn.candidateId)) {
      issues.push(
        createIssue(
          candidatePath,
          "duplicate_waiting_on_candidate",
          "waitingOn候補が重複しています",
        ),
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
          `${path}/value/${index.toString()}/kind`,
          "waiting_on_kind_mismatch",
          "candidate IDの種別とwaitingOnの種別が一致しません",
        ),
      );
    }
  }
}

function validateRelationCandidates(
  values: readonly Pick<AiAnalysisRelation, "candidateId" | "verdict">[],
  input: CodexAnalysisInput,
  path: string,
  requireComplete: boolean,
  issues: CodexOutputValidationIssue[],
): void {
  const candidateIds = new Set(input.candidates.relations.map((candidate) => candidate.id));
  const verdictCounts = new Map<string, number>();

  for (const [index, relation] of values.entries()) {
    const relationPath = `${path}/value/${index.toString()}/candidateId`;
    if (!candidateIds.has(relation.candidateId)) {
      issues.push(
        createIssue(
          relationPath,
          "unknown_relation_candidate",
          "入力のrelation候補集合にない対象を参照しています",
        ),
      );
    }
    verdictCounts.set(relation.candidateId, (verdictCounts.get(relation.candidateId) ?? 0) + 1);
  }

  if (!requireComplete) {
    return;
  }
  for (const candidateId of candidateIds) {
    const count = verdictCounts.get(candidateId) ?? 0;
    if (count === 0) {
      issues.push(
        createIssue(
          `${path}/value`,
          "missing_relation_verdict",
          `relation候補のverdictがありません。対象: ${candidateId}`,
        ),
      );
    } else if (count > 1) {
      issues.push(
        createIssue(
          `${path}/value`,
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

function resultPath(output: SchemaValidCodexElementOutput, element: AiAnalysisElement): string {
  return Object.hasOwn(output, element) ? `/${element}` : `/lockedElements/${element}`;
}

type TextResult = Readonly<{
  evidence?: readonly Readonly<{ summary: string }>[];
  uncertainties: readonly string[];
}>;

function appendCommonTextFields(result: TextResult, path: string, fields: TextField[]): void {
  if (result.evidence != null) {
    for (const [index, evidence] of result.evidence.entries()) {
      fields.push(
        Object.freeze({
          path: `${path}/evidence/${index.toString()}/summary`,
          value: evidence.summary,
        }),
      );
    }
  }
  for (const [index, uncertainty] of result.uncertainties.entries()) {
    fields.push(
      Object.freeze({
        path: `${path}/uncertainties/${index.toString()}`,
        value: uncertainty,
      }),
    );
  }
}

function collectTextFields(
  output: SchemaValidCodexElementOutput,
  input: CodexAnalysisInput,
): readonly TextField[] {
  const fields: TextField[] = [];
  const nextAction = output.nextAction ?? input.lockedElements.nextAction;
  if (nextAction != null) {
    const path = resultPath(output, "nextAction");
    fields.push(Object.freeze({ path: `${path}/value`, value: nextAction.value }));
    appendCommonTextFields(nextAction, path, fields);
  }
  const waitingOn = output.waitingOn ?? input.lockedElements.waitingOn;
  if (waitingOn != null) {
    const path = resultPath(output, "waitingOn");
    for (const [index, candidate] of waitingOn.value.entries()) {
      fields.push(
        Object.freeze({
          path: `${path}/value/${index.toString()}/reasonSummary`,
          value: candidate.reasonSummary,
        }),
      );
    }
    appendCommonTextFields(waitingOn, path, fields);
  }
  const relations = output.relations ?? input.lockedElements.relations;
  if (relations != null) {
    const path = resultPath(output, "relations");
    for (const [index, candidate] of relations.value.entries()) {
      fields.push(
        Object.freeze({
          path: `${path}/value/${index.toString()}/reasonSummary`,
          value: candidate.reasonSummary,
        }),
      );
    }
    appendCommonTextFields(relations, path, fields);
  }
  const progress = output.progress ?? input.lockedElements.progress;
  if (progress != null) {
    const path = resultPath(output, "progress");
    fields.push(
      Object.freeze({
        path: `${path}/value/reasonSummary`,
        value: progress.value.reasonSummary,
      }),
    );
    appendCommonTextFields(progress, path, fields);
  }
  const importance = output.importance ?? input.lockedElements.importance;
  if (importance != null) {
    const path = resultPath(output, "importance");
    fields.push(
      Object.freeze({ path: `${path}/value/rationale`, value: importance.value.rationale }),
    );
    appendCommonTextFields(importance, path, fields);
  }
  const deadline = output.deadline ?? input.lockedElements.deadline;
  if (deadline != null) {
    const path = resultPath(output, "deadline");
    fields.push(
      Object.freeze({ path: `${path}/value/rationale`, value: deadline.value.rationale }),
    );
    appendCommonTextFields(deadline, path, fields);
  }
  const notification = output.notification ?? input.lockedElements.notification;
  if (notification != null) {
    const path = resultPath(output, "notification");
    fields.push(
      Object.freeze({
        path: `${path}/value/reasonSummary`,
        value: notification.value.reasonSummary,
      }),
    );
    appendCommonTextFields(notification, path, fields);
  }
  const status = output.status ?? input.lockedElements.status;
  if (status != null) {
    appendCommonTextFields(status, resultPath(output, "status"), fields);
  }
  return Object.freeze(fields);
}

function validateUrls(
  output: SchemaValidCodexElementOutput,
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

  for (const field of collectTextFields(output, input)) {
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
  output: SchemaValidCodexElementOutput,
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
  output: SchemaValidCodexElementOutput,
  input: CodexAnalysisInput,
  issues: CodexOutputValidationIssue[],
): void {
  const status = output.status ?? input.lockedElements.status;
  const waitingOn = output.waitingOn ?? input.lockedElements.waitingOn;
  if (status == null || waitingOn == null) {
    return;
  }
  const path = output.waitingOn == null ? "/lockedElements/waitingOn" : "/waitingOn";
  if (isTerminalStatus(status.value) && waitingOn.value.length !== 0) {
    issues.push(
      createIssue(path, "terminal_waiting_on", "terminal状態にwaitingOnを設定できません"),
    );
  }
  if (!isTerminalStatus(status.value) && waitingOn.value.length === 0) {
    issues.push(
      createIssue(
        path,
        "non_terminal_without_waiting_on",
        "継続中の状態にはwaitingOnが1件以上必要です",
      ),
    );
  }
}

function validateDeadline(
  output: SchemaValidCodexElementOutput,
  input: CodexAnalysisInput,
  issues: CodexOutputValidationIssue[],
): void {
  const deadline = output.deadline ?? input.lockedElements.deadline;
  if (deadline == null) {
    return;
  }
  try {
    validateDeadlineDate(deadline.value.date, "期限日");
  } catch (error: unknown) {
    if (!(error instanceof RangeError)) {
      throw error;
    }
    issues.push(
      createIssue(
        `${resultPath(output, "deadline")}/value/date`,
        "invalid_deadline_date",
        "期限日は実在するYYYY-MM-DD形式の実在日付またはnullを指定してください",
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

/** schema検証済みのCodex出力を入力候補とsourceの範囲でsemantic検証する。 */
export function validateCodexAnalysisSemantics(
  value: unknown,
  input: CodexAnalysisInput,
): SchemaValidCodexElementOutput {
  const output = validateCodexElementOutput(value, input.selectedElements);
  const knownSources = createKnownSources(input);
  const issues: CodexOutputValidationIssue[] = [];

  validateItemIdentity(output, input, issues);
  validateStatusAndWaitingOn(output, input, issues);
  validateDeadline(output, input, issues);

  const waitingOn = output.waitingOn ?? input.lockedElements.waitingOn;
  if (waitingOn != null) {
    validateWaitingOnCandidates(waitingOn.value, input, resultPath(output, "waitingOn"), issues);
  }
  const relations = output.relations ?? input.lockedElements.relations;
  if (relations != null) {
    validateRelationCandidates(
      relations.value,
      input,
      resultPath(output, "relations"),
      output.relations != null,
      issues,
    );
  }
  validateResultSourceIdUniqueness(output, issues);
  validateSelfCommitmentEvidence(output, input, issues);
  validateSourceReferences(output, input, knownSources, issues);
  validateUrls(output, input, issues);
  validateNativeRelationReferences(input, issues);

  if (issues.length > 0) {
    throw new CodexOutputSemanticValidationError(issues);
  }
  return output;
}
