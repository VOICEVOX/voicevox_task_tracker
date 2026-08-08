# Research Sources

調査基準日: 2026-08-07 JST。実装時はpinするAPI version/CLI versionの公式文書を再確認する。

## GitHub公式

| テーマ                      | 公式資料                                                                                                                                       | 本仕様での利用                                          |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| Organization repo列挙       | https://docs.github.com/en/rest/repos/repos#list-organization-repositories                                                                     | public/non-archived repoの動的発見とpagination          |
| Repository Issue列挙        | https://docs.github.com/en/rest/issues/issues#list-repository-issues                                                                           | repo単位の増分収集。PRも返る点を考慮                    |
| Issue timeline              | https://docs.github.com/en/rest/issues/timeline                                                                                                | cross-reference、assign、label、review request等のevent |
| Issue dependencies          | https://docs.github.com/en/rest/issues/issue-dependencies                                                                                      | native blocked-by/blockingをauthoritative edge化        |
| Sub-issues                  | https://docs.github.com/en/rest/issues/sub-issues                                                                                              | native parent/subtaskをauthoritative hierarchy化        |
| PR reviews                  | https://docs.github.com/en/rest/pulls/reviews                                                                                                  | APPROVED/CHANGES_REQUESTED等                            |
| PR review requests          | https://docs.github.com/en/rest/pulls/review-requests                                                                                          | レビュー待ちとreviewer user/teamの特定                  |
| GraphQL review thread       | https://docs.github.com/en/graphql/reference/objects#pullrequestreviewthread                                                                   | inline threadのresolved状態                             |
| GitHub App installation認証 | https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/authenticating-as-a-github-app-installation              | 短寿命installation token                                |
| GitHub App permissions      | https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/choosing-permissions-for-a-github-app                            | read-only最小権限                                       |
| REST rate limits            | https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api                                                                | primary/secondary limit監視                             |
| Actions schedule            | https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule                                      | cronはUTC、default branch、遅延可能性                   |
| Workflow syntax             | https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax                                                             | permissions、concurrency、workflow_dispatch             |
| GITHUB_TOKEN                | https://docs.github.com/en/actions/security-for-github-actions/security-guides/automatic-token-authentication                                  | job最小権限                                             |
| Repository secret更新       | https://docs.github.com/en/rest/actions/secrets#create-or-update-a-repository-secret                                                           | Actions repository secretの更新API                      |
| Fine-grained token権限      | https://docs.github.com/en/rest/authentication/permissions-required-for-fine-grained-personal-access-tokens#repository-permissions-for-secrets | repositoryの`Secrets` write権限                         |
| Actions security hardening  | https://docs.github.com/en/actions/security-for-github-actions/security-guides/security-hardening-for-github-actions                           | untrusted input、pinning、secret境界                    |
| Pages custom workflow       | https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages                                    | configure/upload/deploy Pages artifact                  |

## OpenAI公式

| テーマ                    | 公式資料                                                                                     | 本仕様での利用                                                       |
| ------------------------- | -------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| Codex non-interactive     | https://developers.openai.com/codex/noninteractive                                           | GitHub Actionsからの非対話実行、JSON event/output                    |
| Codex CLI reference       | https://developers.openai.com/codex/cli/reference                                            | version pin、sandbox、approval、output schema等                      |
| Codex authentication      | https://developers.openai.com/codex/auth                                                     | token自動更新とfile-based `auth.json`                                |
| Codex ChatGPT認証のCI利用 | https://developers.openai.com/codex/noninteractive#use-chatgpt-managed-auth-in-cicd-advanced | `auth.json`の実行中更新と次回runへの保存                             |
| Codex token更新実装       | https://github.com/openai/codex/blob/main/codex-rs/login/src/auth/manager.rs                 | access tokenの有効期限前5分以内の更新とrotation後のrefresh token保存 |
| Structured Outputs        | https://platform.openai.com/docs/guides/structured-outputs                                   | JSON Schema拘束とvalidation                                          |
| Evaluation best practices | https://platform.openai.com/docs/guides/evals                                                | 固定AI出力を通したgolden fixtureの回帰評価                           |

