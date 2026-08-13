# 運用手順

## 日々の確認

日次scheduleは08:00 JSTに対応する基準通知時刻`S`を渡してrunします。
Actionsの遅延は`S`を変更しません。workflow concurrencyでschedule runを直列化します。

成功後はActions artifactとjob summaryのrun reportを確認します。`tracker-state` branchはcacheだけを持ち、Pagesの公開結果や送信済み状態の正本ではありません。

run reportで確認する項目は次のとおりです。

| 項目                   | 確認内容                                                                      |
| ---------------------- | ----------------------------------------------------------------------------- |
| repository/item/edge数 | allowlist内の収集数と現在graphの規模                                          |
| pagination             | repository、item、timeline、comment、review、edit historyの未取得ページがない |
| cache hit/miss         | GitHub収集cache、Codex result、latest importanceの利用数                      |
| stale                  | 503 cacheを使ったrepositoryと影響する項目                                     |
| AI                     | call数、validation失敗、deferred、importance fallback、relation不足           |
| replay                 | unknown件数、current値との不一致、同一source IDの重複                         |
| notification           | `S`、一回通知窓、urgent 3日、critical 2日の候補数と送信結果                   |
| stage                  | Pages、Discord、cache保存の成否と所要時間                                     |

raw API response、本文、comment、編集差分、secretはartifactとjob summaryへ出しません。
人がcache JSONを直接編集して判定を修正する運用はしません。GitHubの正本、`config.yml`、またはfixtureを修正して再実行します。

## 公開allowlist

収集開始時にOrganizationのrepository metadataを全ページ取得します。
public、non-archived、non-disabledだけをallowlistへ入れ、allowlist外の詳細を取得しません。

cache保存前、Pages DTO生成前、Discord payload生成前にallowlistを再検証します。
private、internal、archived、disabled、allowlist外のrepository ID、owner/name、URL、項目が一件でもあれば、cache、Pages、通常Discordをすべて停止します。
過去にpublicだった値をcacheから再公開しません。

設定したmaintainerのユーザー名とteam識別子は公開できますが、team member一覧と所属対応は取得しません。

## 503とstale cache

repositoryの収集が503で失敗した場合は、同一repositoryのcacheがschemaとallowlistを満たすときだけstaleとして評価します。
staleであることをPagesへ明示し、影響する通常通知を除外します。
cacheがない503、503以外の通信失敗、paginationが欠けた結果はrun失敗です。

失敗runではPagesと通常Discordを更新せず、運用障害通知だけを試みます。stale cacheを新しいcacheとして上書きしません。

## 性能profile

cold runはcacheを使わず、現在値と全timeline・編集履歴を再生します。
受入条件は5,000 items、10,000 edgesを30分以内で処理することです。変更件数だけを測るprofileでは不十分です。

```console
pnpm perf:profile
```

外部GitHub、Codex、Discordへ接続せず、全pagination、event sorting、state・relation replay、Pages DTO、通知候補計算をmock入力で測ります。
API unit、Codex call、cache hit/miss、gzip summary sizeもrun reportへ記録します。

30分を超えた場合は、queryのまとめ方、pagination、並列度、不要なraw値の保持を調べます。
判定の正しさを保つために、前回runの判定結果を必須入力へ戻しません。

## stageごとの実行

### collect-analyze

1. 設定を検証し、runの`S`を固定する。
2. repository metadataからallowlistを作る。
3. open itemと必要なrelation端点を列挙する。
4. GitHub収集cacheのhitを検証し、missは全current detail、timeline、comment、review、edit historyを全ページ取得する。
5. source ID、発生時刻、pagination sequenceを正規化し、state、draft、responsibility、relationをreplayする。
6. current detailとreplay結果を照合する。
7. current inputに一致するCodex cacheを読み、missだけAIへ渡す。
8. graph、importance、attention、severity、通知候補を計算する。

actorやrelation targetが取得不能でも、確定できるstateやdraftをunknownにしません。
責務targetの不明なepochだけをunknownとし、current relationに必要なAIが不足する場合は推測せずrunを停止します。

### build-pagesとdeploy-pages

収集時allowlistをDTO生成直前に再検証します。private、internal、archived、disabled、allowlist外の値、secret、危険なURL、raw本文、raw diffを拒否します。
検証済みDTOだけをPagesへdeployします。deployment失敗時は通常Discordとcache保存を行いません。

