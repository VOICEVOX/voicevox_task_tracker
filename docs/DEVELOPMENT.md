# 開発手順

VOICEVOX Task Trackerを手元で開発するための手順です。
本番環境の構築は[デプロイ手順](DEPLOYMENT.md)、運用中の操作は[運用手順](OPERATIONS.md)を参照してください。
設計の背景は[アーキテクチャ](ARCHITECTURE.md)にあります。

## 環境を用意する

Node.jsは`.node-version`の24.11.1、pnpmは`package.json`の`packageManager`で固定した10.33.4を使います。
`packageManager`の指定だけではpnpmのshimが有効にならない環境があるため、Corepackを明示的に有効にします。

```console
corepack enable
pnpm install --frozen-lockfile
```

`--frozen-lockfile`を付けると、`pnpm-lock.yaml`と`package.json`が一致しない場合にインストールが失敗します。

## GitHub Appなしで静的確認する

通常の開発確認は、外部サービスへ接続しない次のcommandを使います。

```console
pnpm format
pnpm typecheck
pnpm lint
pnpm check:source-lines
pnpm format:check
pnpm build
pnpm build:workflow-cli
pnpm build:web
```

GitHub App、実Codex、Pages deploy、Discordの認証は不要です。
`tracker:run`はビルド済みCLIの起動だけを行うため、sourceを変更したら先に`pnpm build`を実行します。
変更したTaskのcontractと呼出元を確認し、対象のcodec・schema・入力検証を必要な範囲で検証してください。

| command                  | 検査・出力                                                     |
| ------------------------ | -------------------------------------------------------------- |
| `typecheck`              | Nodeとwebのincremental型検査                                   |
| `lint`                   | 静的importとexportの循環、source上限、層の依存方向、ESLint規則 |
| `check:dependencies`     | srcとwebの静的importとexportの循環。型専用の辺も含む           |
| `check:source-lines`     | generated/mockを除いた直接編集sourceの1000行上限               |
| `format`、`format:check` | Prettierの整形と差分確認                                       |
| `build`                  | Node向けの`dist/`                                              |
| `build:workflow-cli`     | 固定entrypointを含む`artifacts/workflow/runtime/`のbundle      |
| `build:web`              | `dist/web/`の静的サイト                                        |

cacheは`node_modules/.cache/voicevox-task-tracker/`へ保存します。
型検査はincremental、Prettierとsource-lines・依存検査はcacheを使います。
ESLintはlint対象の全source、型の参照先となるJSON、tsconfig、ESLint設定、package manifest、lockfile、Node版の内容からkeyを計算し、そのkey専用のcacheを使います。
参照先sourceが変わるとkeyも変わるため、型依存規則の古い結果は使われません。
依存検査はsourceの一覧が変わると依存先を解決し直します。
CIはESLint cacheを完全一致のkeyだけで復元し、ほかの静的検査cacheは設定とcheckerのdigestを含むkeyで復元します。
cacheを無効化して繰り返す確認は通常の手順にしません。
新しいsourceが400行を超えたら責務分割を検討し、1000行超はerrorとして扱います。`.github/actions`の直接編集するJavaScriptはESLintとsource-lines検査の両方、composite actionのYAMLはsource-lines検査で確認します。
依存検査は通常のimportとexportに加え、`import("...").Type`などのimport型も循環判定の辺に含めます。
一時baselineや新しいignoreでsourceを例外化しません。

## codecと保存stateを検証する

CLIの次の入口は外部effectを起こさず、指定した入力を検証します。

| command                                                    | 必要な入力                                   |
| ---------------------------------------------------------- | -------------------------------------------- |
| `verify-checkpoint --artifact PATH`                        | `.cpk` checkpointとsidecar、設定             |
| `verify-receipt-chain --input PATH`                        | checkpointとreceipt chainの検証入力          |
| `verify-runtime-recovery --input PATH --bundle-root PATH`  | 固定回復inputとexact bundle                  |
| `verify-state --state-directory PATH --state-revision SHA` | ローカルのGit checkoutと固定commit SHA、設定 |

