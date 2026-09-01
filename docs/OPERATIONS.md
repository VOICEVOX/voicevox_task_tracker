# 運用手順

正常運用時のVOICEVOX Task Trackerは毎日03:00、07:00、11:00、15:00、19:00、23:00 UTCに起動します。
日本時間では00:00、04:00、08:00、12:00、16:00、20:00にPagesとDiscordを更新します。
GitHub Actionsのscheduleには遅延があるため、厳密な投稿時刻は保証しません。

## 日々の確認

`.github/workflows/daily.yml`の最新runで、実行対象のjobが依存順に成功したことを確認します。

1. `quality-eval`
2. `collect-analyze`
3. `persist-state`
4. `build-pages`
5. `deploy-pages`
6. `notify-discord`
7. `notify-operations` 失敗時のみ
8. `report-workflow`

通常の公開経路は`notify-discord`までの6 jobです。
`notify-operations`は収集、Pages関連、Discord通知のいずれかのjobが失敗したときだけ実行されます。
`report-workflow`は先行jobの成否にかかわらず実行され、全job結果と収集metricをActions artifactへ保存します。

Pagesではトップの項目一覧に未完了の追跡項目が表示され、既定が要対応度の降順であることを確認します。
状態で「すべて」を選ぶと、完了済みの追跡項目も表示されます。
表が表示される幅では列見出しから並び替えられ、カードが表示される幅では並び順の選択UIが現れることも確認します。
共通ヘッダーには「最新更新」と相対時刻、共通フッターにはrun IDだけが表示されます。
通知履歴ではDiscordへ送信済みの項目通知が新しい順に表示され、履歴がなければ空状態になることを確認します。
送信した通知は次回runのPages更新後に表示されます。
`tracker-state`では`state/run-reports/YYYY-MM-DD.json`を確認します。
ローカル実行のreportは`artifacts/run-reports/`へ出力されます。
Actionsでは収集reportとworkflow全体のreportを、run IDと試行番号を含む別々のartifactへ保存します。

run reportの主な確認項目は次のとおりです。

| field                               | 意味                                                                          |
| ----------------------------------- | ----------------------------------------------------------------------------- |
| `status`                            | `success`は完全成功、`fallback`はCodex縮退を含む完全run、`failure`は不完全run |
| `complete`                          | stateと公開処理へ進める完全性を満たしたか                                     |
| `failedStage`                       | failureが起きた処理段階                                                       |
| `diagnostics`                       | secretや信頼できない本文を含まない診断                                        |
| `metrics.repositoryCount`           | 公開allowlistに入ったrepository数                                             |
| `metrics.itemCount`                 | 追跡項目数                                                                    |
| `metrics.changedItemCount`          | 前回から更新された追跡項目数                                                  |
| `metrics.activeEdgeCount`           | 有効な関係edge数                                                              |
| `metrics.aiCallCount`               | Codexを実行した件数                                                           |
| `metrics.aiCacheHitCount`           | AI cacheを再利用した件数                                                      |
| `metrics.aiRetainedResultCount`     | AI分析対象へ入れず前回のAI結果を保持した件数                                  |
| `metrics.estimatedInputTokens`      | Codex入力tokenの見積り                                                        |
| `metrics.githubApiRemaining`        | 最後に観測したGitHub API残量                                                  |
| `metrics.staleRepositoryCount`      | 前回値を利用したrepository数                                                  |
| `metrics.notificationCount`         | Discord送信結果を通知管理記録へ記録した通知数。`dismiss-current`では0         |
| `metrics.scheduleDelayMilliseconds` | 予定起動時刻からCLI開始までの遅延                                             |
| `metrics.durationMilliseconds`      | CLI開始からrun完了までの所要時間                                              |

Codex出力のschema検証とsemantic検証に失敗した場合、`diagnostics`へ違反件数が`validationIssueCount`として残ります。
違反した検証ルールは先頭5件まで`validationIssue0Path`と`validationIssue0Code`の形式で残り、添字は0から始まります。
違反の`message`は入力値を含みうるため残しません。

