# 開発手順

VOICEVOX Task Trackerを手元で開発するための手順です。
本番環境の構築は[デプロイ手順](DEPLOYMENT.md)、運用中の操作は[運用手順](OPERATIONS.md)を参照してください。
設計の背景は[アーキテクチャ](ARCHITECTURE.md)にあります。

## 環境を用意する

Node.jsは`.node-version`の24.11.1、pnpmは`package.json`の`packageManager`で固定した10.33.4を使います。
`packageManager`の指定だけではpnpmのshimが有効にならない環境があるため、Corepackを明示的に有効にします。

```console
corepack enable
pnpm install --frozen-lockfile
```

`--frozen-lockfile`を付けると、`pnpm-lock.yaml`と`package.json`が一致しない場合にインストールが失敗します。

## 開発コマンド

| コマンド                  | 内容                                                         | 出力先                                                   |
| ------------------------- | ------------------------------------------------------------ | -------------------------------------------------------- |
| `pnpm build`              | `src`をNode.js向けJavaScriptと型定義へ変換する               | `dist/`                                                  |
| `pnpm build:web`          | 静的Web UIをビルドする                                       | `dist/web/`                                              |
| `pnpm build:workflow-cli` | 日次workflowの後続jobが使うES module bundleを作る            | `artifacts/workflow/runtime/tracker-run.mjs`             |
| `pnpm dev:web`            | Web UIの開発serverを起動する                                 | なし                                                     |
| `pnpm typecheck`          | Node.js側とWeb UI側を型検査する                              | なし                                                     |
| `pnpm test`               | Vitestのテストを1回実行する                                  | なし                                                     |
| `pnpm lint`               | ESLintでコードを検査する                                     | なし                                                     |
| `pnpm format`             | Prettierで対象ファイルを整形する                             | 対象ファイル                                             |
| `pnpm format:check`       | Prettierによる整形差分がないことを検査する                   | なし                                                     |
| `pnpm eval:golden`        | CLIをビルドし、golden fixtureを外部接続なしで評価する        | `artifacts/eval.json`、`artifacts/run-reports/eval.json` |
| `pnpm perf:profile`       | CLIをビルドし、モックした日次runで性能と予算の上限を検証する | `artifacts/performance-profile.json`                     |
| `pnpm tracker:run`        | ビルド済みの`dist/cli/tracker-run.js`を起動する              | サブコマンドによる                                       |

`build:web`は`index.html`に加えて`404.html`と`items/index.html`、`people/index.html`を生成します。
GitHub Pagesは任意のrewrite設定を持たないため、pathベースのdeep linkをこの複製で受けます。

`tracker:run`はビルドを兼ねません。
CLIのコードを変更した後は先に`pnpm build`を実行してください。

## Web UIをローカルで見る

```console
pnpm dev:web
```

Viteは起動時に`config.yml`の`web`設定を読み、base path、画面名、localeを反映します。
表示に使うサンプル公開DTOは`web/public/data/summary.json`と`web/public/data/details.json`です。
Web UIは`summary.json`を最初に取得し、項目詳細を開いたときと項目を検索したときだけ`details.json`を取得します。

実データで表示を確かめる場合は、収集結果を保存してからPages用DTOを書き出します。

```console
pnpm build
pnpm tracker:run collect-analyze --mode none
pnpm tracker:run persist-state
pnpm tracker:run build-pages --output web/public/data
```

`collect-analyze`にはGitHub AppとCodexの認証情報が必要です。
`persist-state`はローカルの`tracker-state` refへ保存するだけで、remoteへはpushしません。
`build-pages --output web/public/data`はサンプル公開DTOを実データで上書きします。
実データは一時出力として扱い、確認後は元のサンプルへ戻してからテストとコミットを行ってください。

## CLIをローカルで動かす

各stageの役割と操作は[運用手順](OPERATIONS.md)の「stageごとの実行」にまとめてあります。
外部サービスへ接続しないサブコマンドは`eval`、`report-workflow`、`persist-state`、`build-pages`です。
`persist-state`と`build-pages`は検証済みartifactとローカルのGit stateを必要とします。

オンラインで収集する場合は、実行するshellへ次の環境変数を設定します。

