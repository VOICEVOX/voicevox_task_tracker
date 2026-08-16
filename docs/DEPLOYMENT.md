# デプロイ手順

この文書は、GitHubの現在値と全timeline・編集履歴を再生する日次runをGitHub Actions、Pages、Discordで運用するための設定を定めます。
日次runの正しさは前回runの判定結果に依存しません。`tracker-state-v4` branchは4種類のcacheだけを保持します。

## GitHub App

GitHub Appは対象Organizationへread-onlyでinstallします。Issue、Pull Request、comment、review、timeline、repository metadata、check、dependency、sub-issueを読むためのrepository read権限だけを付与し、IssueやPRへのwrite権限は付与しません。
OrganizationのMembers権限は付与しません。team member一覧を取得せず、`config.yml`のmaintainersとGitHubが返すteam識別子だけを使います。

repository metadataは最初に全ページ取得します。public、non-archived、non-disabledだけを当runのallowlistへ入れ、allowlist外の詳細を取得しません。
allowlistはcache保存前、Pages生成前、Discord送信前にも再検証します。private、internal、archived、disabled、allowlist外の値が一件でもあればcache、Pages、通常Discordを停止します。

GitHubがrepository取得を503で返した場合、検証済みcacheがあるときだけstaleとして継続します。stale repositoryの項目は明示し、影響する通常通知から除外します。cacheがなければrunを失敗させます。

## Actionsの設定

default branchのscheduleと権限管理された`workflow_dispatch`だけがsecretを使うrunを起動できます。Pull Request由来のuntrusted codeへGitHub App key、Codex認証、Discord webhookを渡しません。
Actionsは必要なjobだけに次のsecretを渡します。

| Secret                           | 用途                                              |
| -------------------------------- | ------------------------------------------------- |
| `GH_APP_ID`                      | GitHub Appの識別子                                |
| `GH_APP_PRIVATE_KEY`             | GitHub Appの短寿命token発行                       |
| `GH_APP_INSTALLATION_ID`         | installation IDの明示指定。通常は自動発見         |
| `CODEX_AUTH_JSON`                | Codex auth-json方式の認証情報                     |
| `CODEX_AUTH_SYNC_TOKEN`          | 本repositoryのsecret更新が必要な同期jobだけで使用 |
| `DISCORD_WEBHOOK_URL`            | 通常digestの送信                                  |
| `DISCORD_OPERATIONS_WEBHOOK_URL` | 運用障害通知の送信                                |

Codexの認証ファイルはrunnerの一時directoryへ権限600で置き、処理後は成功・失敗を問わず削除します。
secretはCodex subprocessへ渡さず、Actions log、artifact、job summaryにもraw token、authorization header、App key、webhook URL、raw API responseを出しません。
認証ファイル内の文字列は配置直後とsecretへ戻す直前にmaskし、同期tokenはsecret書き戻しstepだけへ渡します。

## cache branch

state設定は`branch`、`repositoryCacheDirectory`、`itemCacheDirectory`、`latestImportanceDirectory`、`aiCacheDirectory`、`canonicalJson`だけです。
既定値は次のとおりです。

```yaml
state:
  branch: tracker-state-v4
  repositoryCacheDirectory: state/github-repositories
  itemCacheDirectory: state/github-items
  latestImportanceDirectory: state/ai-latest-importance
  aiCacheDirectory: state/ai-results
  canonicalJson: true
```

各directoryはstate配下の正規化相対pathで、互いに同一でも入れ子でもないことを検証します。
branchには次のcache以外を置きません。

- repository metadataとallowlist検証に使うGitHub repository cache
- Issue、Pull Request、timeline、編集履歴のGitHub item cache
- nodeごとの直近検証済みimportance cache
- normalized input hashで引けるCodex result cache

snapshot、日次履歴、notification ledger、state branchのrun reportは作成しません。
終了項目は`terminalAt`から180日までcacheに保持してよく、期限後は削除します。cacheを削除してもopen項目の現在値と全イベントから重要な判定を再構築できます。

## runの論理stage

