import {
  personalReminderCauseAssessmentSchema,
  type PersonalReminderCauseAssessment,
  type PersonalReminderResponsible,
} from "../domain/personal-reminder-causes.js";
import { type AiAnalysisElementInputFingerprint } from "../domain/ai-analysis-elements.js";
import { assertNonNullable } from "../util/index.js";
import {
  type PersonalReminderAiInput,
  type PersonalReminderCauseSemanticInput,
  type PreparedPersonalReminderAiBatch,
} from "./personal-reminder-input.js";
import {
  type PersonalReminderRawAssessment,
  type PersonalReminderRawReferences,
  type SchemaValidPersonalReminderAiOutput,
} from "./personal-reminder-output.js";

/** 個人催促AIのcause単位semantic問題。 */
export type PersonalReminderCauseSemanticIssue = Readonly<{
  path: string;
  code: string;
  message: string;
}>;

/** 個人催促AIのcause単位semantic検証結果。 */
export type PersonalReminderCauseSemanticValidation = Readonly<{
  accepted: readonly Readonly<{
    causeId: PersonalReminderCauseSemanticInput["cause"]["causeId"];
    inputFingerprint: AiAnalysisElementInputFingerprint;
    assessment: PersonalReminderCauseAssessment;
  }>[];
  rejected: readonly Readonly<{
    causeId: PersonalReminderCauseSemanticInput["cause"]["causeId"];
    issues: readonly PersonalReminderCauseSemanticIssue[];
  }>[];
  unexpected: readonly Readonly<{
    outputIndex: number;
    causeId: string;
  }>[];
}>;

type CanonicalReferences = Readonly<{
  nodeIds: readonly string[];
  relationIds: readonly string[];
  sourceIds: readonly string[];
  reasonSummary: string;
}>;

type CauseInput = PersonalReminderAiInput["causes"][number];

