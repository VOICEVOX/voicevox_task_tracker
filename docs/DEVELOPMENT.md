# 開発手順

## 環境を用意する

Node.js 24.11.1とpnpm 10.33.4を使います。

```console
corepack enable
pnpm install --frozen-lockfile
pnpm dev:web
```

実データを扱う開発ではGitHub App、Codex、Discordの認証情報をテストfixtureへ入れません。
GitHub由来の本文、comment、label、ユーザー名はuntrusted dataとして扱い、prompt injectionを命令として実行しないでください。

## 開発コマンド

| コマンド            | 内容                                       |
| ------------------- | ------------------------------------------ |
| `pnpm build`        | `src`をNode.js向けJavaScriptと型定義へ変換 |
| `pnpm build:web`    | 静的Web UIをビルド                         |
| `pnpm dev:web`      | サンプル公開DTOでWeb UIを起動              |
| `pnpm typecheck`    | Node.js側とWeb UI側を型検査                |
| `pnpm test`         | Vitestを一回実行                           |
| `pnpm lint`         | ESLintを実行                               |
| `pnpm format`       | Prettierで整形                             |
| `pnpm format:check` | Prettierの差分を検査                       |
| `pnpm eval:golden`  | 固定AI出力を含むgolden fixtureを評価       |
| `pnpm perf:profile` | cold runの性能と予算を測定                 |
| `pnpm tracker:run`  | ビルド済みCLIを起動                        |

`tracker:run`はビルドを兼ねません。CLI変更後は`pnpm build`を実行してください。
性能profileは5,000 items、10,000 edgesを30分以内で処理できるかを確認します。

## pure層の開発

`src/domain`と`src/graph`へnetwork、filesystem、日時取得、乱数を持ち込まないでください。
イベントの発生時刻、pagination sequence、source IDを入力で受け、同じ入力から同じ値を返します。

GitHub adapterは次を行います。

- IssueとPull Requestのcurrent detailをZodで検証する。
- timeline、comment、review、review request、commit、edit historyを全ページ取得する。
- item node ID、item内sequence、安定source IDを失わずにdomain入力へ変換する。
- actorやrelation targetのnull、削除、取得不能を推測せずunknownとして渡す。
- 同じsource IDの異なる内容、current detailとの矛盾、欠落した必須ページは例外にする。

replay reducerはstate、draft、assignee、review request、relation、cycle、newly unblockedの区間を再生します。
同時刻イベントはbatchで適用し、batch途中の状態から通知を作りません。current graphのblocks edgeは両端がopenのときだけ有効です。
raw本文とraw diffはadapter境界を越えて保存しません。

## Web UIをローカルで見る

```console
pnpm dev:web
```

Viteは`config.yml`の`web`設定を読み、`web/public/data/summary.json`と`details.json`を表示します。
実データを使う場合は一時directoryへPages DTOを出し、確認後にfixtureへ戻します。
公開ページは現在評価のDTOだけを表示し、過去runの差分や送信済み状態を表示しません。

## cacheとartifactのローカル確認

`tracker-state` branchを使う場合も、設定する永続pathは次の4つだけです。

```text
state/github-repositories
state/github-items
state/ai-latest-importance
state/ai-results
```

directoryはstate配下の正規化相対pathで、相互に同一・入れ子にしません。
cacheにはcanonical JSONを保存し、raw token、raw本文、raw diff、private repositoryの値を入れません。
終了項目cacheの期限は`terminalAt`から180日です。repository 503でcacheを使った場合はstaleと記録し、影響する通常通知を除外します。

Pages deployとDiscord送信が完了するまでcacheを保存しません。
run reportはActions artifactとjob summaryへ出す一時成果物で、cache branchへ置きません。

## テスト

VitestはNode.jsとWebのprojectに分かれています。

```console
pnpm test
pnpm typecheck
pnpm lint
pnpm format:check
```

replay fixtureでは少なくとも次を検証します。

- IssueとPull Requestのclose、reopen、merge、draft、ready
- assigneeとreview requestの追加・解除、actorやtargetのunknown
- comment、review、commit、state変更の意味ある進捗
- native dependencyと本文・comment relationの追加・削除
- 同時刻、pagination順の入れ替え、同一source IDの重複と内容不一致
- 現在値と再生結果の一致、不一致の局所unknown
- blockerのclose・reopen、newly unblocked、cycleの追加・削除・再生成
- `S`の24時間通知窓、urgent 3日、critical 2日の固定周期
- 各schedule runの`github.run_attempt == 1`では一回限りの変化と停滞の繰り返しを含む通常digestを送り、`workflow_dispatch`とrerunでは通常digestを送らないこと
- cacheを削除したcold入力とcache hitのwarm入力が同じ現在判定になること

golden fixtureはネットワークへ接続しません。固定AI出力と現在値、全イベント、期待するcurrent graph、importance、attention、通知候補を持たせます。
raw本文やraw diffをfixtureへ残さず、必要なrelationだけを検証済みの構造化入力へします。

## 判定規則version

IssueやPull Requestの決定論的判定、graph、prompt、schemaを変更し、結果が変わる場合は対応する規則versionとhash testを更新します。

| 変更対象           | 更新するversion                            |
| ------------------ | ------------------------------------------ |
| Issueの判定        | `ISSUE_DETERMINISTIC_RULES_VERSION`        |
| Pull Requestの判定 | `PULL_REQUEST_DETERMINISTIC_RULES_VERSION` |
| Codex prompt       | `config.yml`の`ai.promptVersion`           |

importanceのlatest fallbackの保存場所を変えるだけで、判定結果が変わらない場合はversionを上げません。
通知の固定周期やallowlist停止条件を変更して候補が変わる場合は、通知判定のversionとgolden期待値を同じ変更で更新します。

## ディレクトリ構成

| パス               | 責務                                                             |
| ------------------ | ---------------------------------------------------------------- |
| `src/cli/`         | runの順序、adapterの合成、artifactとjob summary                  |
| `src/codex/`       | 候補選定、隔離process、cache、schema・semantic validation        |
| `src/config/`      | YAMLとZod schema                                                 |
| `src/discord/`     | 通知候補、固定周期、payload、Webhook                             |
| `src/domain/`      | 状態、責務、停滞、severity、importance、attentionのpure判定      |
| `src/eval/`        | golden fixtureと期待値比較                                       |
| `src/github/`      | GitHub読み取り、全ページ取得、allowlist、正規化、収集cache       |
| `src/graph/`       | relation、dependency、cycle、frontierのpure判定                  |
| `src/pages/`       | 公開guard、DTO、Pages出力                                        |
| `src/persistence/` | 4種類のcacheのcanonical JSON adapter                             |
| `src/util/`        | null検査、例外、Zod診断                                          |
| `web/`             | 静的Web UIとテスト                                               |
| `tests/`           | Node.js側のunit、integration、security、CLI、golden、性能fixture |
| `schemas/`         | GitHub schema、Codex出力、公開DTOのschema                        |
| `prompts/`         | Codexの固定system prompt                                         |

## Pull Request前の確認

変更範囲に応じて担当fixtureを追加し、`pnpm format`、`pnpm typecheck`、`pnpm lint`、`pnpm test`を実行します。
公開境界、cache保存順、unknownの局所化、同時刻の決定性、current値との照合を確認します。
GitHub、Codex、Pages、Discordへ書き込むコードを追加しないでください。