verify-stateは作業treeのファイルを検査対象にせず、指定したSHAのstate treeを読みます。
bootstrapを最初に確認し、未完了runならcurrent runtimeで業務payloadをparse・migrationする前に停止します。
未完了runの検証と再開は記録されたexact runtimeで行います。
完了済みstateは現行ingressで読み、marker・record・初回Pages証拠と実Gitの親・初回commitを照合します。
旧snapshotから個人催促時計の再確認待ちが生じた場合は、入口で構造・意味・IDと個人催促のEvidence参照を検証し、保存形式の検証を保留します。
今回収集するGitHub詳細で時計を再確認するまで、`verify-state`の成功はsnapshotを保存できることを示しません。
再確認待ちがないsnapshotは、保存用の直列化と再読込も検証します。
検証用の一時コピーは終了時に削除し、元のstateとremoteを変更しません。

## Web UIをローカルで見る

`pnpm dev:web`でViteを起動します。
Viteは`config.yml`のweb設定と`web/public/data/`のサンプル公開DTOを読みます。
summaryは最初に、detailsは詳細表示や検索時に、通知履歴は履歴ページを開いたときに取得します。
`build:web`はPagesのdeep linkを受ける各ページのHTMLも生成します。
サンプルDTOを実データへ上書きしたままコミットしないでください。

## オンライン確認は専用workflowで行う

ローカルで重い通しrun、全件AI再推論、5,000項目の性能profileを実行しません。
`dry-run`も実GitHub収集と実Codexを使うため、認証不要の静的確認には使えません。
実サービスの確認は、対象範囲と予算を決めたsandbox workflowで行い、連続runと通知actionの証拠を保存します。
性能計測は通常CIから分離した`performance.yml`の手動workflowで行います。
性能profileではstage開始に加え、初回commitの正規化、直列化、候補検証、fileの完全検証と証明の再利用、finalizationのsettlement検証、CAS、receipt、完了の境界でメモリ使用量を記録します。観測値は固定の処理名と数値に限定し、通常runでは出力しません。

CLIは明示的なsubcommandを受け取り、option形式のcommand変換を行いません。
`run-sequential`、`daily`、`dry-run`、`backfill`は同じcanonical engineを使います。
`collect-analyze`は解析と公開計画を同じstageで確定し、checkpointを書き出します。
分割workflowは`route-stage`、`run-stage`、V2固定入口を使って一段ずつ進みます。
production CLIにはPagesの直接deploy adapterがないため、公開の通し確認は日次workflowで行います。

通知actionは`send`、`hold`、`acknowledge-current`です。
`hold`は未送信候補を保持し、`acknowledge-current`は現在の候補を確認済みにします。
どちらも通常のDiscord送信と送信履歴を作りません。jobやbusiness stageの省略には使いません。
起動条件と実サービスの操作は[運用手順](OPERATIONS.md)を参照してください。

## テスト

ユーザーの指示の有無にかかわらず、テストを一切実装しません。

## 判定規則versionを更新する

判定規則を変えたら、対応するversionを上げてください。
上げないと、GitHub側が動いていない項目は再判定されず、古い判定が残り続けます。

| 変更した対象            | 上げるversion                                        |
| ----------------------- | ---------------------------------------------------- |
| Issueの判定             | `ISSUE_DETERMINISTIC_RULES_VERSION`                  |
| Pull Requestの判定      | `PULL_REQUEST_DETERMINISTIC_RULES_VERSION`           |
| Codexの意味上の判定規則 | `src/codex/analysis-elements.ts`の判定要素別revision |

### Codexプロンプトのversionを判断する