`tracker-state`は自動更新専用です。
人間がsnapshot、履歴、AI cache、通知管理記録を直接編集すると履歴と通知抑制の整合を壊すため、修正はGitHub上の正本か`config.yml`で行います。

## 性能profile

OPS-004は通常のCIから分離したend-to-end性能profileで確認します。
外部サービスへ接続せず、本番の`daily`トランザクションへ5,000項目、10,000 edge、変更300件を流します。
GitHub APIは15,000 unitのモックrate limitから、一覧のpaginationと項目ごとの詳細取得で消費したunitを差し引きます。
Codexは設定上限300件までモック出力を返し、予算選別、schema検証、reducerを実際に通します。
state永続化はメモリ上で行い、Pages初期summaryは実際に生成してgzipサイズを測ります。

```console
pnpm perf:profile
```

30分、GitHub API 70%、Codex設定上限、summary gzip 1 MiBのいずれかを超えると終了codeが1になります。
測定結果は`artifacts/performance-profile.json`へ保存されます。
CI上では`性能profile` workflowを手動実行し、同じJSONをActions artifactとして保存します。

## stageごとの実行

日次workflowはjobの権限と副作用を一致させるため、次のstageを別processで実行します。
各stageは`artifacts/workflow/validated-run.json`をschema検証、semantic検証、公開安全性検証へ通してから利用します。
前stageのartifactが存在しない場合や検証に失敗した場合は明示的なエラーで停止します。

収集と判定はGitHub Appの認証情報を使います。
現行の`config.yml`は`ai.authentication: auth-json`を指定します。
Actionsの`collect-analyze` jobは配置stepだけへ`CODEX_AUTH_JSON`を渡し、一時的な`auth.json`を配置して収集stepへ`CODEX_HOME`を渡します。
`CODEX_AUTH_SYNC_TOKEN`は書き戻しstepだけへ`GH_TOKEN`として渡します。
jobは一時ファイルを削除する前に、更新された`auth.json`を`CODEX_AUTH_JSON`へ同期します。
`ai.enabled: true`のローカル実行ではlockfileで固定した`codex`に加え、`auth-json`なら`CODEX_HOME`直下の`auth.json`、`api-key`なら`OPENAI_API_KEY`が必要です。
検証後のsnapshot、通知候補、通知管理記録、run report生成用の収集指標、AI cacheを公開可能なartifactへ保存します。

```console
pnpm build
pnpm tracker:run collect-analyze --mode none
```

backfillでは`--mode linked`か`--mode all-open`を指定し、対象を絞る場合は`--repository VOICEVOX/voicevox`を繰り返します。

state永続化は収集artifactを受け取り、`tracker-state`へ一つのcommitとして保存します。
GitHub App、Codex、Discordのsecretは読みません。

```console
pnpm tracker:run persist-state
```

Pages buildは保存済みstateと同じ収集artifactから公開DTOを生成します。
外部secretは読みません。

```console
pnpm tracker:run build-pages --output web/public/data
pnpm build:web
```

GitHub Pagesへのdeployが成功した後だけ、deploy結果のURLを渡してDiscord stageを実行します。
このstageが読む外部secretは、通常通知用の`DISCORD_WEBHOOK_URL`と障害通知用の`DISCORD_OPERATIONS_WEBHOOK_URL`の2つだけです。

```console
pnpm tracker:run notify-discord --pages-url https://voicevox.github.io/voicevox_task_tracker/
```

ローカルで全stageを1processで確認する場合は従来の`daily`を利用できます。
この実行はstate、Pages用データ、Discordへ順に副作用を発生させるため、設定と認証情報を確認してから実行します。

```console
pnpm tracker:run --backfill none
```

## 誤判定の直し方

