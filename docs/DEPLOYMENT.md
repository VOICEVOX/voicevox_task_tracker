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

repositoryのSettingsからActions variableとActions secretを登録します。

| 名前                             | 種別     | 値                                                  |
| -------------------------------- | -------- | --------------------------------------------------- |
| `GH_APP_ID`                      | Variable | GitHub Appの数値ID                                  |
| `GH_APP_PRIVATE_KEY`             | Secret   | GitHub Appから発行したPEM private key               |
| `CODEX_AUTH_JSON`                | Secret   | Codexの`auth.json`の中身                            |
| `CODEX_AUTH_SYNC_TOKEN`          | Secret   | Codex認証同期用のfine-grained personal access token |
| `DISCORD_WEBHOOK_URL`            | Secret   | 通常digest用のIncoming Webhook URL                  |
| `DISCORD_OPERATIONS_WEBHOOK_URL` | Secret   | 運用障害通知用のIncoming Webhook URL                |

PEM private keyは改行を保持したままsecretへ登録します。

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
`collect-analyze` jobは`CODEX_AUTH_JSON`を`${{ runner.temp }}/codex-home/auth.json`へ権限600で書き出します。
配置時のsha256は指紋として`${{ runner.temp }}/codex-auth-fingerprint`へ保存します。
`codex-home`を`CODEX_HOME`として収集stepへ渡します。
Codexへ渡す認証用の環境変数は`CODEX_HOME`だけです。
Codex CLIはaccess tokenの残り有効期間が5分未満になるとrefresh tokenでtokenを更新し、`auth.json`を書き換えます。
このときrefresh token自体も新しい値へ入れ替わるため、更新後の`auth.json`を保存しないといずれ認証エラーになります。
認証ファイルの配置に成功していれば、書き戻しstepは先行stepの成否を問わず実行します。
`CODEX_AUTH_SYNC_TOKEN`はこのstepだけへ`GH_TOKEN`として渡し、空なら明示的に失敗します。
書き戻しstepは配置時のsha256と現在の`auth.json`を比較します。
変更がなければsecretを更新せず、変更があれば`gh secret set`で`CODEX_AUTH_JSON`を更新します。
この同期が成功する限り、手動の再ログインとsecretの再登録なしにtokenの期限が延長され続けます。
`collect-analyze`は認証ファイルの配置直後とsecretへ書き戻す直前に`.github/scripts/mask-codex-auth-values.sh`を実行します。
このscriptは`auth.json`内のすべての文字列値を`jq`で取り出し、改行を含む値を行へ分け、16文字以上の各行を`::add-mask::`へ登録します。
値に含まれる`%`はworkflow commandへ渡す前に`%25`へescapeします。
GitHub Actionsの自動マスクはrun開始時に読み込んだsecret値と完全一致する文字列だけを隠します。
`auth.json`内の個々のtokenは`CODEX_AUTH_JSON`の部分文字列であり、自動では隠れません。
Codexが更新した`auth.json`もjob開始時のsecretとは異なるため、書き戻し前に更新後の値を登録します。
書き戻し後はjobの最後に`codex-home`と指紋ファイルを削除します。
Codex認証情報と`CODEX_AUTH_SYNC_TOKEN`を`config.yml`、branch、artifact、run logへ書きません。

repositoryのWorkflow permissionsは既定の読み取り専用にします。
read and writeへ変更する必要はありません。
全workflowはtop-levelの`permissions`を空にし、各jobで必要な権限だけを指定しています。
`CODEX_AUTH_SYNC_TOKEN`はjobの`permissions`とは独立した資格情報です。
同期のために既定のread-only設定や`collect-analyze`の`contents: read`を変更しません。
`persist-state`、`notify-discord`、`notify-operations`は`tracker-state`へpushするため、それぞれ`contents: write`を指定します。
これらのjobにはGitHub Actionsが`GITHUB_TOKEN`を自動発行するため、独自の`GITHUB_TOKEN` secretは登録しません。

CLIはremote repositoryへpushしません。
`src/persistence/git-state-branch-adapter.ts`が`hash-object`、`commit-tree`、`update-ref`などを使い、localの`refs/heads/tracker-state`へcommitを作ります。
workflowはCLIの実行前にremoteの`tracker-state`をlocal refへfetchし、CLIの実行後に明示的な`git push`でremoteへ反映します。
`tracker-state`へrulesetを設定する場合はGitHub Actionsによるstate更新を許可し、人間の通常作業branchとして使わないでください。