AI推論のやり直しは重いため、プロンプトの差分だけを理由に全項目や全判定を再推論しません。
`src/codex/analysis-elements.ts`のrevisionは、判定要素ごとの意味上のAI判定規則を識別します。
プロンプトを編集するたびに、状態、待ち相手、次の行動、関係、進捗、重要度、期限、通知推奨、selfCommitmentの9要素すべてについて、更新するか維持するかを判断してください。
変更のレビューには各要素の判断と理由を示し、変更が影響する要素のrevisionだけを上げます。
根拠、信頼度、不確実性の規則や共通指示を変更するときも、影響を受ける所有判定を明示してください。

各要素の構造化出力と下流処理に関わる意味上の判定が変わり得るかを、変更内容と影響範囲から判断します。
意味上の判定が変わらない表記変更ならrevisionを据え置き、判定が変わり得る変更や影響を判断できない変更では、該当要素のrevisionを上げます。
文章の一致率や根拠のない割合を基準にせず、実際の全件再推論も判断手段にしません。

次の変更は、意味上の判定が変わらない場合に限りversionを据え置きます。

- 用語、表記、説明文だけを変える
- 行動主体、行動、対象を変えない自由文の言い換えを行う

次の変更は、構造化された選択や下流処理の意味が変わり得るためversionを上げます。

- `status`、`waitingOn`の候補や順序、`importance`、`deadline`、`notification`、`relations`の意味を変える
- `meaningful progress`、`confidence`、根拠`source`、`nextAction`の意味を変える

versionを据え置いた表記変更は、既存cacheやsnapshotへ即時反映されません。新規分析や別要因による再分析だけが新しい表記になり、新旧の文言が一時的に混在します。この挙動は推論負荷を避けるために受け入れます。既存項目の表記を即時に統一する必要がある場合は、全AI再推論を伴わない表示時の決定論的な変換などを検討します。

model、reasoning effort、promptを変更した場合は、preflight以外の実分析を含むdry-runでAI判定と通知候補の差分を確認します。
`metrics.aiProcessAttemptCount`が1以上でもpreflightだけの場合は実分析を確認できません。

### 判定要素ごとに再推論の必要性を決める

再推論するIssue・PRの選別と、更新する判定要素の範囲を分けます。
各要素について、現在の入力と決定論的な規則だけで確定する判定をAI対象から除きます。
残りの要素は、保存済みの結果と現在のrevision、利用入力、実行条件を比較し、再利用できないものだけを選びます。
必要な要素が残らなければ、そのIssue・PRではAIを呼びません。

項目のアサインや期限の有無だけで、AIの必要性を決めないでください。
たとえばアサイン済みでも、未回答依頼の解釈が必要なら待ち相手のAI判定が必要です。
期限なし、進捗なし、通知を推奨しないという結果も分析済みの結果であり、規則が変われば見直します。
初回、通常の入力変更、失敗・延期の再試行も同じ要素別の選別を通します。
期限・重要度については、既存の通常AI分析の適用範囲と、現在採用している結果の更新を対象にします。

同じIssue・PRで必要な要素は1回の呼び出しにまとめます。
選択外の値を再生成・再採用せず、根拠、信頼度、不確実性は所有判定と一緒に保存します。
状態と待ち相手の片方だけを選ぶ場合は、もう片方の現在の採用値を入力へ含めます。
終了状態と待ち相手の有無など、構造で判定できる整合性は選択結果と保持する値を合わせて検証します。
次の行動の自由文まで、機械的な検証だけで意味の整合性を保証できません。
状態の規則変更で次の行動も変わるなら、開発者が次の行動のrevisionも上げて同時更新を指定してください。
矛盾を解消するために選択外の値を自動で書き換える処理は加えません。