tracker専用のcommand comment、override UI、専用labelはありません。
次回runで機械的に解釈できるように、GitHub上の事実を明確にします。
GitHubのassigneeは確定情報として保持します。未アサインIssueの実質担当は表示上の推定であり、trackerはGitHubへassignを書き戻しません。

抽象的なmaintainer、reviewer、merge_deciderの責務は、`config.yml`でrepositoryごとに設定したメンテナ全員へ展開されます。
担当者を変える場合は`maintainers.defaults`か`maintainers.repositories`のGitHubユーザー名一覧を更新します。
GitHubのteam review requestと本文やコメントの`@organization/team`はteamへの待ちとして残ります。
trackerはteam memberを取得しないため、team memberの活動ではteam宛て項目の停滞起点を更新しません。
個人の活動を停滞計算へ反映させる場合はuserを名指しします。

### コメント

最新コメントで、次に誰が何をするかを一文で明示します。
Issue全体を担当する場合は、その旨を明記し、追跡中でGitHubがclosing referenceとして認識した直接関連PRや継続成果物と結び付けます。本文に書いただけの推定relation、部分対応、助言、検証、review、条件付きの意向、撤回、延期の記載は実質担当の根拠になりません。
複数人を候補にする場合も、Issue全体を共同で進めていることを明記します。部分PRの組み合わせだけから共同担当を推定しません。
trackerは一般的な活動状態を実質担当へ読み替えず、部分担当や部分実装を別の担当としてモデル化しません。
方針判断待ちへ直す場合は、maintainer roleへ必要な判断を明記します。
返答待ちへ直す場合は、回答を求めるuserかteamを名指しします。
質問の内容と未回答であることも明記します。
依存関係なら対象IssueかPRのURLと、現在の項目を止めているか、単なる関連情報かを明記します。

古いmention、謝辞、単なるリンクだけでは責務移動やblockerを確定しません。
Issue author、Pull Request author、最新commenterであることだけでも担当は確定しません。親Issueや横断Issueの作業者を現在のIssueの担当へ移しません。
依頼が解決した場合は、回答か決定を新しいコメントとして残すと未回答扱いを解消しやすくなります。

### assignee

Issueを正式な作業待ちへ直す場合は、実際に作業するuserをassigneeへ設定します。
assigneeが空でもtrackerがIssue全体の実質担当を表示する場合があります。その表示は推定であり、正式なGitHub assigneeの代わりにはなりません。
担当が決まっていない場合や、実質担当の根拠が不足する場合はassigneeを設定しません。
誤って推定された場合は、部分対応、reviewのみ、撤回、延期、引継ぎであることを最新コメントへ明記します。正式assigneeの設定や新しい全体担当の根拠は次回runで再判定されます。
正式assigneeを解除すると、解除前の根拠は実質担当の推定に再利用されません。同じ人や別の人を実質担当にする場合は、解除後にIssue全体を進める新しい根拠を残します。

### ラベル

`config.yml`の`labels.rules`へ登録した既存labelだけがtrackerの意味を持ちます。
repository globとlabel名の正規表現を一致させ、必要な効果を設定します。

| effect                       | 用途                                                 |
| ---------------------------- | ---------------------------------------------------- |
| `priorityWeight`             | 重要度を通じて要対応度を上げ、通知候補の順位も上げる |
| `severityLift`               | 通知判断に使う停滞レベルを最大1段階引き上げる        |
| `requiresMaintainerDecision` | 方針判断待ちとし、maintainer roleへ責務を置く        |
| `suppressNotifications`      | graphには残したまま通常通知を抑える                  |
| `countsAsProgress`           | そのlabel変更を意味のある進捗として扱う              |

trackerはlabelを追加も変更もしません。
label規則を変えた場合はdry-runで通知候補の差分を確認します。

### review request

PRをレビュー待ちへ直す場合は、Current reviewersへレビューを依頼するuserかteamを追加します。
不要になったreview requestはGitHub上で解除します。
現在のreview requestは自然言語より強い決定論的根拠です。

