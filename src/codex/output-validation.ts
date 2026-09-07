import { type CodexAnalysisInput } from "./input.js";
import { validateCodexAnalysisSemantics, type CodexElementOutput } from "./semantic-validation.js";

/** 要素別Codex出力を入力に対応するschemaとsemantic制約で検証する。 */
export function validateCodexAnalysisOutput(
  value: unknown,
  input: CodexAnalysisInput,
): CodexElementOutput {
  return validateCodexAnalysisSemantics(value, input);
}
