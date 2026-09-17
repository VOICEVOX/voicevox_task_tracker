import { z } from "zod";

/** 通常項目AIのsemantic検証issue code。 */
export type CodexSemanticValidationIssueCode =
  | "unknown_source_id_present_in_input"
  | "unknown_source_id_absent_from_input"
  | "source_time_out_of_range"
  | "duplicate_source_id"
  | "self_commitment_wrong_element"
  | "unknown_self_commitment_candidate_source"
  | "self_commitment_evidence_without_value"
  | "self_commitment_evidence_required"
  | "self_commitment_support"
  | "self_commitment_source_kind"
  | "self_commitment_source_actor"
  | "self_commitment_author_unavailable"
  | "unknown_waiting_on_candidate"
  | "duplicate_waiting_on_candidate"
  | "waiting_on_kind_mismatch"
  | "unknown_relation_candidate"
  | "invalid_implements_direction"
  | "missing_relation_verdict"
  | "duplicate_relation_verdict"
  | "url_not_allowed"
  | "item_node_id_mismatch"
  | "item_url_mismatch"
  | "terminal_waiting_on"
  | "non_terminal_without_waiting_on"
  | "invalid_deadline_date"
  | "unknown_native_relation"
  | "unselected_element_present"
  | "selected_element_missing"
  | "duplicate_id"
  | "item_mismatch";

const semanticValidationIssueCodes: readonly [
  CodexSemanticValidationIssueCode,
  ...CodexSemanticValidationIssueCode[],
] = [
  "unknown_source_id_present_in_input",
  "unknown_source_id_absent_from_input",
  "source_time_out_of_range",
  "duplicate_source_id",
  "self_commitment_wrong_element",
  "unknown_self_commitment_candidate_source",
  "self_commitment_evidence_without_value",
  "self_commitment_evidence_required",
  "self_commitment_support",
  "self_commitment_source_kind",
  "self_commitment_source_actor",
  "self_commitment_author_unavailable",
  "unknown_waiting_on_candidate",
  "duplicate_waiting_on_candidate",
  "waiting_on_kind_mismatch",
  "unknown_relation_candidate",
  "invalid_implements_direction",
  "missing_relation_verdict",
  "duplicate_relation_verdict",
  "url_not_allowed",
  "item_node_id_mismatch",
  "item_url_mismatch",
  "terminal_waiting_on",
  "non_terminal_without_waiting_on",
  "invalid_deadline_date",
  "unknown_native_relation",
  "unselected_element_present",
  "selected_element_missing",
  "duplicate_id",
  "item_mismatch",
];

/** 通常項目AIのbase prompt、補正prompt、semantic glossaryを識別するbundle version。 */
export const CODEX_PROMPT_BUNDLE_VERSION =
  "codex-analysis-prompt-bundle-v2-relation-v3-semantic-correction-v1";

/** 通常項目AIのsemantic検証issue code schema。 */
export const codexSemanticValidationIssueCodeSchema = z.enum(semanticValidationIssueCodes);

/** semantic issueを補正生成へ渡せるかと固定説明。 */
export type CodexSemanticValidationIssueCatalogEntry = Readonly<{
  correction: "eligible" | "ineligible";
  glossary: string;
}>;