### notify-discord

通知判定は送信済み状態を参照せず、`S`とGitHub eventの時刻から行います。
一回限りの変化は`S - 24時間 < T <= S`の候補だけにします。
urgentは3日、criticalは2日の固定周期で閾値到達後に再び候補にします。

各schedule runの`github.run_attempt == 1`だけ、一回限りの変化とurgent・criticalの停滞繰り返しを含む通常digestを送ります。`workflow_dispatch`とrerunでは通常digestを送りません。
`github.run_attempt`が1以外なら通常digestを抑えます。Webhookの通信断で送信済みか確認できない極めて稀な重複は許容します。

### persist-cache

PagesのdeployとDiscord送信が完了した後にだけcacheを書き込みます。
`tracker-state`のcache pathは次の4つです。

```text
state/github-repositories
state/github-items
state/ai-latest-importance
state/ai-results
```

canonical JSONを使い、directoryの同一・入れ子を設定時に拒否します。
終了項目cacheは`terminalAt`から180日まで保持し、期限後に削除します。snapshot、日次履歴、notification ledger、state branchのrun reportは作りません。

### report

run reportはActions artifactとjob summaryへ保存します。
成功、stale継続、AI fallback、公開停止、Pages失敗、Discord失敗、cache保存失敗を区別し、診断code、stage、件数、所要時間だけを記録します。
cache branchの入力にはしません。

## 誤判定の直し方

### 状態、責務、時刻

GitHub current detailと全timelineのsource IDを調べます。
同じsource IDの異なる内容、current detailとの矛盾、欠落した必須ページは例外として扱い、現在時刻へ補正しません。
actor不明でもstate、draft、mergeの事実は再生し、assigneeやreview request target不明の責務epochだけをunknownにします。

同時刻イベントはitem内sequenceとsource IDで順序を固定します。順序が変わるfixtureはsource IDによる安定化が働いているか確認します。

### relationとdependency

native dependencyの4イベント、本文・commentのrelation mutation、close・reopenを確認します。
現在graphはcurrent relationから作り、blocks edgeは両端がopenのときだけactiveです。
履歴の一部がunknownなら現在graphを推測で変えず、newly unblockedやcycleなど影響する一回限り通知だけを抑えます。

### importanceとAI

同一normalized inputのCodex resultだけを通常結果として使います。
AI失敗時のlatest fallbackは同じnode IDのimportanceだけです。status、waitingOn、relation、progress、通知理由には使いません。
current graphに必要なAI relationが不足した場合はPagesと通常Discordを止めます。

### 設定と規則

label、severity、importance、attentionの閾値を変えた場合はgolden fixtureと通知候補の差分を確認します。
判定結果が変わるdomain、graph、prompt、schemaの変更では対応する規則versionとhash testを更新します。

## 通知量の調整

severityはDiscord通知だけに使います。通常候補は新しいseverity、責務移動、newly unblocked、new cycle、長期停滞を優先し、bot-only activity、preview更新、recent draft、低信頼AIだけの理由は除外します。
blocked parent自身を毎日催促せず、blockerのseverityとdownstream impactで順位を決めます。

通知が多すぎる場合は、不要な候補の原因となった状態分類、label規則、staleness閾値、AI confidence、予算を順に確認します。
送信成功時刻を保存してcooldownを調整することはできません。固定周期と`S`から候補を再計算します。

## 障害時の確認

1. job summaryのstage、diagnostic code、allowlist、stale、cache hit/missを確認する。
2. Pages、Discord、cache保存のどこで停止したかを確認する。
3. public allowlist違反ならcache、Pages、Discordがすべて停止したことを確認する。
4. relation AI不足なら古い入力へfallbackせず、最後に公開されたPagesを確認する。
5. 503なら検証済みcacheの有無とstale除外を確認する。
6. current値不整合や同一source IDの内容不一致ならfixtureとGraphQL paginationを調べ、例外を隠さない。

PagesまたはDiscordが失敗したrunはcacheを保存しません。次回runはGitHub current detailと全イベントから再計算します。
運用障害通知にも送信済みledgerはなく、同じ障害が続く場合の複数通知は許容します。