人間の`CHANGES_REQUESTED`が最新head以後にある場合は修正待ちを優先し、authorの修正を待ちます。
authorが修正をpushした後はレビュー待ちとしてreviewer側を再評価します。
必要ならreview requestも現在の担当へ合わせます。
未解決のreview threadも修正待ちの根拠になります。
authorが最後に返信したthreadは修正待ちの根拠から外し、reviewerの再確認を待つレビュー待ちとして扱います。
botのreviewとcommentだけではbotへ責務を移しません。
review、助言、検証だけを行った人をIssue全体の実質担当者へ移しません。

これらで待ち先が決まった後も、その相手本人がさらに発言していれば発言の内容から判定し直します。
変更要求を受けたauthorが修正せずに質問すれば返答待ちとなり、reviewerの返答を待ちます。
authorが了解を返しただけなら修正待ちを維持し、authorの修正を待ちます。
待ち先を確実に伝えたい場合は、質問や依頼を明示した文にするか、review requestで示してください。

### native dependency

本当に作業を止めるIssue同士はGitHubのblocked byとblockingで接続します。
親子関係はsub-issueを使います。
native relationはauthoritativeであり、本文のplain linkやCodex推定より優先されます。
子Issueや直接関連PRの作業者を、親Issueや横断Issueの実質担当者へ拡張しません。
Pull RequestがIssueを閉じる関係は、GitHubがclosing referenceとして認識する形で書きます。
GitHubが認識したclosing referenceはauthoritativeな`implements`関係になります。
GitHubが認識しない書き方は本文のclosing keywordとしてしか読めず、Codexの推定に頼る関係になります。

blockerが完了したら対象Issueをcloseし、誤ったnative relationはGitHub上で解除します。
単なる関連項目はnative dependencyにせず、本文かコメントで関連だけであることを明記します。

### 重要度

重要度は項目そのものの重要さを表し、停滞レベルとは別に確認します。
個別の項目の重要度がずれている場合は、まず詳細ページの内訳でどの要因が効いているかを確かめます。
決定論的な要因は、優先度ラベル、native dependency、downstream impactをGitHub上の事実へ合わせると変わります。
Codex由来の重要度要因は、重要な機能である根拠と放置した場合の将来問題が本文かコメントから読み取れるかで決まります。期限の切迫度は重要度へ影響しません。
本文へ重要だと書くだけでは根拠になりません。
全体の加点やlevelを調整する場合は`config.yml`の`importance`を変更し、dry-runでscore、level、内訳を確認します。

### 要対応度

要対応度は重要度、期限の切迫度、停滞の鮮度から計算します。
個別の項目の要対応度がずれている場合は、重要度score、期限日、期限の切迫度、`stallSince`、現在のwait class、そのwait classの`watch`閾値を順に確認します。
terminal項目とブロック解消待ちの項目が0点になるのは意図した動作です。
`importanceCapacity = 100 - deadlinePoints.overdue`として、`recencyScore = round(importanceScore × recencyCoefficient × importanceCapacity / 100)`、`score = recencyScore + deadlinePoints[currentLevel]`で計算します。

停滞による下がり方を全体で調整する場合は`config.yml`の`attention.recencyFloor`を変更します。
要対応度、重要度、期限の切迫度、停滞時間は、項目一覧と担当者ごとのページで選べる四つの並び替えキーです。
既定は要対応度の降順です。
停滞レベルはWeb UIで参照しないため、Webの表示順を直す目的で`severityLift`を変更しません。

設定変更後はdry-runを実行し、要対応度のscore、level、表示対象、並び順、依存グラフのnode選定を確認します。

修正を反映したい場合は日次runを待つか、日次workflowを`backfill: none`で手動実行します。

## backfill

backfillはGitHub Actionsの`日次タスク追跡`を手動実行して指定します。