| 環境変数                         | 必要になる場面                                   |
| -------------------------------- | ------------------------------------------------ |
| `GH_APP_ID`                      | GitHubから収集するすべての処理                   |
| `GH_APP_PRIVATE_KEY`             | GitHubから収集するすべての処理                   |
| `GH_APP_INSTALLATION_ID`         | installation IDの自動発見を上書きする場合だけ    |
| `CODEX_HOME`                     | Codexを使う処理。直下に`auth.json`が必要         |
| `OPENAI_API_KEY`                 | `ai.authentication`を`api-key`へ変更した場合だけ |
| `DISCORD_WEBHOOK_URL`            | 通常通知を送る処理                               |
| `DISCORD_OPERATIONS_WEBHOOK_URL` | 障害通知を送る処理                               |

現行の`config.yml`はAIを有効にし、認証方式を`auth-json`にしているため、収集には`CODEX_HOME`が必要です。
`collect-analyze`はDiscordの環境変数を読みません。

state、Pages、Discordを更新せずに収集から検証までを通したい場合は`dry-run`を使います。
`tracker:run`のpackage scriptは`dry-run`を転送しないため、[デプロイ手順](DEPLOYMENT.md)の「ローカルdry-run」にある呼び出し方を使ってください。

## テスト

`vitest.config.ts`は2つのprojectへテストを分けます。

| project | 対象                 | 実行環境 |
| ------- | -------------------- | -------- |
| `node`  | `tests/**/*.test.ts` | Node.js  |
| `web`   | `web/**/*.test.tsx`  | jsdom    |

`pnpm test`は両方を実行します。
Node.js側にはunit、integration、security、CLI、golden、性能profileのテストがあります。

### golden fixtureを更新する

`tests/fixtures/golden/`の各ケースは`fixture.json`と`expected.json`の2ファイルで構成します。
`fixture.json`は評価時刻、repository、IssueとPull Request、関係候補、固定AI分析、前回状態を持ちます。
`expected.json`はstatus、waitingOn、severity、停滞開始時刻、関係、通知、公開可否の期待値を持ちます。
`large`ケースだけは集計値と性能、サイズ、API予算、Codex予算の合否を記録します。

fixtureはネットワークへ接続しません。
実在するIssue、Pull Request、repository、loginをfixtureへ持ち込まないでください。

期待値の更新に自動化されたコマンドはありません。
判定ロジックか`fixture.json`を変更したら`pnpm test`で実測値との差を確認し、意図した仕様を表す値だけを`expected.json`へ手で反映します。
新しいケースを足す場合は同名のdirectoryへ2ファイルを追加し、`tests/golden-eval.test.ts`の`FIXTURE_NAMES`へ名前を加えます。

期待値を更新してよいのは、判定仕様を意図して変更した場合、fixtureの誤りを直す場合、回帰ケースを追加する場合だけです。
意図しない回帰を通すために期待値を合わせないでください。
golden evalは固定AI出力を検証するもので実モデルを呼ばないため、model、reasoning effort、promptの変更を理由に期待値を更新することもありません。
これらを変更した場合は`metrics.aiCallCount`が1以上になるdry-runで確認します。

### 判定規則versionを更新する

判定規則を変えたら、対応するversionを上げてください。
上げないと、GitHub側が動いていない項目は再判定されず、古い判定が残り続けます。

| 変更した対象                | 上げるversion                              |
| --------------------------- | ------------------------------------------ |
| Issueの判定                 | `ISSUE_DETERMINISTIC_RULES_VERSION`        |
| Pull Requestの判定          | `PULL_REQUEST_DETERMINISTIC_RULES_VERSION` |
| `prompts/`のCodexプロンプト | `config.yml`の`ai.promptVersion`           |

`tests/rules-version-hash.test.ts`が判定に関わるファイルの内容hashを記録しており、更新漏れがあると失敗します。
失敗したら、判定結果が変わるかを考えてversionを上げるか判断し、どちらの場合も記録hashを更新してください。

## ディレクトリ構成

