# デプロイ手順

デプロイ先は`VOICEVOX/voicevox_task_tracker`のGitHub Actions、GitHub Pages、`tracker-state` branchです。
追跡対象のrepositoryへは読み取り専用GitHub Appで接続します。
このrepositoryのstate更新とPages公開には、GitHub Actionsがjobごとに自動発行する`GITHUB_TOKEN`を使います。

## GitHub App

VOICEVOX Organizationの設定からGitHub Appを作成します。

1. Organization SettingsのDeveloper settingsからGitHub Appsを開きます。
2. New GitHub Appを選び、Organization内で識別できるApp名とrepositoryのURLを設定します。
3. Webhookを無効にし、event購読を追加しません。
4. 下表のread権限だけを設定してAppを作成します。
5. private keyを発行し、VOICEVOX Organizationへinstallします。

repositoryへのアクセス範囲は次のどちらかを選びます。

- `All repositories`は新しい公開repositoryを設定変更なしで発見できますが、private repositoryへ技術的にアクセスできるため三重guardを前提とします。
- `Selected repositories`は公開repositoryだけを選べますが、新しいrepositoryを作るたびにinstallation設定の更新が必要です。

動的発見を使う既定構成は`All repositories`です。
どちらを選んでも、Appへwrite権限を与えません。

### Repository permissions

| Permission      | Access    | 用途                                                   |
| --------------- | --------- | ------------------------------------------------------ |
| Metadata        | Read-only | visibility、archive、disabled、ID、名前のinventory     |
| Issues          | Read-only | Issue、comment、timeline、native dependency、sub-issue |
| Pull requests   | Read-only | PR、review、review request、review thread、head情報    |
| Checks          | Read-only | check runの状態                                        |
| Commit statuses | Read-only | commit status context                                  |

### Organization permissions

Organization permissionsはすべて`No access`にします。

`Contents`、`Actions`、`Administration`、`Projects`など、表にない権限は`No access`のままにします。
installation IDは実行時にOrganizationから自動発見します。
ローカル実行では任意の環境変数`GH_APP_INSTALLATION_ID`でinstallation IDを上書きでき、指定した場合は自動発見を省略します。
workflowでは`GH_APP_INSTALLATION_ID`を設定しません。

## Actionsの設定

