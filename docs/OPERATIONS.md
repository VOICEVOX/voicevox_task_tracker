# 運用手順

正常運用時のVOICEVOX Task Trackerは毎日23:00 UTCに起動し、日本時間の08:00以降にPagesとDiscordを更新します。
GitHub Actionsのscheduleには遅延があるため、厳密な投稿時刻は保証しません。

## 日々の確認

`.github/workflows/daily.yml`の最新runで、実行対象のjobが依存順に成功したことを確認します。

1. `test-eval`
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

Pagesでは生成時刻、repository数、item数、unknown数、状態別件数、severity別件数を確認します。
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
| `metrics.estimatedInputTokens`      | Codex入力tokenの見積り                                                        |
| `metrics.githubApiRemaining`        | 最後に観測したGitHub API残量                                                  |
| `metrics.staleRepositoryCount`      | 前回値を利用したrepository数                                                  |
| `metrics.notificationCount`         | 送信結果をledgerへ記録した通知数                                              |
| `metrics.scheduleDelayMilliseconds` | 予定起動時刻からCLI開始までの遅延                                             |
| `metrics.durationMilliseconds`      | CLI開始からrun完了までの所要時間                                              |

`tracker-state`は自動更新専用です。
人間がsnapshot、履歴、AI cache、通知ledgerを直接編集すると履歴とcooldownの整合を壊すため、修正はGitHub上の正本か`config.yml`で行います。

## GitHub GraphQL schemaの更新

`schemas/github-graphql.schema.graphql`はGitHubが公開しているGraphQL schemaの写しです。
送信しうる全クエリをこのschemaで検証し、存在しないフィールドの要求や応答名の衝突を実行前に検出します。
テストはこのファイルだけを読み、ネットワークへ出ません。

GitHub側のschema変更へ追従するときは、次の手順で更新します。

```console
curl -L --fail-with-body https://docs.github.com/public/fpt/schema.docs.graphql --output schemas/github-graphql.schema.graphql
pnpm test
```

更新後にクエリ検証が失敗した場合は、失敗したクエリをschemaへ合わせて修正します。
schemaの写しを古いまま据え置くと検証が形骸化するため、退避や巻き戻しはしません。

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
現行の`config.yml`は`ai.authentication: auth-json`を指定し、Actionsの`collect-analyze` jobは`CODEX_AUTH_JSON`から一時的な`auth.json`を配置して`CODEX_HOME`を渡します。
`ai.enabled: true`のローカル実行ではlockfileで固定した`codex`に加え、`auth-json`なら`CODEX_HOME`直下の`auth.json`、`api-key`なら`OPENAI_API_KEY`が必要です。
検証後のsnapshot、通知候補、notification ledger、run report生成用の収集指標、AI cacheを公開可能なartifactへ保存します。

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

Pages buildは同じ収集artifactから公開DTOを生成します。
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

### コメント

最新コメントで、次に誰が何をするかを一文で明示します。
判断依頼なら対象のuserかteam、必要な判断、回答済みかどうかを具体的に書きます。
依存関係なら対象IssueかPRのURLと、現在の項目を止めているか、単なる関連情報かを明記します。

古いmention、謝辞、単なるリンクだけでは責務移動やblockerを確定しません。
依頼が解決した場合は、回答か決定を新しいコメントとして残すと未回答扱いを解消しやすくなります。

### ラベル

`config.yml`の`labels.rules`へ登録した既存labelだけがtrackerの意味を持ちます。
repository globとlabel名の正規表現を一致させ、必要な効果を設定します。

| effect                       | 用途                                      |
| ---------------------------- | ----------------------------------------- |
| `priorityWeight`             | attention queueと通知候補の並び順を上げる |
| `severityLift`               | severityを最大1段階引き上げる             |
| `requiresMaintainerDecision` | maintainerの判断待ちとして扱う            |
| `suppressNotifications`      | graphには残したまま通常通知を抑える       |
| `countsAsProgress`           | そのlabel変更を意味のある進捗として扱う   |