| `backfill` | 対象                                                     |
| ---------- | -------------------------------------------------------- |
| `none`     | 通常の日次追跡だけを行う                                 |
| `linked`   | 追跡済み項目とrelationで接続する未追跡open項目を追加する |
| `all-open` | 対象repositoryの全open IssueとPull Requestを追加する     |

`repository_filter`は`VOICEVOX/voicevox,VOICEVOX/voicevox_engine`のようなfull nameのカンマ区切りです。
空ならVOICEVOX全体が対象です。
`backfill: none`ではrepository filterを指定できません。

1 runで追加する件数は`tracking.backfill.maxItemsPerRun`までです。
上限を超える場合は同じmodeとfilterで手動runを繰り返します。
`linked`は追跡済み項目の直接の隣接項目を追加し、繰り返すと新しく追加した項目の隣接へ範囲を広げます。

特定の古いIssueかPRだけを追加する場合は、URLかnode IDを`tracking.include`へ追加します。
一度追跡対象へ入った項目は作成日時に関係なく同じ状態、停滞、通知規則で扱います。
大規模な`all-open`はCodex予算と通知候補を急増させるため、Discordを無効にしてrepository単位で確認してから範囲を広げます。

## 通知量の調整

### 現在の通知候補を一括で抑制する

通知条件を調整した直後など、現在の候補を古い通知として一掃したい場合は、日次workflowの手動実行で通知処理を`dismiss-current`にします。

1. default branchのActionsから「日次タスク追跡」のworkflowを開きます。
2. `backfill`を`none`、`repository_filter`を空、`notification_action`を`dismiss-current`にして実行します。
3. `collect-analyze`、`persist-state`、`build-pages`、`deploy-pages`、`notify-discord`、`report-workflow`が成功することを確認します。

`dismiss-current`は現在の通知条件を満たす候補を、reasonごとに最大件数の制限なく、手動抑制済みとして通知管理記録へ保存します。通常のDiscord digestは送信せず、`notification_sent`履歴も作りません。snapshotとPagesの生成は通常runと同じで、通知管理記録の更新は同じatomic transactionへ含まれます。運用障害が発生した場合の`notify-operations`は別系統で動作します。

成功確認では、`tracker-state`の通知管理記録に対象候補の`status: dismissed`が保存され、通知履歴に送信済み項目が追加されていないことを確認します。state branchや通知管理記録を直接編集して抑制を解除してはいけません。

送信済みと手動抑制済みのnotification keyは期限なく抑制します。`status`、停滞レベルを表す`severity`、待ち相手を表す`waitingOn`、各種開始時刻などが変わって別keyになった候補は、次回の`send`で通常どおり通知対象になります。

通常の`send`は、`maxItemsPerDigest`を含む既存の通知選別を行います。

停滞レベルはDiscord通知の判断にだけ使います。
通知選別は停滞レベルの変化、長期停滞、責務移動、重要な依存解消、dependency cycleを優先します。
直近に意味のある進捗がある項目、botだけの活動、recent draft、低信頼のAI判定、labelで抑制した項目は通常通知から外します。
botが作成した項目のtitleが`notifications.automationNoiseTitles`のいずれかと大文字小文字を区別せず一致した場合、graphへ残したまま通常通知から外します。
Renovateの`dependencyDashboardTitle`を変更した場合は同じtitleをこの一覧へ追加します。

特定の状態だけ通知時刻を調整する場合は、対応する`staleness.thresholdsHours`のキーを変更します。
各キーの`watch`は要対応度の半減期にも使うため、変更するとWebの要対応度と並び順も変わります。
`urgent`と`critical`は通知判断だけに使います。

| 状態                                             | キー         |
| ------------------------------------------------ | ------------ |
| 内容確認待ち                                     | `assessment` |
| 担当決め待ち、待ち先不明                         | `owner`      |
| 方針判断待ち                                     | `decision`   |
| レビュー待ち                                     | `review`     |
| `CHANGES_REQUESTED`後の修正待ち                  | `revision`   |
| 作業待ち、作業中、CI失敗やconflictによる修正待ち | `work`       |
| 返答待ち                                         | `reply`      |
| マージ待ち                                       | `merge`      |
| 自動処理待ち                                     | `automation` |