| パス                 | 責務                                                                                       |
| -------------------- | ------------------------------------------------------------------------------------------ |
| `src/cli/`           | 引数解析、日次トランザクション、workflow stage、実アダプターの合成、run report             |
| `src/codex/`         | 分析候補選定、予算、cache、隔離process、schema検証、semantic検証、reducer                  |
| `src/config/`        | `config.yml`の読み込みとZod schema検証                                                     |
| `src/discord/`       | 通知候補選別、cooldown、payload生成、Webhook送信                                           |
| `src/domain/`        | 状態機械、teamとlabelの解決、追跡選定、停滞時間、severity、重要度のpure TypeScript         |
| `src/eval/`          | golden fixtureの解析、期待値との比較、回帰指標                                             |
| `src/github/`        | GitHub App認証、読み取り専用API、収集、正規化、公開allowlist、rate limit管理               |
| `src/graph/`         | 関係候補、edge reconcile、cycle、frontier、downstream impactのpure TypeScript              |
| `src/pages/`         | 独立した公開guard、公開DTO生成、gzip上限検査、JSON出力                                     |
| `src/performance/`   | 外部接続をモックした日次run全体の性能と予算のprofile                                       |
| `src/persistence/`   | canonical JSON、snapshot、履歴、AI cache、通知ledger、run report、state branch transaction |
| `src/util/`          | null検査、到達不能検査、共通エラー、Zod診断                                                |
| `web/`               | ViteとPreactによる静的Web UI、そのテスト、サンプル公開DTO                                  |
| `tests/`             | Node.js側のテストとfixture                                                                 |
| `schemas/`           | GitHub GraphQL schemaの写し、Codex分析出力とsnapshotのJSON Schema                          |
| `prompts/`           | Codexへ渡す固定system prompt                                                               |
| `docs/`              | 要求定義、アーキテクチャ、デプロイ、運用、開発手順、調査資料                               |
| `.github/workflows/` | CI、日次run、性能profileのGitHub Actions workflow                                          |

## コードの方針

[実装方針](../AGENTS.md)が判断の基準です。
実装するときは次の境界を守ってください。

`src/domain`と`src/graph`はネットワークやファイルシステムへ依存しないpure TypeScriptにします。
同じ入力から同じ結果を返す処理だけを置き、pureな判定層から副作用のあるadapterを呼びません。
GitHub、Codex、永続化、Pages、Discordへの副作用はそれぞれのadapterへ閉じ込め、一つのrunとしての順序制御を`src/cli`で行います。

GitHub由来の本文、コメント、label、loginは信頼できない入力として扱い、命令として解釈しません。
Codex出力は候補データとしてschema検証とsemantic検証を通し、状態や外部サービスへ直接反映しません。
追跡対象repositoryへの書き込みは実装しません。

想定外の値では例外を投げ、握りつぶさずerror boundaryまで伝播させます。
別のエラーへ変換するときは`cause`で元のエラーをつなぎます。
外部入力はZodで検証し、型アサーションとnon-null assertionは使いません。

## Web UIのスタイル

Tailwind CSSでスタイルを書きます。
`web/src/styles.css`にはトークン定義と全体の既定だけを置き、ページ固有の規則を足しません。

色とフォントサイズとブレークポイントは`@theme`のトークンを使います。
トークンは役割で名付けてあるので、`bg-surface-card`や`text-state-danger-text`のように意味で選びます。
余白と角丸と影はTailwindの既定スケールへ寄せ、`clamp()`のように既定で表せないものだけ`@theme`へ足します。
操作できる要素は幅の狭い画面でも押せるよう、最小高さを44pxにします。

繰り返し現れる見た目は共通部品にします。

| 部品                      | 用途                                     |
| ------------------------- | ---------------------------------------- |
| `PageSection`             | カードと見出しを備えたページ内セクション |
| `ContentState`            | 空状態、読み込み中、読み込み失敗         |
| `ResponsiveTableCardList` | 広い画面のtableと狭い画面のcard一覧      |
| `Pill`                    | 意味に対応する配色のpill型label          |
| `ActionButton`            | 操作button                               |

`web/src/app.test.tsx`は識別用のclass名を選択子に使います。
見た目をユーティリティclassへ移すときも、識別用のclass名は残します。

## Pull Requestを出す前に

CIと同じ検査を手元で実行します。

```console
pnpm typecheck
pnpm lint
pnpm format:check
pnpm test
pnpm eval:golden
pnpm build
pnpm build:workflow-cli
pnpm build:web
```

`format:check`が失敗した場合は`pnpm format`で整形し、意図しないファイルまで変わっていないことを確認します。
サンプル公開DTOを実データで上書きしたままにしていないかも確認してください。

日次run全体の性能、API予算、Codex予算、Pages summaryのサイズに影響する変更では`pnpm perf:profile`も実行し、`artifacts/performance-profile.json`を確認します。
`.github/workflows/performance.yml`の手動workflowでも同じ検証を実行できます。
