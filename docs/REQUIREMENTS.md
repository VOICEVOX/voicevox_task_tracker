# VOICEVOX Task Tracker 要件定義書

- 対象リポジトリ: `VOICEVOX/voicevox_task_tracker`
- 文書版: 1.0-draft
- 調査基準日: 2026-07-30（JST）
- 実装言語制約: Node.js + TypeScript
- AI backend制約: OpenAI Codexのみ（初期リリース）

## 1. 文書の位置づけ

本書は、VOICEVOX Organization全体の公開Issue/PRについて、**現在の状態、次に行動すべき主体、停滞時間、重要度、要対応度、依存関係、重要な変化**を自動整理し、GitHub PagesとDiscordへ提示するシステムの要件を定義する。

要求文の `MUST` / `SHOULD` は RFC 2119・RFC 8174の規範語として用いる。本書は、要求の識別可能性・検証可能性・追跡可能性を重視するISO/IEC/IEEE 29148系の考え方、NASA Software Engineering Handbookの要求・受入基準・双方向トレーサビリティの実務例を参考に、VOICEVOX向けへ具体化した。全文標準を転載するものではない。

現在の評価入力はGitHubのcurrent detail、全timeline・編集履歴、`config.yml`、workflowが渡す基準通知時刻`S`、検証済みcacheとする。構成と処理境界は[アーキテクチャ](ARCHITECTURE.md)、実運用の設定値は[config.yml](../config.yml)を正本とする。前回runの判定結果は次回runの正しさの入力にしない。

## 2. 背景と問題

VOICEVOXではEditor、Engine、Core、モデル・ランタイム・追加ライブラリ・ブログ等に作業が分散し、次の問題が同時に起きる。

1. Issue/PRの最終更新は分かっても、**誰の行動を待っているか**が分からない。
2. 本文のチェックリスト、コメント、レビュー、別repoのIssueなどに依存関係が分散し、native dependencyが設定されていない場合がある。
3. botコメントやpreview更新で`updated_at`が進み、実質的な停滞が隠れる。
4. 依存先が完了しても、依存元本文の未チェック項目が残り、再開可能になったことを見落とす。
5. 全件通知では疲弊する一方、内容確認漏れや長期停止は早く知りたい。

## 3. 実データ調査から得た設計上の結論