固定値をAI入力へ渡す際に、過去の根拠の再取得を必須にしないでください。
過去の根拠は保存済みの判定結果に保持し、新しい判定の根拠は呼び出し時の入力だけで検証します。
この境界を変更する場合は、過去の根拠が現在の取得範囲に含まれない実データで、正規化、要素選別、入力生成、出力検証、保存まで確認してください。
取得していない根拠を新しい出力が参照すると拒否され、選択外の判定値と生成元が保持されることも確かめます。

各要素の生成元のrevision、入力、実行時刻を保持し、再利用だけで現在の生成結果として記録しません。
現在のrevisionと直接比較するため、途中の更新履歴を記録する必要はありません。
cacheが欠落しても保存済みの有効な結果があれば再分析せず、失敗・延期した要素のrevisionを適用済みにしません。
最新の完了結果と、現在採用している結果を分けて保存します。
低信頼の新しい結果を完了として記録しながら以前の採用値を保持する場合も、採用値の根拠や生成時のrevisionを新しい結果で上書きしません。
特定の判定にしか使わない入力を全要素へ追加すると、入力hashが変わって不要な再推論を増やします。
入力の依存範囲も判定要素ごとに定義してください。

再利用の検証では、AI呼び出しだけを省略する経路と、項目の解析自体を省略する経路を両方確認してください。
採用値が保存されていることに加え、関係と通知推奨が下流のグラフと通知判定で使われることを確かめます。

要対応度は最新の重要度、期限の切迫度、停滞時間、設定から毎run全項目で再計算します。
要対応度だけの変更ではIssueとPull Requestの決定論的規則versionを上げません。
期限日から切迫度を求める規則を変えた場合は、IssueとPull Requestの決定論的規則versionを上げます。

## 永続stateの形式を変更する

snapshot、履歴、通知管理記録の保存形式や列挙値は、次の順序で変更します。

1. 対象文書のschema versionを上げる。
2. 対応する旧versionから現行形式への一方向のマイグレーションを追加し、保存側も現行形式へそろえる。
3. CLIをビルドし、コミットIDを固定した`tracker-state`のコピーを移行して検証する。
4. 実際の保存経路で保存し、再読み込みと再実行で追加の移行が発生しないことを確認する。

```console
pnpm build
pnpm tracker:run verify-state --state-directory path/to/tracker-state/state --state-revision COMMIT_SHA
```

移行の入口で旧形式を検証し、業務処理には現行の型だけを渡します。
未知のversionや不正なデータは例外にし、形式の番号だけを書き換えて受け入れません。
再生成できる旧cacheは、対応する形式と保存先を識別して削除できます。
再利用するcacheは現行形式として検証します。
snapshotの更新と旧cacheの削除は同じcommitに含め、GitHubへの反映まで確認して移行完了とします。
読み込みや`verify-state`だけでは本番stateを書き換えません。

CIの`verify-state`は、本番と同じ移行処理を使ってstate全体を検証し、対象のコミットIDと移行内容をログへ残します。
マージ前の確認では、コピー上で保存失敗と再試行も確かめます。
検証用コードはコミットしません。

移行だけでAIの採用値や通知管理記録を失わせません。
旧AI結果へ現在のrevisionや入力hashを後付けせず、再推論の成功と採用が確定するまで、引き継いだ値と新しい生成結果を区別します。
初回の再計画、AIの失敗・延期後の再試行、無関係な採用値が変わらないことも確認してください。
保存形式の移行完了とAIの再推論完了は別に判断します。
保存形式を変えないプロンプト変更には、要素ごとのrevisionと再推論の規則を使います。

通常読み込む履歴や、復旧を保証する保存点に旧形式が残る間は、その形式からの移行処理を残します。
対応versionと復旧用のコード・stateの保存点を更新時に記録し、保証対象から外す判断をしてから不要な移行処理を削除します。
本番への切替と通知の保留は[運用手順](OPERATIONS.md)に従います。

## ディレクトリ構成