ブロック解消待ちには直接の閾値がありません。
blockerの停滞レベルとdownstream impactが通知順位を決めます。

通知が多すぎる場合は次の順で調整します。

1. 誤った`status`、待ち相手を表す`waitingOn`、依存をGitHub上で明確にします。
   実質担当の誤判定は、Issue全体を担当する宣言、追跡中でGitHubが認識したclosing reference、継続成果物を明記するか、部分対応、reviewのみ、撤回、延期、引継ぎであることを最新コメントへ明記して直します。
2. automation dashboardのtitleを`notifications.automationNoiseTitles`へ追加するか、対象labelへ`labels.rules.effects.suppressNotifications`を割り当てます。
3. 通知を減らす状態に対応する`staleness.thresholdsHours`を増やします。
4. 全状態で直近の進捗を長く猶予する場合は`recentProgressGraceHours`を増やします。
5. `maxItemsPerDigest`を減らします。
6. AI推定が原因なら`ai.confidence.medium`を上げ、実モデルを呼び出すdry-runでAI判定と通知候補の差分を確認します。

通知が少なすぎる場合は逆方向に調整します。

1. maintainer設定、userかteamの指定、review request、native dependency、label規則が`status`と待ち相手を表す`waitingOn`の実態に合うか確認します。
2. 通知を増やす状態に対応する`staleness.thresholdsHours`を減らします。
3. 全状態で直近の進捗を短く猶予する場合は`recentProgressGraceHours`を減らします。
4. `maxItemsPerDigest`を増やします。
5. 重要labelへ`priorityWeight`か`severityLift: 1`を設定します。
6. AI予算不足なら`ai.budget`を増やし、dry-runの`metrics.aiCallCount`、`metrics.estimatedInputTokens`、deferred項目、通知候補を確認します。

閾値、confidence、label規則、AI予算を変更する場合は、dry-runを実行して通知候補の差分を確認します。
schema、semantic validation、reducer、状態、graph、通知判定を変更する場合は`pnpm eval:golden`も実行します。
golden evalはfixture内の固定AI出力を検証して期待結果と比較し、標準fixtureで`fixedAi.networkCallCount: 0`を要求します。
実モデル、reasoning effort、promptの応答品質は評価しないため、これらを変更する場合は`metrics.aiCallCount`が1以上のdry-runでAI判定と通知候補の差分を確認します。
`ai.execution.maxConcurrentCalls`を上げるとrun時間は縮みますが、Codexのrate limitに当たる頻度が増えて再試行が発生しやすくなります。
上げた後は`codex_analysis` stageの失敗数と再試行数を確認します。
mentionは通知量の調整に使わず、運用上必要なuserだけをallowlistへ追加します。

## 障害時の確認

失敗したActions jobをworkflow全体のreportにある`jobs`と照合し、収集失敗ではCLI reportの`failedStage`も確認します。

| stageまたはjob                  | 確認内容                                                                                                                                                                                      |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `quality-eval`                  | `pnpm typecheck`、`pnpm lint`、`pnpm format:check`、`pnpm eval:golden`をローカルで再現する                                                                                                    |
| `configuration`                 | maintainerのGitHubユーザー名一覧、repository名、未知field、日時、正規表現、secret名を確認する                                                                                                 |
| `authentication`                | `GH_APP_ID`、PEM形式、Organizationへのinstallation、必要なread権限だけがあることを確認する                                                                                                    |
| `repository_inventory`          | Appのrepository access、public、archive、disabledの状態を確認する                                                                                                                             |
| `incremental_collection`        | GitHub API残量、429と503、対象repositoryの一時障害を確認する                                                                                                                                  |
| `codex_analysis`                | `codex` executable、model ID、reasoning effort、予算、timeout、同時実行数、`ai.authentication`を確認し、`auth-json`では`CODEX_HOME`直下の`auth.json`、`api-key`では`OPENAI_API_KEY`を確認する |
| `state_persistence`             | Actionsの`contents: write`、`tracker-state`のruleset、同時runがないことを確認する                                                                                                             |
| `build-pages`                   | Pages DTO、`web.basePath`、Web build、公開guardの診断を確認する                                                                                                                               |
| `deploy-pages`                  | Pages Source、`github-pages` environment、`pages: write`と`id-token: write`を確認する                                                                                                         |
| `discord`または`notify-discord` | enabled設定、Webhook secret、channel、Webhook失効、429と503を確認する                                                                                                                         |