`collect-analyze`は`artifacts/workflow/validated-run.json`へ検証済みsnapshot、通知候補、通知管理記録、run report生成用の収集指標、AI cache、Pages URL、Discord送信設定だけを書きます。
GitHub App key、installation token、Codex認証情報、`CODEX_AUTH_SYNC_TOKEN`、Discord webhookはartifactへ含めません。
artifactを利用する後続jobは同じartifactを再検証してから利用します。
依存関係を再インストールせず`notify-discord`でCLIを動かすため、公開sourceから作った自己完結bundleも同じActions artifactへ保存します。
収集時のCLI reportは収集jobの成否にかかわらず、run IDと試行番号を含む別のActions artifactへ保存します。
最後の`report-workflow`は全jobの結果と必須metricを`artifacts/run-reports/workflow.json`へまとめ、別のActions artifactへ保存します。
これらのreport artifactはstateとPagesの入力にしません。

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

現行構成では`config.yml`の`web.basePath`を`/voicevox_task_tracker/`にし、公開URLを`https://voicevox.github.io/voicevox_task_tracker/`とします。
workflowの`deploy-pages` jobはrepositoryをcheckoutせず、`build-pages`が保存したPages artifactを`github-pages` environmentへdeployするだけです。
このため`pages: write`と`id-token: write`だけを使用します。

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

## デプロイ確認

### 1. ローカルdry-run

`.node-version`に記載されたNode.jsをversion managerで有効にします。
Node.jsのversionを確認した後にCorepackを有効にし、`package.json`で固定されたpnpmを使います。

```console
node --version
corepack enable
pnpm --version
```

`maintainers`のGitHubユーザー名一覧とrepository別上書きが意図した内容であることを確認します。
GitHub Appの`GH_APP_ID`と`GH_APP_PRIVATE_KEY`を安全な方法でshellへ渡します。
Codexは`auth.json`を直下に持つdirectoryを`CODEX_HOME`へ指定します。

```console
export CODEX_HOME="${CODEX_HOME:-$HOME/.codex}"
ls "$CODEX_HOME/auth.json"
```

`auth.json`が無ければ`codex login`でログインしてから再度確認します。

`dry-run`はDiscord webhookを読み取らず、state、Pages、Discordを変更しません。

依存関係を検証してCLIをビルドします。

```console
pnpm install --frozen-lockfile
pnpm typecheck
pnpm lint
pnpm format:check
pnpm build
```

現在の`config.yml`を変更せずに`dry-run`を実行します。

```console
node --input-type=module --eval '
const { createDefaultCliApplication } = await import("./dist/index.js");
const result = await createDefaultCliApplication().run([
  "dry-run",
  "--config",
  "config.yml",
  "--artifact",
  "artifacts/dry-run.json",
  "--report",
  "artifacts/run-reports/dry-run.json",
]);
process.exitCode = result.exitCode;
'
```

`artifacts/run-reports/dry-run.json`の`status`、`complete`、`diagnostics`、各metricを確認します。
`artifacts/dry-run.json`には検証済みsnapshotと通知候補が入るため、repository範囲、待ち相手を表す`waitingOn`、関係、通知量を確認します。

### 2. Codexのdry-run

lockfileで固定したCodex CLI `0.145.0`を確認します。

```console
pnpm exec codex --version
```

現行の`config.yml`は`ai.enabled: true`と`ai.authentication: auth-json`を設定済みです。
`CODEX_HOME`直下の`auth.json`を使って同じ`dry-run`を実行し、`ai.model`に設定されたmodel IDでCodex呼び出しが成功することを確認します。
ローカルで`api-key`を使う場合は、`ai.authentication`を`api-key`にして`OPENAI_API_KEY`を渡します。
どちらの方式でも、選択しなかった方式の環境変数はCodexへ渡りません。

`metrics.aiCallCount`が1以上で`status`が`success`となり、`diagnostics`にmodelの利用不可を示す内容がなければ、設定済みmodel IDを利用できています。
`metrics.aiCallCount`が0ならmodelを呼び出していないため、利用可否を確認できていません。
その場合は設定済みmodel IDを`--model`へ指定した最小の`pnpm exec codex exec`を同じ認証情報で実行します。