function issue(path: string, code: string, message: string): PersonalReminderCauseSemanticIssue {
  return Object.freeze({ path, code, message });
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

function uniqueSorted(values: readonly string[]): readonly string[] {
  const sorted = [...values].sort(compareStrings);
  const result: string[] = [];
  for (const value of sorted) {
    if (result.at(-1) !== value) {
      result.push(value);
    }
  }
  return Object.freeze(result);
}

function validateMinimumConfidence(minimumConfidence: number): void {
  if (!Number.isFinite(minimumConfidence) || minimumConfidence < 0 || minimumConfidence > 1) {
    throw new RangeError("個人催促AIのminimumConfidenceは0以上1以下にしてください");
  }
}

function validateUniqueRefs(
  values: readonly string[],
  path: string,
  issues: PersonalReminderCauseSemanticIssue[],
): void {
  const seen = new Set<string>();
  for (const [index, value] of values.entries()) {
    if (seen.has(value)) {
      issues.push(
        issue(`${path}/${index.toString()}`, "duplicate_reference", "同じ参照が重複しています"),
      );
    }
    seen.add(value);
  }
}

function canonicalizeReferences(
  references: PersonalReminderRawReferences,
  causeInput: CauseInput,
  batch: PreparedPersonalReminderAiBatch,
  path: string,
  issues: PersonalReminderCauseSemanticIssue[],
): CanonicalReferences | undefined {
  const allowedItemRefs = new Set<string>(causeInput.itemRefs);
  const allowedRelationRefs = new Set<string>(causeInput.relationRefs);
  const allowedSourceRefs = new Set<string>(causeInput.sourceRefs);
  validateUniqueRefs(references.itemRefs, `${path}/itemRefs`, issues);
  validateUniqueRefs(references.relationRefs, `${path}/relationRefs`, issues);
  validateUniqueRefs(references.sourceRefs, `${path}/sourceRefs`, issues);
  for (const ref of references.itemRefs) {
    if (!allowedItemRefs.has(ref)) {
      issues.push(
        issue(
          `${path}/itemRefs`,
          "reference_not_allowed",
          `原因へ許可されたitem refではありません: ${ref}`,
        ),
      );
    }
  }
  for (const ref of references.relationRefs) {
    if (!allowedRelationRefs.has(ref)) {
      issues.push(
        issue(
          `${path}/relationRefs`,
          "reference_not_allowed",
          `原因へ許可されたrelation refではありません: ${ref}`,
        ),
      );
      continue;
    }
    const relation = batch.input.relations.find((value) => value.ref === ref);
    assertNonNullable(relation, `relation refがtransport inputにありません。対象: ${ref}`);
    if (relation.relation.type === "related_to") {
      issues.push(
        issue(
          `${path}/relationRefs`,
          "related_relation_not_allowed",
          "related_toは原因の効力根拠に使えません",
        ),
      );
    }
  }
  for (const ref of references.sourceRefs) {
    if (!allowedSourceRefs.has(ref)) {
      issues.push(
        issue(
          `${path}/sourceRefs`,
          "reference_not_allowed",
          `原因へ許可されたsource refではありません: ${ref}`,
        ),
      );
    }
  }
  if (issues.length !== 0) {
    return undefined;
  }
  const nodeIds: string[] = [];
  for (const ref of references.itemRefs) {
    const nodeId = batch.refs.items.get(ref);
    assertNonNullable(nodeId, `item refをcanonical IDへ戻せません。対象: ${ref}`);
    nodeIds.push(nodeId);
  }
  const relationIds: string[] = [];
  for (const ref of references.relationRefs) {
    const relationId = batch.refs.relations.get(ref);
    assertNonNullable(relationId, `relation refをcanonical IDへ戻せません。対象: ${ref}`);
    relationIds.push(relationId);
  }
  const sourceIds: string[] = [];
  for (const ref of references.sourceRefs) {
    const sourceId = batch.refs.sources.get(ref);
    assertNonNullable(sourceId, `source refをcanonical IDへ戻せません。対象: ${ref}`);
    sourceIds.push(sourceId);
  }
  return Object.freeze({
    nodeIds: uniqueSorted(nodeIds),
    relationIds: uniqueSorted(relationIds),
    sourceIds: uniqueSorted(sourceIds),
    reasonSummary: references.reasonSummary,
  });
}

function sourceRolesForCause(
  causeInput: PersonalReminderCauseSemanticInput,
): ReadonlyMap<string, ReadonlySet<string>> {
  const rolesBySourceId = new Map<string, Set<string>>();
  for (const scope of causeInput.evidenceScopes) {
    const roles = rolesBySourceId.get(scope.sourceId) ?? new Set<string>();
    for (const role of scope.roles) {
      roles.add(role);
    }
    rolesBySourceId.set(scope.sourceId, roles);
  }
  return rolesBySourceId;
}

function hasEvidenceRole(
  references: CanonicalReferences,
  role: string,
  rolesBySourceId: ReadonlyMap<string, ReadonlySet<string>>,
): boolean {
  return references.sourceIds.some((sourceId) => rolesBySourceId.get(sourceId)?.has(role) === true);
}

function appendConfidenceIssue(
  assessment: PersonalReminderRawAssessment,
  minimumConfidence: number,
  issues: PersonalReminderCauseSemanticIssue[],
): void {
  if (assessment.verdict !== "unknown" && assessment.confidence < minimumConfidence) {
    issues.push(
      issue(
        "/assessment/confidence",
        "confidence_below_minimum",
        "unknown以外の判定はminimumConfidence以上にしてください",
      ),
    );
  }
}

function hasReference(
  references: CanonicalReferences,
  value: string,
  kind: "node" | "relation" | "source",
): boolean {
  switch (kind) {
    case "node":
      return references.nodeIds.includes(value);
    case "relation":
      return references.relationIds.includes(value);
    case "source":
      return references.sourceIds.includes(value);
  }
}

function validateCompleteness(
  assessment: PersonalReminderRawAssessment,
  causeInput: PersonalReminderCauseSemanticInput,
  issues: PersonalReminderCauseSemanticIssue[],
): void {
  if (causeInput.completeness.status === "incomplete") {
    if (assessment.verdict !== "unknown") {
      issues.push(
        issue(
          "/assessment",
          "incomplete_input_required",
          "incomplete入力はincomplete_inputのunknownだけを受け入れます",
        ),
      );
    } else if (assessment.reason !== "incomplete_input") {
      issues.push(
        issue(
          "/assessment/reason",
          "incomplete_input_required",
          "incomplete入力はincomplete_inputのunknownだけを受け入れます",
        ),
      );
    }
    return;
  }
  if (assessment.verdict === "unknown" && assessment.reason === "incomplete_input") {
    issues.push(
      issue(
        "/assessment/reason",
        "incomplete_input_not_allowed",
        "complete入力ではincomplete_inputを使えません",
      ),
    );
  }
}

function validateOptionReferences(
  references: CanonicalReferences,
  option: Readonly<{
    itemNodeId: string;
    relationIds: readonly string[];
    evidenceSourceIds: readonly string[];
  }>,
  path: string,
  issues: PersonalReminderCauseSemanticIssue[],
): void {
  if (!hasReference(references, option.itemNodeId, "node")) {
    issues.push(
      issue(
        `${path}/references/itemRefs`,
        "option_item_missing",
        "選択したoptionのitemを根拠へ含めてください",
      ),
    );
  }
  for (const relationId of option.relationIds) {
    if (!hasReference(references, relationId, "relation")) {
      issues.push(
        issue(
          `${path}/references/relationRefs`,
          "option_relation_missing",
          "選択したoptionのrelationを根拠へ含めてください",
        ),
      );
    }
  }
  for (const sourceId of option.evidenceSourceIds) {
    if (!hasReference(references, sourceId, "source")) {
      issues.push(
        issue(
          `${path}/references/sourceRefs`,
          "option_source_missing",
          "選択したoptionのsourceを根拠へ含めてください",
        ),
      );
    }
  }
}

function sameResponsible(
  left: readonly PersonalReminderResponsible[],
  right: readonly PersonalReminderResponsible[],
): boolean {
  const signature = (value: PersonalReminderResponsible): string =>
    `${value.kind}\u0000${value.candidateId.toLowerCase()}\u0000${value.role}`;
  const leftValues = left.map(signature).sort(compareStrings);
  const rightValues = right.map(signature).sort(compareStrings);
  return (
    leftValues.length === rightValues.length &&
    leftValues.every((value, index) => value === rightValues[index])
  );
}

function createCanonicalAssessment(
  assessment: PersonalReminderRawAssessment,
  references: CanonicalReferences,
  causeInput: PersonalReminderCauseSemanticInput,
): PersonalReminderCauseAssessment {
  switch (assessment.verdict) {
    case "actionable":
      return personalReminderCauseAssessmentSchema.parse({
        verdict: "actionable",
        references,
        confidence: assessment.confidence,
      });
    case "waiting": {
      const option = causeInput.waitingOptions.find(
        (value) => value.optionId === assessment.optionId,
      );
      assertNonNullable(option, `waiting optionがありません。対象: ${assessment.optionId}`);
      return personalReminderCauseAssessmentSchema.parse({
        verdict: "waiting",
        waitingFor: {
          itemNodeId: option.itemNodeId,
          action: option.action.summary,
        },
        references,
        confidence: assessment.confidence,
      });
    }
    case "duplicate":
      return personalReminderCauseAssessmentSchema.parse({
        verdict: "duplicate",
        canonicalCauseId: assessment.canonicalCauseId,
        references,
        confidence: assessment.confidence,
      });
    case "not_required":
      return personalReminderCauseAssessmentSchema.parse({
        verdict: "not_required",
        references,
        confidence: assessment.confidence,
      });
    case "unknown":
      return personalReminderCauseAssessmentSchema.parse({
        verdict: "unknown",
        reason: assessment.reason,
        references,
        confidence: assessment.confidence,
      });
  }
}

function validateOneCause(
  assessment: PersonalReminderRawAssessment,
  causeInput: CauseInput,
  semanticInput: PersonalReminderCauseSemanticInput,
  batch: PreparedPersonalReminderAiBatch,
  minimumConfidence: number,
): Readonly<{
  assessment: PersonalReminderCauseAssessment | undefined;
  issues: readonly PersonalReminderCauseSemanticIssue[];
}> {
  const issues: PersonalReminderCauseSemanticIssue[] = [];
  const references = canonicalizeReferences(
    assessment.references,
    causeInput,
    batch,
    "/assessment",
    issues,
  );
  appendConfidenceIssue(assessment, minimumConfidence, issues);
  validateCompleteness(assessment, semanticInput, issues);
  if (references == null) {
    return Object.freeze({ assessment: undefined, issues: Object.freeze(issues) });
  }
  const rolesBySourceId = sourceRolesForCause(semanticInput);
  if (assessment.verdict === "actionable") {
    if (!hasEvidenceRole(references, "obligation_candidate", rolesBySourceId)) {
      issues.push(
        issue(
          "/assessment/references/sourceRefs",
          "obligation_evidence_missing",
          "actionableにはobligation_candidate根拠が必要です",
        ),
      );
    }
    if (!hasEvidenceRole(references, "actionability", rolesBySourceId)) {
      issues.push(
        issue(
          "/assessment/references/sourceRefs",
          "actionability_evidence_missing",
          "actionableにはactionability根拠が必要です",
        ),
      );
    }
  }
  if (assessment.verdict === "not_required") {
    if (semanticInput.cause.responsibility.authority === "fixed") {
      issues.push(
        issue(
          "/assessment/verdict",
          "fixed_not_required_forbidden",
          "fixed authorityの原因をnot_requiredにはできません",
        ),
      );
    }
    if (
      !hasEvidenceRole(references, "resolution", rolesBySourceId) &&
      !hasEvidenceRole(references, "obligation_candidate", rolesBySourceId)
    ) {
      issues.push(
        issue(
          "/assessment/references/sourceRefs",
          "negative_evidence_missing",
          "not_requiredにはresolutionまたはobligation_candidate根拠が必要です",
        ),
      );
    }
  }
  if (
    assessment.verdict === "unknown" &&
    assessment.reason !== "incomplete_input" &&
    references.nodeIds.length === 0 &&
    references.relationIds.length === 0 &&
    references.sourceIds.length === 0
  ) {
    issues.push(
      issue(
        "/assessment/references",
        "uncertainty_evidence_missing",
        "競合または曖昧さを示す根拠が必要です",
      ),
    );
  }
  if (assessment.verdict === "waiting") {
    const option = semanticInput.waitingOptions.find(
      (value) => value.optionId === assessment.optionId,
    );
    if (option == null) {
      issues.push(
        issue(
          "/assessment/optionId",
          "waiting_option_not_found",
          "入力にないwaiting optionは選べません",
        ),
      );
    } else {
      if (option.itemNodeId !== semanticInput.cause.itemNodeId && option.relationIds.length === 0) {
        issues.push(
          issue(
            "/assessment/optionId",
            "waiting_relation_missing",
            "異なるitemへのwaiting optionにはrelationが必要です",
          ),
        );
      }
      validateOptionReferences(references, option, "/assessment", issues);
    }
  }
  if (assessment.verdict === "duplicate") {
    const option = semanticInput.duplicateOptions.find(
      (value) => value.canonicalCauseId === assessment.canonicalCauseId,
    );
    if (option == null) {
      issues.push(
        issue(
          "/assessment/canonicalCauseId",
          "duplicate_option_not_found",
          "入力にないduplicate optionは選べません",
        ),
      );
    } else {
      if (!sameResponsible(option.responsible, semanticInput.cause.responsible)) {
        issues.push(
          issue(
            "/assessment/canonicalCauseId",
            "duplicate_responsible_mismatch",
            "duplicate optionの責任主体集合が一致しません",
          ),
        );
      }
      if (option.action.kind !== semanticInput.cause.action.kind) {
        issues.push(
          issue(
            "/assessment/canonicalCauseId",
            "duplicate_action_mismatch",
            "duplicate optionのaction kindが一致しません",
          ),
        );
      }
      validateOptionReferences(references, option, "/assessment", issues);
    }
  }
  if (issues.length !== 0) {
    return Object.freeze({ assessment: undefined, issues: Object.freeze(issues) });
  }
  return Object.freeze({
    assessment: createCanonicalAssessment(assessment, references, semanticInput),
    issues: Object.freeze([]),
  });
}

/** 個人催促AIのoutputをcause単位でsemantic検証する。 */
export function validatePersonalReminderCauseSemantics(
  input: Readonly<{
    batch: PreparedPersonalReminderAiBatch;
    output: SchemaValidPersonalReminderAiOutput;
    minimumConfidence: number;
  }>,
): PersonalReminderCauseSemanticValidation {
  validateMinimumConfidence(input.minimumConfidence);
  type Accepted = PersonalReminderCauseSemanticValidation["accepted"][number];
  type Rejected = PersonalReminderCauseSemanticValidation["rejected"][number];
  type Unexpected = PersonalReminderCauseSemanticValidation["unexpected"][number];
  const accepted: Accepted[] = [];
  const rejected: Rejected[] = [];
  const unexpected: Unexpected[] = [];
  const outputRowsByCauseId = new Map<
    string,
    readonly { index: number; assessment: PersonalReminderRawAssessment }[]
  >();
  for (const [index, row] of input.output.causes.entries()) {
    const rows = outputRowsByCauseId.get(row.causeId) ?? [];
    outputRowsByCauseId.set(row.causeId, [
      ...rows,
      Object.freeze({ index, assessment: row.assessment }),
    ]);
  }
  const knownCauseIds = new Set<string>();
  for (const causeInput of input.batch.input.causes) {
    knownCauseIds.add(causeInput.causeId);
    const preparedCause = input.batch.causeInputs.get(causeInput.causeId);
    assertNonNullable(preparedCause, `cause inputがありません。対象: ${causeInput.causeId}`);
    const rows = outputRowsByCauseId.get(causeInput.causeId) ?? [];
    if (rows.length === 0) {
      rejected.push({
        causeId: causeInput.causeId,
        issues: Object.freeze([
          issue("/causes", "cause_row_missing", "入力causeに対応するoutput rowがありません"),
        ]),
      });
      continue;
    }
    if (rows.length !== 1) {
      rejected.push({
        causeId: causeInput.causeId,
        issues: Object.freeze([
          issue("/causes", "cause_row_duplicate", "同じcause IDのoutput rowが複数あります"),
        ]),
      });
      continue;
    }
    const row = rows[0];
    assertNonNullable(row, "cause output rowがありません");
    const result = validateOneCause(
      row.assessment,
      causeInput,
      preparedCause.input,
      input.batch,
      input.minimumConfidence,
    );
    if (result.assessment == null) {
      rejected.push({ causeId: causeInput.causeId, issues: result.issues });
      continue;
    }
    accepted.push({
      causeId: causeInput.causeId,
      inputFingerprint: preparedCause.inputFingerprint,
      assessment: result.assessment,
    });
  }
  for (const [causeId, rows] of outputRowsByCauseId) {
    if (!knownCauseIds.has(causeId)) {
      for (const row of rows) {
        unexpected.push({ outputIndex: row.index, causeId });
      }
    }
  }
  return Object.freeze({
    accepted: Object.freeze(accepted),
    rejected: Object.freeze(rejected),
    unexpected: Object.freeze(unexpected),
  });
}
