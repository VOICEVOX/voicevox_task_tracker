/** Codex認証preflightへ渡す固定prompt。 */
export const CODEX_AUTHENTICATION_PREFLIGHT_PROMPT =
  "Codexの認証済み接続を確認してください。短い応答で完了してください。";

/** Codex認証preflightの固定promptに含まれるUnicode文字数。 */
export const CODEX_AUTHENTICATION_PREFLIGHT_INPUT_CHARACTERS = Array.from(
  CODEX_AUTHENTICATION_PREFLIGHT_PROMPT,
).length;