`metrics.aiCacheHitCount`、`metrics.estimatedInputTokens`、`diagnostics`も確認します。
`pnpm eval:golden`はfixture内の固定AI出力をschema検証、semantic検証、reducer、状態判定、graph、通知選別へ通し、期待結果と比較します。
標準fixtureは`fixedAi.networkCallCount: 0`を要求するため、実モデル、reasoning effort、promptの応答品質を評価しません。
schema、semantic validation、reducer、状態、graph、通知判定を変更した場合はgolden evalも実行します。
model、reasoning effort、promptを変更した場合は、実モデルを呼び出したdry-runで`metrics.aiCallCount`が1以上になることを確認し、AI判定と通知候補の差分を確認します。
Actionsの`collect-analyze` jobはlockfileから同じCodex CLIをインストールし、収集前にversion確認を行います。

### 3. 日次workflow

通常digest用と運用障害通知用のIncoming Webhookを作成し、Actionsの`DISCORD_WEBHOOK_URL`と`DISCORD_OPERATIONS_WEBHOOK_URL`へ登録します。
PagesのSourceを`GitHub Actions`にし、`notifications.discord.enabled: true`であることを確認してから、repositoryのdefault branchから日次workflowを手動実行します。
workflowはdefault branchからのscheduleまたは手動実行だけを許可します。
入力は`backfill: none`とし、repository filterは空にします。
手動実行の`notification_action`は`send`が既定値で、通常の通知を送ります。現在の通知候補を一掃したい場合だけ`dismiss-current`を選びます。
手動実行でも`persist-state`、Pages buildとdeploy、`notify-discord`の順に進みます。

`dismiss-current`では、現在の通知条件を満たす候補をreasonごとに最大件数の制限なく通知管理記録へ手動抑制済みとして保存します。通常のDiscord digestと`notification_sent`履歴は作られません。snapshotとPagesは通常runと同じように生成し、通知管理記録の更新は同じatomic transactionで保存します。手動入力は現在の候補を一括で抑制する操作なので、対象範囲を確認してから実行してください。運用障害が起きた場合の`notify-operations`は別系統で通知します。

workflow artifactは`notificationAction`を保持します。`persist-state`はsnapshotと手動抑制済みの通知管理記録を同じatomic transactionで保存します。`notify-discord`はartifactと`tracker-state`のsnapshot run IDを照合し、不一致なら通常通知もrun完了処理も行いません。state branchや通知管理記録を直接編集してはいけません。

成功後に次を確認します。

- `collect-analyze`の「更新されたCodex認証ファイルをsecretへ書き戻す」stepが成功していること
- `tracker-state`がdefault branchと別の履歴を持つこと
- `persist-state`のcommitにsnapshot、当日履歴、新しいAI cache、通知管理記録がまとまっていること
- 後続の通知jobが実測時刻と実送信数を含むrun report、通知管理記録、当日の日次履歴のcommitを追加していること
- Pagesの生成時刻がrun reportの`startedAt`と一致し、repository数、item数、stale表示も一致すること
- private repositoryのID、名前、URL、secret、不要な本文がstateとPagesにないこと
- 通常digestがPages deploy後にだけ送信され、候補0件なら送信されないこと
- 同じ候補を含む再実行では送信されず、送信済みの通知管理記録項目が維持されること
- `notification_action: dismiss-current`では通常のDiscord送信と`notification_sent`履歴がなく、対象候補の通知管理記録項目が`status: dismissed`になっていること
- `dismiss-current`の抑制は同じnotification keyへ期限なく適用され、`status`、停滞レベルを表す`severity`、待ち相手を表す`waitingOn`、各種開始時刻などが変わった候補は次回の`send`で通知対象になること

`tracking.startAt: null`なら、最初の完全成功runの時刻がsnapshotへ固定されます。
収集、Pages、Discordのいずれかで運用対象の失敗が起きたrunでは、`notify-operations`が障害通知を1件送ります。
GitHub Actionsのscheduleは遅延し得るため、00:00、04:00、08:00、12:00、16:00、20:00 JSTは起動予定時刻として扱います。

mentionが必要になった場合だけ、GitHubユーザー名と17桁から20桁のDiscord user IDを`mentions.users`へ登録します。
登録されていないuserと`@everyone`はmentionされません。