/** 通常項目AIのsemantic issue codeごとの補正可否と固定説明。 */
export const CODEX_SEMANTIC_VALIDATION_ISSUE_CATALOG = Object.freeze({
  unknown_source_id_present_in_input: {
    correction: "eligible",
    glossary: "sources以外の入力領域にあるsource IDを参照しています",
  },
  unknown_source_id_absent_from_input: {
    correction: "eligible",
    glossary: "入力に存在しないsource IDを参照しています",
  },
  source_time_out_of_range: {
    correction: "eligible",
    glossary: "判定時刻より後のsourceを参照しています",
  },
  duplicate_source_id: {
    correction: "eligible",
    glossary: "同じsource IDを要素内で重複して指定しています",
  },
  self_commitment_wrong_element: {
    correction: "eligible",
    glossary: "self_commitmentの根拠をselfCommitment以外の要素へ指定しています",
  },
  unknown_self_commitment_candidate_source: {
    correction: "eligible",
    glossary: "selfCommitment候補にないsource IDを参照しています",
  },
  self_commitment_evidence_without_value: {
    correction: "eligible",
    glossary: "selfCommitmentの値に対応しない根拠を指定しています",
  },
  self_commitment_evidence_required: {
    correction: "eligible",
    glossary: "selfCommitmentの値に対応する根拠がありません",
  },
  self_commitment_support: {
    correction: "eligible",
    glossary: "selfCommitmentの根拠supportsが不正です",
  },
  self_commitment_source_kind: {
    correction: "eligible",
    glossary: "selfCommitmentの根拠sourceのkindが不正です",
  },
  self_commitment_source_actor: {
    correction: "eligible",
    glossary: "selfCommitmentの根拠sourceのactorが不正です",
  },
  self_commitment_author_unavailable: {
    correction: "eligible",
    glossary: "selfCommitmentの根拠authorが識別できません",
  },
  unknown_waiting_on_candidate: {
    correction: "eligible",
    glossary: "waitingOn候補集合にない候補を参照しています",
  },
  duplicate_waiting_on_candidate: {
    correction: "eligible",
    glossary: "waitingOn候補を重複して指定しています",
  },
  waiting_on_kind_mismatch: {
    correction: "eligible",
    glossary: "waitingOn候補のkindとcandidate IDの種別が一致しません",
  },
  unknown_relation_candidate: {
    correction: "eligible",
    glossary: "relation候補集合にない候補を参照しています",
  },
  invalid_implements_direction: {
    correction: "eligible",
    glossary: "implementsの向きがPull RequestからIssueになっていません",
  },
  missing_relation_verdict: {
    correction: "eligible",
    glossary: "relation候補のverdictが不足しています",
  },
  duplicate_relation_verdict: {
    correction: "eligible",
    glossary: "relation候補のverdictが重複しています",
  },
  url_not_allowed: {
    correction: "eligible",
    glossary: "許可されていないURLを自然言語の値に含めています",
  },
  item_node_id_mismatch: {
    correction: "eligible",
    glossary: "出力itemのnode IDが入力itemと一致しません",
  },
  item_url_mismatch: {
    correction: "eligible",
    glossary: "出力itemのURLが入力itemと一致しません",
  },
  terminal_waiting_on: {
    correction: "eligible",
    glossary: "terminal状態にwaitingOnを指定しています",
  },
  non_terminal_without_waiting_on: {
    correction: "eligible",
    glossary: "継続中の状態にwaitingOnがありません",
  },
  invalid_deadline_date: {
    correction: "eligible",
    glossary: "期限日が実在する日付またはnullではありません",
  },
  unknown_native_relation: {
    correction: "ineligible",
    glossary: "入力のauthoritativeなnative relation信号がrelation候補にありません",
  },
  unselected_element_present: {
    correction: "eligible",
    glossary: "選択されていない要素を出力しています",
  },
  selected_element_missing: {
    correction: "eligible",
    glossary: "選択した要素が出力されていません",
  },
  duplicate_id: {
    correction: "eligible",
    glossary: "要素内で同じIDを重複して指定しています",
  },
  item_mismatch: {
    correction: "eligible",
    glossary: "出力itemが入力itemと一致しません",
  },
} satisfies Readonly<
  Record<CodexSemanticValidationIssueCode, CodexSemanticValidationIssueCatalogEntry>
>);

/** semantic issue codeが補正生成の対象か判定する。 */
export function isCodexSemanticCorrectionEligible(
  code: string,
): code is CodexSemanticValidationIssueCode {
  const parsed = codexSemanticValidationIssueCodeSchema.safeParse(code);
  if (!parsed.success) {
    return false;
  }
  return CODEX_SEMANTIC_VALIDATION_ISSUE_CATALOG[parsed.data].correction === "eligible";
}

/** semantic issueの固定glossaryを補正promptへ渡す順序で返す。 */
export function listCodexSemanticValidationIssueGlossary(): readonly Readonly<{
  code: CodexSemanticValidationIssueCode;
  correction: "eligible" | "ineligible";
  glossary: string;
}>[] {
  return Object.freeze(
    semanticValidationIssueCodes.map((code) => {
      const parsedCode = codexSemanticValidationIssueCodeSchema.parse(code);
      return Object.freeze({
        code: parsedCode,
        correction: CODEX_SEMANTIC_VALIDATION_ISSUE_CATALOG[parsedCode].correction,
        glossary: CODEX_SEMANTIC_VALIDATION_ISSUE_CATALOG[parsedCode].glossary,
      });
    }),
  );
}
