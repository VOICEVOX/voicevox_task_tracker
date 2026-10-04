/** Codex adapterが利用できる認証方式の一覧。 */
export const CODEX_AUTHENTICATIONS = ["api-key", "auth-json"] as const;

/** Codex adapterが利用する認証方式。 */
export type CodexAuthentication = (typeof CODEX_AUTHENTICATIONS)[number];