| パス                               | 責務                                                                                                 |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `src/cli/`                         | 引数解析、実アダプターの合成、applicationへのdispatch                                                |
| `src/application/tracking-run/`    | 日次runの閉じた値、proof型、副作用を要求するport契約                                                 |
| `src/canonical-json/`              | pure leafでcanonical JSON直列化とSHA-256値を検証し、`index.ts`からNode.js hashを公開する             |
| `src/codex/`                       | 分析候補選定、予算、cache、隔離process、schema検証、semantic検証、reducer                            |
| `src/config/`                      | `config.yml`の読み込みとZod schema検証                                                               |
| `src/diagnostics/`                 | 詳細診断のJSONL記録、Error直列化、暗号化、復号                                                       |
| `src/discord/`                     | 通知候補選別、通知管理記録による重複抑制、payload生成、Webhook送信                                   |
| `src/domain/`                      | 状態機械、maintainerとlabelの解決、追跡選定、停滞時間、停滞レベル、重要度、要対応度のpure TypeScript |
| `src/github/`                      | GitHub App認証、読み取り専用API、収集、正規化、公開allowlist、rate limit管理                         |
| `src/graph/`                       | 関係候補、edge reconcile、cycle、frontier、downstream impactのpure TypeScript                        |
| `src/infrastructure/tracking-run/` | GitHub・Codex・Git・Pages・Discord・時計・digestのport実装とworkflowへの接続                         |
| `src/pages/`                       | 独立した公開guard、公開DTO生成、gzip上限検査、JSON出力                                               |
| `src/performance/`                 | 外部接続をモックした日次runの処理時間、API使用率、AI論理call数、summaryサイズのprofile               |
| `src/persistence/`                 | snapshot、履歴、AI cache、通知管理記録、run report、state branch transaction                         |
| `src/util/`                        | null検査、到達不能検査、共通エラー、Zod診断                                                          |
| `web/`                             | ViteとPreactによる静的Web UIとサンプル公開DTO                                                        |
| `fixtures/`                        | 性能profileへ渡す固定入力                                                                            |
| `schemas/`                         | Codex分析出力とsnapshotのJSON Schema                                                                 |
| `prompts/`                         | Codexへ渡す固定system prompt                                                                         |
| `docs/`                            | 要求定義、アーキテクチャ、デプロイ、運用、開発手順、調査資料                                         |
| `.github/workflows/`               | CI、日次run、性能profile、マージゲートのGitHub Actions workflow                                      |

## コードの方針

[実装方針](../AGENTS.md)が判断の基準です。
実装するときは次の境界を守ってください。

`src/domain`と`src/graph`はネットワークやファイルシステムへ依存しないpure TypeScriptにします。
同じ入力から同じ結果を返す処理だけを置き、pureな判定層から副作用のあるadapterを呼びません。
`src/application/tracking-run`はCLI、環境変数、ファイルシステム、副作用を持つbarrelを参照せず、pureなleafとport契約だけを使います。
段階のcore型は`CoreByStage`で段階名に対応付け、inventory以後へbase state全体やCLI requestを引き継ぎません。
公開repositoryの選定はinventory portで一度だけ行い、下流は確定済みallowlistをそのまま使います。
checkpoint、artifact、receiptのdigest計算は`ContentDigestPort`を通して`src/infrastructure/tracking-run`へ置きます。
sourceの1000行上限はTypeScriptとJavaScriptをESLint、shell、CSS、Vue、Python、workflow YAMLを`check:source-lines`で確認します。
GitHub、Codex、永続化、Pages、Discordへの副作用はそれぞれのadapterへ閉じ込め、一つのrunとしての順序制御はapplicationのcanonical engineで行います。

GitHub由来の本文、コメント、label、ユーザー名は信頼できない入力として扱い、命令として解釈しません。
Codex出力は候補データとしてschema検証とsemantic検証を通し、状態や外部サービスへ直接反映しません。
追跡対象repositoryへの書き込みは実装しません。