trackerはlabelを追加も変更もしません。
label規則を変えた場合は`pnpm test`とdry-runで通知候補の差分を確認します。

### review request

PRのCurrent reviewersへ実際に待っているuserかteamを追加します。
不要になったreview requestはGitHub上で解除します。
現在のreview requestは自然言語より強い決定論的根拠です。

人間の`CHANGES_REQUESTED`が最新head以後にある場合はauthor待ちが優先されます。
authorが修正をpushした後はreviewer側を再評価するため、必要ならreview requestも現在の担当へ合わせます。
未解決のreview threadもauthor待ちの根拠になりますが、authorが最後に返信したthreadはreviewer側の再確認待ちとして扱います。
botのreviewとcommentだけではbotへ責務を移しません。

これらで待ち先が決まった後も、その相手本人がさらに発言していれば発言の内容から判定し直します。
変更要求を受けたauthorが修正せずに質問すれば待ち先はreviewerへ移り、了解を返しただけならauthor待ちのままです。
待ち先を確実に伝えたい場合は、質問や依頼を明示した文にするか、review requestで示してください。

### native dependency

本当に作業を止めるIssue同士はGitHubのblocked byとblockingで接続します。
親子関係はsub-issueを使います。
native relationはauthoritativeであり、本文のplain linkやCodex推定より優先されます。

blockerが完了したら対象Issueをcloseし、誤ったnative relationはGitHub上で解除します。
単なる関連項目はnative dependencyにせず、本文かコメントで関連だけであることを明記します。

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

通知選別はseverityの変化、長期停滞、責務移動、重要な依存解消、dependency cycleを優先します。
直近に意味のある進捗がある項目、botだけの活動、recent draft、低信頼のAI判定、labelで抑制した項目は通常通知から外します。
botが作成した項目のtitleが`notifications.automationNoiseTitles`のいずれかと大文字小文字を区別せず一致した場合、graphへ残したまま通常通知から外します。
Renovateの`dependencyDashboardTitle`を変更した場合は同じtitleをこの一覧へ追加します。

通知が多すぎる場合は次の順で調整します。

1. 誤った責務や依存をGitHub上で明確にします。
2. automation dashboardのtitleを`notifications.automationNoiseTitles`へ追加するか、対象labelへ`labels.rules.effects.suppressNotifications`を割り当てます。
3. `staleness.thresholdsHours`と`recentProgressGraceHours`を増やします。
4. `cooldownDays`を増やし、`maxItemsPerDigest`を減らします。
5. AI推定が原因なら`ai.confidence.medium`を上げ、実モデルを呼び出すdry-runでAI判定と通知候補の差分を確認します。

通知が少なすぎる場合は逆方向に調整します。

1. team、review request、native dependency、label規則が実態と一致するか確認します。
2. `staleness.thresholdsHours`と`recentProgressGraceHours`を減らします。
3. `maxItemsPerDigest`を増やし、`cooldownDays`を減らします。
4. 重要labelへ`priorityWeight`か`severityLift: 1`を設定します。
5. AI予算不足なら`ai.budget`を増やし、dry-runの`metrics.aiCallCount`、`metrics.estimatedInputTokens`、deferred項目、通知候補を確認します。

閾値、confidence、label規則、AI予算を変更する場合は、`pnpm test`とdry-runを実行して通知候補の差分を確認します。
schema、semantic validation、reducer、状態、graph、通知判定を変更する場合は`pnpm eval:golden`も実行します。
golden evalはfixture内の固定AI出力を検証して期待結果と比較し、標準fixtureで`fixedAi.networkCallCount: 0`を要求します。
実モデル、reasoning effort、promptの応答品質は評価しないため、これらを変更する場合は`metrics.aiCallCount`が1以上のdry-runでAI判定と通知候補の差分を確認します。
mentionは通知量の調整に使わず、運用上必要なuserだけをallowlistへ追加します。

## 障害時の確認

