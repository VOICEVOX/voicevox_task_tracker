# 運用手順

運用担当者がrunの結果を確認し、停止・再開・手動解決を行う手順です。
構築は[デプロイ手順](DEPLOYMENT.md)、ローカル確認は[開発手順](DEVELOPMENT.md)を参照してください。
日次起動の予定は03:00、07:00、11:00、15:00、19:00、23:00 UTC、日本時間の00:00、04:00、08:00、12:00、16:00、20:00です。Actionsのscheduleには遅延があります。

## 日次runはreceiptとstateの両方で確認する

`daily.yml`は`_tracking-run.yml`を呼び、次の依存順で進みます。

1. `quality`
2. `bootstrap`
3. `prepare-runtime`
4. `analyze`
5. `commit-initial-state`
6. `initial-pages`
7. `settle-notifications`
8. `finalize-run`
9. `notification-history-pages`
10. `complete`
11. `observe`

business stageの一覧と所有先は[アーキテクチャ](ARCHITECTURE.md#canonical-stageは直前の成果物を受け取る)にあります。
再開時はexact stateから次stageを選び、完了済みeffectを再実行しません。
通知actionがholdやacknowledge-currentでもsettlementとfinalizationを実行します。
通知履歴Pagesはfinalization後です。公開不要のrunも、その結果をreceiptへ記録してcompleteへ進みます。
observeは先行jobの成否にかかわらず全jobの結果とfailure artifactをまとめます。

固定pathは`state/run-transaction-marker-v1.json`、`state/durable-publication-record-v1.json`、`state/initial-pages-publication-evidence-v1.json`です。
同じrevisionから読み、run ID、checkpointとrecordのdigest、phase sequence、期待する親、初回Pages証拠を照合します。
markerはinitial_state_committed、notifications_in_progress、notifications_settled、run_finalizedの順に進みます。
ファイル名のV1は固定pathの契約名で、record本文のversionとは別です。
stateやledgerを人間が直接編集して結果を変更しません。

Pagesではトップの項目一覧に未完了の追跡項目が表示され、既定が要対応度の降順であることを確認します。
状態で「すべて」を選ぶと、完了済みの追跡項目も表示されます。
現在対応の責任主体と実行可能性の絞り込みが、担当者一覧と個人ページの項目数に一致することを確認します。同じ相手に複数の原因があっても同じ項目は1件と数えます。項目全体の状態とblockerは現在対応と併記し、停滞時間の集計は「項目の最長停滞時間」として確認します。
表が表示される幅では列見出しから並び替えられ、カードが表示される幅では並び順の選択UIが現れることも確認します。
共通ヘッダーには「最新更新」と相対時刻、共通フッターにはrun IDだけが表示されます。
通知履歴ではDiscordへ送信済みの項目通知が新しい順に表示され、履歴がなければ空状態になることを確認します。
送信した通知は、同じrunの`notification-history-pages`がPages公開に成功した後に表示されます。
個人通知の履歴は送信時の相手と行動であり、現在対応が変わっても書き換わらないことを確認します。
`tracker-state`では`state/run-reports/YYYY-MM-DD.json`を確認します。
ローカル実行のreportは`artifacts/run-reports/`へ出力されます。
Actionsでは収集reportとworkflow全体のreportを、run IDと試行番号を含む別々のartifactへ保存します。

run reportの主な確認項目は次のとおりです。

| field                               | 意味                                                                              |
| ----------------------------------- | --------------------------------------------------------------------------------- |
| `status`                            | `success`は完全成功、`fallback`はCodex縮退を含む完全run、`failure`は不完全run     |
| `complete`                          | stateと公開処理へ進める完全性を満たしたか                                         |
| `failedStage`                       | failureが起きた処理段階                                                           |
| `diagnostics`                       | secretや信頼できない本文を含まない診断                                            |
| `metrics.repositoryCount`           | 公開allowlistに入ったrepository数                                                 |
| `metrics.itemCount`                 | 追跡項目数                                                                        |
| `metrics.changedItemCount`          | 前回から更新された追跡項目数                                                      |
| `metrics.activeEdgeCount`           | 有効な関係edge数                                                                  |
| `metrics.aiCallCount`               | preflightを含むCodexの論理call数。retryとsemantic補正の追加世代は含めない         |
| `metrics.aiProcessAttemptCount`     | preflight、汎用AI、個人原因AI、retry、semantic補正のCodex exec実試行数            |
| `metrics.aiCacheHitCount`           | AI cacheを再利用した件数                                                          |
| `metrics.aiRetainedResultCount`     | AI分析対象へ入れず前回のAI結果を保持した件数                                      |
| `metrics.estimatedInputTokens`      | 選択した分析候補とpreflightの入力token見積り。追加試行の増分は含めない            |
| `metrics.githubApiRemaining`        | 最後に観測したGitHub API残量                                                      |
| `metrics.staleRepositoryCount`      | 前回値を利用したrepository数                                                      |
| `metrics.notificationCount`         | Discord送信結果を通知管理記録へ記録した通知数。`hold`と`acknowledge-current`では0 |
| `metrics.scheduleDelayMilliseconds` | 予定起動時刻からCLI開始までの遅延                                                 |
| `metrics.durationMilliseconds`      | CLI開始からrun完了までの所要時間                                                  |

個人原因は`metrics.personalReminderCauseCount`で件数を確認します。`personalReminderAiCallCount`は複数原因をまとめた実行batch数で、preflightを含みません。`personalReminderAiCacheHitCount`と`personalReminderAssessmentReuseCount`は原因ごとのcache利用数と採用値再利用数です。全体の`aiCallCount`と`estimatedInputTokens`には、汎用AI、個人原因のAI、preflightを合わせて計上します。
`aiProcessAttemptCount`は論理call数と別に、processRunnerへ渡した`codex exec`を1回ずつ数えます。呼び出し後の起動失敗、timeout、結果不明も含み、呼び出し前の失敗と`codex --version`は含みません。成功、縮退、段階失敗のreportに記録します。
`personalReminderUnknownCount`は正常に完了した未確定判定です。`personalReminderFailedCount`、`personalReminderDeferredCount`、`personalReminderNotEvaluatedCount`は現在有効な採用値がない原因を数えます。正常なunknownだけではrunを`fallback`にせず、失敗・延期で有効な判定を使えない場合を縮退として確認します。

Codex出力のschema検証とsemantic検証に失敗した場合、`diagnostics`へ違反件数が`validationIssueCount`として残ります。
違反した検証ルールは先頭5件まで`validationIssue0Path`と`validationIssue0Code`の形式で残り、添字は0から始まります。
違反の`message`は入力値を含みうるため残しません。

AI有効runで汎用AIの分析処理が結果を返した場合、`diagnostics`に`codex_semantic_generations`から始まる集計行が1行残ります。

| field                      | 意味                                                       |
| -------------------------- | ---------------------------------------------------------- |
| `generationCount`          | 初回を含む汎用AIの生成世代数                               |
| `correctionStartedCount`   | 第2世代の補正を開始した候補数                              |
| `correctionSucceededCount` | 補正出力がcanonical検証まで通った候補数                    |
| `correctionExhaustedCount` | 補正を開始し、総世代数の上限までsemantic違反が残った候補数 |
| `processAttemptCount`      | 汎用AIのtransport retryを含むprocess試行数                 |

これらの件数は個人催促AIと認証preflightを含みません。ここでの`processAttemptCount`は汎用AIだけの集計で、run全体の`metrics.aiProcessAttemptCount`とは範囲が異なります。集計行にはitem ID、違反のpathやcode、本文を含めません。
補正上限に達した項目を縮退させて完了した通常runにも集計行が残ります。
致命的なalias変換失敗やforcedモードの失敗で`analyzeCodex`が戻らない場合は、この行が残らないため、行がないことから補正0件とは判断できません。

汎用AIのsemantic補正は`ai.execution.maxSemanticGenerations`で制限します。必須の整数設定で範囲は1から3、初回を含みます。1は補正無効で、現行値3では2回まで補正できます。
各世代には`ai.execution.maxAttempts`までのtransport retryがあり、候補1件あたりのprocess試行数は最大で両設定値の積になります。実試行のrun残枠がなければretryと補正は行わず、候補を延期します。
補正の追加世代は`metrics.aiCallCount`に加算せず、補正envelopeの増分も論理入力予算と`metrics.estimatedInputTokens`へ含めません。実際の入力文字数は暗号化した詳細診断の`standardInputCharacters`で確認します。

## 未完了runは記録されたexact runtimeで再開する

現行制御runtimeはbootstrapだけを読みます。
markerとrecordが両方ない場合、または整合した完了runの場合だけcurrent runtimeで新規runを開始します。
未完了runの業務payloadはcurrent runtimeでparse・migrationせず、元のcode revisionとbundleのexact runtimeへ渡します。

V2の再開は、制御側のbundle検証とexact側のstage実行の二段階です。
制御側でlockfile、toolchain、manifestの全file digest、固定entrypoint、adapter identityを照合し、exact側のinspectが次stageを選びます。
execute_stageが一段を進め、Pages action後はrecord_pagesが観測結果を検証します。
元artifactの消失時は同じsourceから再生成し、記録されたdigestと一致した場合だけ使用します。
Pagesの現行YAMLの実効条件と外部actionのSHA、exact sourceから起動するlocal actionとscriptのbyte列を照合します。
記録されたsourceを先頭でcheckoutする経路が変わった場合はeffect前に停止します。
GitHub再収集、AI再計画、固定outboxの選び直しを再開手段にしません。

V1は固定entrypointとinput/outputの回復protocolを維持し、静的action adapterとaction SHAの登録値を照合します。
未知のadapter、identity不一致、manifest欠落、実行できないready-only bundleは通常の自動復旧対象として扱いません。
ready-onlyのimmutable V1 runは、state revision、record/marker digest、元sourceとbundle、実送達の証拠を保存して手動停止し、現行CLIの業務commandで代替しません。
停止対象のstateを通常の再開やsandbox連続runの証拠に使いません。
V2 bundleは生成時期にかかわらず、記録されたexact runtimeと同じadapterを検証できれば、安全な未完stageから自動再開します。

## 失敗したoperationのeffect certaintyを確認する

公開failure artifactのfailedStage、failureKind、binding evidence、lastReceiptDigest、failedOperationEffectCertainty、recovery dispositionを確認します。
run開始前、bootstrap、pre-checkpoint、checkpoint以後ではbindingを区別します。
operation-local certaintyは失敗した処理自身のno_effect、committed、ambiguousです。前段の成功receiptだけでcommittedへ変えません。

| 失敗位置                                        | 状態と次の操作                                                               |
| ----------------------------------------------- | ---------------------------------------------------------------------------- |
| 初回commit前                                    | state更新は未確定。今回のfailure evidenceを確認し、原因を直して新規runへ進む |
| 初回commit・Pages・通知settlementの途中         | 同じrun・checkpointのexact runtimeで残るeffectだけを再開する                 |
| Discordの通信例外、5xx、応答不正、送信中の停止  | delivery_startedを残し、届いたか確認するまでsettlementとfinalizationを止める |
| finalization後の通知履歴Pages                   | finalized stateと送達結果を保ち、同じrunの履歴公開だけを再開する             |
| 別run、別checkpoint、state head変更、superseded | 競合として停止し、最新stateと元runの証拠を照合する                           |
| 公開境界違反                                    | 保存・Pages・通常Discord・運用障害通知を停止し、公開境界の原因を除く         |

Pagesでは同じrun、checkpoint、revision、content、adapterに結合した成功receiptを検証し、再deployを省略できます。
矛盾する成功結果、破損、元buildやchainの欠落、成功を証明できないupload結果では停止します。
前runの初回Pages証拠を今回の通知開始条件へ転用しません。
state commit後のPages失敗でstateを巻き戻しません。

production直列実行のPages childが起動した場合、`tracker-pages-effect-lease`の`state/production-pages-effect-lease-v1.json`を確認します。
固定pathのlease本文はschema version 2です。active leaseはrun、checkpoint、親Actions実行IDとattempt、公開phase、固定state revision、intent digestを保持します。同じ公開operationの識別子は固定し、deployが始まらなかったと証明できた場合だけattemptの連番と識別子を更新します。
親が停止しても子は公開を続けるため、leaseがactiveの間は別のtracking runを開始しません。
同じrunを再開するには`recover_tracking_run`で`execution_shape`に`sequential`、`run_id`にleaseのrun IDを指定します。`run_sequential`の`run_id`指定でも再開できます。
再開処理はexact runtime、state、receiptを照合し、同じattemptのchildを探します。childがleaseに記録済みなら、その実行IDとattemptから観測artifactを取得します。dispatch開始後のattemptを再dispatchしません。
初回Pagesの成功receiptが確定した場合だけ履歴Pagesのleaseへ進みます。新たなchildを起動するときは、実行中のworkflowと固定sourceのPages child workflowが同じ内容であることを確認します。childは固定sourceでPagesを生成し、公開前に出力manifestをintentと照合します。
childの検索はdispatch期間のActions runを全ページ確認し、1000件を超える期間は分割します。childの重複、未発見、実行中、観測artifactの欠落や不一致、upload、deploy、deployment ID、公開URLの未確定は停止してactive leaseを保持します。
`no_effect`は失敗したchildのdeploy stepが未開始だったことをActionsの実記録で確認した場合だけ確定します。効果が不明なattemptは`unknown`として停止し、同じoperationの次attemptを自動開始しません。
最終reportとreceiptを検証して保存した継続attemptがleaseをCASで解放します。効果が曖昧なleaseを自動解放する操作はありません。

運用障害通知は`tracker-operations-alerts`の`state/operations-alert-ledger-v1.json`へ送信予約を保存してから送ります。
同じincidentの送信済みまたは曖昧な予約を再送せず、receiptを失っても専用branchの実状態を先に確認します。
通常runのmarkerを運用障害通知のcommitで書き換えません。
本番の直列runでtracking jobが失敗した場合も、公開failure artifactを分割runと同じ通知jobへ渡します。
直列runではCLI起動前の失敗でartifactがない場合だけ基盤障害として通知します。CLI起動後にartifactを取得できなければ送信を止めます。
Pages leaseがactiveでも運用通知は専用branchだけを更新し、leaseを解放しません。

## 曖昧なDiscord送達を手動解決する

delivery_startedは期限で解除しません。
同じrunのsettlementとfinalization、新しい日次runを止め、Discordの投稿と実行ログを確認します。
届いていなければretry、届いたか送信不要ならacknowledgeを選びます。
受信を確認せずretryすると重複送信になり得ます。

1. 同じexact revisionのmarkerとledgerからrun ID、checkpoint digest、delivery ID、attempt ID、固定outbox順のnotification keyを取得します。
2. 元Actions実行IDとcode revision、記録済みrunの実行形態を確認し、default branchの「Discord送達の手動解決」へ指定します。production直列runではactive Pages leaseの親Actions実行IDを指定します。
3. select-runtimeが分割runのV2固定bundle、または直列runのV1固定sourceを検証したことを確認します。手動判断の結果は同じrunのmanual resolution receiptへ記録されます。
4. 分割runは共通workflow、直列runは固定V1 runtimeの再開から、残りmessage、settlement、finalization、通知履歴Pages、completeへ進んだことを確認します。

retryの手動解決操作自体はDiscordへ送信しません。
元の固定予約と開始試行を保持し、検証済みreceiptを受け取る同じrunの再開だけが再送できます。
acknowledgeは確認済みにし、送信履歴を追加しません。
receipt消失時は同じ入力の解決操作を再実行し、実Gitの親子stateから独立に検証したreceiptを取得します。
相反する判断、別runや別attemptへの適用は拒否されます。
直列runでは、固定sourceとactive Pages lease、開始済み送達をGit stateと照合してからV1の手動解決commandを実行します。証拠が欠ける場合は送達状態もleaseも変更しません。

## sandboxで連続runと通知actionを確認する

`sandbox.yml`は`Hiroshiba/voicevox_task_tracker`の`codex/daily-transaction-refactor`から起動し、source_refも同じbranchにします。
実行code revisionを固定し、reusable workflowの定義が一致することを確認します。
create/resetは公開seedから新しいenvironmentと`sandbox-state/env-<run ID>-<attempt>`を作り、`preparing` manifestを保存します。
新環境はstate、receipt、必要なcoverageの検証が終わると`ready`になります。`preparing`の環境では通常のcontinueとdisposeを実行できません。旧形式のmanifestはreadyとして読み、次のcontinueが完了したときに現行形式へ保存します。
workflowの排他groupはenvironment ID単位です。resetは旧環境のgroupで読込から新環境のready確定まで実行し、旧branchを上書きしません。異なるenvironmentの操作は並行できます。continueは同じenvironmentの前回stateを読み、disposeは取得したheadから変更されていない場合だけ削除します。待機中のrunがActionsによって新しい待機runへ置換された場合は、取り消されたrunのjobが始まっていないこととstate revisionが変わっていないことを確認し、無効果として扱います。必要な操作は改めて起動します。
新branch作成後にresetが失敗した場合、そのbranchは`preparing`のまま残ります。確定したresult、receipt、coverage artifactがそろっていれば`recover-reset`に旧environment IDと新environment IDを指定します。確定結果を持つrunが元resetと異なる場合は、そのActions run IDとattemptも指定します。復旧はmanifestに記録した元reset runのID、attempt、code revision、終了状態、旧環境headと、新環境のstate、receipt、coverageを照合します。検証CLIは元のcode revisionから組み立て、追跡や通知を再実行せずmanifestだけをreadyへ進めます。source branchのheadが進んでも復旧できます。証拠が欠ける場合や新旧環境のheadが変わった場合は停止します。
Discordと本番Pagesへは書き込まず、実GitHub収集・実AI・sandbox state更新と、Pages/Discordのrecording portを組み合わせます。
同じCodex認証を使うrunは前のrunが完了してから起動します。

連続2 runではscenario_idをcontinuity、notification_actionをsend、outcomeをrecorded_success、messageIndexを0にします。
firstはcreateまたはresetで実AIの成功を含むrunを完了させます。
secondはcontinueで、firstのActions run ID/attempt、tracking run ID、final state revision、code revisionをrecording_controlのcontinuityへ渡します。
firstのresult/coverage artifactと実Gitの親子revisionを照合し、同じenvironmentのstate読込、cache再利用、通知重複抑制を確認します。
preflightだけのAI実試行を、対象項目の推論成功として数えません。

通知actionは次の順に独立scenarioで確認します。

| scenario_id           | actionとrecording結果                                           | 確認する証拠                                                   |
| --------------------- | --------------------------------------------------------------- | -------------------------------------------------------------- |
| send-clear-rejection  | send / recorded_clear_rejection                                 | 明確な拒否が送信済み履歴にならず、再試行可能な予約へ戻る       |
| hold                  | hold / recorded_success                                         | pendingを保持し、送信予約と送信履歴を増やさない                |
| acknowledge-current   | acknowledge-current / recorded_success                          | 確認済みへ進み、送信履歴を増やさず、既存sentを保持する         |
| ambiguous-retry       | send / recorded_ambiguous、その後retry / recorded_success       | 曖昧な開始記録を保持し、同じ固定予約の手動解決と再開だけが送る |
| ambiguous-acknowledge | send / recorded_ambiguous、その後acknowledge / recorded_success | 確認済みへ進み、自動再送と送信履歴の追加をしない               |

各scenarioのfirstはreset_sourceをseedにしたresetを使います。
曖昧なfirstは`preparing`のまま停止します。resolutionは`resume-preparing`で元のpending revision、delivery operation、Actions run IDとattempt、tracking run IDを渡します。元reset runと子effectの終了、旧環境head、新旧環境の進行中runを確認し、元runのcode revisionと現在のreusable workflow定義を照合してから、既存の手動解決と同じrunの再開を実行します。source branchが進んでいても元runのcode revisionとruntimeを使います。workflow定義が一致しなければ効果を加えず停止します。finalized receiptが確定した後に新環境をreadyへ進めます。
notification controlのpriorへ先行scenarioの実行ID、environment、最終revision、coverage digestを順番どおり指定し、機械検証を通します。
通知matrixは各scenarioの元reset run、manifest、永続record、runtime bundle、coverage、完了resultを個別に照合します。scenario間でsource branchのcommitが異なっていても、各runのcode revisionと証拠が一致すれば集約できます。
曖昧なfirstではpendingを示す失敗結果も必要な証拠です。すべてのfirstを通常完了として扱いません。
入力schemaは`.github/scripts/parse-sandbox-recording-control.mjs`を正本とします。

Actionsの成功表示だけでgate完了にしません。
同じenvironmentの2 runと全action scenarioについて、実行ID、固定SHA、state revision、receipt chain、effect report、result、coverage artifactを保存して照合します。
未実行、DNS・認証・外部サービス障害で止まった確認は未完了として記録します。

## 誤判定の直し方

tracker専用のcommand comment、override UI、専用labelはありません。
次回runで機械的に解釈できるように、GitHub上の事実を明確にします。
GitHubのassigneeは確定情報として保持します。未アサインIssueの実質担当は表示上の推定であり、trackerはGitHubへassignを書き戻しません。

個人への催促が疑わしい場合は、現在対応の責任主体、行動、根拠と実行可能性を先に確認します。項目全体の依存待ちと、並行して進められる対応は両立します。
`unknown`は判断に必要な情報の不足や競合を表し、AIの実行失敗とは区別します。正常に評価した`unknown`は同じ入力で再利用するため、再実行を繰り返すだけでは変わりません。`failed`と`deferred`は必要性が残れば次回runで再試行します。有効な採用値が現在入力と一致する場合は、直近の実行失敗だけでその判定を消しません。
正式な依頼や担当決定などの規則による義務は、AIから義務なしに変更しません。通知を止めるために無関係なassigneeやstatusを変更せず、依頼の解決・撤回・引継ぎ、実際に待っている工程を正本へ反映します。

### AI表示を三つの軸で読み分ける

AIの実行状態、判定要素が決定論的に不要だったか、表示値が現在入力で検証済みかは別の情報です。

| 公開DTO                                          | 読み方                                                                                                                                                                                                                                                    |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `runStatus`                                      | その項目で今回行ったAI分析の処理結果です。`failed`は失敗、`deferred`は予算上限による未実行を表します                                                                                                                                                      |
| `omission`                                       | 9個のAI判定要素のうち、確定規則だけで決まるためAI推定を不要とした範囲です。`partial`は一部、`all`は全部を表します                                                                                                                                         |
| `aiAnalysis.unverifiedValues`                    | 項目の最終表示値のうち、現在入力でAI依存が検証済みと証明できない値です                                                                                                                                                                                    |
| `currentResponses[].unverifiedValues`            | 一つの現在対応について、責任主体、行動、実行可能性、待機先、根拠のどの値が現在入力で未検証かを示します                                                                                                                                                    |
| `currentResponses[].subjectMembershipUnverified` | その対応の責任主体を現在の対応者として数えるかが未検証であることを示します。同じ項目で同じ主体を示す別の対応が一つでも検証済みなら、その主体の項目への所属は確定します                                                                                    |
| `currentResponsesUnverified`                     | 現在対応の件数や構成が現在入力で未検証で、表示内容が増減する可能性があることを示します                                                                                                                                                                    |
| `currentResponseSubjectChanges`                  | 人物集計へ追加または削除され得るuserとteamを示します。`bounded`では対象を`addableSubjects`と`removableSubjects`へ列挙し、特定できない場合は`unbounded`にします。roleだけの増減は人物集計を変えないため、責任主体が検証済みなら`bounded`の空配列になります |

`not_required`はAI判定が不要だったことを表し、失敗や延期ではありません。確定規則だけで決まった値には警告マークが付きません。
`failed`または`deferred`の項目と、未検証の表示値や現在対応を持つ項目には一覧行の警告マークが付きます。詳細では、未検証の値のそばにある警告マークから説明を確認できます。一覧の`ai=unverified`はこれらの項目をまとめて絞り込みます。`ai=partial`は一部要素がAI不要、`ai=all`は全要素がAI不要の項目を絞り込みます。

現在の対応に表示される「今回はAI判定を実行していません」は、今回の意味評価を実行しなかった`deferred`を表します。原因にはAI予算の上限だけでなく、上流relationの未確定、入力の不完全、入力件数や文字数の上限があります。GitHub上の方針判断を延期した意味でも、AIが判断したうえで結論を先送りした意味でもありません。

期限日はCodexが本文やコメントから抽出し、期限の切迫度は期限日と現在日から決定論的に計算します。この場合、切迫度の計算にAIを使わなくても、期限日が現在入力で未検証なら切迫度も同じAI producerに依存するため警告マークが付きます。

抽象的なmaintainer、reviewer、merge_deciderの責務は、`config.yml`でrepositoryごとに設定したメンテナ全員へ展開されます。
担当者を変える場合は`maintainers.defaults`か`maintainers.repositories`のGitHubユーザー名一覧を更新します。
GitHubのteam review requestと本文やコメントの`@organization/team`はteamへの待ちとして残ります。
trackerはteam memberを取得しないため、team宛て項目ではコメントした人がteam memberかどうかを判定しません。
個人のコメントを待ち先の活動として停滞計算へ反映させる場合はuserを名指しします。
PRのレビュー担当選定待ちとレビュー待ちでは、teamへの依頼でも人間のレビューを進展として扱います。

### コメント

最新コメントで、次に誰が何をするかを一文で明示します。
Issue全体を担当する場合は、その旨を明記し、追跡中でGitHubがclosing referenceとして認識した直接関連PRや継続成果物と結び付けます。本文に書いただけの推定relation、部分対応、助言、検証、review、条件付きの意向、撤回、延期の記載は実質担当の根拠になりません。
複数人を候補にする場合も、Issue全体を共同で進めていることを明記します。部分PRの組み合わせだけから共同担当を推定しません。
trackerは一般的な活動状態を実質担当へ読み替えず、部分担当や部分実装を別の担当としてモデル化しません。
方針判断待ちへ直す場合は、maintainer roleへ必要な判断を明記します。
返答待ちへ直す場合は、回答を求めるuserかteamを名指しします。
質問の内容と未回答であることも明記します。
依存関係なら対象IssueかPRのURLに加え、どの行動を止めているか、並行できる行動があるか、単なる関連情報かを明記します。部分実装や代替案を、Issue全体の完了や同じ対応の重複と取り違えないよう範囲も示します。

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
label規則を変えた場合はsandboxで通知候補の差分を確認します。

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
個人原因の評価はnative blockの事実を変更しません。reviewや計画などが並行可能なら、依存関係を残したまま現在対応へ表示します。単なる`related_to`を理由に催促は抑止しません。

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

### 通知候補を保持して送信を保留する

AI判定の更新内容を確認してから通知したい場合は、手動実行の`notification_action`を`hold`にします。
通知候補は通知管理記録の`pendingNotifications`へ保存し、送信予約、確認済み、送信済みの記録は追加しません。
すでに送信済み・確認済み・送信開始済みの記録は維持します。

1. repository variableの`VOICEVOX_TASK_TRACKER_SCHEDULE_PAUSED`を文字列`true`にし、定期実行を停止します。
2. 実行中と待機中の日次runを確認します。変数の変更だけでは開始済みのrunは止まらないため、state更新と通知処理の完了を待ちます。
3. default branchの「日次タスク追跡」を、`backfill: none`、`repository_filter`は空、`notification_action: hold`で手動実行します。
4. `commit-initial-state`、`settle-notifications`、`finalize-run`、`complete`、`observe`の成功を確認します。`settle-notifications`は送信せずにrunの完了処理を行うため、jobを省略しません。
5. Pagesとrun reportで判定結果を確認し、通知管理記録で保留候補を確認します。分析の失敗・延期が残る場合は、各runの完了を待って`hold`で再実行します。
6. 通常送信に戻すときは、手動実行で`send`を指定します。保留候補は現在の条件で再検証され、まだ有効な候補だけが通常の件数上限に従って送信されます。
7. 古いrunが残っていないことを確認し、停止用変数を削除するか`false`にして定期実行を再開します。

停止用変数は手動実行を止めません。
定期実行のイベントは発生しますが、開始jobと、障害通知・run報告を含む後続jobを省略します。
`hold`自体は指定したrunだけに適用されるため、確認中は停止用変数を維持してください。
手動実行中に障害が発生した場合の運用障害通知は通常どおり動きます。

個人原因の候補は、同じ通知keyなら検出時刻を保って再検証します。入力が変わって採用値が使えない場合や、`waiting`・`unknown`へ変わった場合は送信を保留します。失敗・延期やrepositoryの収集失敗だけでは責務を終了させません。
進捗や待機解消で停滞起点が変わった場合は、現在の閾値で候補を選び直します。新しいkeyになると検出時刻も更新し、閾値未満なら古い候補を失効させます。責務が終了した場合、`not_required`・`duplicate`になった場合、相手・行動・責務期間が交代した場合も旧候補を取り除きます。

### 保存形式の変更は未完了runの復旧後に切り替える

1. 定期起動を停止し、開始済み・待機中のrunの完了を確認します。曖昧なdelivery_startedは手動解決し、未完了runは元のexact runtimeで復旧します。
2. 稼働codeとstateのSHAを保存し、Git checkoutの同じSHAをverify-stateへ指定して現行ingressとcommit chainを検証します。
3. 入口で旧形式から現行形式へ一方向に移行し、AI採用値、根拠、時計、履歴、通知済み・確認済み記録を保つことを確認します。
4. マージ後のCI成功を確認し、定期停止を維持してholdで初回runを実行します。
5. remoteへpushされた現行state、cache移行、marker・record・初回Pages証拠、finalizationを確認し、通知候補の確認後にsendと定期起動を再開します。

検証やローカルcommitだけでは本番の移行完了と見なしません。
push前の失敗は停止を維持し最新remote headから再試行します。
push後のAI失敗・延期は現行stateで再試行し、古いstateへの巻き戻しで通知記録を失わせません。

### 現在の通知候補を一括で確認済みにする

通知条件を調整した直後など、現在の候補をDiscordへ送らず、通知済みと同様に扱いたい場合は、日次workflowの手動実行で通知処理を`acknowledge-current`にします。

1. default branchのActionsから「日次タスク追跡」のworkflowを開きます。
2. `backfill`を`none`、`repository_filter`を空、`notification_action`を`acknowledge-current`にして実行します。
3. `analyze`、`commit-initial-state`、`initial-pages`、`settle-notifications`、`finalize-run`、`complete`、`observe`が成功することを確認します。`notification-history-pages`は公開不要という結果を記録します。

`acknowledge-current`は現在の通知条件を満たす候補を、reasonごとに最大件数の制限なく、確認済みとして通知管理記録へ保存します。同じnotification keyは送信済みと同様に通知対象から除外します。すでに送信済みの同じkeyは送信日時とDiscord message IDを維持します。通常のDiscord digestは送信せず、`notification_sent`履歴も作りません。snapshotとPagesの生成は通常runと同じで、通知管理記録の更新は同じatomic transactionへ含まれます。運用障害が発生した場合の`observe`の運用通知は別系統で動作します。

成功確認では、`tracker-state`の通知管理記録に未送信だった対象候補の`status: acknowledged`が保存され、通知履歴に送信済み項目が追加されていないことを確認します。すでに送信済みだった同じkeyは`status: sent`のままです。state branchや通知管理記録を直接編集して確認済み状態を解除してはいけません。

`sent`と`acknowledged`の同じnotification keyは期限なく通知対象から除外します。
個人通知は同じkeyの記録を照合します。意味入力や表示文だけの変化ではkeyを変えませんが、進捗や待機解消で起点が変われば現在の閾値で選び直します。
systemの時間系通知と待ち先不明の通知は、同じ待ち期間・通知理由・停滞レベルの送信済みまたは確認済み記録も照合します。進捗で停滞起点が変わっても、同じ待ち期間の同じ通知は再送しません。
待つ行動や相手の変更、同じレビュワーへの新しいレビュー依頼、停滞レベルの上昇は新たな通知候補になります。依存解消や循環検出などは、それぞれの変化に応じた選別を行います。
確認済みにする操作は、実行時点で通知条件を満たす候補だけを対象にします。まだ基準時間に達していない項目の将来の通知は抑制しません。

分析が延期された項目から、後日のrunで新たな通知候補が生じることがあります。
判定結果の確認中に候補を失わず保留する場合は`hold`を使います。
`acknowledge-current`は本来送るべき通知も確認済みにするため、一時的な送信停止には使いません。

通常の`send`は、`maxItemsPerDigest`を含む既存の通知選別を行います。
件数上限で送れなかった候補は、検出日時と通知理由を通知管理記録の`pendingNotifications`へ保存します。次回以降の集計では、保存した理由が現在も有効な候補を通知対象に戻し、その時点の停滞レベルと優先順位で選別します。新しい候補が増え続ける場合、優先順位の低い候補は引き続き送信を待ちます。

持ち越した責務移動の通知は、移動先の待ち相手が変わったら破棄します。たとえばAからBへの移動を通知する前にCへ移った場合、Bへの移動は通知しません。BからCへの移動は、その変化自体が通知条件を満たす場合に新しい候補になります。依存解消の候補は再び依存待ちになったら破棄し、停滞の候補は進捗や状態が変わったら見直します。収集に失敗したリポジトリの候補は送信せずに保持し、次に収集できたときに有効性を確認します。送信済みまたは確認済みになった候補は持ち越し対象から除きます。

依存循環の通知候補は、グラフで新しく検出した循環から作ります。同じ循環が続いている間は同じ通知として扱い、一度解消してから再発した場合は新しい通知にします。

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
ブロック中にも実行可能な独立した個人対応は、その行動の閾値で判定します。原因の`obligationSince`は責務発生、`actionableSince`は実行可能性の起点で、実際の通知時刻は有効な進捗を反映した`stallSince`から計算します。
イベント時刻が取得できない原因は、最初に責務や実行可能性を確認できたsnapshotの観測時刻を`first_observation`として保持します。AI評価のたびに起点が更新されていないことを確認してください。

通知が多すぎる場合は次の順で調整します。

1. 個人通知では原因の相手、行動、実行可能性、停滞起点を確認し、その根拠となる依頼・進捗・依存をGitHub上で明確にします。system通知では項目全体の`status`、`waitingOn`、理由固有の変化を確認します。
   実質担当の誤判定は、Issue全体を担当する宣言、追跡中でGitHubが認識したclosing reference、継続成果物を明記するか、部分対応、reviewのみ、撤回、延期、引継ぎであることを最新コメントへ明記して直します。
2. automation dashboardのtitleを`notifications.automationNoiseTitles`へ追加するか、対象labelへ`labels.rules.effects.suppressNotifications`を割り当てます。
3. 通知を減らす状態に対応する`staleness.thresholdsHours`を増やします。
4. 全状態で直近の進捗を長く猶予する場合は`recentProgressGraceHours`を増やします。
5. `maxItemsPerDigest`を減らします。
6. 汎用AIの低信頼な推定が原因なら`ai.confidence.medium`を上げ、実モデルを呼び出すsandboxでAI判定と通知候補の差分を確認します。個人原因では、まず義務と実行可能性の根拠がそろっているかを確認します。

通知が少なすぎる場合は逆方向に調整します。

1. maintainer設定、userかteamの指定、review request、native dependency、label規則が実態に合うか確認します。個人通知では現在対応が`waiting`・`unknown`になっていないか、入力変更後の意味評価や前段の関係評価が延期されていないかも確認します。
2. 通知を増やす状態に対応する`staleness.thresholdsHours`を減らします。
3. 全状態で直近の進捗を短く猶予する場合は`recentProgressGraceHours`を減らします。
4. `maxItemsPerDigest`を増やします。
5. 重要labelへ`priorityWeight`か`severityLift: 1`を設定します。
6. AI予算不足なら`ai.budget`を増やし、dry-runの`metrics.aiCallCount`、`metrics.estimatedInputTokens`、deferred項目と個人原因、通知候補を確認します。前段の関係評価だけで予算を使い切っていないかも確認します。

閾値、confidence、label規則、AI予算を変更する場合は、sandboxで通知候補の差分を確認します。
model、reasoning effort、promptを変更する場合は、`metrics.aiCallCount`が1以上になるsandboxでAI判定と通知候補の差分を確認します。
`ai.execution.maxConcurrentCalls`を上げるとrun時間は縮みますが、Codexのrate limitに当たる頻度が増えて再試行が発生しやすくなります。
上げた後は`generic_ai_executed` stageの失敗数と再試行数を確認します。
mentionは通知量の調整に使わず、運用上必要なuserだけをallowlistへ追加します。

## 詳細な失敗を調べる

公開failureのdiagnostics参照に対応する暗号化artifactを取得し、安全なローカル環境で登録時と同じ鍵を使って復号します。
復号したstack、cause、Codex出力は公開IssueやPRへそのまま貼りません。
CLI起動前や暗号化自体の失敗では詳細artifactがない場合もあるため、公開failureのbindingと元jobの結果を確認します。

```console
pnpm diagnostics decrypt --key-file path/to/key.b64 --input path/to/diagnostics.bundle --output path/to/diagnostics.jsonl
```

| failedStage                                                                | 最初に確認するもの                                                        |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| prepared / inventory_collected / collected                                 | 設定、read権限、公開inventory、API残量、収集failure                       |
| generic_ai_executed / personal_reminder_executed                           | 認証preflight、実試行・予算・timeout、schema/semantic診断                 |
| runtime_bootstrap / runtime_selection / runtime_launch                     | exact state、元codeとbundle、manifest、全file digest、adapterとaction SHA |
| checkpoint_encoding / checkpoint_binding                                   | canonical bytes、sidecar、payload/file digest、base revision、完全性proof |
| initial_state_committed / notifications_settled / run_finalized            | 実Gitの親、changed path manifest、marker・record、同じrunのreceipt        |
| initial_pages_prepared / initial_pages_published                           | 出力manifest、deploy intent、現在性preflight、初回Pages証拠               |
| notification_history_pages_prepared / notification_history_pages_published | finalized revision、送信履歴、同じrunの公開receipt                        |

GitHubとCodexのretryは設定した上限に従います。
Discordの自動retryは429だけです。通信例外・5xx・応答不正は曖昧として手動確認します。
公開guardの原因を直すためにallowlistや安全設定を無効化しません。