想定外の値では例外を投げ、握りつぶさずerror boundaryまで伝播させます。
別のエラーへ変換するときは`cause`で元のエラーをつなぎます。
外部入力はZodで検証し、型アサーションとnon-null assertionは使いません。

## Web UIの表示・UX

ページ間で変える理由がない表示は変えません。

利用者向けの説明では、内部の列挙値やフィールド名をそのまま表示せず、意味を直接表す日本語を使います。
英字やカタカナの用語は、日本語文化圏で広く使われている場合、固有名やサービス名である場合、外部サービスの正式な用語を保つ必要がある場合に限って使います。
用語ごとの許可一覧は作らず、想定する利用者が説明なしで意味を理解できるかで判断します。
同じ概念には同じ表現を使い、通知条件では通知対象、抑制条件、再通知条件が読み取れるようにします。
既存の表示へ適用するときは変更対象の画面や説明に範囲を絞り、全件を一括置換しません。

Web UI全体のリンク先は、[要求仕様の`WEB-019`](REQUIREMENTS.md#1110-webページ)に従います。
項目詳細へのリンクには`ItemDetailsLink`を使います。
GitHubへのリンクには`GitHubIconButton`を使うか、`SafeGitHubLink`に「GitHubで開く」などの文言を表示します。
内部詳細がない項目の参照やタイトルはテキストで表示します。

項目一覧 `/` と担当者個別 `/people/{ユーザー名}` の項目一覧では、次の規約を守ります。

- マージ済み、完了、対応しないの項目は既定で表示せず、トップページの状態で「すべて」を選ぶと表示します。
- `ResponsiveTableCardList`は画面幅だけで表とカードを切り替え、ページの種類では切り替えません。
- 切り替え幅は`breakpoint`で呼び出し側が明示します。
- 並び順の選択UIはカードを表示する幅でだけ表示し、`ResponsiveTableCardList`と同じ`breakpoint`で隠します。
- 表の列は「項目、待ち相手と状態、要対応度、重要度、停滞時間」の順に置きます。
- カードのフィールドも表の列と同じ順に置きます。
- 待ち相手と状態は、主な待ち相手、状態、主候補の理由の順に表示します。理由が空なら理由の段を省きます。
- 複数の待ち相手がいる場合は主候補だけを表示し、残りは件数で示します。
- 待ち相手の表示は`model-waiting-on.ts`で文字列とユーザー名の断片へ分け、文字列が必要な処理と画面表示を同じ断片から組み立てます。
- 個人のユーザー名は共通部品で人ごとのページへリンクし、teamはリンクにしません。
- 項目一覧のユーザー名には20px、担当者一覧のユーザー名には24px、人ページの見出しには40pxのGitHubアバターを添えます。項目詳細には添えません。
- アバターURLはユーザー名を`encodeURIComponent`へ通して`https://github.com/{ユーザー名}.png?size=48`の形で組み立てます。
- アバターは空の`alt`、`loading="lazy"`、`decoding="async"`、数値の`width`と`height`を持たせ、読み込み失敗時も隣のユーザー名だけで人物を識別できるようにします。
- teamにはアバターを表示しません。
- 人ページには既存のGitHubマークと文字を並べたGitHubプロフィールリンクを置き、安全な外部リンクとして新しいタブで開きます。
- トップページの主候補は`primaryWaitingOn.index`を使い、`not_applicable`では先頭候補を使います。
- 担当者個別では閲覧者本人または選択した所属teamに対応する先頭候補を使います。
- 項目見出しには共通部品の`ItemListHeading`を使います。
- 項目見出しの1行目には題名、AI警告アイコン、GitHubアイコンボタンを順に置きます。
- 項目見出しの2行目には`owner/repo#123`、種別、古い観測値のバッジを順に置きます。
- 題名の文字サイズと太さは、どのページでも、表でもカードでも同じにします。
- 一覧の要対応度と重要度はlevel名を省き、項目詳細と同じ書式の点数だけを表示します。
- 項目詳細の要対応度と重要度はlevel名と点数の両方を表示します。
- 要対応度のバッジは塗り、重要度のバッジは枠線で表し、色を見分けられなくても二つの指標を区別できるようにします。
- 重要度が低の場合もバッジを表示し、未算出と区別します。
- 表は固定レイアウトにし、項目を最も広く、待ち相手と状態を次に広くします。数値列は狭くして等幅数字を中央へ揃えます。
- GitHubアイコンボタンは、項目見出しでは題名の隣、現在の実装Pull Requestでは参照の隣に置きます。操作領域は44px以上にします。
- 一覧の件数と選択中の並び替えキー名を要約表示しません。
- サイト名は`text-base font-semibold`、ページ見出しは`text-lg font-semibold`で統一し、見出しレベルは表示サイズと分けて決めます。
- 操作方法だけを説明する文章はページ見出しや一覧操作の周囲へ置きません。
- 観測時刻は公開データ全体の属性として、共通ヘッダーの「最新更新」へ一か所だけ表示します。
- 共通フッターはrun IDだけを表示します。
- 表の列見出しは画面上端に固定します。
- 絞り込みなどで待ち相手だけを指す表示は「待ち相手」、一覧の複合列は「待ち相手と状態」、要対応度を指す表示は「要対応度」に統一します。
- CSPの`img-src`は同一origin、data URL、`github.com`、`avatars.githubusercontent.com`だけを許可し、他のディレクティブは画像表示のために広げません。

## Web UIのスタイル

Tailwind CSSでスタイルを書きます。
`web/src/styles.css`にはトークン定義と全体の既定だけを置き、ページ固有の規則を足しません。

色とフォントサイズとブレークポイントは`@theme`のトークンを使います。
トークンは役割で名付けてあるので、`bg-surface-card`や`text-state-danger-text`のように意味で選びます。
生成りのページとカードに深緑のアクセントを合わせ、OSの設定に応じてライトテーマとダークテーマを提供します。
本文は端末のゴシック体、サイト名とページや項目詳細の見出しは`font-display`、点数や時間や件数は`font-mono`を使います。
Webフォントは読み込みません。
余白と角丸と影はTailwindの既定スケールへ寄せ、`clamp()`のように既定で表せないものだけ`@theme`へ足します。
カードとセクションは`rounded-2xl`で揃え、表とカード一覧だけに薄い影を付けます。
IssueとPull Requestの種別はそれぞれsuccess系とinfo系、状態はneutral系のピルで表示します。
操作できる要素は幅の狭い画面でも押せるよう、最小高さを44pxにします。

繰り返し現れる見た目は共通部品にします。

| 部品                      | 用途                                     |
| ------------------------- | ---------------------------------------- |
| `PageSection`             | カードと見出しを備えたページ内セクション |
| `ContentState`            | 空状態、読み込み中、読み込み失敗         |
| `ResponsiveTableCardList` | 広い画面のtableと狭い画面のcard一覧      |
| `Pill`                    | 意味に対応する配色のpill型label          |
| `ActionButton`            | 操作button                               |

## Pull Requestを出す前に

CIと同じ検査を手元で実行します。

```console
pnpm typecheck
pnpm lint
pnpm check:source-lines
pnpm format:check
pnpm build
pnpm build:workflow-cli
pnpm build:web
```

`format:check`が失敗した場合は`pnpm format`で整形し、意図しないファイルまで変わっていないことを確認します。
参照先の型を変更した場合も、`pnpm lint`で型情報を使うESLint規則を確認します。
サンプル公開DTOを実データで上書きしたままにしていないかも確認してください。

外部サービスを使った確認、sandboxの連続run、通知actionの確認結果は、実行IDと証拠artifactを別途レビューへ記載します。
静的確認の成功だけで外部確認も完了したとは扱いません。