## Discord公式

| テーマ           | 公式資料                                                                        | 本仕様での利用                          |
| ---------------- | ------------------------------------------------------------------------------- | --------------------------------------- |
| Execute Webhook  | https://discord.com/developers/docs/resources/webhook#execute-webhook           | public channelへの一方向送信、wait=true |
| Allowed Mentions | https://discord.com/developers/docs/resources/message#allowed-mentions-object   | mention既定無効・allowlist              |
| Embed limits     | https://discord.com/developers/docs/resources/message#embed-object-embed-limits | payload事前分割                         |
| Rate limits      | https://discord.com/developers/docs/topics/rate-limits                          | response headerに従うretry              |

## 要求工学・品質の参考

| 資料                                    | URL                                                                             | 参考にした点                               |
| --------------------------------------- | ------------------------------------------------------------------------------- | ------------------------------------------ |
| ISO/IEC/IEEE 29148:2018 landing page    | https://www.iso.org/standard/72089.html                                         | 要求工学、要求仕様の構造と品質             |
| IEEE 29148 standard page                | https://standards.ieee.org/ieee/29148/6937/                                     | system/software requirements specification |
| NASA SWE-050 Software Requirements      | https://swehb.nasa.gov/display/SWEHBVC/SWE-050+-+Software+Requirements          | 明確で検証可能なsoftware requirements      |
| NASA SWE-034 Acceptance Criteria        | https://swehb.nasa.gov/display/SWEHBVC/SWE-034+-+Acceptance+Criteria            | 受入基準を要求と対応付ける考え方           |
| NASA SWE-052 Bidirectional Traceability | https://swehb.nasa.gov/display/SWEHBVC/SWE-052+-+Bidirectional+Traceability     | 要求とtestのtraceability                   |
| RFC 2119 / RFC 8174                     | https://www.rfc-editor.org/rfc/rfc2119 / https://www.rfc-editor.org/rfc/rfc8174 | MUST/SHOULD規範語                          |
| WCAG 2.2                                | https://www.w3.org/TR/WCAG22/                                                   | 公開Web UIのアクセシビリティ               |
| JSON Schema 2020-12                     | https://json-schema.org/draft/2020-12                                           | Codex output/state validation              |

## VOICEVOX実例

| 実例                      | URL                                                        | 観察                                           |
| ------------------------- | ---------------------------------------------------------- | ---------------------------------------------- |
| cross-repo umbrella       | https://github.com/VOICEVOX/voicevox_project/issues/99     | 複数repoの更新を1つのIssueで管理               |
| 明示blocker付きPR         | https://github.com/VOICEVOX/voicevox_engine/pull/1871      | 本文に「待っています」と複数項目を記載         |
| 完了済みblocker           | https://github.com/VOICEVOX/onnxruntime-builder/issues/111 | 依存元本文が古くてもtarget stateはclosed       |
| release checklist         | https://github.com/VOICEVOX/voicevox_core/issues/1286      | 入れ子checklistとIssue link                    |
| human changes requested   | https://github.com/VOICEVOX/voicevox/pull/3079             | bot activityとは別にhuman reviewが責務を変える |
| approval + bot comment    | https://github.com/VOICEVOX/kanalizer/pull/133             | bot指摘を所有者にしない必要                    |
| explicit decision request | https://github.com/VOICEVOX/voicevox/issues/3031           | 特定個人へ判断依頼                             |
| automation dashboard      | https://github.com/VOICEVOX/voicevox_core/issues/635       | 定期bot更新によるnoise                         |
| inactive Issue運用見直し  | https://github.com/VOICEVOX/voicevox_engine/pull/1865      | maintainer棚卸し工数不足の背景                 |
