# VOICEVOX Task Tracker 要件定義書

- 対象リポジトリ: `VOICEVOX/voicevox_task_tracker`
- 文書版: 1.0-draft
- 調査基準日: 2026-07-30（JST）
- 実装言語制約: Node.js + TypeScript
- AI backend制約: OpenAI Codexのみ（初期リリース）

## 1. 文書の位置づけ

本書は、VOICEVOX Organization全体の公開Issue/PRについて、**現在の状態、次に行動すべき主体、停滞時間、依存関係、重要な変化**を自動整理し、GitHub PagesとDiscordへ提示するシステムの要件を定義する。

要求文の `MUST` / `SHOULD` は RFC 2119・RFC 8174の規範語として用いる。本書は、要求の識別可能性・検証可能性・追跡可能性を重視するISO/IEC/IEEE 29148系の考え方、NASA Software Engineering Handbookの要求・受入基準・双方向トレーサビリティの実務例を参考に、VOICEVOX向けへ具体化した。全文標準を転載するものではない。

Snapshotデータモデルの正本は[snapshot schema](../schemas/snapshot.schema.json)、構成と処理境界の詳細は[アーキテクチャ](ARCHITECTURE.md)、実運用の設定値は[config.yml](../config.yml)とする。本書ではこれらの定義を重複して掲載しない。

## 2. 背景と問題

VOICEVOXではEditor、Engine、Core、モデル・ランタイム・追加ライブラリ・ブログ等に作業が分散し、次の問題が同時に起きる。

1. Issue/PRの最終更新は分かっても、**誰の行動を待っているか**が分からない。
2. 本文のチェックリスト、コメント、レビュー、別repoのIssueなどに依存関係が分散し、native dependencyが設定されていない場合がある。
3. botコメントやpreview更新で`updated_at`が進み、実質的な停滞が隠れる。
4. 依存先が完了しても、依存元本文の未チェック項目が残り、再開可能になったことを見落とす。
5. 全件通知では疲弊する一方、triage忘れや長期停止は早く知りたい。

## 3. 実データ調査から得た設計上の結論