日次workflowには、repositoryのSettingsからActions variableとActions secretを登録します。
forkのsandbox workflowには、[試行用認証の登録手順](#forkの試行用認証を登録する)を使います。

| 名前                                                  | 種別     | 値                                                  |
| ----------------------------------------------------- | -------- | --------------------------------------------------- |
| `GH_APP_ID`                                           | Variable | GitHub Appの数値ID                                  |
| `GH_APP_PRIVATE_KEY`                                  | Secret   | GitHub Appから発行したPEM private key               |
| `CODEX_AUTH_JSON`                                     | Secret   | Codexの`auth.json`の中身                            |
| `CODEX_AUTH_SYNC_TOKEN`                               | Secret   | Codex認証同期用のfine-grained personal access token |
| `DISCORD_WEBHOOK_URL`                                 | Secret   | 通常digest用のIncoming Webhook URL                  |
| `DISCORD_OPERATIONS_WEBHOOK_URL`                      | Secret   | 運用障害通知用のIncoming Webhook URL                |
| `VOICEVOX_TASK_TRACKER_DIAGNOSTICS_AES256_KEY_V1_B64` | Secret   | 詳細診断artifactの暗号化鍵                          |

PEM private keyは改行を保持したままsecretへ登録します。

鍵は32 byteの乱数をBase64へ変換した値です。
Git管理外の安全なdirectoryで鍵ファイルを作り、権限を600にしてください。

```console
umask 077
openssl rand 32 | openssl base64 -A > path/to/diagnostics-key.b64
chmod 600 path/to/diagnostics-key.b64
gh secret set VOICEVOX_TASK_TRACKER_DIAGNOSTICS_AES256_KEY_V1_B64 --repo VOICEVOX/voicevox_task_tracker < path/to/diagnostics-key.b64
```

鍵ファイルは暗号化済み診断artifactの復号に必要です。
紛失すると既存artifactを復号できないため、GitHubとは別の安全な場所へ保管します。

`CODEX_AUTH_JSON`はローカルでCodexへログインすると生成される`auth.json`をそのまま登録します。

```console
gh secret set CODEX_AUTH_JSON --repo VOICEVOX/voicevox_task_tracker < "${CODEX_HOME:-$HOME/.codex}/auth.json"
```

`CODEX_AUTH_SYNC_TOKEN`にはfine-grained personal access tokenを登録します。
次の設定で作成します。

1. GitHubのユーザー設定からDeveloper settings、Personal access tokens、Fine-grained tokensを順に開きます。
2. Resource ownerで対象repositoryの所有者を選びます。
3. Repository accessをOnly select repositoriesにし、`VOICEVOX/voicevox_task_tracker`だけを選びます。
4. Repository permissionsは`Secrets`の`Read and write`だけを与えます。
5. Organizationのrepositoryを対象にする場合はOrganizationへ承認を申請し、承認後に使用します。

作成したtokenをsecretへ登録します。
実行するとtokenの入力を求められます。

```console
gh secret set CODEX_AUTH_SYNC_TOKEN --repo VOICEVOX/voicevox_task_tracker
```

現行の`config.yml`は`ai.authentication: auth-json`を指定します。
`analyze` jobは`CODEX_AUTH_JSON`が空なら認証ファイルの配置を省き、非空なら`${{ runner.temp }}/codex-home/auth.json`へ権限600で書き出します。
配置時のsha256は指紋として`${{ runner.temp }}/codex-auth-fingerprint`へ保存します。
`codex-home`を`CODEX_HOME`として収集stepへ渡します。
Codexへ渡す認証用の環境変数は`CODEX_HOME`だけです。
Codex CLIはaccess tokenの残り有効期間が5分未満になるとrefresh tokenでtokenを更新し、`auth.json`を書き換えます。
このときrefresh token自体も新しい値へ入れ替わるため、更新後の`auth.json`を保存しないといずれ認証エラーになります。
`auth-json`で実行候補が1件以上あるrunでは、候補processより先に固定した短文による認証preflightを空の一時directoryで1論理call実行します。候補データと通常のsystem promptは渡さず、preflightの完了後に設定済みの並列度で候補を処理します。候補なし、cache hitだけ、全候補が予算延期のrunでは実行しません。
`api-key`ではpreflightを実行しません。このpreflightは必要時のtoken更新機会を先に設ける緩和策であり、refreshを強制しません。preflight後に各並列processが更新条件へ入れば、認証競合は残ります。
preflightに失敗したrunは候補を1件も開始せず、`generic_ai_executed`を失敗させます。
認証secretへの書き戻しは本番の`analyze`だけが行います。
配置後のmaskまで完了していれば、書き戻しstepを先行stepの成否を問わず実行します。
本番の実行stepへは`CODEX_AUTH_SYNC_TOKEN`の有無を示す真偽値だけを渡します。`auth-json`で実行候補がある場合、この値が偽ならCodexの起動前に失敗します。
tokenの値は本番の書き戻しstepだけへ`GH_TOKEN`として渡します。
書き戻しstepは更新後の値をmaskしてから、配置時のsha256と現在の`auth.json`を比較します。
変更があってtokenが空なら、secretの更新前に失敗します。
変更がなければsecretを更新せず、変更があれば`gh secret set`で`CODEX_AUTH_JSON`を更新します。
この同期が成功する限り、手動の再ログインとsecretの再登録なしにtokenの期限が延長され続けます。
`analyze`は認証ファイルの配置直後に`.github/scripts/mask-codex-auth-values.sh`を実行します。本番の書き戻し直前にも実行します。
このscriptは`auth.json`内のすべての文字列値を`jq`で取り出し、改行を含む値を行へ分け、16文字以上の各行を`::add-mask::`へ登録します。
値に含まれる`%`はworkflow commandへ渡す前に`%25`へescapeします。
GitHub Actionsの自動マスクはrun開始時に読み込んだsecret値と完全一致する文字列だけを隠します。
`auth.json`内の個々のtokenは`CODEX_AUTH_JSON`の部分文字列であり、自動では隠れません。
Codexが更新した`auth.json`もjob開始時のsecretとは異なるため、書き戻し前に更新後の値を登録します。
jobの最後に`codex-home`と指紋ファイルを削除します。
Codex認証情報と`CODEX_AUTH_SYNC_TOKEN`を`config.yml`、branch、artifact、run logへ書きません。

同じrepositoryの`analyze` jobは、共通の排他groupで認証の使用を直列化します。書き戻しも本番で直列化します。
repository secretはworkflow runの受付時に読み込まれるため、待機中に別runが認証を更新しても、受付済みrunには反映されません。
手動実行は、同じ認証を使う前のrunが完了してから起動します。
この制約は日次workflowとsandbox workflowに共通です。
同期用の真偽値はtokenの登録有無だけを示し、有効期限やsecret更新権限は保証しません。
tokenの権限不足やjobの中断が起きた場合、stateの保存と認証secretの同期は原子的に完了しません。

repositoryのWorkflow permissionsは既定の読み取り専用にします。
read and writeへ変更する必要はありません。
全workflowはtop-levelの`permissions`を空にし、各jobで必要な権限だけを指定しています。
`CODEX_AUTH_SYNC_TOKEN`はjobの`permissions`とは独立した資格情報です。
同期のために既定のread-only設定や`analyze`の`contents: read`を変更しません。
`commit-initial-state`、Pages結果のrecord、`settle-notifications`、`finalize-run`はstateへpushするため`contents: write`を指定します。`_tracking-observe.yml`の運用通知は専用の`tracker-operations-alerts`へ保存します。
これらのjobにはGitHub Actionsが`GITHUB_TOKEN`を自動発行するため、独自の`GITHUB_TOKEN` secretは登録しません。

`src/persistence/git-state-branch-adapter.ts`はremote refの現在値を読み、`hash-object`と`commit-tree`でcommitを作って非force pushします。運用障害通知の専用refは初回通知時に作成し、以後は同じrefの直前commitを親にします。
`tracker-state`と`tracker-operations-alerts`へrulesetを設定する場合は、GitHub Actionsによる更新を許可し、人間の通常作業branchとして使わないでください。

日次workflowの`daily.yml`とsandbox workflowは、共通の`_tracking-run.yml`を呼び出します。
`_tracking-run.yml`はquality、bootstrap、固定runtimeの準備、analyze、初回commit、初回Pages、通知settlement、finalization、通知履歴Pages、complete、observeを接続します。
Pagesは`_tracking-pages.yml`、全jobの報告と運用通知は`_tracking-observe.yml`を使います。

手動のproduction直列実行には`run_sequential.yml`を使います。
親の`run-sequential` CLIは初回state commitから通知履歴Pagesまで一つのprocessで進み、Pages公開時だけ`sequential_pages_effect.yml`を起動して実結果を待ちます。
子workflowは固定sourceとstate revision、公開intentを再検証し、Pagesの構成、artifact upload、deployと結果の観測だけを行います。
親が実deployment IDとURLを検証してreceiptへ保存するまで、Discord通知へ進みません。
子workflowは親のproduction排他groupを取らず、専用groupと`tracker-pages-effect-lease` branchで同じ公開効果の重複を防ぎます。
親はreportとreceipt artifactの保存後にleaseを解放します。
leaseがactiveの間は日次実行、手動復旧、Discord送達解決、別のproduction直列実行を停止します。

analyzeが作る`validated-run.cpk`には公開可能なsnapshot、公開allowlist、通知候補、AI生成元、保存・公開計画を結合します。
snapshot本文は一度だけ保存し、公開計画はsnapshot digestを参照します。sidecarは`.cpk`全byteのdigestを保持します。
secret、API client、installation token、Codex認証、Webhookを含めません。
後段はcheckpointとsidecarを再検証し、初回commit後はexact state revisionから読み直します。

`workflow-cli-runtime` artifactには自己完結bundle、固定V1/V2 entrypointとruntime manifestを保存します。
manifestはcode revision、lockfile digest、Node・pnpmのtoolchain、全fileの相対path・byte数・digest、回復protocol、adapter identityを固定します。
再開時は元runのbundleを取得し、消失していたら同じsourceから再生成して記録値と完全一致する場合だけ使います。
再生成時のmanifest writerは、取得したexact sourceの配置から一意に選びます。
現行制御runtimeはbootstrapだけを読み、未完了payloadの検証とeffectはexact runtimeで行います。

各stageのreceiptとcheckpointは`tracking-stage-<stage>` artifactへ、公開failureは独立したfailure artifactへ保存します。
最後のobserveは全jobの結果と、失敗binding・operation-local certaintyを集約します。
reportとfailure artifactをsnapshotやPagesの入力として使いません。
詳細なstack、Codex process出力は一時JSONLへ分離し、本番とsandboxではそれぞれの鍵でAES-256-GCM暗号化したartifactだけを保存します。
平文は暗号化の成否にかかわらず削除し、暗号化鍵はsandbox入口の形式検査と各暗号化stepだけへ渡します。
詳細診断artifactの保持期間は本番で7日、sandboxで30日です。

### forkの試行用認証を登録する

`Hiroshiba/voicevox_task_tracker`のrepository variableへ`GH_APP_ID`を登録します。
repository secretsへ`GH_APP_PRIVATE_KEY`、`CODEX_AUTH_JSON`、`VOICEVOX_TASK_TRACKER_SANDBOX_DIAGNOSTICS_AES256_KEY_V1_B64`を登録します。
診断鍵は本番とは別の32 byteの乱数をBase64へ変換し、Git管理外の安全な場所へ権限600で保管します。

```console
gh secret set CODEX_AUTH_JSON --repo Hiroshiba/voicevox_task_tracker < "${CODEX_HOME:-$HOME/.codex}/auth.json"
umask 077
openssl rand 32 | openssl base64 -A > path/to/sandbox-diagnostics-key.b64
chmod 600 path/to/sandbox-diagnostics-key.b64
gh secret set VOICEVOX_TASK_TRACKER_SANDBOX_DIAGNOSTICS_AES256_KEY_V1_B64 --repo Hiroshiba/voicevox_task_tracker < path/to/sandbox-diagnostics-key.b64
```

sandboxは`CODEX_AUTH_SYNC_TOKEN`を受け取らず、Codex認証secretを書き戻しません。
診断鍵が未設定または形式不正なら、環境の準備とCodexの起動前に停止します。
Codexが`auth.json`を更新しても次のActions runへ引き継がれません。
自動起動されるcontinuityの2回目や後続scenarioは、古いrefresh tokenが無効になると認証エラーで停止し得ます。
認証エラーから復旧するときは、再ログインで得た`auth.json`をforkの`CODEX_AUTH_JSON` secretへ登録してから継続実行します。

## マージゲートの設定

`.github/workflows/merge_gatekeeper.yml`はauto mergeとmerge queueのためのチェッカーです。
[VOICEVOX/merge-gatekeeper](https://github.com/VOICEVOX/merge-gatekeeper)でApprove数の重み付き合計が足りているかを判定し、[upsidr/merge-gatekeeper](https://github.com/upsidr/merge-gatekeeper)で他の全CIの完了を待ちます。

他のworkflowと同じく、どちらのactionもfull commit SHAでpinします。
VOICEVOX/merge-gatekeeperはtagを持たないため、追跡先の`main`をversionの代わりにコメントへ書きます。
上流の修正はSHAを差し替えるPRで取り込みます。

このworkflowだけは`pull_request_target`をtriggerに使います。
auto mergeを有効にできるのはwrite権限を持つ人だけで、workflowはrepositoryをcheckoutせずrun stepも持たないため、PR側のcodeが実行されることはありません。

必要スコアは2で、`@Hiroshiba`のApproveに2点、`#reviewer` teamのApproveに1点を与えます。
Hiroshibaが1人でApproveすれば通り、reviewerだけなら2人のApproveが要ります。
Review when Readyを押した人もApproveとして数えます。

Approve数の判定にはVOICEVOX organizationで共有している`GATEKEEPER_TOKEN` secretを使います。
このsecretはteamの所属を引くためにorganizationのMember権限を要求するので、repository secretとして登録せず、organization secretの利用対象へこのrepositoryを含めます。
CIの完了待ちは自動発行の`GITHUB_TOKEN`だけで足り、jobには`checks: read`と`statuses: read`しか与えません。

workflowを追加しただけでは有効になりません。
repositoryのSettingsで次を設定します。

- GeneralのAllow auto-mergeをONにする
- Rulesetを作成し、Require status checks to passへ`merge_gatekeeper`を追加する
- 同じRulesetのRequire merge queueをONにする

必須チェック名はworkflow名ではなくjob名の`merge_gatekeeper`です。
job名を変えるとRulesetの必須チェックが永久に未完了のままになるため、変えないでください。

## Pagesの設定

repositoryをpublicにした後、SettingsのPagesでSourceを`GitHub Actions`にします。
branchをPages sourceへ指定しません。

`config.yml`の`web.basePath`を`/voicevox_task_tracker/`にし、公開URLを`https://voicevox.github.io/voicevox_task_tracker/`とします。
`_tracking-pages.yml`はinitialとnotification_historyのphaseを受け取り、同じbuild・preflight・action・record境界を使います。
`sequential_pages_effect.yml`も同じ固定SHAのPages actionとdeployment ID観測actionを使います。

buildは保存済みstateの固定revisionからDTOを投影し、Web出力全fileのmanifest、build receipt、deploy intentを保存します。
deploy直前にremote stateと出力全fileを照合します。
productionでpreflightがreadyの場合だけ、pinしたconfigure-pages、upload-pages-artifact、deploy-pages actionを実行します。
record jobはactionの結果、artifact ID・digest、adapter identityをexact runtimeへ渡し、検証済みreceiptを保存します。
初回Pagesの成功証拠はstateの固定pathにも保存し、通知開始の必須条件にします。

Pages deploy jobは`contents: read`、`actions: read`、`pages: write`、`id-token: write`を持ち、record jobはstate更新の`contents: write`を持ちます。
sandboxでは同じpreflightを通し、通常artifactへサイトを保存するrecording portで結果を記録します。本番Pagesへdeployしません。
通知履歴Pagesはrun finalization後のstateを使い、送信履歴が増えない場合は公開不要というreceiptを作ります。
この後段の失敗でfinalized stateを巻き戻したりDiscordを再送したりしません。

## config.yml

現行の`config.yml`には実運用値と全設定項目が入っています。
設定の完全な一覧は`config.yml`を直接確認します。
Zodのstrict schemaで未知のfieldも拒否するため、設定名を追加せず既存項目を変更します。

デプロイ前に必ず確認する項目は次のとおりです。

| 設定                                                                                           | 確認内容                                                           |
| ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `tracking.startAt`                                                                             | 追跡を開始する日時                                                 |
| `maintainers.defaults`と`maintainers.repositories`                                             | 既定値とrepository別上書きへ指定するメンテナのGitHubユーザー名一覧 |
| `attention.recencyFloor`と`attention.levels`                                                   | 要対応度の鮮度係数の下限とlevelの閾値                              |
| `attention.deadlinePoints`                                                                     | 期限の切迫度加点が設定順に増加し、overdueが30以下か                |
| `ai.authentication`と`ai.model`                                                                | Actionsへ登録した認証方式と利用可能なmodel ID                      |
| `notifications.discord.enabled`                                                                | 初回の日次workflowからDiscord通知を実行する設定になっているか      |
| `notifications.discord.webhookSecretName`と`notifications.discord.operationsWebhookSecretName` | Actionsへ登録した2つのsecret名と一致するか                         |
| `web.basePath`                                                                                 | GitHub Pagesのrepository pathと一致するか                          |

secretの値は`config.yml`へ書きません。
現行設定ではCodexとDiscord通知が有効で、mentionは無効です。
その他の閾値、追跡規則、通知上限、保存先は`config.yml`を正本として確認し、運用中の調整は[運用手順](OPERATIONS.md)に従います。

メンテナは次の形式で指定します。
`defaults`と`repositories`の各値は1件以上のGitHubユーザー名を持つ一覧です。
repository別の値は既定値を置き換えます。

```yaml
maintainers:
  defaults: [Hiroshiba]
  repositories:
    VOICEVOX/voicevox: [sevenc-nanashi]
    VOICEVOX/voicevox_core: [qryxip, Hiroshiba]
```

### importance

`importance`は項目そのものの重要度を決める設定です。
重要度の計算は`staleness`から独立し、計算結果を要対応度の基礎に使います。

| 設定                                                                         | 意味                                                                        |
| ---------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `importance.weights.priorityLabelMultiplier`                                 | `labels.rules`で解決した`priorityWeight`へ掛ける倍率                        |
| `importance.weights.blockedItem`、`blockedRepository`、`downstreamImpactMax` | 止めているopen項目数とリポジトリ数の重み、downstream impactによる加点の上限 |
| `importance.weights.significantFeature`、`futureRisk`                        | Codexが判定する重要な機能と将来問題の重み                                   |
| `importance.levels.medium`、`high`                                           | mediumとhighのscore下限。medium未満はlowとし、highはmedium以上にする        |

各重みは0以上にします。
scoreは各要因の加点を0から100の整数へ収めた値です。

### attention

`attention`は重要度、期限の切迫度、停滞の鮮度から要対応度を決める設定です。
項目のwait classに対応する`staleness.thresholdsHours`の`watch`を鮮度係数の半減期として使います。

| 設定                       | 意味                                                                                               |
| -------------------------- | -------------------------------------------------------------------------------------------------- |
| `attention.recencyFloor`   | 鮮度係数の下限。0以上1以下とし、既定値は0.4                                                        |
| `attention.levels.medium`  | mediumのscore下限。既定値は20                                                                      |
| `attention.levels.high`    | highのscore下限。既定値は40とし、medium以上にする                                                  |
| `attention.deadlinePoints` | 期限の切迫度ごとの加点。noneは0に固定し、期限が近い順に増加させ、overdueを30以下の安全な整数にする |

鮮度係数は`recencyFloor + (1 - recencyFloor) × 0.5 ^ (停滞時間 ÷ watch閾値)`で求めます。
`importanceCapacity = 100 - deadlinePoints.overdue`として、`recencyScore = round(importanceScore × recencyCoefficient × importanceCapacity / 100)`を求め、期限の切迫度加点を足して要対応度scoreを0から100の整数にします。
terminal項目とブロック解消待ちの項目は要対応度scoreが0になります。

## デプロイ前後の確認

マージ前は[開発手順](DEVELOPMENT.md)の静的確認を実行します。
CIはPRとmainへのpushでformat、incremental typecheck、cached lint、source-lines、CLI・workflow CLI・Webの3 buildを検査します。
ESLint cacheはlint対象sourceと型設定、依存lockfileの内容から計算したkeyが完全一致するときだけ復元します。
verify-state jobはtracker-stateの全履歴と固定SHAを取得し、現行ingress、marker・record・初回Pages証拠と実commit chainを検証します。
未完了runがある場合はcurrent runtimeの検証を停止し、exact runtimeでの復旧を先に行います。

外部確認はforkのsandboxで行います。
同じenvironmentの連続2 run、更新前後のruntime再現、通知actionと明確な拒否・曖昧な結果・手動解決を、run IDとstate revision・receipt・coverage artifactで確認します。
静的検査の成功だけを外部確認の成功として報告しません。
外部確認の条件と実行入力は[運用手順](OPERATIONS.md)にまとめています。

本番の公開確認はdefault branchの「日次タスク追跡」を手動起動します。
`backfill: none`、空のrepository filterを使い、確認中の通知を保持するときは`notification_action: hold`を選びます。
設定の`VOICEVOX_TASK_TRACKER_SCHEDULE_PAUSED`を文字列`true`にすると定期実行だけを止められます。開始済みrunの完了を待ってから手動実行します。

成功時は次の証拠を同じrunで照合します。

- 初回commitにsnapshot、履歴、AI cache、通知ledger、durable record、markerがまとまっている
- 初回Pagesのmanifest・公開receipt・固定証拠が同じcheckpointとstate revisionを指している
- 通知が初回Pages成功後にだけ始まり、messageごとの保存後に次の送信へ進んでいる
- finalization receiptとmarkerの`run_finalized`が一致し、その後の通知履歴Pagesが成功または公開不要になっている
- 認証ファイルを配置した場合は書き戻しと一時ファイル削除が成功している
- state・公開DTO・failure artifactに非公開repository参照やsecretが含まれていない

`hold`は候補をpendingへ保存し、`acknowledge-current`は現在条件を満たす候補を上限なしで確認済みにします。
両方とも通常のDiscord送信と送信履歴を作りません。
すでにsentの同じkeyの送信日時とmessage IDを維持し、同じnotification keyの再送を抑えます。
`tracking.startAt`が未指定なら、初回Pagesと通知の確定後のfinalizationで追跡開始時刻を固定します。
mentionが必要な場合だけ`mentions.users`へ登録し、未登録userと`@everyone`はmentionしません。
