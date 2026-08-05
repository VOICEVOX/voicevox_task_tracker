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

| Permission | Access    | 用途                                    |
| ---------- | --------- | --------------------------------------- |
| Members    | Read-only | 設定したteam slugの存在確認とmember解決 |

`Contents`、`Actions`、`Administration`、`Projects`など、表にない権限は`No access`のままにします。
installation IDは実行時にOrganizationから自動発見します。
ローカル実行では任意の環境変数`GH_APP_INSTALLATION_ID`でinstallation IDを上書きでき、指定した場合は自動発見を省略します。
workflowでは`GH_APP_INSTALLATION_ID`を設定しません。

## Actionsの設定

repositoryのSettingsからActions variableとActions secretを登録します。

| 名前                             | 種別     | 値                                    |
| -------------------------------- | -------- | ------------------------------------- |
| `GH_APP_ID`                      | Variable | GitHub Appの数値ID                    |
| `GH_APP_PRIVATE_KEY`             | Secret   | GitHub Appから発行したPEM private key |
| `CODEX_AUTH_JSON`                | Secret   | Codexの`auth.json`の中身              |
| `DISCORD_WEBHOOK_URL`            | Secret   | 通常digest用のIncoming Webhook URL    |
| `DISCORD_OPERATIONS_WEBHOOK_URL` | Secret   | 運用障害通知用のIncoming Webhook URL  |

PEM private keyは改行を保持したままsecretへ登録します。

`CODEX_AUTH_JSON`はローカルでCodexへログインすると生成される`auth.json`をそのまま登録します。

```console
gh secret set CODEX_AUTH_JSON --repo VOICEVOX/voicevox_task_tracker < "${CODEX_HOME:-$HOME/.codex}/auth.json"
```

現行の`config.yml`は`ai.authentication: auth-json`を指定します。
`collect-analyze` jobは`CODEX_AUTH_JSON`を`${{ runner.temp }}/codex-home/auth.json`へ権限600で書き出し、このdirectoryを`CODEX_HOME`として収集stepへ渡します。
Codexへ渡す認証用の環境変数は`CODEX_HOME`だけです。
配置した`auth.json`はjobの成否を問わず終了時に削除します。

Codex CLIは実行のたびに`auth.json`のtokenを更新しますが、Actions上の更新はrunnerの破棄とともに失われます。
Codex呼び出しが認証エラーで失敗するようになったら、ローカルのCodexへログインし直してから同じコマンドでsecretを登録し直します。
認証情報を`config.yml`、branch、artifact、run logへ書きません。

repositoryのWorkflow permissionsは既定の読み取り専用にします。
read and writeへ変更する必要はありません。
全workflowはtop-levelの`permissions`を空にし、各jobで必要な権限だけを指定しています。
`persist-state`、`notify-discord`、`notify-operations`は`tracker-state`へpushするため、それぞれ`contents: write`を指定します。
これらのjobにはGitHub Actionsが`GITHUB_TOKEN`を自動発行するため、独自の`GITHUB_TOKEN` secretは登録しません。

CLIはremote repositoryへpushしません。
`src/persistence/git-state-branch-adapter.ts`が`hash-object`、`commit-tree`、`update-ref`などを使い、localの`refs/heads/tracker-state`へcommitを作ります。
workflowはCLIの実行前にremoteの`tracker-state`をlocal refへfetchし、CLIの実行後に明示的な`git push`でremoteへ反映します。
`tracker-state`へrulesetを設定する場合はGitHub Actionsによるstate更新を許可し、人間の通常作業branchとして使わないでください。

`collect-analyze`は`artifacts/workflow/validated-run.json`へ検証済みsnapshot、通知候補、notification ledger、run report生成用の収集指標、AI cache、Pages URL、Discord送信設定だけを書きます。
GitHub App key、installation token、Codex認証情報、Discord webhookはartifactへ含めません。
artifactを利用する後続jobは同じartifactを再検証してから利用します。
依存関係を再インストールせず`notify-discord`でCLIを動かすため、公開sourceから作った自己完結bundleも同じActions artifactへ保存します。
収集時のCLI reportは収集jobの成否にかかわらず、run IDと試行番号を含む別のActions artifactへ保存します。
最後の`report-workflow`は全jobの結果と必須metricを`artifacts/run-reports/workflow.json`へまとめ、別のActions artifactへ保存します。
これらのreport artifactはstateとPagesの入力にしません。

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