調査したIssueとPR、観察内容は[Research SourcesのVOICEVOX実例](RESEARCH_SOURCES.md#voicevox実例)を参照。

実例から次の設計判断を導いた。

- 本文の記載だけでなく、隣接nodeの最新stateを伝播し、依存解消時に依存元を再判定する。
- checklistとindentからrelation候補を抽出し、native relationと区別して曖昧な関係だけをCodexで判定する。
- bot activityを進捗扱いせず、latest headとhuman reviewの前後関係で修正待ちとレビュー待ちを決める。
- botをボール所有者にせず、承認、merge readiness、未解決human threadを別々に評価する。
- 追跡とgraph利用をDiscordのnoise抑制から分離する。
- assigneeだけでなく、未回答の明示依頼をCodexで根拠付き判定する。

このため、システムは「GitHubの確定情報による状態機械」＋「曖昧な自然言語関係だけを判定するCodex」＋「型付き依存グラフ」の三層とする。

## 4. 目的と成功指標

### 4.1 目的

- 朝の短時間で、要対応度が高い項目と次の担当を把握できる。
- repoを越えた依存の末端、再開可能項目、循環を見つけられる。
- 判定が誤っていても、なぜそう判断したかをGitHub上の根拠へ遡れる。
- botがGitHub上の運用を勝手に変更せず、既存のコメント・ラベル・review運用を正本にする。

### 4.2 運用KPI（初期目標）

- 追跡中open項目の90%以上で、`waitingOn=unknown`以外を根拠付き表示できる。
- 48時間を超えた内容未確認項目をgolden fixture上で100%検出する。
- daily digestは通常10項目以下とし、同一理由の不要な連日再送を行わない。
- private/internal repo由来データの公開件数を常に0件とする。
- 固定AI出力を使うgolden fixtureの処理結果について、critical/urgent recallを95%以上、誤通知率を10%以下に保つ。

## 5. スコープ

### 5.1 対象

- VOICEVOX Organizationの全public・non-archived・non-disabled repository
- GitHub Issue、Pull Request、Issue/PR timeline、comments、reviews、review threads、review requests、commits、checks、native dependencies、sub-issues、closing references、cross-references
- GitHub Pages上の公開static site
- Discord public channelへのIncoming Webhook通知
- `tracker-state-v4` branchによる4種類のcacheの永続化。判定結果、日次差分、通知済み状態、run reportは保存しない

### 5.2 対象外

- GitHub Discussions
- GitHub Projectsを正本とする運用
- 対象Issue/PRへのlabel追加・変更、comment投稿、assign、review request、close/merge
- Codexによるrepository code実装・修正
- private/internal repositoryの内容
- Discord上での対話型bot操作（v1）

## 6. 用語

| 用語                | 定義                                                                            |
| ------------------- | ------------------------------------------------------------------------------- |
| tracked item        | 追跡対象に入ったIssueまたはPR                                                   |
| status              | 待たれている行動。誰を待つかは含まない                                          |
| waitingOn           | 次に状態を進める行動が期待される主体                                            |
| ball / ボール       | waitingOnと同義の運用上の表現                                                   |
| statusSince         | 現在statusへ遷移した時刻                                                        |
| ownerSince          | 現在waitingOnへ遷移した時刻                                                     |
| stallSince          | 現在の待ち状態で意味のある進捗か責務主体本人の活動が最後に起きた時刻            |
| severity            | Discord通知に使う停滞の深刻さ。none、watch、urgent、criticalの4段階             |
| importance          | 項目そのものの重要度。0から100のscoreとlow、medium、highの3段階                 |
| attention           | 重要度と停滞の短さから求める要対応度。0から100のscoreとlow、medium、highの3段階 |
| meaningful progress | push、回答、review、決定、依存解消など、次工程を進める変化                      |
| authoritative edge  | GitHub native dependency/sub-issue等、AIより優先するrelation                    |
| inferred edge       | 本文・コメント・link候補をCodexが関係ありと判定したrelation                     |
| actionable frontier | openなincoming `blocks` edgeを持たず、今着手可能な非terminal node               |
| downstream impact   | そのnodeが止めているopen node/repoの直接・推移的規模                            |
| stale repo          | repository取得が503で失敗し、検証済み収集cacheを一時的に使うrepo                |

## 7. 推奨状態モデル

### 7.1 status enum

statusは待たれている行動を表す。誰を待っているかはwaitingOnだけで表し、status名へ主体を含めない。
主体名を状態名にすると、その人が行動するのを待つのか、その人が決まるのを待つのかを読み取れないためである。

| status                   | 表示名           | 待っている行動                                             |
| ------------------------ | ---------------- | ---------------------------------------------------------- |
| `waiting_for_assessment` | 内容確認待ち     | 内容がまだ読まれておらず、扱いの検討が始まっていない       |
| `waiting_for_owner`      | 担当決め待ち     | 内容は検討されたが、誰が進めるか決まっていない             |
| `waiting_for_decision`   | 方針判断待ち     | 進め方そのものの判断を待っている                           |
| `waiting_for_review`     | レビュー待ち     | レビューされるのを待っている                               |
| `waiting_for_revision`   | 修正待ち         | レビュー指摘、conflict、CI失敗への対応を待っている         |
| `waiting_for_reply`      | 返答待ち         | 未回答の質問や依頼への返答を待っている                     |
| `waiting_for_work`       | 作業待ち         | 担当が決まっている作業が進むのを待っている                 |
| `waiting_for_unblock`    | ブロック解消待ち | 依存している項目の解消を待っている                         |
| `waiting_for_automation` | 自動処理待ち     | merge queueやrequired checksなど自動処理の完了を待っている |
| `waiting_for_merge`      | マージ待ち       | マージ操作を待っている                                     |
| `in_progress`            | 作業中           | draft Pull Requestで作業が現に進んでいる                   |
| `unknown`                | 待ち先不明       | 根拠が足りず待ち先を決められない                           |

終了状態は`terminal_merged`、`terminal_completed`、`terminal_not_planned`とする。
`in_progress`だけは待ち状態ではなく、作業が現に進んでいることを表す。この違いは意図したものである。

### 7.2 waitingOn enum

waitingOnは待たれている主体を表す。`kind`が主体の種類、`role`がその主体を待つ根拠である。

`kind`は`user`、`team`、`role`、`item`、`automation`、`unknown`を使う。
`role`はauthor、maintainer、reviewer、assignee、respondent、dependency、merge_decider、ci、unknownとする。

`respondent`は名指しで質問や依頼を向けられた相手を表し、その人の役割を問わない。
これにより、作成者という役割を待つ`kind=role`・`role=author`と、たまたま作成者である個人を名指しで待つ`kind=user`・`role=respondent`を区別できる。
メンテナー全体を待つ場合と、メンテナーのうち特定の個人を待つ場合も同じように分かれる。

`kind=user`の`candidateId`はGitHubユーザー名、`kind=team`は`organization/slug`とする。
`config.yml`に設定したメンテナのGitHubユーザー名は公開情報として扱う。
抽象的なmaintainer、reviewer、merge_deciderのwaitingOnは、そのrepositoryのメンテナ1人につき1件の`kind=user`候補へ展開する。
`kind=team`はGitHubのteam review requestと、本文やコメントの`@organization/team`から生まれる。
team memberは解決しない。
複数blockerや複数assigneeを表せる配列とし、UI・通知用にprimaryを1つ選ぶ。

### 7.3 PR判定の既定優先順位

1. merged/closedならterminal。
2. authoritativeまたは高信頼のopen blockerがあれば`waiting_for_unblock`。
3. merge queue/auto-merge/required checks実行中なら`waiting_for_automation`。
4. latest head以後にhuman `CHANGES_REQUESTED`があれば`waiting_for_revision`。
5. 未解決human review threadのうち最後のhumanコメントがauthor以外のものがあれば`waiting_for_revision`。
6. 変更要求後にauthorがpush済みなら`waiting_for_review`として再review側を評価。
7. 現行review requestがあれば`waiting_for_review`とし、requestされたuserまたはteamを待つ。
8. ラベルが方針判断を要求していれば`waiting_for_decision`。
9. draftは原則`in_progress`とし、authorを待つ。ただし明示的判断依頼・blockerを優先。
10. PR変更起因と判定できるrequired check失敗、またはmerge conflictがあれば`waiting_for_revision`。
11. 必要承認/checks済みなら`waiting_for_merge`とし、merge判断者を待つ。
12. 残るopenのnon-draft PRは`waiting_for_owner`とし、レビュー担当を決めるmaintainerを待つ。
13. CI失敗・コメント意味等が曖昧な場合だけCodexへ渡す。

4、5、6とuserへのreview requestで待ち先を決めた後、その待ち先本人が責務の起点より後に本文のある発言をしていれば、発言の意味を解釈しないと責務を確定できない。決定論的な待ち先を既定として残したままCodexへ渡す。5では、未解決threadの最後のhumanコメントに本文がある場合も同じ扱いとする。そのコメントがauthorの対応を求めるとは限らないためである。teamへのreview requestではmemberを解決しないため、team memberの発言をこの再判定の根拠にしない。

11と12のmerge_decider、reviewer、maintainerはrepositoryごとのメンテナ全員へ`kind=user`候補として展開する。

### 7.4 Issue判定の既定優先順位

1. closedならterminal。
2. open blockerがあれば`waiting_for_unblock`。
3. 最新の未回答な明示依頼がmaintainer役割だけへ向くなら`waiting_for_decision`。それ以外は`waiting_for_reply`とし、名指しされた相手を`respondent`として待つ。相手がassignee本人でも、待っているのは作業ではなく返答なので`waiting_for_reply`とする。
4. assigneeがいれば`waiting_for_work`とし、assigneeを待つ。
5. 未アサインなら、作成者以外のhumanコメント、現在のラベル、担当履歴のいずれかがあれば`waiting_for_owner`、どれもなければ`waiting_for_assessment`とし、どちらもmaintainerを待つ。
6. 作成者がmaintainerでも、次の担当が不明ならmaintainerの責務のままとする。

maintainerはrepositoryごとに設定したメンテナを指し、メンテナ全員へ`kind=user`候補として展開する。

### 7.5 現在値とevent replayの整合

current item/detailを現在値の正本とし、timeline、comment、review、`userContentEdits`、relation mutationを発生時刻、item node ID、pagination sequence、source IDで安定して再生する。
再生した最終state、draft、assignee、review request、terminal時刻がcurrent値と矛盾する場合は推測で合わせず、該当するstateまたは責務の事実をunknownにするか例外でrunを停止する。
actorが取得不能でもstateやdraftの事実は復元し、assigneeやreview requestのtargetが取得不能な責務epochだけをunknownにする。
同じsource IDの内容不一致、必須ページの取得不能、現在relationの復元不能を黙って補完してはならない。

## 8. 停滞時間、停滞の深刻さ、重要度、要対応度の既定値

すべて内部UTC、表示JST。日数は営業日ではなく連続時間で計算する。`updated_at`は参考値であり、severity clockの正本にしない。

| wait class | watch | urgent | critical | 主な扱い                                                       |
| ---------- | ----: | -----: | -------: | -------------------------------------------------------------- |
| assessment |   48h |    96h |     168h | 内容確認待ちの見落としを検出                                   |
| owner      |   48h |    96h |     168h | 担当決め待ちまたは待ち先不明を検出                             |
| decision   |   48h |    96h |     168h | 方針判断待ちの停滞を検出                                       |
| review     |   48h |   120h |     240h | レビュー待ちはreview requestから計時                           |
| revision   |   72h |   168h |     336h | 変更要求後の修正待ちはauthorのpush後にレビュー待ちへ遷移可能   |
| reply      |   48h |   120h |     240h | 返答待ちは未回答の質問や依頼から計時                           |
| work       |  168h |   336h |     720h | 作業待ち、作業中、変更要求以外の修正待ちは実装作業の長さを考慮 |
| merge      |   24h |    72h |     168h | マージ待ちの見落としを早めに検出                               |
| automation |    6h |    24h |      72h | 自動処理待ちは通常のCI時間を通知しない                         |

blocked parentは「親自身を毎日催促」せず、blockerのseverityとdownstream impactを通知順位へ使う。priority labelはseverityを最大1段階引き上げられるが、低信頼AIだけでcriticalへ引き上げない。
severityはDiscord通知の判断だけに使い、Web UIの表示、絞り込み、並び替え、依存グラフには使わない。

重要度は項目そのものの重要さを表し、停滞の深刻さを表すseverityとは独立して計算する。
決定論的な要因は、優先度ラベルの重み、他のopen項目とリポジトリを止めている影響規模、期限付きのopen milestoneとする。
期限が設定日数以内のmilestoneは追加で加点する。
Codexは重要な機能か、期限が明示されているか、将来問題になるかを判定し、confidenceがlowならこれらを加点しない。
そのrunでCodex判定を得られない場合に再利用できるのは、同じnode IDの直近検証済みimportanceだけである。status、waitingOn、relation、progress、通知候補は過去入力から再利用しない。
scoreは各要因の加点を0から100の整数へ収め、設定した閾値でlow、medium、highへ分ける。

要対応度は重要度を主、停滞の短さを従として次の式で計算する。
停滞が長い項目は対応が不要だった場合が多いという前提に立ち、重要度が低いまま最近動いただけの項目を上位へ置かない。

```text
鮮度係数 = recencyFloor + (1 - recencyFloor) × 0.5 ^ (停滞時間 ÷ watch閾値)
要対応度スコア = round(重要度スコア × 鮮度係数)
```

停滞時間は`stallSince`からrun開始時刻までの経過時間とする。
watch閾値は項目のwait classに対応する`staleness.thresholdsHours`の`watch`とし、鮮度係数の半減期として使う。
`attention.recencyFloor`の既定値は0.4とし、停滞が伸びても要対応度は重要度の0.4倍までしか下げない。
要対応度scoreは0から100の整数とし、`attention.levels`の閾値でlow、medium、highへ分ける。
既定の下限はhighを40、mediumを20とする。
terminal項目と`waiting_for_unblock`の項目は要対応度scoreを0とする。
要対応度はGitHub側の変更有無にかかわらず、最新の重要度、停滞時間、設定から毎run全項目で再計算する。

## 9. Discord選別既定

通知する主な変化:

- severityがwatch/urgent/criticalへ初めて上がった。
- 内容確認待ち、担当決め待ち、待ち先不明が48時間を超えた。
- human `CHANGES_REQUESTED`後の修正待ちが長期化した。
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

通知0件なら投稿しない。送信済み状態を保存せず、基準時刻`S`と発生時刻で一回通知窓を決める。urgentは3日、criticalは2日の固定周期で再通知する。

## 10. 追跡対象への追加規則

1. `startAt`以後に作成されたopen項目。
2. 開始日前でも、開始後にhuman-relevant変更が起きたopen項目。
3. tracked itemから参照された、またはtracked itemを参照したOrganization内項目。
4. native dependency/sub-issueで接続した項目。
5. configで明示includeした項目。
6. `workflow_dispatch`のbackfill（linked/all-open）。

各runで`startAt`、現在のopen状態、全event、現在relationから追跡条件を再構築する。過去runで対象だったことだけを理由に残さない。closed/merged項目は`terminalAt`から180日までcacheに保持してよい。

## 11. 要求一覧

要求は合計193件である。

### 11.1 目的・成果

| ID        | 規範 | 要求                                                                                                                                        | 受入要約                                                                                                                         |
| --------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `GOL-001` | MUST | 一元的な現況把握 — 全追跡対象の現在状態を、公開Webページの1か所から把握できなければならない。                                               | `AT-GOL-001`: 異なる3リポジトリのIssue/PRを含むfixtureで、各項目の状態が同一ページから到達できる。                               |
| `GOL-002` | MUST | ボールの所在 — 各追跡項目について、次に行動すべき個人・チーム・役割・依存項目・自動処理のいずれかを示さなければならない。                   | `AT-GOL-002`: fixture全件でwaitingOnが1件以上、またはterminalであり、理由と根拠が表示される。                                    |
| `GOL-003` | MUST | 停滞検知 — 単なるGitHubのupdated_atではなく、責務が移った時点、意味のある進捗、責務主体本人の活動を基準に停滞時間を算出しなければならない。 | `AT-GOL-003`: botコメントのみ追加したfixtureでstallSinceが変化せず、人間の責務移動イベントでは変化する。                         |
| `GOL-004` | MUST | 依存関係の可視化 — リポジトリをまたぐブロッカー、親子、実装、関連関係を型付きグラフとして可視化しなければならない。                         | `AT-GOL-004`: 3リポジトリ以上をまたぐグラフfixtureで、型・向き・根拠が確認できる。                                               |
| `GOL-005` | MUST | 高シグナル通知 — 毎日のDiscord通知は、通知条件に該当する項目を選別し、全件羅列を避けなければならない。                                      | `AT-GOL-005`: 通常項目50件と通知条件に該当する3件のfixtureで、Discord候補は該当項目中心かつ設定上限以内となる。                  |
| `GOL-006` | MUST | 根拠追跡 — 各判定は、入力eventのsource ID、ルール、AI出力、信頼度へ追跡可能でなければならない。過去runとの差分を永続化する必要はない。      | `AT-GOL-006`: 任意の項目からcurrent detail、timeline、編集履歴、AI結果の根拠へ到達できる。                                       |
| `GOL-007` | MUST | 読み取り専用運用 — 追跡対象リポジトリのIssue、PR、コメント、ラベル、アサイン、レビュー依頼を変更してはならない。                            | `AT-GOL-007`: 統合テストで対象リポジトリへのwrite API呼び出しが0件である。                                                       |
| `GOL-008` | MUST | 決定論優先 — GitHubの確定情報と定式ルールを先に適用し、Codexは曖昧部分の補助と失敗または延期した分析の再試行に限定しなければならない。      | `AT-GOL-008`: 明確なレビュー依頼fixtureではAI呼び出しなしで同一結果が得られる。                                                  |
| `GOL-009` | MUST | 走査時刻からの独立 — 停滞起点はGitHub由来の時刻だけから決めなければならない。走査した時刻や過去に走査した回数を起点へ持ち込んではならない。 | `AT-GOL-009`: 同一fixtureをrun開始時刻だけ数ヶ月ずらして2回判定し、全項目の`statusSince`、`ownerSince`、`stallSince`が一致する。 |

### 11.2 スコープ

| ID        | 規範   | 要求                                                                                                                                                | 受入要約                                                                                                         |
| --------- | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `SCP-001` | MUST   | 対象Organization — 対象OrganizationはVOICEVOXでなければならない。                                                                                   | `AT-SCP-001`: 設定のorganizationがVOICEVOX以外なら起動前検証が失敗する。                                         |
| `SCP-002` | MUST   | 公開リポジトリ限定 — visibilityがpublicのリポジトリだけを追跡・cache保存・公開しなければならない。                                                  | `AT-SCP-002`: private/internalを混ぜたfixtureで、その項目が収集後・cache・Pages・Discordの全段階に存在しない。   |
| `SCP-003` | MUST   | archive除外 — archived=trueのリポジトリを追跡対象から除外しなければならない。                                                                       | `AT-SCP-003`: archive状態を検出したrunでcache、Pages、Discordの全出力から外れ、停止理由がartifactへ残る。        |
| `SCP-004` | MUST   | 動的発見 — 対象リポジトリ一覧を固定せず、毎回Organization APIからページネーションして発見しなければならない。                                       | `AT-SCP-004`: 新しいpublic/non-archived repo fixtureが設定変更なしで次回実行に含まれる。                         |
| `SCP-005` | MUST   | Issue対象 — 対象リポジトリのIssueを追跡できなければならない。                                                                                       | `AT-SCP-005`: open Issue fixtureが正規化ノードとして保存される。                                                 |
| `SCP-006` | MUST   | Pull Request対象 — 対象リポジトリのPull RequestをIssueと区別して追跡できなければならない。                                                          | `AT-SCP-006`: REST issues応答に含まれるPRを二重計上せずPRノードに分類する。                                      |
| `SCP-007` | MUST   | Discussions除外 — GitHub Discussionsを収集・表示・通知対象にしてはならない。                                                                        | `AT-SCP-007`: Discussion fixtureがstateに入らない。                                                              |
| `SCP-008` | MUST   | Projects非依存 — GitHub Projectsを状態の正本または必須連携先にしてはならない。                                                                      | `AT-SCP-008`: Project権限・Projectデータなしで全受入試験が成功する。                                             |
| `SCP-009` | SHOULD | 外部依存のゴースト表示 — VOICEVOX外のpublic項目がブロッカーとして参照された場合、再帰追跡せず説明用ゴーストノードとして表示すべきである。           | `AT-SCP-009`: 外部public URL fixtureが最小メタデータのghost nodeとなり、通知責務の直接対象にならない。           |
| `SCP-010` | MUST   | bot作成項目の同等扱い — botが作成したIssue/PRを作成者だけを理由に特別扱いしてはならない。                                                           | `AT-SCP-010`: 同一内容のhuman作成・bot作成fixtureで、作成者種別以外の判定結果が一致する。                        |
| `SCP-011` | MUST   | 外部参照の公開条件 — VOICEVOX外の参照先もpublic・non-archived・non-disabledの場合だけ関係候補として扱い、除外対象をcacheとPagesへ残してはならない。 | `AT-SCP-011`: 通常、archive済み、disabledの外部repository参照fixtureで通常の参照だけが候補、cache、Pagesに残る。 |

### 11.3 設定

| ID        | 規範 | 要求                                                                                                                                                          | 受入要約                                                                                                         |
| --------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `CFG-001` | MUST | 設定schema version — 設定ファイルにschemaVersionを持ち、未知のmajor versionを拒否しなければならない。                                                         | `AT-CFG-001`: 未対応majorの設定で明示的エラーとなり処理を開始しない。                                            |
| `CFG-002` | MUST | 既定メンテナ — `maintainers.defaults`へすべてのrepositoryに適用するメンテナのGitHubユーザー名一覧を設定できなければならない。                                 | `AT-CFG-002`: 既定値のみのrepoで抽象的なメンテナ責務が設定したユーザー名へ解決される。                           |
| `CFG-003` | MUST | 複数メンテナ — `maintainers.defaults`と`maintainers.repositories`の各値へ1人以上のGitHubユーザー名を指定でき、1repositoryを複数人で担当できなければならない。 | `AT-CFG-003`: 2人を指定したrepoで2件の`kind=user`候補へ展開される。                                              |
| `CFG-004` | MUST | リポジトリ別上書き — `maintainers.repositories`へ`owner/repo`ごとのメンテナ一覧を設定し、該当repositoryでは既定値を置き換えなければならない。                 | `AT-CFG-004`: 2 repo fixtureで一方は既定、一方はrepository別一覧が適用される。                                   |
| `CFG-005` | MUST | メンテナ設定の検証 — 空の一覧、不正なGitHubユーザー名、大文字小文字だけが異なる重複、不正なrepository名を設定エラーとして扱わなければならない。               | `AT-CFG-005`: 各不正値で公開・通知が行われず、設定箇所を含む診断が出る。                                         |
| `CFG-006` | MUST | 既存ラベル意味付け — 既存ラベルを優先度・要議論・通知抑制等へ読み替えるルールをrepo glob付きで設定できなければならない。                                      | `AT-CFG-006`: 同名ラベルをrepo別に異なる意味へ割り当てられる。                                                   |
| `CFG-007` | MUST | bot識別設定 — botのユーザー名、末尾パターン、明示allow/denyを設定できなければならない。                                                                       | `AT-CFG-007`: 既知bot・未知human・例外bot fixtureが期待通り分類される。                                          |
| `CFG-008` | MUST | 追跡開始日時 — `tracking.startAt`をISO 8601の明示設定として検証し、run成功時刻で自動確定してはならない。                                                      | `AT-CFG-008`: timezone付き日時がUTC正規化され、未指定や不正値では処理を開始しない。                              |
| `CFG-009` | MUST | 手動includeと追跡追加上限 — 古い項目の明示include、repo filter、backfill上限、`tracking.relationExpansion.maxItemsPerRun`を設定できなければならない。         | `AT-CFG-009`: 開始日前の指定URLだけをincludeでき、関係先展開上限がAPI呼び出し前に適用される。                    |
| `CFG-010` | MUST | Discordメンション設定 — GitHubユーザー名とDiscord user IDの対応、mentions.enabled、許可対象を設定でき、既定は無効でなければならない。                         | `AT-CFG-010`: 既定payloadのallowed_mentionsが空で、enabled時も許可ID以外をmentionしない。                        |
| `CFG-011` | MUST | 重要度設定 — 重要度の各要因の重み、期限間近とみなす日数、levelの閾値を設定できなければならない。                                                              | `AT-CFG-011`: 重み、日数、閾値の変更が重要度へ反映され、highがmedium未満なら設定を拒否する。                     |
| `CFG-012` | MUST | 要対応度設定 — 鮮度係数の下限とlevelの閾値を設定できなければならない。                                                                                        | `AT-CFG-012`: `recencyFloor`と閾値の変更が要対応度へ反映され、0から1の範囲外とhighがmedium未満の設定を拒否する。 |

### 11.4 GitHub収集

| ID        | 規範 | 要求                                                                                                                                                                                                                                                                     | 受入要約                                                                                                            |
| --------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| `COL-001` | MUST | GitHub App認証 — 日次収集はGitHub App installation tokenで認証できなければならない。                                                                                                                                                                                     | `AT-COL-001`: App ID/private keyから短寿命tokenを取得してAPI疎通できる。                                            |
| `COL-002` | MUST | 読み取り最小権限 — 収集用GitHub Appは必要なrepository read権限だけを要求し、GitHubのteam member一覧を取得してはならない。                                                                                                                                                | `AT-COL-002`: 権限一覧にrepositoryへのwrite権限とOrganizationのMembers権限が存在しない。                            |
| `COL-003` | MUST | repo一覧ページネーション — Organizationの全repoページを取得しなければならない。                                                                                                                                                                                          | `AT-COL-003`: 100件超fixtureでも最終ページまで欠落なく取得する。                                                    |
| `COL-004` | MUST | 公開境界での即時フィルタ — repoメタデータ取得直後にpublic・non-archived・non-disabledを検証し、それ以前にIssue本文等を取得してはならない。                                                                                                                               | `AT-COL-004`: private repo fixtureではrepo metadata以外のAPIが呼ばれない。                                          |
| `COL-005` | MUST | 項目一覧ページネーション — 各repoのopen Issue/PRを全ページ取得しなければならない。                                                                                                                                                                                       | `AT-COL-005`: 100件超のopen item fixtureで件数が一致する。                                                          |
| `COL-006` | MUST | 安定識別子 — GitHub global node IDを主識別子として保持し、owner/repo#numberとURLを表示用別名として保持しなければならない。                                                                                                                                               | `AT-COL-006`: repo rename fixtureで同じnode IDの再生結果が別項目に分裂しない。                                      |
| `COL-007` | MUST | 基本メタデータ — title、body fingerprint、author、created/updated/closed、state reason、draft、assignees、labels、milestoneを取得しなければならない。                                                                                                                    | `AT-COL-007`: schema必須フィールドがfixtureから欠落なく正規化される。                                               |
| `COL-008` | MUST | Issueコメント — 追跡Issueの全human-relevant issue commentsと取得可能な編集履歴をページネーションして取得しなければならない。                                                                                                                                             | `AT-COL-008`: 100件超コメントfixtureで順序・ID・編集時刻が保持される。                                              |
| `COL-009` | MUST | PRレビュー — PR review submissionのstate、actor、commit、timeを取得しなければならない。                                                                                                                                                                                  | `AT-COL-009`: APPROVED/CHANGES_REQUESTED/DISMISSED fixtureを区別する。                                              |
| `COL-010` | MUST | レビューthread — inline review threadとresolved状態を取得しなければならない。                                                                                                                                                                                            | `AT-COL-010`: resolved/unresolved threadが別信号になる。                                                            |
| `COL-011` | MUST | レビュー依頼 — requested user reviewerとrequested team reviewer、追加・解除時刻を取得しなければならない。                                                                                                                                                                | `AT-COL-011`: request→remove fixtureで現行依頼だけがwaitingOn候補となる。                                           |
| `COL-012` | MUST | PR push検知 — head SHA、commit時刻、force-push相当のtimeline変化を取得しなければならない。                                                                                                                                                                               | `AT-COL-012`: review後push fixtureで最新headと時系列が判定に渡る。                                                  |
| `COL-013` | MUST | merge/CI状態 — mergeability、merge state、auto-merge、merge queue相当、check run/statusを可能な範囲で取得しなければならない。                                                                                                                                            | `AT-COL-013`: ready/running/failing/conflict fixtureを区別する。                                                    |
| `COL-014` | MUST | timelineイベント — assigned、unassigned、labeled、unlabeled、review requested、ready for review、cross-reference、`BlockedByAddedEvent`、`BlockedByRemovedEvent`、`BlockingAddedEvent`、`BlockingRemovedEvent`等のtimelineと`userContentEdits`を取得しなければならない。 | `AT-COL-014`: IssueとPull Requestの全ページfixtureが安定ID、発生時刻、item内sequence付き正規化eventになる。         |
| `COL-015` | MUST | native dependency — GitHubのnative issue dependencyを利用可能な場合に取得しなければならない。                                                                                                                                                                            | `AT-COL-015`: blocked-by/blocking fixtureがauthoritative edgeになる。                                               |
| `COL-016` | MUST | sub-issue — GitHubのsub-issue/parent関係を利用可能な場合に取得しなければならない。                                                                                                                                                                                       | `AT-COL-016`: parent/sub-issue fixtureがauthoritative hierarchyになる。                                             |
| `COL-017` | MUST | inbound cross-reference — 追跡項目へ別Issue/PRからリンクされたcross-referenceを検出し、source itemを候補に加えなければならない。                                                                                                                                         | `AT-COL-017`: 新規sourceがtracked targetへリンクするfixtureでsourceが発見される。                                   |
| `COL-018` | MUST | 変更種別保持 — コメント、push、review、review request、label、assignee、state、relationの変更種別を区別して保存しなければならない。                                                                                                                                      | `AT-COL-018`: 同一updated_at変化でもevent kind別に出力される。                                                      |
| `COL-019` | MUST | cache利用 — current fingerprintが一致する検証済み収集cacheを使い、不一致またはcache missではcurrent detailと全eventを取得しなければならない。                                                                                                                            | `AT-COL-019`: cache hitはschema検証後だけ再利用され、cold runでは必要な全項目が取得される。                         |
| `COL-020` | MUST | timeline全履歴取得 — 詳細取得対象のtimeline、comment、review、編集履歴を`since`なしで全ページ取得しなければならない。                                                                                                                                                    | `AT-COL-020`: 100件を超えるfixtureでもqueryに`since`が含まれず、pagination末尾までsource IDとsequenceが保持される。 |
| `COL-021` | MUST | rate limit管理 — GitHub rate-limit headers/GraphQL costを監視し、安全余裕を残して収集計画を調整しなければならない。                                                                                                                                                      | `AT-COL-021`: 残量閾値以下のfixtureでAI前にcheckpoint/停止し、部分公開しない。                                      |
| `COL-022` | MUST | repo単位stale処理 — 503で取得不能なrepoは検証済み収集cacheがある場合だけstaleとして明示し、影響する通常通知から除外しなければならない。                                                                                                                                  | `AT-COL-022`: 1 repoだけ503のfixtureでcacheがあればstale表示、cacheがなければPagesとDiscordを更新せず失敗する。     |

### 11.5 追跡ライフサイクル

| ID        | 規範 | 要求                                                                                                                                                                      | 受入要約                                                                                          |
| --------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `TRK-001` | MUST | startAt明示 — `tracking.startAt`は設定から読み、最初の成功時刻や実行時刻へ置き換えてはならない。                                                                          | `AT-TRK-001`: 未指定設定では起動せず、同じ設定を再実行して値が変化しない。                        |
| `TRK-002` | MUST | 開始日以後の新規項目 — startAt以後に作成されたopen Issue/PRを自動追跡しなければならない。                                                                                 | `AT-TRK-002`: 境界前後1秒のfixtureで後だけ自動includeされる。                                     |
| `TRK-003` | MUST | 開始日前でも新規活動 — startAt前作成でもstartAt後にhuman-relevant変更があったopen項目を自動追跡しなければならない。                                                       | `AT-TRK-003`: 古いIssueへの新規human comment fixtureがincludeされる。                             |
| `TRK-004` | MUST | trackedから参照された古い項目 — tracked itemが参照する同Organizationの古い項目をrelation candidateとして追跡へ加えなければならない。                                      | `AT-TRK-004`: 開始日前blocker URL fixtureがincludeされる。                                        |
| `TRK-005` | MUST | trackedを参照する古い項目 — cross-referenceによりtracked itemを参照した古いsource itemを追跡へ加えなければならない。                                                      | `AT-TRK-005`: 開始日前sourceの新規cross-reference fixtureがincludeされる。                        |
| `TRK-006` | MUST | native関係の再帰include — native dependency/sub-issueで接続するOrganization内項目を設定深度まで再帰includeしなければならない。                                            | `AT-TRK-006`: 深度3 fixtureで上限どおりincludeされ無限巡回しない。                                |
| `TRK-007` | MUST | 明示include — 設定したIssue/PR URLまたはnode IDを作成日時に関係なく追跡できなければならない。                                                                             | `AT-TRK-007`: closedを含む明示URL fixtureが追跡される。                                           |
| `TRK-008` | MUST | workflow_dispatch backfill — manual workflowでnone/linked/all-openのbackfill modeとrepo filterを指定できなければならない。                                                | `AT-TRK-008`: dry-run後にall-openを実行し、対象範囲だけ追加される。                               |
| `TRK-009` | MUST | 古さによる差別禁止 — 追跡条件を満たすopen項目には作成日時によらず同じ状態・停滞・通知ルールを適用しなければならない。                                                     | `AT-TRK-009`: 同一event列で作成日だけ異なる2 fixtureの判定が一致する。                            |
| `TRK-010` | MUST | terminal cache — closed/merged項目を`terminalAt`から180日までcacheへ保持してよい。現在のopen判定へ無条件に流用してはならない。                                            | `AT-TRK-010`: close後179日はcacheから表示でき、期限超過後は削除でき、open項目の判定は変化しない。 |
| `TRK-011` | MUST | terminal再分析抑制 — terminal項目は状態遷移直後、分析入力または判定規則の変更、AIC-023の再試行を除き、Codex再分析と停滞通知を行ってはならない。                           | `AT-TRK-011`: AI分析済みのclosed unchanged fixtureでAI callとstall notificationが0件になる。      |
| `TRK-012` | MUST | automation noiseは追跡と通知を分離 — Renovate dashboard等のautomation項目を必要なら追跡・関係表示しつつ、作成者だけで削除せず通知抑制ルールを別に適用しなければならない。 | `AT-TRK-012`: automation itemがgraph nodeとして残り、既定digestからは除外される。                 |

### 11.6 状態・ボール判定

| ID        | 規範 | 要求                                                                                                                                                                                                                                                      | 受入要約                                                                                                                                      |
| --------- | ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `RSP-001` | MUST | 状態と責務の分離 — status、waitingOn、nextAction、statusSince、ownerSinceを別フィールドで保持しなければならない。                                                                                                                                         | `AT-RSP-001`: 同一ownerでstatusだけ変わるfixtureを表現できる。                                                                                |
| `RSP-002` | MUST | 責務種別 — waitingOnはuser、team、role、item、automation、unknownを表現できなければならない。                                                                                                                                                             | `AT-RSP-002`: 全種別のschema fixtureがvalidationに通る。                                                                                      |
| `RSP-003` | MUST | 未アサインIssueの分類 — 作成者以外のhumanコメント、現在のラベル、担当履歴のいずれかがあれば担当決め待ち、なければ内容確認待ちとし、当該repoのメンテナ全員へ責務を置かなければならない。                                                                   | `AT-RSP-003`: コメントなし、humanコメントあり、botコメントのみ、ラベルありの各fixtureが期待する状態となり、設定した各ユーザー名が候補になる。 |
| `RSP-004` | MUST | アサインIssue — 明確な別の待ち根拠がないアサイン済みIssueは作業待ちとし、assigneeの作業を待たなければならない。                                                                                                                                           | `AT-RSP-004`: assignee 1名または複数名のfixtureで全員がwaitingOn候補となる。                                                                  |
| `RSP-005` | MUST | 未回答の明示依頼 — 最新の未回答な質問・判断依頼が個人またはteamへ向く場合、返答待ちとして名指しされた相手をrespondentにしなければならない。                                                                                                               | `AT-RSP-005`: 本文/コメントの依頼fixtureでCodexがsource ID付きのrespondentを選ぶ。                                                            |
| `RSP-006` | MUST | maintainer作成でも責務維持 — 設定したメンテナが作成したIssue/PRでも次の担当が明確でなければ当該repoのメンテナ全員へ責務を置かなければならない。                                                                                                           | `AT-RSP-006`: maintainer-authored unassigned fixtureでauthorへ責務が移らず、設定した各ユーザー名が候補になる。                                |
| `RSP-007` | MUST | open blocker優先 — 確定したopen blockerがある項目はstatus=waiting_for_unblockとし、waitingOnにblocker itemを置かなければならない。                                                                                                                        | `AT-RSP-007`: open/closed blocker混在fixtureでopenだけがwaitingOnになる。                                                                     |
| `RSP-008` | MUST | draft PRの既定 — 明示的に他者の行動を待っていないdraft PRは作業中とし、authorへ責務を置かなければならない。                                                                                                                                               | `AT-RSP-008`: recent draft fixtureが`in_progress`となり、waitingOn.roleがauthorになる。                                                       |
| `RSP-009` | MUST | draft中の明示依頼 — draftでもmaintainerへの方針判断依頼や外部blockerを明示している場合、作業中としてauthorへ責務を置く既定を上書きできなければならない。                                                                                                  | `AT-RSP-009`: draft + decision request fixtureが方針判断待ちとなり、設定したメンテナ全員へ責務が移る。                                        |
| `RSP-010` | MUST | レビュー未依頼PR — ready-for-reviewのPRにreview requestがなく、他の明確な待ち先もない場合は担当決め待ちとし、レビュー担当を決めるメンテナ全員へ責務を置かなければならない。                                                                               | `AT-RSP-010`: reviewerなしPR fixtureが担当決め待ちとなり、設定した各ユーザー名が候補になる。                                                  |
| `RSP-011` | MUST | 個人レビュー依頼 — 現行requested reviewer userがいるPRはレビュー待ちとし、当該userのレビューを待たなければならない。                                                                                                                                      | `AT-RSP-011`: user request fixtureでユーザー名が表示される。                                                                                  |
| `RSP-012` | MUST | teamレビュー依頼 — 現行requested team reviewerがいるPRはレビュー待ちとし、当該teamのレビューを待たなければならない。                                                                                                                                      | `AT-RSP-012`: team request fixtureでteam slugが表示される。                                                                                   |
| `RSP-013` | MUST | 変更要求後の修正待ち — 最新head commit以後にhuman reviewerの`CHANGES_REQUESTED`がある場合は修正待ちとし、authorの修正を待たなければならない。                                                                                                             | `AT-RSP-013`: VOICEVOX/voicevox#3079型fixtureが修正待ちとなり、waitingOn.roleがauthorになる。                                                 |
| `RSP-014` | MUST | 変更対応push後のレビュー待ち — `CHANGES_REQUESTED`後にauthorが新しいhead commitをpushし、再対応が完了したと推定できる場合はレビュー待ちとし、reviewer側へ責務を戻せなければならない。                                                                     | `AT-RSP-014`: review→push fixtureがレビュー待ちとなり、ownerSinceがpush時刻へ変わる。                                                         |
| `RSP-015` | MUST | 未解決human thread — 未解決のhuman review threadをactionable signalとして扱わなければならない。ただし最後のhumanコメントがauthorのthreadはauthor応答済みとみなし、修正待ちの根拠にしてはならない。                                                        | `AT-RSP-015`: unresolved human thread fixtureはresolved版より修正待ちの優先度が高い。authorが最後に返信したthreadは修正待ちにならない。       |
| `RSP-016` | MUST | bot review非所有 — botのreview/commentだけを理由に個人・teamのボールをbotへ移してはならない。                                                                                                                                                             | `AT-RSP-016`: Copilot comment fixtureでwaitingOn.kindがautomation/user botにならない。                                                        |
| `RSP-017` | MUST | 承認済みready-to-merge — 必要承認とchecksを満たしauto-mergeまたはqueueが未設定のPRはマージ待ちとし、設定したメンテナ全員のマージ判断を待たなければならない。                                                                                              | `AT-RSP-017`: approved/passing fixtureが`waiting_for_merge`となり、設定した各ユーザー名が`role=merge_decider`の候補になる。                   |
| `RSP-018` | MUST | 自動処理待ち — auto-merge、merge queue、実行中required checksで人の操作が不要な間は自動処理待ちとし、automationの完了を待たなければならない。                                                                                                             | `AT-RSP-018`: queue/running checks fixtureが自動処理待ちとなり、waitingOn.kindがautomationになる。短時間の人向け通知は出さない。              |
| `RSP-019` | MUST | コード起因CI失敗 — PR変更に起因すると確度高く判定できるrequired check failureは修正待ちとし、authorの修正を待たなければならない。                                                                                                                         | `AT-RSP-019`: deterministic test failure fixtureが修正待ちとなり、waitingOn.roleがauthorになる。                                              |
| `RSP-020` | MUST | infra/flaky CI — インフラまたはflakyの疑いがあるcheck failureはCodex評価し、低信頼時は担当決め待ちとして設定したメンテナ全員へ責務を置くか、待ち先不明へ縮退しなければならない。                                                                          | `AT-RSP-020`: runner outage fixtureが修正待ちとしてauthorの修正を待つ判定にならない。                                                         |
| `RSP-021` | MUST | merge conflict — 他の明確な運用ルールがないmerge conflict PRは修正待ちとし、authorの修正を待たなければならない。                                                                                                                                          | `AT-RSP-021`: conflicting fixtureが修正待ちとなり、authorのnext actionがbranch更新になる。                                                    |
| `RSP-022` | MUST | terminal状態 — `terminal_merged`、`terminal_completed`、`terminal_not_planned`を区別し、いずれも人のwaitingOnを空にしなければならない。                                                                                                                   | `AT-RSP-022`: 3 terminal fixtureでstatus reasonが区別される。                                                                                 |
| `RSP-023` | MUST | 複数blocker — 複数open blockerを同時に保持し、primary blocker選定と全一覧を表示しなければならない。                                                                                                                                                       | `AT-RSP-023`: 3 blockers fixtureで欠落せず、primary選定理由がある。                                                                           |
| `RSP-024` | MUST | 責務遷移時刻 — waitingOnの実体またはstatusが変わった時点でownerSince/stallSinceを更新しなければならない。                                                                                                                                                 | `AT-RSP-024`: 担当決め待ちのメンテナ候補からrequested reviewerへ責務が移るfixtureで時刻がreview requestになる。                               |
| `RSP-025` | MUST | 意味のある進捗 — 単なるコメント数ではなく、成果物push、回答、レビュー、依存解消、決定等をlastProgressAtとして判定しなければならない。                                                                                                                     | `AT-RSP-025`: 雑談コメントと回答コメントfixtureでlastProgressAtが異なる。                                                                     |
| `RSP-026` | MUST | bot activityで停滞解除禁止 — botコメント、preview URL更新、定期dashboard更新だけではstallSinceをリセットしてはならない。                                                                                                                                  | `AT-RSP-026`: bot-only activity fixtureで停滞時間が継続する。                                                                                 |
| `RSP-027` | MUST | label変更の扱い — label変更はpriority/semanticsを再計算するが、設定で進捗扱いされたlabel以外はstallSinceをリセットしてはならない。                                                                                                                        | `AT-RSP-027`: priority label追加fixtureでseverity、重要度、要対応度が変わり、stallSinceは維持される。                                         |
| `RSP-028` | MUST | 不確実性表示 — 責務判定にconfidence、根拠source IDs、uncertaintiesを持ち、低信頼時はunknown/推定表示へ縮退しなければならない。                                                                                                                            | `AT-RSP-028`: 低confidence fixtureが断定表示・高優先通知にならない。                                                                          |
| `RSP-029` | MUST | 保持者の発言による責務の反転 — 変更要求、未解決review thread、userへのreview依頼で待ち先を決めた後、その待ち先本人が責務の起点より後に本文のある発言をしている場合、発言の意味を解釈して責務を判定しなければならない。                                    | `AT-RSP-029`: 変更要求後にauthorが質問するfixtureは返答待ちとなり、reviewerの返答を待つ。teamへのreview依頼ではmemberの発言を照合しない。     |
| `RSP-030` | MUST | 応答不要の発言 — 了解、謝辞、進捗報告のように相手の行動を必要としない発言だけを理由に、責務を相手へ移してはならない。                                                                                                                                     | `AT-RSP-030`: authorが了解コメントだけを返すfixtureは修正待ちを維持し、authorの修正を待つ。                                                   |
| `RSP-031` | MUST | 責務主体の活動による停滞起点 — 現在の`kind=user`候補がGitHub上で活動した時刻を停滞起点の下限としなければならない。`kind=team`候補は責務アカウントを持たず、team member、第三者、botの活動、draft戻し、merge queueの出し入れでは停滞を解除してはならない。 | `AT-RSP-031`: user候補本人のコメントで停滞起点が進み、team member、第三者、botのコメントでは進まない。                                        |
| `RSP-032` | MUST | リポジトリ責務の展開 — 抽象的なmaintainer、reviewer、merge_deciderのwaitingOnを当該repoのメンテナ1人につき1件の`kind=user`候補へ展開しなければならない。                                                                                                  | `AT-RSP-032`: 複数メンテナfixtureで各ユーザー名の候補が入力順に現れ、明示されたuserとteamの候補は変更されない。                               |

### 11.7 依存グラフ

| ID        | 規範 | 要求                                                                                                                                                                | 受入要約                                                                                                                      |
| --------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `GRF-001` | MUST | node種別 — graph nodeはissue、pull_request、external_referenceを区別しなければならない。                                                                            | `AT-GRF-001`: 3種fixtureが異なるshape/icon/textで識別できる。                                                                 |
| `GRF-002` | MUST | blocks向き — blockerからblocked itemへ向くcanonical blocks edgeを保存し、blockedByを導出しなければならない。                                                        | `AT-GRF-002`: AがBを待つfixtureでedge=B→A、A.blockedBy=[B]となる。                                                            |
| `GRF-003` | MUST | edge型 — blocks、parent_of、implements、related_to、duplicatesを区別しなければならない。                                                                            | `AT-GRF-003`: 各relation fixtureが同一edge typeへ混同されない。                                                               |
| `GRF-004` | MUST | provenance — 各edgeにnative、explicit_text、closing_keyword、checklist、cross_reference、ai_inference等のprovenanceを保持しなければならない。                       | `AT-GRF-004`: current graphの各edgeがsource kindとsource IDを持ち、確定関係と推定関係を区別して示す。                         |
| `GRF-005` | MUST | native優先 — GitHub native dependency、sub-issue、closing referenceを最高優先のauthoritative relationとして扱わなければならない。                                   | `AT-GRF-005`: AIが反対するfixtureでもnative edgeは維持されcontradictionが注記される。                                         |
| `GRF-006` | MUST | plain linkは候補 — 単なるhyperlink/cross-referenceだけでblocks edgeを確定してはならない。                                                                           | `AT-GRF-006`: 関連リンクだけのfixtureがrelated/noneとなりblockedにならない。                                                  |
| `GRF-007` | MUST | closing keyword — PR本文のclose、fix、resolve keywordを推定のimplements候補として抽出し、blocksやauthoritative relationと混同してはならない。                       | `AT-GRF-007`: 本文だけにclosing keywordがあるfixtureが`closing_keyword`由来の推定implements候補になる。                       |
| `GRF-008` | MUST | checklist階層候補 — Issue本文のchecklistとindentをparent/subtask候補として抽出しなければならない。                                                                  | `AT-GRF-008`: VOICEVOX/voicevox_core#1286型fixtureで階層候補が生成される。                                                    |
| `GRF-009` | MUST | AI edge判定 — 曖昧候補ごとにCodexがrelation typeまたはnoneを返し、confidenceとevidenceを付けなければならない。                                                      | `AT-GRF-009`: 全candidateにverdictが1件ずつ存在する。                                                                         |
| `GRF-010` | MUST | 推定edgeの切断 — 本文編集・コメント追加・依存完了等で根拠がなくなった推定edgeを次回再分析でactive graphから外せなければならない。                                   | `AT-GRF-010`: edge根拠削除fixtureでactive=falseとなる。                                                                       |
| `GRF-011` | MUST | edge replay — edgeの追加、型変更、confidence変更、削除をGitHub eventと編集履歴から再生しなければならない。                                                          | `AT-GRF-011`: add→change→remove fixtureから区間と発生時刻を再現し、永続的な差分一覧を作らない。                               |
| `GRF-012` | MUST | cycle検知 — blocks graphの強連結成分を検出し、dependency_cycleとして通知候補化しなければならない。                                                                  | `AT-GRF-012`: A→B→C→A fixtureで無限再帰せず1 cycle componentとなる。                                                          |
| `GRF-013` | MUST | actionable frontier — open incoming blocks edgeを持たない非terminal項目をactionable frontierとして算出しなければならない。                                          | `AT-GRF-013`: DAG fixtureで実行可能な末端だけがfrontierになる。                                                               |
| `GRF-014` | MUST | downstream impact — 各nodeが直接・推移的に止めるopen node数とrepo数を算出しなければならない。                                                                       | `AT-GRF-014`: 既知DAGで期待countと一致する。                                                                                  |
| `GRF-015` | MUST | cross-repo保持 — repo境界を越えるedgeを同一connected componentに保持しなければならない。                                                                            | `AT-GRF-015`: project→core→engine fixtureが1 componentになる。                                                                |
| `GRF-016` | MUST | 隣接変化伝播 — 依存nodeのstate/edgeが変わった場合、本文未更新の隣接nodeも再分類しなければならない。                                                                 | `AT-GRF-016`: 閉じたblockerを待つ古いPR fixtureが本文変更なしでnewly_unblockedになる。                                        |
| `GRF-017` | MUST | native closing reference — GitHubの`closingIssuesReferences`とtimelineの`willCloseTarget`を取得し、authoritativeなimplements relationとして確定しなければならない。 | `AT-GRF-017`: 両方のclosing reference fixtureがnative implementsになり、本文だけのclosing keyword fixtureは推定のままになる。 |

### 11.8 Codex利用

| ID        | 規範 | 要求                                                                                                                                                                                                                                                                                                                                  | 受入要約                                                                                                                                                                                              |
| --------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AIC-001` | MUST | Codex限定 — 初期リリースのAI backendはOpenAI Codexだけを実装対象としなければならない。                                                                                                                                                                                                                                                | `AT-AIC-001`: configでprovider=codex以外を指定すると未対応エラーになる。                                                                                                                              |
| `AIC-002` | MUST | 曖昧変更と再試行だけ呼出し — 定式ルールで高信頼に確定できず入力または隣接graph hashが変わった項目と、AIC-023の再試行項目だけをCodex分析候補にしなければならない。                                                                                                                                                                     | `AT-AIC-002`: 検証済み結果を持つunchanged fixtureとclear fixtureのAI call数が0、ambiguous changed fixtureだけ1となる。                                                                                |
| `AIC-003` | MUST | content-addressed cache — model、reasoningEffort、Codex CLI/API version、promptVersion、schemaVersion、判定に影響しないrun開始時刻を除いたnormalized input hashをcache keyに含めなければならない。                                                                                                                                    | `AT-AIC-003`: key構成要素または判定入力の変更でcache missとなり、run開始時刻だけの変更ではcache hitとなる。                                                                                           |
| `AIC-004` | MUST | Structured Output — Codex最終出力を`schemas/codex-analysis.schema.json`で拘束しなければならない。                                                                                                                                                                                                                                     | `AT-AIC-004`: Codex呼び出しが同Schemaを使い、非JSON・extra property・enum外出力が受理されない。                                                                                                       |
| `AIC-005` | MUST | read-only隔離 — Codexを空の一時workspace、read-only sandbox、承認要求なし、不要toolなしで実行しなければならない。                                                                                                                                                                                                                     | `AT-AIC-005`: adversarial prompt fixtureでworking tree変更・外部コマンド成功が0件である。                                                                                                             |
| `AIC-006` | MUST | secret隔離 — Codex subprocessへOpenAI認証以外のGitHub App key、installation token、Discord webhook、Actions token、`CODEX_AUTH_SYNC_TOKEN`を渡してはならない。                                                                                                                                                                        | `AT-AIC-006`: process environment検査で禁止secret名が存在しない。                                                                                                                                     |
| `AIC-007` | MUST | prompt injection対策 — Issue/PR本文・コメントをuntrusted dataとして区切り、内部命令に従わないsystem instructionを固定しなければならない。                                                                                                                                                                                             | `AT-AIC-007`: unit testで固定system instructionとuntrusted入力JSONの分離を確認する。golden fixtureでは命令を採用した固定AI出力をvalidationで拒否し、実モデルを呼び出さない。                          |
| `AIC-008` | MUST | 候補制約 — relation targetとwaitingOn user/teamは入力candidate集合からのみ選択させなければならない。                                                                                                                                                                                                                                  | `AT-AIC-008`: 未知のURLやユーザー名を返した出力がsemantic validationで拒否される。                                                                                                                    |
| `AIC-009` | MUST | source ID根拠 — AI判定のevidenceは入力に付与したsource IDを参照しなければならない。                                                                                                                                                                                                                                                   | `AT-AIC-009`: 存在しないsource IDの出力が拒否される。                                                                                                                                                 |
| `AIC-010` | MUST | 簡潔な説明 — 出力は短いreasonSummaryと根拠だけを含み、内部思考過程の出力を要求・保存してはならない。                                                                                                                                                                                                                                  | `AT-AIC-010`: schemaにchainOfThought相当フィールドがなく、summary長制限が効く。                                                                                                                       |
| `AIC-011` | MUST | confidence閾値 — high>=0.85、medium>=0.65、low<0.65を既定とし、mediumは推定表示、lowはfallbackとしなければならない。                                                                                                                                                                                                                  | `AT-AIC-011`: 境界値fixtureで表示・通知扱いが仕様通り変わる。                                                                                                                                         |
| `AIC-012` | MUST | 二重validationと出力制約 — JSON Schema validation後にcandidate参照、時刻、URL、矛盾、native relation保護のsemantic validationを行い、同じ規則を固定system promptでAIへ明示しなければならない。`deterministicSignals`のnative relation制約には実在する候補IDを設定しなければならない。                                                 | `AT-AIC-012`: schema-validだが候補外のfixtureがsemantic stageで失敗する。4種類のnative relation fixtureで入力制約が空にならず、AIが反対してもnative edgeが維持される。                                |
| `AIC-013` | MUST | AI失敗時縮退 — timeout、rate limit、schema error時は定式判定でPages生成を継続してよいが、current graphに必要なrelation AIが欠けた場合はPagesと通常Discordを停止しなければならない。AI状態と項目ごとの利用状況はrun artifactへ出し、次回runの判定入力へしない。                                                                        | `AT-AIC-013`: AI無効、全件失敗、部分失敗、relation不足のfixtureで継続または停止が区別され、artifactだけに診断が残る。                                                                                 |
| `AIC-014` | MUST | 完全一致cache — Codex出力のcacheはsource/input hashが完全一致する場合だけ通常結果へ使い、入力変更後の結果を現在の関係や責務へ流用してはならない。重要度判定を得られない場合はIMP-005に従う。                                                                                                                                          | `AT-AIC-014`: 本文1文字変更fixtureで異なる入力のcacheが使われず、importance以外の過去結果も使われない。                                                                                               |
| `AIC-015` | MUST | 再現情報 — 各AI結果にmodel identifier、reasoningEffort、backend version、promptVersion、schemaVersion、input/output hash、実行時刻を記録しなければならない。                                                                                                                                                                          | `AT-AIC-015`: 任意結果から全再現metadataが取得できる。                                                                                                                                                |
| `AIC-016` | MUST | run予算 — 1 runあたりcall数、入力文字/token見積、費用上限を設定できなければならない。                                                                                                                                                                                                                                                 | `AT-AIC-016`: 上限到達fixtureで追加callを停止する。                                                                                                                                                   |
| `AIC-017` | MUST | 予算超過優先順位 — 予算不足時は曖昧な状態判定候補、owner unknown、changed blockers、downstream impact、current inputのnode ID順に分析し、残りをdeferredとしてartifactへ記録しなければならない。                                                                                                                                       | `AT-AIC-017`: 高優先候補がnode ID順の規則で選ばれ、deferredが次回runの必須入力にならない。                                                                                                            |
| `AIC-018` | MUST | golden eval — 実VOICEVOX運用パターンを匿名化/固定したgolden fixture suiteを保持しなければならない。                                                                                                                                                                                                                                   | `AT-AIC-018`: review change、stale blocker、checklist、bot noise、direct requestのfixtureが存在する。                                                                                                 |
| `AIC-019` | MUST | 更新前回帰評価 — schema、semantic validation、reducer、状態、graph、通知判定の更新は固定AI出力を使うgolden evalの基準を満たさなければならない。model、reasoning effort、promptの更新は実モデルを呼び出すdry-run結果も確認しなければならない。                                                                                         | `AT-AIC-019`: 意図的な判定退行でCIが失敗し、標準golden fixtureの`fixedAi.networkCallCount`が0になる。model、reasoning effort、promptの変更では`metrics.aiCallCount`が1以上のdry-run差分をreviewする。 |
| `AIC-020` | MUST | AI非書込 — Codex出力は提案データとして検証・reducerを通し、GitHub変更、Discord直接送信、state直接上書きを許してはならない。                                                                                                                                                                                                           | `AT-AIC-020`: mockでCodexがwrite指示を返しても副作用APIが呼ばれない。                                                                                                                                 |
| `AIC-021` | MUST | 認証方式選択 — `ai.authentication`は`api-key`か`auth-json`に限定し、AI有効時だけ選択した方式の認証情報を要求しなければならない。Codex認証providerはsubprocessへ`api-key`では`OPENAI_API_KEY`だけ、`auth-json`では`CODEX_HOME`だけを渡さなければならない。`auth-json`では直下の`auth.json`の存在だけを確認し、内容を読んではならない。 | `AT-AIC-021`: 認証方式ごとのprocess environmentと`auth.json`不在時の起動前エラーが要件に一致し、AI無効時はどちらの認証環境変数も要求されない。                                                        |
| `AIC-022` | MUST | 並列実行 — 予算計画で選ばれた候補を`ai.execution.maxConcurrentCalls`件まで同時に実行できなければならない。判定結果と失敗の並びは完了順に依存せず予算計画順で決定論的でなければならない。                                                                                                                                              | `AT-AIC-022`: 同時実行数が設定値を超えず、逆順に完了しても結果と失敗の並びが変わらない。                                                                                                              |
| `AIC-023` | MUST | AI再試行 — current inputに一致するresult cacheがない項目は、状態にかかわらず今回の候補選定へ従ってAIを再実行できなければならない。AI失敗時に同じnode IDのlatest importanceだけをfallbackへ使い、relationや責務を再利用してはならない。                                                                                                | `AT-AIC-023`: result cache missはcurrent inputから再実行され、latest importance以外の過去結果が使われない。                                                                                           |

### 11.9 重要度と要対応度

| ID        | 規範 | 要求                                                                                                                                                                                            | 受入要約                                                                                                     |
| --------- | ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `IMP-001` | MUST | 停滞の深刻さとの分離 — 各追跡項目の重要度を、停滞の深刻さを表すseverityとは別に保持しなければならない。                                                                                         | `AT-IMP-001`: 同じseverityでも重要度要因が異なる2項目でscoreとlevelが別々に決まる。                          |
| `IMP-002` | MUST | 決定論的要因 — 優先度ラベルの重み、downstream impact、期限付きのopen milestoneから重要度を決定論的に加点しなければならない。期限間近のmilestoneは追加で加点する。                               | `AT-IMP-002`: 各要因を単独で持つfixtureがCodexなしで設定どおり加点される。                                   |
| `IMP-003` | MUST | 自然言語要因 — Codexは、重要な機能か、期限が明示されているか、将来問題になるかの3要因を根拠付きで判定しなければならない。                                                                       | `AT-IMP-003`: 3要因を個別に満たすfixtureで対応する要因だけが加点され、根拠が保持される。                     |
| `IMP-004` | MUST | 低信頼判定の非加点 — Codex判定のconfidenceがlowの場合、Codex由来の重要度要因を加点してはならない。                                                                                              | `AT-IMP-004`: 同じCodex出力でもmedium境界未満では3要因が加点されず、境界以上では加点される。                 |
| `IMP-005` | MUST | latest importance fallback — そのrunでCodexの重要度判定を得られない項目は、同じnode IDの直近検証済みimportanceだけを再利用してよい。なければlabel、milestone、downstream impactだけで計算する。 | `AT-IMP-005`: 過去入力の状態や関係を使わず、latest importanceの有無で3要因または決定論的要因へ分岐する。     |
| `IMP-006` | MUST | scoreとlevel — 重要度scoreを要因の加点から0以上100以下の整数として求め、設定した閾値によりlevelをlow、medium、highのいずれかへ分類しなければならない。                                          | `AT-IMP-006`: 0点、閾値境界、100点を超える要因合計のfixtureでscoreとlevelが期待値に一致する。                |
| `ATT-001` | MUST | 要対応度計算 — wait classのwatch閾値を半減期とする鮮度係数を重要度scoreへ掛け、四捨五入した0以上100以下の要対応度scoreとlevelを求めなければならない。                                           | `AT-ATT-001`: 停滞0時間、半減期、長期停滞、level境界のfixtureで式と設定どおりのscoreとlevelになる。          |
| `ATT-002` | MUST | 計時対象外 — terminal項目とblocker待ちで自身が動けない項目は要対応度scoreを0にしなければならない。                                                                                              | `AT-ATT-002`: terminalと`waiting_for_unblock`のfixtureが重要度にかかわらず0点となる。                        |
| `ATT-003` | MUST | 毎run再計算 — 要対応度は前回値を引き継がず、最新の重要度、停滞時間、wait class、設定から毎run全項目で再計算しなければならない。                                                                 | `AT-ATT-003`: GitHub側が未変更の項目もrun開始時刻と設定に応じて再計算され、決定論的規則versionに依存しない。 |

### 11.10 Webページ

| ID        | 規範 | 要求                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | 受入要約                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| --------- | ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `WEB-001` | MUST | GitHub Pages公開 — Web UIをVOICEVOX/voicevox_task_trackerのGitHub PagesへActions artifact経由で公開しなければならない。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | `AT-WEB-001`: mainの成功run後にPages URLが200を返す。                                                                                                                                                                                                                                                                                                                                                                                       |
| `WEB-002` | MUST | トップページの項目一覧 — トップ`/`はすべての追跡項目を検索、絞り込み、並び替え、50件単位でページ送りできる項目一覧にしなければならない。見出しは「項目一覧」とし、既定は要対応度の降順にしなければならない。グローバルナビゲーションは項目一覧と担当者の二つにし、一覧専用の`/items`を提供してはならない。項目詳細の`/items/{repositoryName}/{number}`は提供しなければならない。共通ヘッダーのサイト名は16px相当、各ページ見出しは18px相当で表示し、見出しレベルを維持しなければならない。共通フッターはrun IDだけを表示しなければならない。                                                                                                                                                                                                                                                                                                                                                                    | `AT-WEB-002`: トップに全追跡項目が要対応度の降順で現れ、検索、絞り込み、並び替え、ページ送りを利用できる。グローバルナビゲーションは二項目で、`/items`は未対応URL、項目詳細pathは有効になる。サイト名と各ページ見出しが指定サイズで現れ、共通フッターにはrun IDだけが現れる。                                                                                                                                                               |
| `WEB-004` | MUST | 項目ごとの依存graph — 各item詳細で、その項目とactive edgeで直接つながる項目を依存graphとして閲覧でき、隣接項目の詳細へ遷移できなければならない。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | `AT-WEB-004`: 依存関係を持つitem fixtureで中心項目と隣接項目が図に現れ、依存がない項目では図が出ない。                                                                                                                                                                                                                                                                                                                                      |
| `WEB-005` | MUST | 停滞と影響の明示 — 長いstall時間とdownstream impactを追跡対象nodeの中へ数値で示し、nodeの形、edgeの線種、矢印の向きが何を表すかを凡例として図の近くへ示さなければならない。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | `AT-WEB-005`: 停滞日数と影響するopen項目数がnodeに現れ、凡例にnodeの形、edgeの線種、矢印の向きの説明が現れる。                                                                                                                                                                                                                                                                                                                              |
| `WEB-006` | MUST | frontier表示 — actionable frontierを依存graph上で識別できなければならない。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | `AT-WEB-006`: DAG fixtureのfrontier nodeにtext/icon表示がある。                                                                                                                                                                                                                                                                                                                                                                             |
| `WEB-007` | MUST | 表示上限と中心項目 — 公開summaryの依存graphは要対応度を最初の優先順位として初期nodeを選ばなければならない。項目詳細では中心項目を必ず描き、frontier、要対応度の順で表示上限内の候補を選び、上限外の隣接項目の件数を示さなければならない。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | `AT-WEB-007`: 初期graphと上限を超える隣接項目のfixtureで要対応度による選定順が一致し、中心項目、frontier、除外件数が表示される。                                                                                                                                                                                                                                                                                                            |
| `WEB-008` | MUST | 一覧の絞り込みと並び替え — repo、type、status、importance、waitingOn、stall、AI利用状況で絞り込める項目一覧を提供しなければならない。並び替えキーは要対応度、重要度、停滞時間の三つだけとし、既定は要対応度の降順にしなければならない。一覧の要対応度と重要度はlevel名を省いてscoreだけを表示し、levelに対応する三段階の色を使わなければならない。要対応度は塗り、重要度は枠線で区別しなければならない。AI分析に失敗または延期し、AI推定が最新でない項目には警告アイコンを表示しなければならない。確定ルールだけで判定してAI推定を意図的に省いた項目と区別し、どちらも絞り込めなければならない。値が有限の列は公開データに実在する選択肢から選ばせ、URLへは表示文言ではなく識別子を入れなければならない。一覧上部へ件数と選択中の並び替えキー名を表示してはならない。表を表示する幅では列見出しだけを、カードを表示する幅では専用の選択UIだけを並び替え操作に使い、両者の切り替え幅を一致させなければならない。 | `AT-WEB-008`: keyboardのみで全filterとitem遷移ができ、`ai=outdated`で`failed`と`deferred`だけ、`ai=skipped`で`not_required`だけが表示される。警告アイコンは前者だけに現れる。要対応度と重要度は点数だけがlevel別の色と異なるバッジ形式で現れ、scoreの数値順でsortされる。三つの並び替えだけをURLから復元し、選択肢に無いURL値は捨てられる。件数と並び替えキー名の要約は現れず、表の幅では列見出し、カードの幅では選択UIから並び替えられる。 |
| `WEB-009` | MUST | item詳細 — 各item詳細にGitHub URL、状態、要対応度のscoreとlevel、重要度のscore、level、内訳、waitingOn、next action、停滞時間、blocker、evidence、判定の確度区分を表示しなければならない。過去runの差分や送信済み状態を履歴UIとして表示してはならない。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | `AT-WEB-009`: 任意itemで要対応度と重要度の必須欄、current eventの根拠、AI診断が確認でき、日次差分とnotification ledgerの表示が存在しない。                                                                                                                                                                                                                                                                                                  |
| `WEB-010` | MUST | 検索とdeep link — repo、number、title、actor、team、labelで検索でき、filter/itemをURLで共有できなければならない。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | `AT-WEB-010`: 再読込・別browserで同じdeep link状態が再現する。                                                                                                                                                                                                                                                                                                                                                                              |
| `WEB-011` | MUST | アクセシビリティ — 日本語UIはWCAG 2.2 AAを目標に、keyboard、focus、contrast、非色依存、screen-reader labelを備えなければならない。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | `AT-WEB-011`: 自動a11y検査に重大違反がなく、主要flowをkeyboardで完了できる。                                                                                                                                                                                                                                                                                                                                                                |
| `WEB-012` | MUST | 鮮度表示 — データ全体のobservedAtを「最新更新」の見出しと相対時間で示してJST絶対時刻を補助へ添え、取得できなかったリポジトリの項目には古い観測値であることを示さなければならない。AI分析を設定で無効にしたときだけ、トップページの項目一覧へ「AI分析は設定で無効です。確定ルールで表示しています。」という全体の注意を示さなければならない。AI推定が最新でない項目は一覧の各行へ警告アイコンで示さなければならない。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | `AT-WEB-012`: 共通ヘッダーに「最新更新」と相対時間が現れ、stale repositoryの項目が最新と誤認できない表示になる。AI無効のfixtureではトップページの一覧見出し付近へ全体の注意が現れる。AIの利用不可や縮退だけでは全体の注意が現れず、`failed`と`deferred`の項目では各行に警告アイコンが現れる。                                                                                                                                               |
| `WEB-013` | MUST | waitingOnの対象明示 — waitingOn表示は役割名だけで終わらせず、作成者とassigneeはユーザー名、依存項目はrepo#numberまで示さなければならない。個人のユーザー名は人ごとのページへのリンクにし、項目一覧では装飾用のGitHubアバターを添えなければならない。アバターを読み込めない場合もユーザー名だけで対象を識別できなければならない。teamはアバターもリンクも表示してはならない。個人を特定できないroleは特定の一人ではないと分かる表示にする。一覧では主な待ち相手、状態、主候補の理由を一つのセルへ順に示し、理由が空なら理由の段を省かなければならない。複数候補は主候補と残りの件数だけを示さなければならない。トップページの主候補は`primaryWaitingOn.index`で選び、`not_applicable`なら先頭候補を使わなければならない。担当者個別では閲覧者本人または選択した所属teamに対応する先頭候補を使わなければならない。                                                                                                | `AT-WEB-013`: 全kindのfixtureで待機先の個人、team、項目、処理を特定できる。項目一覧の個人のユーザー名には空の代替テキストを持つアバターが現れ、画像の成否にかかわらずユーザー名を読める。個人のユーザー名のリンクを選ぶと人ごとのページへ移動し、teamにはアバターもリンクも現れない。複数候補のfixtureでは主候補と状態と理由と残数だけが現れ、担当者個別では本人または選択teamの候補が主になる。                                            |
| `WEB-014` | MUST | 担当者別の停滞一覧 — 待ち相手を個人とteamへ解決した担当者一覧と、個人ごとの停滞項目一覧を提供しなければならない。担当者一覧の個人のユーザー名と個人ごとのページの見出しには装飾用のGitHubアバターを添え、teamには添えてはならない。個人ごとのページは安全な外部リンクで本人のGitHubプロフィールを新しいタブに開けなければならない。個人ごとのページは閲覧者が選んだ所属teamへの待ちも合流させ、その選択をURLで共有できなければならない。個人ごとのページは要対応度、重要度、停滞時間の三つだけで並び替えでき、既定を要対応度の降順とし、並び順をURLで共有できなければならない。                                                                                                                                                                                                                                                                                                                                 | `AT-WEB-014`: 待ち相手fixtureで担当者一覧の件数と個人ごとのページの項目数が一致する。個人には所定の大きさと属性を持つアバターが現れ、teamには現れない。個人ごとのページから正しいGitHubプロフィールを安全属性付きの別タブで開ける。team選択と三つの並び順を含むURLを開き直しても同じ項目が同じ順序で出る。                                                                                                                                  |
| `WEB-015` | MUST | 閲覧者自身の記憶 — 閲覧者は自分のユーザー名と所属teamをブラウザーへ記憶し、1操作で自分の停滞項目へ到達できなければならない。記憶した値はURLより優先してはならない。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | `AT-WEB-015`: 記憶後に自分の担当への導線が現れ、記憶を解除すると消える。壊れた記憶値は破棄され、画面は通常どおり描画される。                                                                                                                                                                                                                                                                                                                |
| `WEB-016` | MUST | 項目一覧の一貫性 — 項目一覧の表とカードは、項目、待ち相手と状態、要対応度、重要度、停滞時間の順にしなければならない。複数の項目一覧では、同じ概念を同じ語彙、同じ視覚表現、同じ並び順で示さなければならない。表示形式は画面幅で決め、ページで決めてはならない。表は固定レイアウトとし、項目を最も広く、待ち相手と状態を次に広く、三つの数値列を狭くしなければならない。数値は等幅数字で中央または右へ揃えなければならない。ページの目的から説明できる違いだけを許し、それ以外の差を設けてはならない。                                                                                                                                                                                                                                                                                                                                                                                                           | `AT-WEB-016`: 項目一覧と担当者個別を複数の画面幅で表示し、同じ五つの情報が同じ語彙、視覚表現、並び順で現れる。広い画面では項目の題名へ最も広い幅が割り当てられ、狭い画面では同じ順のカードになる。各ページの差は主候補の選び方など目的に必要な要素だけになる。                                                                                                                                                                              |

設定したメンテナのGitHubユーザー名は`kind=user`のwaitingOnとして公開し、他のuser候補と同じ担当者ページ、リンク、アバターを使う。
担当者一覧は公開summaryのwaitingOnにあるuserとteamを別の待ち相手として集計し、teamをmemberへ展開しない。
所属teamの選択肢は公開summaryに現れるteam識別子だけから作り、閲覧者が自身の所属を選ぶ。

### 11.11 Discord通知

| ID        | 規範 | 要求                                                                                                                                                                                                                                                                                                                           | 受入要約                                                                                                                                     |
| --------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `NTF-001` | MUST | 基準時刻付き起動 — scheduleを毎日23:00 UTC（08:00 JST）に設定し、workflow_dispatchも提供し、runにはjob開始時刻ではない基準通知時刻`S`を渡さなければならない。各schedule runの`github.run_attempt == 1`だけ、一回限りの変化と停滞の繰り返しを含む通常digestを送り、`workflow_dispatch`とrerunでは通常digestを送ってはならない。 | `AT-NTF-001`: workflowのscheduleと手動trigger、遅延しても不変な`S`、scheduleの初回attemptだけ通常digestとなる分岐を静的・fixtureで検査する。 |
| `NTF-002` | MUST | Pages後通知とcache保存順 — 通常digestはPagesのdeployment成功後にだけ送信し、GitHub収集cacheとAI cacheはPagesとDiscordの完了後に保存しなければならない。                                                                                                                                                                        | `AT-NTF-002`: PagesまたはDiscord失敗fixtureでcacheが保存されず、Pages成功後だけ通常digestが送られる。                                        |
| `NTF-003` | MUST | Discord Incoming Webhook — v1通知はDiscord Incoming Webhookを使用し、URLをActions secretから取得しなければならない。                                                                                                                                                                                                           | `AT-NTF-003`: secretなしで明示エラー、secret値はlogに出ない。                                                                                |
| `NTF-004` | MUST | mention既定無効 — 既定payloadはallowed_mentionsで全mentionを無効化しなければならない。                                                                                                                                                                                                                                         | `AT-NTF-004`: @everyone/@user文字列fixtureでも実mentionが許可されない。                                                                      |
| `NTF-005` | MUST | mention allowlist — 有効化時も設定済みDiscord IDだけをallowed_mentions.usersへ含めなければならない。                                                                                                                                                                                                                           | `AT-NTF-005`: 未登録GitHubユーザー名はplain text表示になる。                                                                                 |
| `NTF-006` | MUST | 通知選別 — threshold crossing、urgent/critical停滞、owner不明48h超、責務遷移、newly unblocked高impact、cycleを主要通知候補としなければならない。                                                                                                                                                                               | `AT-NTF-006`: 各reason fixtureがcandidateになる。                                                                                            |
| `NTF-007` | MUST | digest構成 — digestを「停止要因」「内容確認または担当が未確定」「新規解消・重要変化」に分け、各itemにrepo#number、title、waitingOn、duration、reason、URLを含めなければならない。                                                                                                                                              | `AT-NTF-007`: 現在評価から作ったpayloadが必須項目を満たす。                                                                                  |
| `NTF-008` | MUST | Discord制限内分割 — embed/文字数/件数のDiscord制限を事前計算し、安全上限を超える場合は複数messageへ分割しなければならない。                                                                                                                                                                                                    | `AT-NTF-008`: 長文20件fixtureがAPI rejectなしの複数payloadになる。                                                                           |
| `NTF-009` | MUST | noise抑制 — freshな作業中、bot-only更新、unchanged watch、recent draft、低信頼AI-only、automation dashboardを既定digestから除外しなければならない。                                                                                                                                                                            | `AT-NTF-009`: noise fixture群が候補0件になる。                                                                                               |
| `NTF-010` | MUST | 決定論的な通知窓 — 通知済み状態を保存せず、基準時刻`S`とevent時刻から一回限りの通知を`S - 24時間 < T <= S`で選び、urgentは3日、criticalは2日の固定周期で再通知しなければならない。                                                                                                                                             | `AT-NTF-010`: 境界時刻、同一入力の再実行、urgent・criticalの固定周期fixtureで期待候補になる。                                                |
| `NTF-011` | MUST | 空digest抑制 — 通知対象が0件なら通常digestを送信してはならない。                                                                                                                                                                                                                                                               | `AT-NTF-011`: 0 candidate fixtureでwebhook callが0件になる。                                                                                 |
| `NTF-012` | MUST | 運用障害通知 — 収集・Pages・Discord自身の重大障害を通常item digestと区別し、設定により同一または別webhookへ1件だけ通知できなければならない。                                                                                                                                                                                   | `AT-NTF-012`: 連続retry失敗fixtureで重複しないops alertが生成される。                                                                        |
| `NTF-013` | MUST | current評価照合 — Discord送信前にPagesのdeployment成功、runの`S`、収集allowlist、current graphの入力が同一runのartifactと一致することを検証し、不一致なら送信してはならない。                                                                                                                                                  | `AT-NTF-013`: 同一runだけ送信adapterが呼ばれ、`S`、allowlist、graph入力が異なるfixtureでは呼ばれず失敗する。                                 |

### 11.12 永続化

| ID        | 規範 | 要求                                                                                                                                                                                       | 受入要約                                                                                                     |
| --------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| `DAT-001` | MUST | main branch責務 — main branchにはsource、config、schema、prompt、docs、testsを置き、日次cache commitを混在させてはならない。                                                               | `AT-DAT-001`: branch tree検査で4種類のcacheがmainに存在しない。                                              |
| `DAT-002` | MUST | cache branch — `tracker-state-v4` branchへ4種類のcacheだけをcanonical JSONで保存し、snapshot、日次履歴、notification ledger、run reportを置いてはならない。                                | `AT-DAT-002`: branch treeが指定directoryだけを持ち、不要なpathを拒否する。                                   |
| `DAT-003` | MUST | GitHub収集cache — `state/github-repositories`と`state/github-items`へ検証済みcurrent metadata、全event、pagination情報をcacheし、cache miss時にcold replayできなければならない。           | `AT-DAT-003`: cache削除後もcurrent graph、state、責務、terminal保持を再構築できる。                          |
| `DAT-004` | MUST | AI cache — `state/ai-results`へ完全一致入力のCodex結果、`state/ai-latest-importance`へnodeごとの直近importanceだけを保存しなければならない。                                               | `AT-DAT-004`:入力変更でresult cache missになり、AI失敗時はimportanceだけがfallbackになる。                   |
| `DAT-005` | MUST | 通知状態非永続化 — 通知候補は`S`とevent時刻、urgent・criticalの固定周期から計算し、notification ledgerを作成してはならない。                                                               | `AT-DAT-005`: runnerを破棄しても同一入力と`S`から同じ候補になり、送信済み状態のpathが存在しない。            |
| `DAT-006` | MUST | cache保存順と公開安全性 — PagesとDiscordの完了後だけsorted/canonical cacheを保存し、secret、raw token、private repoのID、owner/name、repository URL、raw本文、raw diffを含めてはならない。 | `AT-DAT-006`: PagesまたはDiscord失敗時にcache hashが変わらず、secret scanとprivate sentinel testが成功する。 |

`tracker-state-v4` branchで許可するdirectoryは`state/github-repositories`、`state/github-items`、`state/ai-latest-importance`、`state/ai-results`だけである。各directoryはstate配下の正規化相対pathで、相互に同一・入れ子にしない。`canonicalJson`を必須とし、raw本文、raw diff、token、private repositoryの値をcacheへ入れない。

`config.yml`に設定したメンテナのGitHubユーザー名は公開情報としてcurrent waitingOnへ出力できる。
teamのwaitingOnはteam識別子だけを保存し、team member一覧やteamとuserの対応は保存しない。

### 11.13 セキュリティ・プライバシー

| ID        | 規範 | 要求                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | 受入要約                                                                                                                                                                                                                                                                                                                                                                                        |
| --------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SEC-001` | MUST | job最小権限 — 収集、state push、Pages deploy、Discord notifyを権限分離し、各jobのGITHUB_TOKEN permissionsを最小化しなければならない。                                                                                                                                                                                                                                                                                                                                                                                                                         | `AT-SEC-001`: workflow permissions静的検査がallowlistと一致する。                                                                                                                                                                                                                                                                                                                               |
| `SEC-002` | MUST | secret trigger境界 — secretを使うjobはdefault branchのscheduleまたは権限管理されたworkflow_dispatchだけで実行しなければならない。ただしmerge gateは、auto merge有効化だけをtriggerとし、checkoutもrunも持たない場合に限りpull_request_targetで実行してよい。pull_request_targetでuntrusted codeを実行してはならない。                                                                                                                                                                                                                                         | `AT-SEC-002`: pull_requestからsecret jobへ到達する経路がなく、pull_request_targetはcheckoutもrunも持たないmerge gateだけである。                                                                                                                                                                                                                                                                |
| `SEC-003` | MUST | Action pinning — 第三者/公式を含むGitHub Actionをfull commit SHAでpinし、更新をreview付きPRで行わなければならない。                                                                                                                                                                                                                                                                                                                                                                                                                                           | `AT-SEC-003`: workflow内uses参照が全て40桁SHAである。                                                                                                                                                                                                                                                                                                                                           |
| `SEC-004` | MUST | public-only fail closed — cache保存前、publish直前、Discord送信前に収集時のpublic repo allowlistを独立検証し、違反1件でもcache、Pages、Discord公開を中止しなければならない。                                                                                                                                                                                                                                                                                                                                                                                  | `AT-SEC-004`: private repositoryのID、owner/name、URLと未知repositoryの注入fixtureで3出力すべて停止する。                                                                                                                                                                                                                                                                                       |
| `SEC-005` | MUST | Web content安全化 — GitHub由来文字列をescape/sanitizeし、allowlist URL、CSP、noopener等を適用しなければならない。                                                                                                                                                                                                                                                                                                                                                                                                                                             | `AT-SEC-005`: XSS/危険URL fixtureが実行・遷移できない。                                                                                                                                                                                                                                                                                                                                         |
| `SEC-006` | MUST | ログredaction — Actions log・job summary・artifactにsecret、authorization header、raw App key、webhook URL、未加工API responseを出してはならない。`collect-analyze` jobは`auth.json`の配置直後とsecretへの書き戻し直前に、ファイル内のすべての文字列値を`jq`で抽出しなければならない。改行を含む値は行へ分け、16文字以上の各行を`::add-mask::`へ登録しなければならない。値に含まれる`%`は登録前に`%25`へescapeしなければならない。                                                                                                                            | `AT-SEC-006`: canary secretを用いた統合テストで全log/artifact検索が0件になる。workflow静的検査で配置直後と書き戻し直前のmask script呼び出しを確認する。script検査で`jq`による全文字列値の抽出、改行を含む値の行分割、16文字未満の除外、`%`の`%25`へのescape、各値の`::add-mask::`登録を確認する。                                                                                               |
| `SEC-007` | MUST | Codex認証ファイルの一時配置と同期 — `collect-analyze` jobは`CODEX_AUTH_JSON` secretをrunnerの一時directoryにある`auth.json`へ権限600で配置し、配置時のsha256を保存しなければならない。Codex認証情報として`CODEX_HOME`だけを収集stepへ渡さなければならない。配置stepが成功していれば、先行stepの成否を問わずsha256を再計算し、変わった場合だけ`CODEX_AUTH_JSON`へ書き戻さなければならない。`CODEX_AUTH_SYNC_TOKEN`は書き戻しstepだけへ渡し、空なら明示的に失敗しなければならない。job終了時は成否を問わず一時directoryと指紋ファイルを削除しなければならない。 | `AT-SEC-007`: workflow静的検査で`CODEX_AUTH_JSON`の空値拒否、directory権限700、file権限600、配置時sha256の保存、`CODEX_HOME`の受け渡し、`always() && steps.codex_auth_placement.outcome == 'success'`による同期、書き戻しstepだけへの`CODEX_AUTH_SYNC_TOKEN`の受け渡し、同期用tokenの空値拒否、sha256変更時だけの`gh secret set CODEX_AUTH_JSON`、`if: always()`によるjob最後の削除を確認する。 |
| `SEC-008` | MUST | メンテナとteamの公開境界 — `config.yml`に設定したメンテナのGitHubユーザー名は公開情報としてwaitingOnへ出力できなければならない。GitHubのteam member一覧は取得せず、state、公開DTO、Discord通知へ含めてはならない。閲覧者の所属teamは公開summaryに現れるteam識別子から閲覧者自身がWeb UIで選ばなければならない。                                                                                                                                                                                                                                               | `AT-SEC-008`: GitHub AppにMembers権限がない。メンテナ責務とteam待ちを持つfixtureでは公開DTOへ設定したユーザー名とteam識別子が現れ、member一覧とteamからuserへの対応はstate、公開DTO、Discord通知に現れない。                                                                                                                                                                                    |

### 11.14 運用・性能

| ID        | 規範 | 要求                                                                                                                                                                                                                                      | 受入要約                                                                                                                                                                                   |
| --------- | ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `OPS-001` | MUST | 排他と再実行 — workflow concurrencyでschedule runを直列化し、manual runとrerunでは通常digestを送ってはならない。                                                                                                                          | `AT-OPS-001`: 同時2 run fixtureでcache raceと通常digest重複が起きず、manual・rerunの通常digestが0件になる。                                                                                |
| `OPS-002` | MUST | retryと公開保護 — GitHub、Codex、Discordの一時失敗を設定上限付きでretryし、完全性を満たさないrunでPages、通常Discord、cacheを更新してはならない。                                                                                         | `AT-OPS-002`: 429、503、transport例外、timeout、恒久エラーのfixtureで試行回数と公開出力が期待値になり、失敗時のcache hashが維持される。                                                    |
| `OPS-003` | MUST | observability — run summaryにrepo/item/change/edge/AI call/cache/token見積/API残量/stale/notification/所要時間を記録しなければならない。Codex出力の検証失敗では、違反件数と先頭5件までのpathとcodeをdiagnosticsへ記録しなければならない。 | `AT-OPS-003`: 成功・fallback・失敗runのsummaryに必須metricが存在し、Codex出力検証違反fixtureで`validationIssueCount`と`validationIssue0Path`、`validationIssue0Code`から始まる要約が残る。 |
| `OPS-004` | MUST | cold性能と予算 — 基準fixtureの5,000 items、10,000 edgesを全詳細・全event replayで30分以内、GitHub API予算70%以内、Codex設定上限以内で処理し、Web初期summaryをgzip 1 MiB以内にしなければならない。                                         | `AT-OPS-004`: cold performance profileが全閾値を満たす。                                                                                                                                   |

## 12. 非機能方針補足

### 12.1 可用性・正確性

GitHub Actionsのscheduleは厳密なリアルタイムschedulerではなく、混雑時に遅延し得る。そのためworkflowから08:00 JSTに対応する基準時刻`S`を渡し、実投稿時刻と遅延をmetric化する。完全性を満たさないrunはPages、通常Discord、cacheを更新しない。

### 12.2 セキュリティ

- GitHub Appはread-only。webhook受信は不要。
- AppをOrganizationのall repositoriesへinstallする場合でも、repo metadata直後とpublish直前の二重public guardを必須とする。
- Codex processへGitHub/Discord secretを渡さない。
- Codex認証同期には、このrepositoryだけを対象とし、repository permissionsを`Secrets`のRead and writeだけにしたfine-grained personal access tokenを使う。
- Codex認証同期用tokenはsecret書き戻しstepだけへ渡す。
- Issue本文・コメントはprompt injectionを含み得るuntrusted dataとして扱う。
- public pageへ全文転載せず、短いparaphrase、source ID、GitHub URLを保存する。
- workflow actionはfull SHA pin、secret jobはschedule/manual default branchとuntrusted codeを実行しないmerge gateのみ。

### 12.3 保守性

- pure TypeScript domain reducerとGitHub/Codex/Discord/cache adapterを分離する。
- prompt・schema・deterministic rulesは独立versionを持つ。
- cache schemaはZodで検証し、4種類のcache以外を読み込まない。
- runtimeはNode.js LTSをpinし、strict TypeScriptの型検査、lint、format検査、VitestによるNodeとWebのテスト、golden eval、CLI、workflow用CLI、WebのbuildをCIで実行する。

## 13. 受入と変更管理

- 既存の要求IDは意味を保てる範囲で現行のcache-only契約へ更新し、一意な受入試験IDを持つ。
- MUST要求の未達はrelease blocker。
- SHOULD要求の未達は理由・代替・期限をdecision logへ記録する。
- schema、semantic validation、reducer、状態、graph、通知判定の変更はgolden evalと通知候補差分をPRでreviewする。
- model、reasoning effort、promptの変更は実モデルを呼び出したdry-runのAI判定と通知候補差分をPRでreviewする。
- 仕様変更は本書、schema、configを同一PRで更新する。

## 14. 参照資料

公式仕様とVOICEVOX実例の一覧は `docs/RESEARCH_SOURCES.md` を参照。