調査したIssueとPR、観察内容は[Research SourcesのVOICEVOX実例](RESEARCH_SOURCES.md#voicevox実例)を参照。

実例から次の設計判断を導いた。

- 本文の記載だけでなく、隣接nodeの最新stateを伝播し、依存解消時に依存元を再判定する。
- checklistとindentからrelation候補を抽出し、native relationと区別して曖昧な関係だけをCodexで判定する。
- bot activityを進捗扱いせず、latest headとhuman reviewの前後関係でauthor待ちとreviewer待ちを決める。
- botをボール所有者にせず、承認、merge readiness、未解決human threadを別々に評価する。
- 追跡とgraph利用をDiscordのnoise抑制から分離する。
- assigneeだけでなく、未回答の明示依頼をCodexで根拠付き判定する。

このため、システムは「GitHubの確定情報による状態機械」＋「曖昧な自然言語関係だけを判定するCodex」＋「型付き依存グラフ」の三層とする。

## 4. 目的と成功指標

### 4.1 目的

- 朝の短時間で、止まっている重要項目と次の担当を把握できる。
- repoを越えた依存の末端、再開可能項目、循環を見つけられる。
- 判定が誤っていても、なぜそう判断したかをGitHub上の根拠へ遡れる。
- botがGitHub上の運用を勝手に変更せず、既存のコメント・ラベル・review運用を正本にする。

### 4.2 運用KPI（初期目標）

- 追跡中open項目の90%以上で、`waitingOn=unknown`以外を根拠付き表示できる。
- 48時間を超えた未triage項目をgolden fixture上で100%検出する。
- daily digestは通常10項目以下とし、同一理由の不要な連日再送を行わない。
- private/internal repo由来データの公開件数を常に0件とする。
- 固定AI出力を使うgolden fixtureの処理結果について、critical/urgent recallを95%以上、誤通知率を10%以下に保つ。

## 5. スコープ

### 5.1 対象

- VOICEVOX Organizationの全public・non-archived・non-disabled repository
- GitHub Issue、Pull Request、Issue/PR timeline、comments、reviews、review threads、review requests、commits、checks、native dependencies、sub-issues、cross-references
- GitHub Pages上の公開static site
- Discord public channelへのIncoming Webhook通知
- Git branchによるstate/history/cache/notification ledgerの永続化

### 5.2 対象外

- GitHub Discussions
- GitHub Projectsを正本とする運用
- 対象Issue/PRへのlabel追加・変更、comment投稿、assign、review request、close/merge
- Codexによるrepository code実装・修正
- private/internal repositoryの内容
- Discord上での対話型bot操作（v1）

## 6. 用語

| 用語                | 定義                                                                 |
| ------------------- | -------------------------------------------------------------------- |
| tracked item        | 追跡対象に入ったIssueまたはPR                                        |
| waitingOn           | 次に状態を進める行動が期待される主体                                 |
| ball / ボール       | waitingOnと同義の運用上の表現                                        |
| statusSince         | 現在statusへ遷移した時刻                                             |
| ownerSince          | 現在waitingOnへ遷移した時刻                                          |
| stallSince          | 現在の待ち状態で意味のある進捗か責務主体本人の活動が最後に起きた時刻 |
| meaningful progress | push、回答、review、決定、依存解消など、次工程を進める変化           |
| authoritative edge  | GitHub native dependency/sub-issue等、AIより優先するrelation         |
| inferred edge       | 本文・コメント・link候補をCodexが関係ありと判定したrelation          |
| actionable frontier | openなincoming `blocks` edgeを持たず、今着手可能な非terminal node    |
| downstream impact   | そのnodeが止めているopen node/repoの直接・推移的規模                 |
| stale repo          | 今回取得に失敗し、前回値しかないrepo                                 |

## 7. 推奨状態モデル

### 7.1 status enum

- `new_untriaged`
- `needs_maintainer_decision`
- `waiting_for_review`
- `waiting_for_author`
- `waiting_for_assignee`
- `blocked`
- `waiting_for_automation`
- `ready_to_merge`
- `in_progress`
- `unknown`
- `terminal_merged`
- `terminal_completed`
- `terminal_not_planned`

### 7.2 waitingOn enum

`user`、`team`、`role`（author/maintainer/reviewer/assignee）、`item`、`automation`、`unknown`。複数blockerや複数assigneeを表せる配列とし、UI・通知用にprimaryを1つ選ぶ。

### 7.3 PR判定の既定優先順位

1. merged/closedならterminal。
2. authoritativeまたは高信頼のopen blockerがあれば`blocked`。
3. merge queue/auto-merge/required checks実行中なら`waiting_for_automation`。
4. latest head以後のhuman `CHANGES_REQUESTED`ならauthor待ち。
5. 未解決human review threadのうち最後のhumanコメントがauthor以外のものがあればauthor待ち。
6. 変更要求後にauthor push済みなら再review側を評価。
7. 現行review requestがあればrequested user/team待ち。
8. draftは原則author待ち。ただし明示的判断依頼・blockerを優先。
9. 必要承認/checks済みなら`ready_to_merge`＋maintainer待ち。
10. ready-for-reviewでreview未依頼ならmaintainer待ち。
11. CI失敗・コメント意味等が曖昧な場合だけCodexへ渡す。

4、5、6、7で待ち先を決めた後、その待ち先本人が責務の起点より後に本文のある発言をしていれば、発言の意味を解釈しないと責務を確定できない。決定論的な待ち先を既定として残したままCodexへ渡す。5では、未解決threadの最後のhumanコメントに本文がある場合も同じ扱いとする。そのコメントがauthorの対応を求めるとは限らないためである。

### 7.4 Issue判定の既定優先順位

1. closedならterminal。
2. open blockerがあれば`blocked`。
3. 最新の未回答な明示依頼があれば相手待ち。
4. assigneeがいればassignee待ち。
5. それ以外の未アサインIssueはmaintainer待ち。
6. 作成者がmaintainerでも、次担当不明ならmaintainer責務のまま。

## 8. 停滞時間・severity既定値

すべて内部UTC、表示JST。日数は営業日ではなく連続時間で計算する。`updated_at`は参考値であり、severity clockの正本にしない。

| wait class                        | watch | urgent | critical | 主な扱い                             |
| --------------------------------- | ----: | -----: | -------: | ------------------------------------ |
| maintainer triage / owner unknown |   48h |    96h |     168h | 「丸2日」を最初の通知境界とする      |
| reviewer                          |   48h |   120h |     240h | review requestから計時               |
| author after changes requested    |   72h |   168h |     336h | author pushでreviewer側へ遷移可能    |
| assignee/in progress              |  168h |   336h |     720h | 実装作業の長さを考慮                 |
| ready to merge                    |   24h |    72h |     168h | merge decisionの見落としを早めに検出 |
| automation                        |    6h |    24h |      72h | 通常のCI時間は通知しない             |

blocked parentは「親自身を毎日催促」せず、blockerのseverityとdownstream impactを通知順位へ使う。priority labelはseverityを最大1段階引き上げられるが、低信頼AIだけでcriticalへ引き上げない。

## 9. Discord選別既定

通知する主な変化:

- severityがwatch/urgent/criticalへ初めて上がった。
- 未triage・owner unknownが48時間を超えた。
- human `CHANGES_REQUESTED`後のauthor待ちが長期化した。
- high-impact blockerがurgent以上になった。
- 依存解消で重要項目が`newly_unblocked`になった。
- blocks cycleが新たに発生した。
- 2日以上停止後にwaitingOnが変わった。

既定で除外するもの:

- 直近24時間にmeaningful progressがある通常項目。
- bot-only activity、preview更新、Renovate dashboard定期更新。
- unchanged watch項目。
- recent draft。
- confidence<0.65のAI-only判定（owner unknown警告を除く）。

通知0件なら投稿しない。unchanged urgentは3日、criticalは2日のcooldownを置く。

## 10. 追跡対象への追加規則

1. `startAt`以後に作成されたopen項目。
2. 開始日前でも、開始後にhuman-relevant変更が起きたopen項目。
3. tracked itemから参照された、またはtracked itemを参照したOrganization内項目。
4. native dependency/sub-issueで接続した項目。
5. configで明示includeした項目。
6. `workflow_dispatch`のbackfill（linked/all-open）。

一度入った項目は古さにかかわらず同一ルールで扱う。closed/merged後も既定180日保持する。

## 11. 要求一覧

要求は合計170件である。

### 11.1 目的・成果

| ID        | 規範 | 要求                                                                                                                                        | 受入要約                                                                                                                         |
| --------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `GOL-001` | MUST | 一元的な現況把握 — 全追跡対象の現在状態を、公開Webページの1か所から把握できなければならない。                                               | `AT-GOL-001`: 異なる3リポジトリのIssue/PRを含むfixtureで、各項目の状態が同一ページから到達できる。                               |
| `GOL-002` | MUST | ボールの所在 — 各追跡項目について、次に行動すべき個人・チーム・役割・依存項目・自動処理のいずれかを示さなければならない。                   | `AT-GOL-002`: fixture全件でwaitingOnが1件以上、またはterminalであり、理由と根拠が表示される。                                    |
| `GOL-003` | MUST | 停滞検知 — 単なるGitHubのupdated_atではなく、責務が移った時点、意味のある進捗、責務主体本人の活動を基準に停滞時間を算出しなければならない。 | `AT-GOL-003`: botコメントのみ追加したfixtureでstallSinceが変化せず、人間の責務移動イベントでは変化する。                         |
| `GOL-004` | MUST | 依存関係の可視化 — リポジトリをまたぐブロッカー、親子、実装、関連関係を型付きグラフとして可視化しなければならない。                         | `AT-GOL-004`: 3リポジトリ以上をまたぐグラフfixtureで、型・向き・根拠が確認できる。                                               |
| `GOL-005` | MUST | 高シグナル通知 — 毎日のDiscord通知は、行動が必要な項目を選別し、全件羅列を避けなければならない。                                            | `AT-GOL-005`: 通常項目50件・要対応3件のfixtureで、Discord候補は要対応中心かつ設定上限以内となる。                                |
| `GOL-006` | MUST | 監査可能性 — 各判定は、入力イベント、ルール、AI出力、信頼度、変更履歴まで追跡可能でなければならない。                                       | `AT-GOL-006`: 任意の項目から判定根拠と前回との差分へ到達できる。                                                                 |
| `GOL-007` | MUST | 読み取り専用運用 — 追跡対象リポジトリのIssue、PR、コメント、ラベル、アサイン、レビュー依頼を変更してはならない。                            | `AT-GOL-007`: 統合テストで対象リポジトリへのwrite API呼び出しが0件である。                                                       |
| `GOL-008` | MUST | 決定論優先 — GitHubの確定情報と定式ルールを先に適用し、Codexは変更された曖昧部分の補助に限定しなければならない。                            | `AT-GOL-008`: 明確なレビュー依頼fixtureではAI呼び出しなしで同一結果が得られる。                                                  |
| `GOL-009` | MUST | 走査時刻からの独立 — 停滞起点はGitHub由来の時刻だけから決めなければならない。走査した時刻や過去に走査した回数を起点へ持ち込んではならない。 | `AT-GOL-009`: 同一fixtureをrun開始時刻だけ数ヶ月ずらして2回判定し、全項目の`statusSince`、`ownerSince`、`stallSince`が一致する。 |

### 11.2 スコープ

| ID        | 規範   | 要求                                                                                                                                                | 受入要約                                                                                                         |
| --------- | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `SCP-001` | MUST   | 対象Organization — 対象OrganizationはVOICEVOXでなければならない。                                                                                   | `AT-SCP-001`: 設定のorganizationがVOICEVOX以外なら起動前検証が失敗する。                                         |
| `SCP-002` | MUST   | 公開リポジトリ限定 — visibilityがpublicのリポジトリだけを追跡・保存・公開しなければならない。                                                       | `AT-SCP-002`: private/internalを混ぜたfixtureで、その項目が収集後・state・Pagesの全段階に存在しない。            |
| `SCP-003` | MUST   | archive除外 — archived=trueのリポジトリを追跡対象から除外しなければならない。                                                                       | `AT-SCP-003`: archive状態変更後の次回実行でアクティブ対象から外れ、履歴には理由が残る。                          |
| `SCP-004` | MUST   | 動的発見 — 対象リポジトリ一覧を固定せず、毎回Organization APIからページネーションして発見しなければならない。                                       | `AT-SCP-004`: 新しいpublic/non-archived repo fixtureが設定変更なしで次回実行に含まれる。                         |
| `SCP-005` | MUST   | Issue対象 — 対象リポジトリのIssueを追跡できなければならない。                                                                                       | `AT-SCP-005`: open Issue fixtureが正規化ノードとして保存される。                                                 |
| `SCP-006` | MUST   | Pull Request対象 — 対象リポジトリのPull RequestをIssueと区別して追跡できなければならない。                                                          | `AT-SCP-006`: REST issues応答に含まれるPRを二重計上せずPRノードに分類する。                                      |
| `SCP-007` | MUST   | Discussions除外 — GitHub Discussionsを収集・表示・通知対象にしてはならない。                                                                        | `AT-SCP-007`: Discussion fixtureがstateに入らない。                                                              |
| `SCP-008` | MUST   | Projects非依存 — GitHub Projectsを状態の正本または必須連携先にしてはならない。                                                                      | `AT-SCP-008`: Project権限・Projectデータなしで全受入試験が成功する。                                             |
| `SCP-009` | SHOULD | 外部依存のゴースト表示 — VOICEVOX外のpublic項目がブロッカーとして参照された場合、再帰追跡せず説明用ゴーストノードとして表示すべきである。           | `AT-SCP-009`: 外部public URL fixtureが最小メタデータのghost nodeとなり、通知責務の直接対象にならない。           |
| `SCP-010` | MUST   | bot作成項目の同等扱い — botが作成したIssue/PRを作成者だけを理由に特別扱いしてはならない。                                                           | `AT-SCP-010`: 同一内容のhuman作成・bot作成fixtureで、作成者種別以外の判定結果が一致する。                        |
| `SCP-011` | MUST   | 外部参照の公開条件 — VOICEVOX外の参照先もpublic・non-archived・non-disabledの場合だけ関係候補として扱い、除外対象をstateとPagesへ残してはならない。 | `AT-SCP-011`: 通常、archive済み、disabledの外部repository参照fixtureで通常の参照だけが候補、state、Pagesに残る。 |

### 11.3 設定

| ID        | 規範 | 要求                                                                                                                                                  | 受入要約                                                                                      |
| --------- | ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `CFG-001` | MUST | 設定schema version — 設定ファイルにschemaVersionを持ち、未知のmajor versionを拒否しなければならない。                                                 | `AT-CFG-001`: 未対応majorの設定で明示的エラーとなり処理を開始しない。                         |
| `CFG-002` | MUST | 既定メンテナーチーム — Organization共通の既定メンテナーチームをteam slugで設定できなければならない。                                                  | `AT-CFG-002`: 既定値のみのrepoでメンテナーロールが当該teamへ解決される。                      |
| `CFG-003` | MUST | 既定レビュワーチーム — Organization共通の既定レビュワーチームをteam slugで設定できなければならない。                                                  | `AT-CFG-003`: 既定値のみのrepoでレビュワーロールが当該teamへ解決される。                      |
| `CFG-004` | MUST | リポジトリ別上書き — 例外リポジトリだけメンテナー・レビュワーチームを上書きできなければならない。                                                     | `AT-CFG-004`: 2 repo fixtureで一方は既定、一方はoverrideが適用される。                        |
| `CFG-005` | MUST | 未設定チームの安全停止 — 必須team slugがplaceholder・空・取得不能の場合、誤った個人推定をせず設定エラーとして扱わなければならない。                   | `AT-CFG-005`: 存在しないslugで公開・通知が行われず、診断が出る。                              |
| `CFG-006` | MUST | 既存ラベル意味付け — 既存ラベルを優先度・要議論・通知抑制等へ読み替えるルールをrepo glob付きで設定できなければならない。                              | `AT-CFG-006`: 同名ラベルをrepo別に異なる意味へ割り当てられる。                                |
| `CFG-007` | MUST | bot識別設定 — bot login、末尾パターン、明示allow/denyを設定できなければならない。                                                                     | `AT-CFG-007`: 既知bot・未知human・例外bot fixtureが期待通り分類される。                       |
| `CFG-008` | MUST | 追跡開始日時 — tracking.startAtをISO 8601で設定・永続化できなければならない。                                                                         | `AT-CFG-008`: timezone付き日時がUTC正規化され、再実行で変化しない。                           |
| `CFG-009` | MUST | 手動includeと追跡追加上限 — 古い項目の明示include、repo filter、backfill上限、`tracking.relationExpansion.maxItemsPerRun`を設定できなければならない。 | `AT-CFG-009`: 開始日前の指定URLだけをincludeでき、関係先展開上限がAPI呼び出し前に適用される。 |
| `CFG-010` | MUST | Discordメンション設定 — GitHub loginとDiscord user IDの対応、mentions.enabled、許可対象を設定でき、既定は無効でなければならない。                     | `AT-CFG-010`: 既定payloadのallowed_mentionsが空で、enabled時も許可ID以外をmentionしない。     |

### 11.4 GitHub収集

| ID        | 規範 | 要求                                                                                                                                                   | 受入要約                                                                                              |
| --------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| `COL-001` | MUST | GitHub App認証 — 日次収集はGitHub App installation tokenで認証できなければならない。                                                                   | `AT-COL-001`: App ID/private keyから短寿命tokenを取得してAPI疎通できる。                              |
| `COL-002` | MUST | 読み取り最小権限 — 収集用GitHub Appは必要なrepository/organization read権限だけを要求しなければならない。                                              | `AT-COL-002`: 権限一覧に対象repoへのwrite権限が存在しない。                                           |
| `COL-003` | MUST | repo一覧ページネーション — Organizationの全repoページを取得しなければならない。                                                                        | `AT-COL-003`: 100件超fixtureでも最終ページまで欠落なく取得する。                                      |
| `COL-004` | MUST | 公開境界での即時フィルタ — repoメタデータ取得直後にpublic・non-archived・non-disabledを検証し、それ以前にIssue本文等を取得してはならない。             | `AT-COL-004`: private repo fixtureではrepo metadata以外のAPIが呼ばれない。                            |
| `COL-005` | MUST | 項目一覧ページネーション — 各repoのopen Issue/PRを全ページ取得しなければならない。                                                                     | `AT-COL-005`: 100件超のopen item fixtureで件数が一致する。                                            |
| `COL-006` | MUST | 安定識別子 — GitHub global node IDを主識別子として保持し、owner/repo#numberとURLを表示用別名として保持しなければならない。                             | `AT-COL-006`: repo rename fixtureで履歴が別ノードに分裂しない。                                       |
| `COL-007` | MUST | 基本メタデータ — title、body fingerprint、author、created/updated/closed、state reason、draft、assignees、labels、milestoneを取得しなければならない。  | `AT-COL-007`: schema必須フィールドがfixtureから欠落なく正規化される。                                 |
| `COL-008` | MUST | Issueコメント — 追跡Issueの全human-relevant issue commentsをページネーションして取得しなければならない。                                               | `AT-COL-008`: 100件超コメントfixtureで順序・IDが保持される。                                          |
| `COL-009` | MUST | PRレビュー — PR review submissionのstate、actor、commit、timeを取得しなければならない。                                                                | `AT-COL-009`: APPROVED/CHANGES_REQUESTED/DISMISSED fixtureを区別する。                                |
| `COL-010` | MUST | レビューthread — inline review threadとresolved状態を取得しなければならない。                                                                          | `AT-COL-010`: resolved/unresolved threadが別信号になる。                                              |
| `COL-011` | MUST | レビュー依頼 — requested user reviewerとrequested team reviewer、追加・解除時刻を取得しなければならない。                                              | `AT-COL-011`: request→remove fixtureで現行依頼だけがwaitingOn候補となる。                             |
| `COL-012` | MUST | PR push検知 — head SHA、commit時刻、force-push相当のtimeline変化を取得しなければならない。                                                             | `AT-COL-012`: review後push fixtureで最新headと時系列が判定に渡る。                                    |
| `COL-013` | MUST | merge/CI状態 — mergeability、merge state、auto-merge、merge queue相当、check run/statusを可能な範囲で取得しなければならない。                          | `AT-COL-013`: ready/running/failing/conflict fixtureを区別する。                                      |
| `COL-014` | MUST | timelineイベント — assigned、unassigned、labeled、unlabeled、review requested、ready for review、cross-reference等のtimelineを取得しなければならない。 | `AT-COL-014`: イベントfixtureが安定ID付き正規化イベントになる。                                       |
| `COL-015` | MUST | native dependency — GitHubのnative issue dependencyを利用可能な場合に取得しなければならない。                                                          | `AT-COL-015`: blocked-by/blocking fixtureがauthoritative edgeになる。                                 |
| `COL-016` | MUST | sub-issue — GitHubのsub-issue/parent関係を利用可能な場合に取得しなければならない。                                                                     | `AT-COL-016`: parent/sub-issue fixtureがauthoritative hierarchyになる。                               |
| `COL-017` | MUST | inbound cross-reference — 追跡項目へ別Issue/PRからリンクされたcross-referenceを検出し、source itemを候補に加えなければならない。                       | `AT-COL-017`: 新規sourceがtracked targetへリンクするfixtureでsourceが発見される。                     |
| `COL-018` | MUST | 変更種別保持 — コメント、push、review、review request、label、assignee、state、relationの変更種別を区別して保存しなければならない。                    | `AT-COL-018`: 同一updated_at変化でもevent kind別に出力される。                                        |
| `COL-019` | MUST | 増分収集 — 前回成功時刻とitem fingerprintを使い、変更項目だけ詳細再取得できなければならない。                                                          | `AT-COL-019`: 1000項目中10変更fixtureで詳細取得が変更10件と依存隣接だけに限定される。                 |
| `COL-020` | MUST | 重複防止とoverlap — 取りこぼし防止の時間overlapを持ち、event IDで重複排除しなければならない。                                                          | `AT-COL-020`: 同一eventを2回含むoverlap fixtureで1件になる。                                          |
| `COL-021` | MUST | rate limit管理 — GitHub rate-limit headers/GraphQL costを監視し、安全余裕を残して収集計画を調整しなければならない。                                    | `AT-COL-021`: 残量閾値以下のfixtureでAI前にcheckpoint/停止し、部分公開しない。                        |
| `COL-022` | MUST | repo単位stale処理 — 一時的に取得不能なrepoをstaleとして明示し、前回値と取得時刻を保持しつつ誤った最新値として扱ってはならない。                        | `AT-COL-022`: 1 repoだけ503のfixtureで全体は診断付き、当該repoはstale表示され通知判定から除外される。 |

### 11.5 追跡ライフサイクル

| ID        | 規範 | 要求                                                                                                                                                                      | 受入要約                                                                          |
| --------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `TRK-001` | MUST | 初回startAt確定 — tracking.startAtが未指定なら、最初の完全成功時刻を確定してstateへ保存しなければならない。                                                               | `AT-TRK-001`: 初回失敗では確定せず、初回成功で一度だけ確定する。                  |
| `TRK-002` | MUST | 開始日以後の新規項目 — startAt以後に作成されたopen Issue/PRを自動追跡しなければならない。                                                                                 | `AT-TRK-002`: 境界前後1秒のfixtureで後だけ自動includeされる。                     |
| `TRK-003` | MUST | 開始日前でも新規活動 — startAt前作成でもstartAt後にhuman-relevant変更があったopen項目を自動追跡しなければならない。                                                       | `AT-TRK-003`: 古いIssueへの新規human comment fixtureがincludeされる。             |
| `TRK-004` | MUST | trackedから参照された古い項目 — tracked itemが参照する同Organizationの古い項目をrelation candidateとして追跡へ加えなければならない。                                      | `AT-TRK-004`: 開始日前blocker URL fixtureがincludeされる。                        |
| `TRK-005` | MUST | trackedを参照する古い項目 — cross-referenceによりtracked itemを参照した古いsource itemを追跡へ加えなければならない。                                                      | `AT-TRK-005`: 開始日前sourceの新規cross-reference fixtureがincludeされる。        |
| `TRK-006` | MUST | native関係の再帰include — native dependency/sub-issueで接続するOrganization内項目を設定深度まで再帰includeしなければならない。                                            | `AT-TRK-006`: 深度3 fixtureで上限どおりincludeされ無限巡回しない。                |
| `TRK-007` | MUST | 明示include — 設定したIssue/PR URLまたはnode IDを作成日時に関係なく追跡できなければならない。                                                                             | `AT-TRK-007`: closedを含む明示URL fixtureが追跡される。                           |
| `TRK-008` | MUST | workflow_dispatch backfill — manual workflowでnone/linked/all-openのbackfill modeとrepo filterを指定できなければならない。                                                | `AT-TRK-008`: dry-run後にall-openを実行し、対象範囲だけ追加される。               |
| `TRK-009` | MUST | 古さによる差別禁止 — 一度追跡対象に入った項目は作成日時によらず同じ状態・停滞・通知ルールを適用しなければならない。                                                       | `AT-TRK-009`: 同一event historyで作成日だけ異なる2 fixtureの判定が一致する。      |
| `TRK-010` | MUST | terminal保持 — closed/merged項目を既定180日間、依存解消と履歴表示のため保持しなければならない。                                                                           | `AT-TRK-010`: close後179日は表示、retention超過後はactive datasetから退避される。 |
| `TRK-011` | MUST | terminal再分析抑制 — terminal項目は状態遷移直後を除き、本文等が変わらない限りCodex再分析・停滞通知を行ってはならない。                                                    | `AT-TRK-011`: closed unchanged fixtureでAI callとstall notificationが0件になる。  |
| `TRK-012` | MUST | automation noiseは追跡と通知を分離 — Renovate dashboard等のautomation項目を必要なら追跡・関係表示しつつ、作成者だけで削除せず通知抑制ルールを別に適用しなければならない。 | `AT-TRK-012`: automation itemがgraph nodeとして残り、既定digestからは除外される。 |

### 11.6 状態・ボール判定

| ID        | 規範 | 要求                                                                                                                                                                                                           | 受入要約                                                                                                                                  |
| --------- | ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `RSP-001` | MUST | 状態と責務の分離 — status、waitingOn、nextAction、statusSince、ownerSinceを別フィールドで保持しなければならない。                                                                                              | `AT-RSP-001`: 同一ownerでstatusだけ変わるfixtureを表現できる。                                                                            |
| `RSP-002` | MUST | 責務種別 — waitingOnはuser、team、role、item、automation、unknownを表現できなければならない。                                                                                                                  | `AT-RSP-002`: 全種別のschema fixtureがvalidationに通る。                                                                                  |
| `RSP-003` | MUST | 未アサインIssueの既定 — 明確な別根拠がない未アサインIssueは当該repoのmaintainer role待ちとしなければならない。                                                                                                 | `AT-RSP-003`: unassigned/no-request Issue fixtureがmaintainerになる。                                                                     |
| `RSP-004` | MUST | アサインIssue — 明確な別の待ち根拠がないアサイン済みIssueはassignee待ちとしなければならない。                                                                                                                  | `AT-RSP-004`: assignee 1名/複数fixtureで全員が候補となる。                                                                                |
| `RSP-005` | MUST | 未回答の明示依頼 — 最新の未回答な質問・判断依頼が個人またはteamへ向く場合、その相手を優先できなければならない。                                                                                                | `AT-RSP-005`: 本文/コメントの依頼fixtureでCodexがsource ID付きで相手を選ぶ。                                                              |
| `RSP-006` | MUST | maintainer作成でも責務維持 — maintainerが作成したIssue/PRでも次の担当が明確でなければmaintainer roleの責務としなければならない。                                                                               | `AT-RSP-006`: maintainer-authored unassigned fixtureがauthor任せにならない。                                                              |
| `RSP-007` | MUST | open blocker優先 — 確定したopen blockerがある項目はstatus=blockedとし、waitingOnにblocker itemを置かなければならない。                                                                                         | `AT-RSP-007`: open/closed blocker混在fixtureでopenだけがwaitingOnになる。                                                                 |
| `RSP-008` | MUST | draft PRの既定 — 明示的な他者待ちがないdraft PRはauthor待ちとしなければならない。                                                                                                                              | `AT-RSP-008`: recent draft fixtureがauthor/in_progressになる。                                                                            |
| `RSP-009` | MUST | draft中の明示依頼 — draftでもmaintainer判断や外部blockerを明示している場合、author既定を上書きできなければならない。                                                                                           | `AT-RSP-009`: draft + decision request fixtureでmaintainer待ちになる。                                                                    |
| `RSP-010` | MUST | レビュー未依頼PR — ready-for-reviewのPRにreview requestがなく、他の明確な待ち先もない場合はmaintainer role待ちとしなければならない。                                                                           | `AT-RSP-010`: reviewerなしPR fixtureがmaintainer triageになる。                                                                           |
| `RSP-011` | MUST | 個人レビュー依頼 — 現行requested reviewer userがいるPRは当該user待ちとしなければならない。                                                                                                                     | `AT-RSP-011`: user request fixtureでloginが表示される。                                                                                   |
| `RSP-012` | MUST | teamレビュー依頼 — 現行requested team reviewerがいるPRは当該team待ちとしなければならない。                                                                                                                     | `AT-RSP-012`: team request fixtureでteam slugが表示される。                                                                               |
| `RSP-013` | MUST | 変更要求後のauthor待ち — 最新head commit以後にhuman reviewerのCHANGES_REQUESTEDがある場合はauthor待ちとしなければならない。                                                                                    | `AT-RSP-013`: VOICEVOX/voicevox#3079型fixtureでauthor待ちになる。                                                                         |
| `RSP-014` | MUST | 変更対応push後の再review待ち — CHANGES_REQUESTED後にauthorが新しいhead commitをpushし、再対応が完了したと推定できる場合はreviewer側へ責務を戻せなければならない。                                              | `AT-RSP-014`: review→push fixtureでownerSinceがpush時刻へ変わる。                                                                         |
| `RSP-015` | MUST | 未解決human thread — 未解決のhuman review threadをactionable signalとして扱わなければならない。ただし最後のhumanコメントがauthorのthreadはauthor応答済みとみなし、author待ちの根拠にしてはならない。           | `AT-RSP-015`: unresolved human thread fixtureでresolved版よりauthor待ち優先度が高く、authorが最後に返信したthreadはauthor待ちにならない。 |
| `RSP-016` | MUST | bot review非所有 — botのreview/commentだけを理由に個人・teamのボールをbotへ移してはならない。                                                                                                                  | `AT-RSP-016`: Copilot comment fixtureでwaitingOn.kindがautomation/user botにならない。                                                    |
| `RSP-017` | MUST | 承認済みready-to-merge — 必要承認とchecksを満たしauto-merge/queue未設定のPRはmaintainerのmerge decision待ちとしなければならない。                                                                              | `AT-RSP-017`: approved/passing fixtureがready_to_merge + maintainerになる。                                                               |
| `RSP-018` | MUST | 自動merge待ち — auto-merge、merge queue、実行中required checksで人の操作が不要な間はautomation待ちとしなければならない。                                                                                       | `AT-RSP-018`: queue/running checks fixtureがautomationになり短時間の人向け通知を出さない。                                                |
| `RSP-019` | MUST | コード起因CI失敗 — PR変更に起因すると確度高く判定できるrequired check failureはauthor待ちとしなければならない。                                                                                                | `AT-RSP-019`: deterministic test failure fixtureがauthorになる。                                                                          |
| `RSP-020` | MUST | infra/flaky CI — インフラ・flakyの疑いがあるcheck failureはCodex評価し、低信頼時はmaintainer role待ちまたはunknownへ縮退しなければならない。                                                                   | `AT-RSP-020`: runner outage fixtureがauthor断定にならない。                                                                               |
| `RSP-021` | MUST | merge conflict — 他の明確な運用ルールがないmerge conflict PRはauthor待ちとしなければならない。                                                                                                                 | `AT-RSP-021`: conflicting fixtureがauthor + update branch actionになる。                                                                  |
| `RSP-022` | MUST | terminal状態 — merged、closed-completed、closed-not-plannedを区別し、いずれも人のwaitingOnを空にしなければならない。                                                                                           | `AT-RSP-022`: 3 terminal fixtureでstatus reasonが区別される。                                                                             |
| `RSP-023` | MUST | 複数blocker — 複数open blockerを同時に保持し、primary blocker選定と全一覧を表示しなければならない。                                                                                                            | `AT-RSP-023`: 3 blockers fixtureで欠落せず、primary選定理由がある。                                                                       |
| `RSP-024` | MUST | 責務遷移時刻 — waitingOnの実体またはstatusが変わった時点でownerSince/stallSinceを更新しなければならない。                                                                                                      | `AT-RSP-024`: maintainer→reviewer遷移fixtureで時刻がreview requestになる。                                                                |
| `RSP-025` | MUST | 意味のある進捗 — 単なるコメント数ではなく、成果物push、回答、レビュー、依存解消、決定等をlastProgressAtとして判定しなければならない。                                                                          | `AT-RSP-025`: 雑談コメントと回答コメントfixtureでlastProgressAtが異なる。                                                                 |
| `RSP-026` | MUST | bot activityで停滞解除禁止 — botコメント、preview URL更新、定期dashboard更新だけではstallSinceをリセットしてはならない。                                                                                       | `AT-RSP-026`: bot-only activity fixtureで停滞時間が継続する。                                                                             |
| `RSP-027` | MUST | label変更の扱い — label変更はpriority/semanticsを再計算するが、設定で進捗扱いされたlabel以外はstallSinceをリセットしてはならない。                                                                             | `AT-RSP-027`: priority label追加fixtureでseverityだけ変わりstallSinceは維持される。                                                       |
| `RSP-028` | MUST | 不確実性表示 — 責務判定にconfidence、根拠source IDs、uncertaintiesを持ち、低信頼時はunknown/推定表示へ縮退しなければならない。                                                                                 | `AT-RSP-028`: 低confidence fixtureが断定表示・高優先通知にならない。                                                                      |
| `RSP-029` | MUST | 保持者の発言による責務の反転 — 変更要求、未解決review thread、review依頼で待ち先を決めた後、その待ち先本人が責務の起点より後に本文のある発言をしている場合、発言の意味を解釈して責務を判定しなければならない。 | `AT-RSP-029`: 変更要求後にauthorが質問するfixtureで待ち先がreviewerへ移る。                                                               |
| `RSP-030` | MUST | 応答不要の発言 — 了解、謝辞、進捗報告のように相手の行動を必要としない発言だけを理由に、責務を相手へ移してはならない。                                                                                          | `AT-RSP-030`: authorが了解コメントだけを返すfixtureでauthor待ちが維持される。                                                             |
| `RSP-031` | MUST | 責務主体の活動による停滞起点 — 現在の待ち先本人がGitHub上で活動した時刻を停滞起点の下限としなければならない。第三者やbotの活動、draft戻し、merge queueの出し入れでは停滞を解除してはならない。                 | `AT-RSP-031`: 待ち先本人のコメントで停滞起点が進み、第三者のコメントでは進まない。                                                        |

### 11.7 依存グラフ

| ID        | 規範 | 要求                                                                                                                                          | 受入要約                                                                               |
| --------- | ---- | --------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `GRF-001` | MUST | node種別 — graph nodeはissue、pull_request、external_referenceを区別しなければならない。                                                      | `AT-GRF-001`: 3種fixtureが異なるshape/icon/textで識別できる。                          |
| `GRF-002` | MUST | blocks向き — blockerからblocked itemへ向くcanonical blocks edgeを保存し、blockedByを導出しなければならない。                                  | `AT-GRF-002`: AがBを待つfixtureでedge=B→A、A.blockedBy=[B]となる。                     |
| `GRF-003` | MUST | edge型 — blocks、parent_of、implements、related_to、duplicatesを区別しなければならない。                                                      | `AT-GRF-003`: 各relation fixtureが同一edge typeへ混同されない。                        |
| `GRF-004` | MUST | provenance — 各edgeにnative、explicit_text、closing_keyword、checklist、cross_reference、ai_inference等のprovenanceを保持しなければならない。 | `AT-GRF-004`: edge detailにsource kindとsource IDが表示される。                        |
| `GRF-005` | MUST | native優先 — GitHub native dependency/sub-issueを最高優先のauthoritative relationとして扱わなければならない。                                 | `AT-GRF-005`: AIが反対するfixtureでもnative edgeは維持されcontradictionが注記される。  |
| `GRF-006` | MUST | plain linkは候補 — 単なるhyperlink/cross-referenceだけでblocks edgeを確定してはならない。                                                     | `AT-GRF-006`: 関連リンクだけのfixtureがrelated/noneとなりblockedにならない。           |
| `GRF-007` | MUST | closing keyword — close/fix/resolve keywordをimplements/closing relationとして抽出し、blocksと混同してはならない。                            | `AT-GRF-007`: PR closes Issue fixtureがimplementsになる。                              |
| `GRF-008` | MUST | checklist階層候補 — Issue本文のchecklistとindentをparent/subtask候補として抽出しなければならない。                                            | `AT-GRF-008`: VOICEVOX/voicevox_core#1286型fixtureで階層候補が生成される。             |
| `GRF-009` | MUST | AI edge判定 — 曖昧候補ごとにCodexがrelation typeまたはnoneを返し、confidenceとevidenceを付けなければならない。                                | `AT-GRF-009`: 全candidateにverdictが1件ずつ存在する。                                  |
| `GRF-010` | MUST | 推定edgeの切断 — 本文編集・コメント追加・依存完了等で根拠がなくなった推定edgeを次回再分析でactive graphから外せなければならない。             | `AT-GRF-010`: edge根拠削除fixtureでactive=falseとなる。                                |
| `GRF-011` | MUST | edge履歴 — edgeの追加、型変更、confidence変更、削除を履歴として保持しなければならない。                                                       | `AT-GRF-011`: add→change→remove fixtureが3 eventとして閲覧できる。                     |
| `GRF-012` | MUST | cycle検知 — blocks graphの強連結成分を検出し、dependency_cycleとして表示・通知候補化しなければならない。                                      | `AT-GRF-012`: A→B→C→A fixtureで無限再帰せず1 cycle componentとなる。                   |
| `GRF-013` | MUST | actionable frontier — open incoming blocks edgeを持たない非terminal項目をactionable frontierとして算出しなければならない。                    | `AT-GRF-013`: DAG fixtureで実行可能な末端だけがfrontierになる。                        |
| `GRF-014` | MUST | downstream impact — 各nodeが直接・推移的に止めるopen node数とrepo数を算出しなければならない。                                                 | `AT-GRF-014`: 既知DAGで期待countと一致する。                                           |
| `GRF-015` | MUST | cross-repo保持 — repo境界を越えるedgeを同一connected componentに保持しなければならない。                                                      | `AT-GRF-015`: project→core→engine fixtureが1 componentになる。                         |
| `GRF-016` | MUST | 隣接変化伝播 — 依存nodeのstate/edgeが変わった場合、本文未更新の隣接nodeも再分類しなければならない。                                           | `AT-GRF-016`: 閉じたblockerを待つ古いPR fixtureが本文変更なしでnewly_unblockedになる。 |

### 11.8 Codex利用

| ID        | 規範 | 要求                                                                                                                                                                                                                                                                                          | 受入要約                                                                                                                                                                                              |
| --------- | ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AIC-001` | MUST | Codex限定 — 初期リリースのAI backendはOpenAI Codexだけを実装対象としなければならない。                                                                                                                                                                                                        | `AT-AIC-001`: configでprovider=codex以外を指定すると未対応エラーになる。                                                                                                                              |
| `AIC-002` | MUST | 曖昧変更だけ呼出し — 定式ルールで高信頼に確定できず、入力または隣接graph hashが変わった項目だけCodexへ送らなければならない。                                                                                                                                                                  | `AT-AIC-002`: unchanged/clear fixtureのAI call数が0、ambiguous changedのみ1となる。                                                                                                                   |
| `AIC-003` | MUST | content-addressed cache — model、reasoningEffort、Codex CLI/API version、promptVersion、schemaVersion、判定に影響しないrun開始時刻を除いたnormalized input hashをcache keyに含めなければならない。                                                                                            | `AT-AIC-003`: key構成要素または判定入力の変更でcache missとなり、run開始時刻だけの変更ではcache hitとなる。                                                                                           |
| `AIC-004` | MUST | Structured Output — Codex最終出力を`schemas/codex-analysis.schema.json`で拘束しなければならない。                                                                                                                                                                                             | `AT-AIC-004`: Codex呼び出しが同Schemaを使い、非JSON・extra property・enum外出力が受理されない。                                                                                                       |
| `AIC-005` | MUST | read-only隔離 — Codexを空の一時workspace、read-only sandbox、承認要求なし、不要toolなしで実行しなければならない。                                                                                                                                                                             | `AT-AIC-005`: adversarial prompt fixtureでworking tree変更・外部コマンド成功が0件である。                                                                                                             |
| `AIC-006` | MUST | secret隔離 — Codex subprocessへOpenAI認証以外のGitHub App key、installation token、Discord webhook、Actions tokenを渡してはならない。                                                                                                                                                         | `AT-AIC-006`: process environment snapshotで禁止secret名が存在しない。                                                                                                                                |
| `AIC-007` | MUST | prompt injection対策 — Issue/PR本文・コメントをuntrusted dataとして区切り、内部命令に従わないsystem instructionを固定しなければならない。                                                                                                                                                     | `AT-AIC-007`: unit testで固定system instructionとuntrusted入力JSONの分離を確認する。golden fixtureでは命令を採用した固定AI出力をvalidationで拒否し、実モデルを呼び出さない。                          |
| `AIC-008` | MUST | 候補制約 — relation targetとwaitingOn user/teamは入力candidate集合からのみ選択させなければならない。                                                                                                                                                                                          | `AT-AIC-008`: 未知URL/loginを返した出力がsemantic validationで拒否される。                                                                                                                            |
| `AIC-009` | MUST | source ID根拠 — AI判定のevidenceは入力に付与したsource IDを参照しなければならない。                                                                                                                                                                                                           | `AT-AIC-009`: 存在しないsource IDの出力が拒否される。                                                                                                                                                 |
| `AIC-010` | MUST | 簡潔な説明 — 出力は短いreasonSummaryと根拠だけを含み、内部思考過程の出力を要求・保存してはならない。                                                                                                                                                                                          | `AT-AIC-010`: schemaにchainOfThought相当フィールドがなく、summary長制限が効く。                                                                                                                       |
| `AIC-011` | MUST | confidence閾値 — high>=0.85、medium>=0.65、low<0.65を既定とし、mediumは推定表示、lowはfallbackとしなければならない。                                                                                                                                                                          | `AT-AIC-011`: 境界値fixtureで表示・通知扱いが仕様通り変わる。                                                                                                                                         |
| `AIC-012` | MUST | 二重validation — JSON Schema validation後にcandidate参照、時刻、URL、矛盾、native relation保護のsemantic validationを行わなければならない。                                                                                                                                                   | `AT-AIC-012`: schema-validだが候補外のfixtureがsemantic stageで失敗する。                                                                                                                             |
| `AIC-013` | MUST | AI失敗時縮退 — timeout、rate limit、schema error時も定式判定でPages生成を継続し、AIの有効状態、利用可否、縮退状態をrun statusと独立してsnapshotへ保存し明示しなければならない。                                                                                                               | `AT-AIC-013`: AI無効のsuccess runとCodex 500のfallback runで異なるAI状態が表示される。                                                                                                                |
| `AIC-014` | MUST | 旧結果の安全再利用 — source/input hashが完全一致する場合だけ前回AI結果を再利用し、変更後はstale結果を断定表示してはならない。                                                                                                                                                                 | `AT-AIC-014`: 本文1文字変更fixtureで旧cacheが使われない。                                                                                                                                             |
| `AIC-015` | MUST | 再現情報 — 各AI結果にmodel identifier、reasoningEffort、backend version、promptVersion、schemaVersion、input/output hash、実行時刻を記録しなければならない。                                                                                                                                  | `AT-AIC-015`: 任意結果から全再現metadataが取得できる。                                                                                                                                                |
| `AIC-016` | MUST | run予算 — 1 runあたりcall数、入力文字/token見積、費用上限を設定できなければならない。                                                                                                                                                                                                         | `AT-AIC-016`: 上限到達fixtureで追加callを停止する。                                                                                                                                                   |
| `AIC-017` | MUST | 予算超過優先順位 — 予算不足時はseverity候補、owner unknown、changed blockers、downstream impact順に分析し、残りをdeferred表示しなければならない。                                                                                                                                             | `AT-AIC-017`: 10候補/3call上限fixtureで上位3件が選ばれる。                                                                                                                                            |
| `AIC-018` | MUST | golden eval — 実VOICEVOX運用パターンを匿名化/固定したgolden fixture suiteを保持しなければならない。                                                                                                                                                                                           | `AT-AIC-018`: review change、stale blocker、checklist、bot noise、direct requestのfixtureが存在する。                                                                                                 |
| `AIC-019` | MUST | 更新前回帰評価 — schema、semantic validation、reducer、状態、graph、通知判定の更新は固定AI出力を使うgolden evalの基準を満たさなければならない。model、reasoning effort、promptの更新は実モデルを呼び出すdry-run結果も確認しなければならない。                                                 | `AT-AIC-019`: 意図的な判定退行でCIが失敗し、標準golden fixtureの`fixedAi.networkCallCount`が0になる。model、reasoning effort、promptの変更では`metrics.aiCallCount`が1以上のdry-run差分をreviewする。 |
| `AIC-020` | MUST | AI非書込 — Codex出力は提案データとして検証・reducerを通し、GitHub変更、Discord直接送信、state直接上書きを許してはならない。                                                                                                                                                                   | `AT-AIC-020`: mockでCodexがwrite指示を返しても副作用APIが呼ばれない。                                                                                                                                 |
| `AIC-021` | MUST | 認証方式選択 — `ai.authentication`は`api-key`か`auth-json`に限定し、AI有効時だけ選択した方式の認証情報を要求しなければならない。`api-key`では`OPENAI_API_KEY`だけを渡さなければならない。`auth-json`では`CODEX_HOME`だけを渡し、直下の`auth.json`は存在だけを確認して内容を読んではならない。 | `AT-AIC-021`: 認証方式ごとのprocess environmentと`auth.json`不在時の起動前エラーが要件に一致し、AI無効時はどちらの認証環境変数も要求されない。                                                        |

### 11.9 Webページ

| ID        | 規範 | 要求                                                                                                                                                                                                                   | 受入要約                                                                                                                           |
| --------- | ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `WEB-001` | MUST | GitHub Pages公開 — Web UIをVOICEVOX/voicevox_task_trackerのGitHub PagesへActions artifact経由で公開しなければならない。                                                                                                | `AT-WEB-001`: mainの成功run後にPages URLが200を返す。                                                                              |
| `WEB-002` | MUST | 概要dashboard — 生成時刻、repo/item数、status/severity別件数、unknown/stale件数を概要表示しなければならない。                                                                                                          | `AT-WEB-002`: fixture集計値と画面値が一致する。                                                                                    |
| `WEB-003` | MUST | attention queue — 要対応項目をseverity、priority、downstream impact、stall時間で並べたqueueを表示しなければならない。                                                                                                  | `AT-WEB-003`: 既知fixtureで期待順序になる。                                                                                        |
| `WEB-004` | MUST | 依存graph — connected component/repo cluster単位で依存graphを閲覧できなければならない。                                                                                                                                | `AT-WEB-004`: 1000 node fixtureでcomponent選択から対象graphを開ける。                                                              |
| `WEB-005` | MUST | 時間の視覚強調 — 長いstall時間とdownstream impactをnode size等で強調し、凡例を表示しなければならない。                                                                                                                 | `AT-WEB-005`: 1d/10d/30d fixtureの表示サイズが単調増加し上限で暴走しない。                                                         |
| `WEB-006` | MUST | frontier表示 — actionable frontierをgraphと一覧の両方で識別できなければならない。                                                                                                                                      | `AT-WEB-006`: DAG fixtureのfrontier nodeにtext/icon表示がある。                                                                    |
| `WEB-007` | MUST | cycle表示 — dependency cycleをcollapse/強調し、構成nodeを展開できなければならない。                                                                                                                                    | `AT-WEB-007`: 3 node cycle fixtureでブラウザが固まらず展開できる。                                                                 |
| `WEB-008` | MUST | 表形式代替 — graphを使わずrepo、type、status、waitingOn、stall、blockers、updatedでsort/filterできる表を提供しなければならない。                                                                                       | `AT-WEB-008`: keyboardのみで全列filterとitem遷移ができる。                                                                         |
| `WEB-009` | MUST | item詳細 — 各item詳細にGitHub URL、状態、waitingOn、next action、時間、blocker、evidence、confidence、履歴を表示しなければならない。                                                                                   | `AT-WEB-009`: 任意itemで必須欄が確認できる。                                                                                       |
| `WEB-010` | MUST | 検索とdeep link — repo、number、title、actor、team、labelで検索でき、filter/itemをURLで共有できなければならない。                                                                                                      | `AT-WEB-010`: 再読込・別browserで同じdeep link状態が再現する。                                                                     |
| `WEB-011` | MUST | アクセシビリティ — 日本語UIはWCAG 2.2 AAを目標に、keyboard、focus、contrast、非色依存、screen-reader labelを備えなければならない。                                                                                     | `AT-WEB-011`: 自動a11y検査に重大違反がなく、主要flowをkeyboardで完了できる。                                                       |
| `WEB-012` | MUST | 鮮度表示 — 全体とrepo/itemごとにobservedAt、JST絶対時刻、相対時間、staleを表示し、AIの無効、利用不可、縮退を区別して表示しなければならない。                                                                           | `AT-WEB-012`: stale repoと3種類のAI状態のfixtureが最新や完全成功と誤認できない表示になる。                                         |
| `WEB-013` | MUST | waitingOnの対象明示 — waitingOn表示は役割名だけで終わらせず、作成者とassigneeはlogin、依存項目はrepo#numberまで示さなければならない。個人を特定できないroleは特定の一人ではないと分かる表示にする。                    | `AT-WEB-013`: 全kindのfixtureで、表示文字列から待機先の個人、team、項目、処理を特定できる。                                        |
| `WEB-014` | MUST | 担当者別の停滞一覧 — 待ち相手を個人とteamへ解決した担当者一覧と、個人ごとの停滞項目一覧を提供しなければならない。個人ごとのページは閲覧者が選んだ所属teamへの待ちも合流させ、その選択をURLで共有できなければならない。 | `AT-WEB-014`: 待ち相手fixtureで担当者一覧の件数と個人ごとのページの項目数が一致し、team選択を含むURLを開き直しても同じ項目が出る。 |
| `WEB-015` | MUST | 閲覧者自身の記憶 — 閲覧者は自分のloginと所属teamをブラウザーへ記憶し、1操作で自分の停滞項目へ到達できなければならない。記憶した値はURLより優先してはならない。                                                         | `AT-WEB-015`: 記憶後に自分の担当への導線が現れ、記憶を解除すると消える。壊れた記憶値は破棄され、画面は通常どおり描画される。       |

### 11.10 Discord通知

| ID        | 規範 | 要求                                                                                                                                                                                                    | 受入要約                                                                                    |
| --------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `NTF-001` | MUST | 08:00 JST日次起動 — scheduleを毎日23:00 UTC（08:00 JST）に設定し、workflow_dispatchも提供しなければならない。                                                                                           | `AT-NTF-001`: workflow YAMLのcronと手動triggerを静的検査する。                              |
| `NTF-002` | MUST | Pages後通知 — 通常digestは最新Pagesのdeployment成功後にだけ送信しなければならない。                                                                                                                     | `AT-NTF-002`: Pages失敗fixtureで通常digestが送られない。                                    |
| `NTF-003` | MUST | Discord Incoming Webhook — v1通知はDiscord Incoming Webhookを使用し、URLをActions secretから取得しなければならない。                                                                                    | `AT-NTF-003`: secretなしで明示エラー、secret値はlogに出ない。                               |
| `NTF-004` | MUST | mention既定無効 — 既定payloadはallowed_mentionsで全mentionを無効化しなければならない。                                                                                                                  | `AT-NTF-004`: @everyone/@user文字列fixtureでも実mentionが許可されない。                     |
| `NTF-005` | MUST | mention allowlist — 有効化時も設定済みDiscord IDだけをallowed_mentions.usersへ含めなければならない。                                                                                                    | `AT-NTF-005`: 未登録GitHub loginはplain text表示になる。                                    |
| `NTF-006` | MUST | 通知選別 — threshold crossing、urgent/critical停滞、owner不明48h超、責務遷移、newly unblocked高impact、cycleを主要通知候補としなければならない。                                                        | `AT-NTF-006`: 各reason fixtureがcandidateになる。                                           |
| `NTF-007` | MUST | digest構成 — digestを「停止要因」「責務/triage不明」「新規解消・重要変化」に分け、各itemにrepo#number、title、waitingOn、duration、reason、URLを含めなければならない。                                  | `AT-NTF-007`: payload snapshotが必須項目を満たす。                                          |
| `NTF-008` | MUST | Discord制限内分割 — embed/文字数/件数のDiscord制限を事前計算し、安全上限を超える場合は複数messageへ分割しなければならない。                                                                             | `AT-NTF-008`: 長文20件fixtureがAPI rejectなしの複数payloadになる。                          |
| `NTF-009` | MUST | noise抑制 — freshな作業中、bot-only更新、unchanged watch、recent draft、低信頼AI-only、automation dashboardを既定digestから除外しなければならない。                                                     | `AT-NTF-009`: noise fixture群が候補0件になる。                                              |
| `NTF-010` | MUST | 重複/cooldown — notification ledgerの予約は24時間だけ再送を抑え、期限切れ後は再送可能にしなければならない。cooldownは送信済み記録だけへ適用し、urgentは既定3日、criticalは既定2日としなければならない。 | `AT-NTF-010`: 期限内と期限切れの予約、同日再実行、連日fixtureで期待回数になる。             |
| `NTF-011` | MUST | 空digest抑制 — 通知対象が0件なら通常digestを送信してはならない。                                                                                                                                        | `AT-NTF-011`: 0 candidate fixtureでwebhook callが0件になる。                                |
| `NTF-012` | MUST | 運用障害通知 — 収集・Pages・Discord自身の重大障害を通常item digestと区別し、設定により同一または別webhookへ1件だけ通知できなければならない。                                                            | `AT-NTF-012`: 連続retry失敗fixtureで重複しないops alertが生成される。                       |
| `NTF-013` | MUST | 永続化済みrun照合 — 通常digestの送信前にworkflow artifactのsnapshotとtracker-state branchの永続化済みsnapshotでrun IDが一致することを検証し、不一致なら送信せず失敗しなければならない。                 | `AT-NTF-013`: 同じrunなら送信adapterが呼ばれ、異なるrunなら呼ばれず日本語エラーで失敗する。 |

### 11.11 永続化

| ID        | 規範 | 要求                                                                                                                                                                                                   | 受入要約                                                                                          |
| --------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------- |
| `DAT-001` | MUST | main branch責務 — main branchにはsource、config、schema、prompt、docs、testsを置き、日次state commitを混在させてはならない。                                                                           | `AT-DAT-001`: branch tree検査で日次snapshotがmainに存在しない。                                   |
| `DAT-002` | MUST | state branch — 永続状態を専用orphan branch tracker-stateへGit管理しなければならない。                                                                                                                  | `AT-DAT-002`: 初回bootstrapでbranchが作成され、以後同branchへbot commitされる。                   |
| `DAT-003` | MUST | current snapshot — tracker-stateにschema-versioned current snapshotをcanonical JSONで保存しなければならない。                                                                                          | `AT-DAT-003`: 同一入力2回でvolatile fieldを除くbyte列が一致する。                                 |
| `DAT-004` | MUST | 日次履歴 — 日次差分またはevent historyを日付単位で保持し、previous→currentを再構成できなければならない。                                                                                               | `AT-DAT-004`: 任意2日間のowner/edge/severity差分を再生できる。                                    |
| `DAT-005` | MUST | AI cacheと通知ledger — AI cache、analysis metadata、予約期限と送信結果を持つnotification ledgerをstate branchで保持しなければならない。                                                                | `AT-DAT-005`: runnerを破棄して再実行してもcache hit、予約期限、cooldownが維持される。             |
| `DAT-006` | MUST | atomic/canonical/public-safe commit — validation完了後だけsorted/canonical stateをatomic commitし、secret、raw token、private repoのID、owner/name、repository URL、不要な全文本文を含めてはならない。 | `AT-DAT-006`: 失敗途中でlast good commitが変わらず、secret scan/private sentinel testが成功する。 |

### 11.12 セキュリティ・プライバシー

| ID        | 規範 | 要求                                                                                                                                                                                                                                         | 受入要約                                                                                                                                                |
| --------- | ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SEC-001` | MUST | job最小権限 — 収集、state push、Pages deploy、Discord notifyを権限分離し、各jobのGITHUB_TOKEN permissionsを最小化しなければならない。                                                                                                        | `AT-SEC-001`: workflow permissions静的検査がallowlistと一致する。                                                                                       |
| `SEC-002` | MUST | secret trigger境界 — secretを使うjobはdefault branchのscheduleまたは権限管理されたworkflow_dispatchだけで実行し、pull_request_targetでuntrusted codeを実行してはならない。                                                                   | `AT-SEC-002`: PR eventからsecret jobへ到達する経路がない。                                                                                              |
| `SEC-003` | MUST | Action pinning — 第三者/公式を含むGitHub Actionをfull commit SHAでpinし、更新をreview付きPRで行わなければならない。                                                                                                                          | `AT-SEC-003`: workflow内uses参照が全て40桁SHAである。                                                                                                   |
| `SEC-004` | MUST | public-only fail closed — serialization直前は収集inventory、publish直前はworkflow artifactへ保持した収集時のpublic repo allowlistで独立検証し、違反1件でも新state、Pages、Discord公開を中止しなければならない。                              | `AT-SEC-004`: private repositoryのID、owner/name、URLと未知repositoryの注入fixtureで3出力すべて停止する。                                               |
| `SEC-005` | MUST | Web content安全化 — GitHub由来文字列をescape/sanitizeし、allowlist URL、CSP、noopener等を適用しなければならない。                                                                                                                            | `AT-SEC-005`: XSS/危険URL fixtureが実行・遷移できない。                                                                                                 |
| `SEC-006` | MUST | ログredaction — Actions log・job summary・artifactにsecret、authorization header、raw App key、webhook URL、未加工API responseを出してはならない。                                                                                           | `AT-SEC-006`: canary secretを用いた統合テストで全log/artifact検索が0件になる。                                                                          |
| `SEC-007` | MUST | Codex認証ファイルの一時配置 — `collect-analyze` jobは`CODEX_AUTH_JSON` secretをrunnerの一時directoryにある`auth.json`へ権限600で配置し、Codex認証情報として`CODEX_HOME`だけを収集stepへ渡し、job終了時に成否を問わず削除しなければならない。 | `AT-SEC-007`: workflow静的検査でsecretの空値拒否、directory権限700、file権限600、`CODEX_HOME`の受け渡し、`if: always()`による最終stepの削除を確認する。 |
| `SEC-008` | MUST | team memberの非公開 — GitHubのteam member一覧はrun内でのみ用い、公開DTO、state、Discord通知へ出力してはならない。閲覧者の所属teamは閲覧者自身がWeb UIで選ぶ。                                                                                | `AT-SEC-008`: 公開DTOのstrict schemaがmember一覧の欄を拒否し、Pages出力に現れるteam情報が識別子だけになる。                                             |

### 11.13 運用・性能

| ID        | 規範 | 要求                                                                                                                                                                                              | 受入要約                                                                                                                                    |
| --------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `OPS-001` | MUST | 排他と再実行 — workflow concurrencyで日次runを直列化し、manual rerunを安全かつ冪等にしなければならない。                                                                                          | `AT-OPS-001`: 同時2 run fixtureでstate race・通常digest重複が起きない。                                                                     |
| `OPS-002` | MUST | retryとlast-good保護 — GitHub、Codex、Discordの一時失敗を設定上限付きの指数backoffとjitterでretryし、恒久エラーはretryせず、完全性を満たさないrunでlast-good Pagesとstateを上書きしてはならない。 | `AT-OPS-002`: 429、503、transport例外、timeout、恒久エラーのfixtureで試行回数と待機時間が期待値になり、失敗後もlast good hashが維持される。 |
| `OPS-003` | MUST | observability — run summaryにrepo/item/change/edge/AI call/cache/token見積/API残量/stale/notification/所要時間を記録しなければならない。                                                          | `AT-OPS-003`: 成功・fallback・失敗runのsummaryに必須metricが存在する。                                                                      |
| `OPS-004` | MUST | 性能と予算 — 基準fixture（5,000 items、10,000 edges、変更300件）を30分以内、GitHub API予算70%以内、Codex設定上限以内で処理し、Web初期summaryをgzip 1 MiB以内にしなければならない。                | `AT-OPS-004`: CI performance profileが全閾値を満たす。                                                                                      |

## 12. 非機能方針補足

### 12.1 可用性・正確性

GitHub Actionsのscheduleは厳密なリアルタイムschedulerではなく、混雑時に遅延し得る。そのため「08:00 JSTにtriggerする」ことを要件とし、実投稿時刻と遅延をmetric化する。完全性を満たさないrunはlast-goodを上書きしない。

### 12.2 セキュリティ

- GitHub Appはread-only。webhook受信は不要。
- AppをOrganizationのall repositoriesへinstallする場合でも、repo metadata直後とpublish直前の二重public guardを必須とする。
- Codex processへGitHub/Discord secretを渡さない。
- Issue本文・コメントはprompt injectionを含み得るuntrusted dataとして扱う。
- public pageへ全文転載せず、短いparaphrase、source ID、GitHub URLを保存する。
- workflow actionはfull SHA pin、secret jobはschedule/manual default branchのみ。

### 12.3 保守性

- pure TypeScript domain reducerとGitHub/Codex/Discord adapterを分離する。
- prompt・schema・deterministic rulesは独立versionを持つ。
- state schema migrationを用意し、古いstateを破壊的に読み捨てない。
- runtimeはNode.js LTSをpinし、strict TypeScriptの型検査、lint、format検査、VitestによるNodeとWebのテスト、golden eval、CLI、workflow用CLI、WebのbuildをCIで実行する。

## 13. 受入と変更管理

- 全170要求は一意な受入試験IDを持つ。
- MUST要求の未達はrelease blocker。
- SHOULD要求の未達は理由・代替・期限をdecision logへ記録する。
- schema、semantic validation、reducer、状態、graph、通知判定の変更はgolden evalと通知候補差分をPRでreviewする。
- model、reasoning effort、promptの変更は実モデルを呼び出したdry-runのAI判定と通知候補差分をPRでreviewする。
- 仕様変更は本書、schema、configを同一PRで更新する。

## 14. 参照資料

公式仕様とVOICEVOX実例の一覧は `docs/RESEARCH_SOURCES.md` を参照。