`incremental_collection`が`errorType=CliRelationExpansionLimitError`で失敗した場合は、同じ診断行の`relationExpansionLimit`、`relationExpansionFetchedCount`、`relationExpansionUnfetchedCount`を確認します。
件数が想定より多いときは、GitHub上の誤ったnative relationや参照を直します。
妥当な件数なら、GitHub API残量と`operations.githubApiBudgetRatio`を確認したうえで`tracking.relationExpansion.maxItemsPerRun`を引き上げ、`backfill: none`で再実行します。
この失敗ではstate、Pages、通常のDiscord通知を更新しません。

収集の診断に「端点を取得できなかった関係候補を除外しました」が出る場合は、archive済みrepositoryやOrganization外の参照先など、公開境界の外にある関係先が残っています。
run自体は成功し、除外した関係候補は依存グラフへ載りません。

Actions上でCodexの認証エラーが起きた場合は、まず過去の`collect-analyze`でCodex認証の書き戻しstepが失敗していないか確認します。
書き戻しが失敗していたときは、`CODEX_AUTH_SYNC_TOKEN`の登録、tokenの有効期限、Organizationの承認、対象repositoryと`Secrets`の`Read and write`権限を確認して直し、`backfill: none`で再実行します。
保存済みのCodex認証をrefreshできず、再実行でも回復しない場合だけローカルのCodexへログインし直します。
[デプロイ手順](DEPLOYMENT.md)のコマンドで、新しい`auth.json`を`CODEX_AUTH_JSON`の初期値として登録します。

`fallback`はAI分析に失敗または延期した項目を決定論的判定と利用可能な前回結果へ縮退した完全runです。
項目一覧を`AI推定が最新でない`で絞り込み、各行の警告アイコンと項目詳細の注記で対象を特定します。
原因はrun reportの`codex_fallback`と`codex_deferred`、および`validationIssue0Code`から追います。
`metrics.aiCacheHitCount`が0でも`metrics.aiRetainedResultCount`が1以上なら、未変更項目のAI結果はAI分析対象へ入れず保持されています。
対象項目は次回runで詳細取得とAI分析へ再び含まれるため、原因を直せば手動再実行なしで解消します。
`failure`が`state_persistence`より前ならstateは更新されません。
`pages`か`discord`で失敗した場合はstate commit後の可能性があるため、snapshotのrun IDとPagesの生成時刻を比較し、両者が同じrunか確認します。
Pages deployに失敗した場合は最後に成功したPagesを基準にし、Discordを送信しません。
state commit後のPages失敗は想定内であり、stateを巻き戻しません。
次回runはcommit済みsnapshotを前回値として新しいsnapshotを作り、state commit後にPagesを更新するため、同じrun IDと生成時刻へ再び揃います。

公開guardが失敗した場合は安全設定を無効化しません。
どの入力にallowlist外repository、private sentinel、secretらしい値、長すぎる全文、安全でないURLが入ったかを、secretをlogへ出さずに調べます。
原因を除いた後に`backfill: none`で手動再実行します。

同じrunを再実行してもworkflow concurrencyと通知管理記録が競合と通常通知の重複を抑えます。
GitHub、Codex、Discordの429と503は設定した回数だけretryし、それでも失敗する場合は外部サービスの回復後に再実行します。