| 設定                                                                                           | 確認内容                                                      |
| ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| `tracking.startAt`                                                                             | 追跡を開始する日時                                            |
| `teams.defaults`と`teams.repositories`                                                         | Organizationに実在するmaintainerとreviewerのteam slug         |
| `ai.authentication`と`ai.model`                                                                | Actionsへ登録した認証方式と利用可能なmodel ID                 |
| `notifications.discord.enabled`                                                                | 初回の日次workflowからDiscord通知を実行する設定になっているか |
| `notifications.discord.webhookSecretName`と`notifications.discord.operationsWebhookSecretName` | Actionsへ登録した2つのsecret名と一致するか                    |
| `web.basePath`                                                                                 | GitHub Pagesのrepository pathと一致するか                     |

secretの値は`config.yml`へ書きません。
現行設定ではCodexとDiscord通知が有効で、mentionは無効です。
その他の閾値、追跡規則、通知上限、保存先は`config.yml`を正本として確認し、運用中の調整は[運用手順](OPERATIONS.md)に従います。

### importance

`importance`は項目そのものの重要度を決める設定です。
停滞の深刻さを決める`staleness`とは独立しています。

| 設定                                                                         | 意味                                                                        |
| ---------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `importance.weights.priorityLabelMultiplier`                                 | `labels.rules`で解決した`priorityWeight`へ掛ける倍率                        |
| `importance.weights.blockedItem`、`blockedRepository`、`downstreamImpactMax` | 止めているopen項目数とリポジトリ数の重み、downstream impactによる加点の上限 |
| `importance.weights.milestoneWithDueDate`、`milestoneDueSoon`                | 期限付きのopen milestoneと期限間近の場合の追加点                            |
| `importance.weights.significantFeature`、`explicitDeadline`、`futureRisk`    | Codexが判定する重要な機能、明示された期限、将来問題の重み                   |
| `importance.dueSoonDays`                                                     | milestoneを期限間近として追加加点する残り日数                               |
| `importance.levels.medium`、`high`                                           | mediumとhighのscore下限。medium未満はlowとし、highはmedium以上にする        |

各重みと日数は0以上にします。
scoreは各要因の加点を0から100の整数へ収めた値です。

## デプロイ確認

### 1. ローカルdry-run

`.node-version`に記載されたNode.jsをversion managerで有効にします。
Node.jsのversionを確認した後にCorepackを有効にし、`package.json`で固定されたpnpmを使います。

```console
node --version
corepack enable
pnpm --version
```

設定済みのteam slugがOrganizationに存在することを確認します。
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
pnpm test
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
`artifacts/dry-run.json`には検証済みsnapshotと通知候補が入るため、repository範囲、waitingOn、関係、通知量を確認します。

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
手動実行でも`persist-state`、Pages buildとdeploy、`notify-discord`の順に進みます。

成功後に次を確認します。

- `tracker-state`がdefault branchと別の履歴を持つこと
- `persist-state`のcommitにsnapshot、当日履歴、新しいAI cache、通知ledgerがまとまっていること
- 後続の通知jobが実測時刻と実送信数を含むrun reportと通知ledgerのcommitを追加していること
- Pagesの生成時刻がrun reportの`startedAt`と一致し、repository数、item数、stale表示も一致すること
- private repositoryのID、名前、URL、secret、不要な本文がstateとPagesにないこと
- 通常digestがPages deploy後にだけ送信され、候補0件なら送信されないこと
- 同じ候補を含む再実行でcooldownが効くこと

`tracking.startAt: null`なら、最初の完全成功runの時刻がsnapshotへ固定されます。
収集、Pages、Discordのいずれかで運用対象の失敗が起きたrunでは、`notify-operations`が障害通知を1件送ります。
GitHub Actionsのscheduleは遅延し得るため、08:00 JSTは起動予定時刻として扱います。

mentionが必要になった場合だけ、GitHub loginと17桁から20桁のDiscord user IDを`mentions.users`へ登録します。
登録されていないuserと`@everyone`はmentionされません。