失敗したActions jobをworkflow全体のreportにある`jobs`と照合し、収集失敗ではCLI reportの`failedStage`も確認します。

| stageまたはjob                  | 確認内容                                                                                                                                                                          |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `test-eval`                     | `pnpm typecheck`、`pnpm test`、`pnpm lint`、`pnpm format:check`、`pnpm eval:golden`をローカルで再現する                                                                           |
| `configuration`                 | placeholder、team slug、未知field、日時、正規表現、secret名を確認する                                                                                                             |
| `authentication`                | `GH_APP_ID`、PEM形式、Organizationへのinstallation、必要なread権限だけがあることを確認する                                                                                        |
| `repository_inventory`          | Appのrepository access、team access、public、archive、disabledの状態を確認する                                                                                                    |
| `incremental_collection`        | GitHub API残量、429と503、対象repositoryの一時障害を確認する                                                                                                                      |
| `codex_analysis`                | `codex` executable、model ID、reasoning effort、予算、timeout、`ai.authentication`を確認し、`auth-json`では`CODEX_HOME`直下の`auth.json`、`api-key`では`OPENAI_API_KEY`を確認する |
| `state_persistence`             | Actionsの`contents: write`、`tracker-state`のruleset、同時runがないことを確認する                                                                                                 |
| `build-pages`                   | Pages DTO、`web.basePath`、Web build、公開guardの診断を確認する                                                                                                                   |
| `deploy-pages`                  | Pages Source、`github-pages` environment、`pages: write`と`id-token: write`を確認する                                                                                             |
| `discord`または`notify-discord` | enabled設定、Webhook secret、channel、Webhook失効、429と503を確認する                                                                                                             |

`incremental_collection`が`errorType=CliRelationExpansionLimitError`で失敗した場合は、同じ診断行の`relationExpansionLimit`、`relationExpansionFetchedCount`、`relationExpansionUnfetchedCount`を確認します。
件数が想定より多いときは、GitHub上の誤ったnative relationや参照を直します。
妥当な件数なら、GitHub API残量と`operations.githubApiBudgetRatio`を確認したうえで`tracking.relationExpansion.maxItemsPerRun`を引き上げ、`backfill: none`で再実行します。
この失敗ではstate、Pages、通常のDiscord通知を更新しません。

収集の診断に「端点を取得できなかった関係候補を除外しました」が出る場合は、archive済みrepositoryやOrganization外の参照先など、公開境界の外にある関係先が残っています。
run自体は成功し、除外した関係候補は依存グラフへ載りません。

Actions上でCodexの認証エラーが起きた場合は、ローカルのCodexへログインし直し、[デプロイ手順](DEPLOYMENT.md)のコマンドで`CODEX_AUTH_JSON`を登録し直します。

`fallback`はCodexを利用できなかった項目を決定論的判定へ縮退した完全runです。
PagesでAI unavailableと不確実性を確認し、原因を直して再実行します。
`failure`が`state_persistence`より前ならstateは更新されません。
`pages`か`discord`で失敗した場合はstate commit後の可能性があるため、snapshotのrun IDとPagesの生成時刻を比較し、両者が同じrunか確認します。
Pages deployに失敗した場合は最後に成功したPagesを基準にし、Discordを送信しません。
state commit後のPages失敗は想定内であり、stateを巻き戻しません。
次回runはcommit済みsnapshotを前回値として新しいsnapshotを作り、state commit後にPagesを更新するため、同じrun IDと生成時刻へ再び揃います。

公開guardが失敗した場合は安全設定を無効化しません。
どの入力にallowlist外repository、private sentinel、secretらしい値、長すぎる全文、安全でないURLが入ったかを、secretをlogへ出さずに調べます。
原因を除いた後に`backfill: none`で手動再実行します。

同じrunを再実行してもworkflow concurrencyと通知ledgerが競合と通常通知の重複を抑えます。
GitHub、Codex、Discordの429と503は設定した回数だけretryし、それでも失敗する場合は外部サービスの回復後に再実行します。