1. `config.yml`を検証し、workflowから基準通知時刻`S`を受け取る。日次scheduleの`S`は08:00 JSTに対応する固定値で、job開始時刻ではない。
2. repository metadataを全ページ取得し、public・non-archived・non-disabled allowlistを確定する。
3. allowlist内のopen itemと必要なrelation端点を列挙する。
4. cache hitをschema検証する。missは現在値と全timeline、comment、review、edit historyを全ページ取得する。
5. 発生時刻、item node ID、item内sequence、source IDでイベントを安定ソートし、state、draft、責務、relation、cycle、newly unblockedを再生する。
6. current item/detailを正として復元結果と照合する。不整合、同じsource IDの異なる内容、取得不能な必須ページは推測で補わずrunを止める。actorやrelation targetだけが不明な場合は影響範囲をunknownにする。
7. 現在入力に完全一致するAI cacheを使い、missだけCodexへ渡す。current relationに必要なAI結果が欠けた場合はPagesと通常Discordを止める。
8. 最終graph、importance、attention、severity、通知候補を確定し、allowlistを再検証する。
9. Pages DTOとDiscord payloadをartifactへ出す。Pagesをdeployし、各schedule runの`github.run_attempt == 1`だけ、一回限りの変化と停滞の繰り返しを含む通常digestを送る。`workflow_dispatch`とrerunは通常digestを送らない。
10. PagesとDiscordの完了後に、新しい収集cacheとAI cacheだけをcanonical JSONで保存する。
11. 実測値、診断、各job結果をActions artifactとjob summaryへrun reportとして保存する。

Pages、Discord、cache保存のどこかで失敗したrunは公開結果を更新しません。運用障害通知は同じrunの失敗を伝えますが、送信済み状態を永続化しません。

## config.ymlの確認

| 設定               | 確認内容                                              |
| ------------------ | ----------------------------------------------------- |
| `organization`     | `VOICEVOX`であること                                  |
| `maintainers`      | 有効なGitHubユーザー名の一覧であること                |
| `tracking.startAt` | ISO 8601の明示値。run成功時に自動確定しない           |
| `tracking.include` | 初期範囲とbackfill対象                                |
| `state.*`          | 上記4 directoryとbranch、canonical JSON               |
| `ai`               | model、promptVersion、schema、budget、confidence      |
| `importance`       | label、milestone、impact、AI要因の重みと閾値          |
| `staleness`        | wait classごとのwatch、urgent、critical閾値           |
| `notifications`    | Discord、mention、上限、automation noise、Sの入力方法 |

`tracking.startAt`の未指定を最初の成功run時刻へ置き換える処理はありません。既存運用で必要な開始時刻は設定へ明示します。
重要度と要対応度の計算式、severity閾値、表示理由は設定以外で変更しません。

## ローカルdry-run

外部サービスを書き換えずに収集から公開guardまで確認する場合はdry-runを使います。

```console
pnpm build
pnpm tracker:run dry-run --artifact artifacts/dry-run.json
```

実データを読みますが、Pages生成、Discord通知、stateとcacheの保存は行いません。artifactには現在評価の要約、allowlist診断、cache hit/miss、AI検証結果、graphと通知候補を入れます。raw本文、raw diff、secret、private repositoryの値は入れません。
run reportはActions artifactとjob summaryへ出す形式と同じschemaで生成します。

golden fixtureの固定AI出力、schema、semantic validation、reducer、graph、通知選別を確認するには`pnpm eval:golden`を使います。
model、reasoning effort、promptを変更した場合は実モデルを使うdry-runでAI判定と通知候補の差分を確認します。

## デプロイ確認

初回の実行では次を確認します。

- repository metadataが全ページ取得され、allowlist外の詳細を読んでいない。
- `tracker-state-v4` branchに4種類のcacheだけがcanonical JSONで保存されている。
- 終了項目のcache期限が`terminalAt`から180日である。
- 503でcacheを使ったrepositoryがstale表示され、通常通知から除外されている。
- Pages DTOとDiscord payloadが同じ`S`、allowlist、current graphから生成されている。
- Pages deployとDiscord送信の後にcache保存が行われている。
- 各schedule runの`github.run_attempt == 1`だけ通常digestが送信され、`workflow_dispatch`とrerunでは送信されていない。
- run reportがActions artifactとjob summaryにあり、state branchにない。
- 5,000 items、10,000 edgesのcold fixtureを30分以内で処理できる。

Pagesが失敗した場合は通常digestを送らず、Discordが失敗した場合はcacheを保存せず、いずれも運用障害通知の対象にします。

## Permissionsと公開安全性

Pagesの公開は、収集時allowlistとpublish直前の再検証が一致した場合だけ許可します。
repository ID、owner/name、URL、GitHub由来本文、comment、label、ユーザー名は信頼できない入力としてescapeし、不要な全文や認証情報をpublic artifactへ入れません。
設定したmaintainerのユーザー名とteam識別子は公開できますが、team member一覧や所属対応は取得・公開しません。
