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
| `pnpm lint`               | ESLintでコードを検査する                                     | なし                                                     |
| `pnpm format`             | Prettierで対象ファイルを整形する                             | 対象ファイル                                             |
| `pnpm format:check`       | Prettierによる整形差分がないことを検査する                   | なし                                                     |
| `pnpm eval:golden`        | CLIをビルドし、golden fixtureを外部接続なしで評価する        | `artifacts/eval.json`、`artifacts/run-reports/eval.json` |
| `pnpm perf:profile`       | CLIをビルドし、モックした日次runで性能と予算の上限を検証する | `artifacts/performance-profile.json`                     |
| `pnpm tracker:run`        | ビルド済みの`dist/cli/tracker-run.js`を起動する              | サブコマンドによる                                       |

`build:web`は`index.html`に加えて`404.html`と`items/index.html`、`people/index.html`、`notification-history/index.html`、`guide/index.html`、`notifications/index.html`を生成します。
GitHub Pagesは任意のrewrite設定を持たないため、pathベースのdeep linkをこの複製で受けます。

`tracker:run`はビルドを兼ねません。
CLIのコードを変更した後は先に`pnpm build`を実行してください。

## Web UIをローカルで見る

```console
pnpm dev:web
```

Viteは起動時に`config.yml`の`web`設定を読み、base path、画面名、localeを反映します。
表示に使うサンプル公開DTOは`web/public/data/summary.json`、`web/public/data/details.json`、`web/public/data/notification-history.json`です。
Web UIは`summary.json`を最初に取得します。
項目詳細を開いたときと項目を検索したときだけ`details.json`を取得し、通知履歴を開いたときだけ`notification-history.json`を取得します。

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
実データは一時出力として扱い、確認後は元のサンプルへ戻してからコミットしてください。

## CLIをローカルで動かす

各stageの役割と操作は[運用手順](OPERATIONS.md)の「stageごとの実行」にまとめてあります。
外部サービスへ接続しないサブコマンドは`eval`、`report-workflow`、`persist-state`、`build-pages`です。
`persist-state`と`build-pages`は検証済みartifactとローカルのGit stateを必要とします。

`daily`、`backfill`、`collect-analyze`には`--notification-action send|dismiss-current`を指定できます。省略時は`send`です。`dry-run`にはこの指定はありません。

```console
pnpm tracker:run --backfill none --notification-action dismiss-current
pnpm tracker:run --backfill linked --notification-action dismiss-current
pnpm tracker:run collect-analyze --mode none --notification-action dismiss-current
```

`tracker:run`は`--backfill none`を`daily`へ変換し、`linked`または`all-open`を`backfill`へ変換します。

`dismiss-current`は現在の通知条件を満たす候補を上限なしで手動抑制済みとしてledgerへ保存し、通常のDiscord送信と`notification_sent`履歴を作りません。通知判定規則、Web UI、README、`config.yml`は変わりません。

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

ユーザーが明示的に実装を依頼した場合だけテストを実装します。

## Golden評価

`fixtures/golden/`の各ケースは`fixture.json`と`expected.json`の2ファイルで構成します。
`fixture.json`は評価時刻、repository、IssueとPull Request、関係候補、固定AI分析、前回状態を持ちます。
`expected.json`はstatus、waitingOn、severity、停滞開始時刻、関係、通知、公開可否の期待値を持ちます。
`large`ケースだけは集計値と性能、サイズ、API予算、Codex予算の合否を記録します。

fixtureはネットワークへ接続しません。
実在するIssue、Pull Request、repository、ユーザー名をfixtureへ持ち込まないでください。

期待値の更新に自動化されたコマンドはありません。
判定ロジックか`fixture.json`を変更したら`pnpm eval:golden`で実測値との差を確認し、意図した仕様を表す値だけを`expected.json`へ手で反映します。
新しいケースを足す場合は、同じdirectoryへ`fixture.json`と`expected.json`を追加します。
`fixture.json`の`name`は既存ケースと重複させないでください。

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

要対応度は最新の重要度、期限の切迫度、停滞時間、設定から毎run全項目で再計算します。
要対応度だけの変更ではIssueとPull Requestの決定論的規則versionを上げません。
期限日から切迫度を求める規則を変えた場合は、IssueとPull Requestの決定論的規則versionを上げます。

### 永続stateの列挙値を変更する

snapshot、履歴、通知ledgerが保存する列挙値は、次の順序で変更します。

1. 対象文書のschema versionを上げる。
2. 旧versionから現行versionへのマイグレーションを追加する。
3. CLIをビルドし、checkoutした`tracker-state`の実stateを検証する。

```console
pnpm build
pnpm tracker:run verify-state --state-directory path/to/tracker-state/state
```

## ディレクトリ構成

| パス                 | 責務                                                                                               |
| -------------------- | -------------------------------------------------------------------------------------------------- |
| `src/cli/`           | 引数解析、日次トランザクション、workflow stage、実アダプターの合成、run report                     |
| `src/codex/`         | 分析候補選定、予算、cache、隔離process、schema検証、semantic検証、reducer                          |
| `src/config/`        | `config.yml`の読み込みとZod schema検証                                                             |
| `src/discord/`       | 通知候補選別、ledgerによる重複抑制、payload生成、Webhook送信                                       |
| `src/domain/`        | 状態機械、maintainerとlabelの解決、追跡選定、停滞時間、severity、重要度、要対応度のpure TypeScript |
| `src/eval/`          | golden fixtureの解析、期待値との比較、回帰指標                                                     |
| `src/github/`        | GitHub App認証、読み取り専用API、収集、正規化、公開allowlist、rate limit管理                       |
| `src/graph/`         | 関係候補、edge reconcile、cycle、frontier、downstream impactのpure TypeScript                      |
| `src/pages/`         | 独立した公開guard、公開DTO生成、gzip上限検査、JSON出力                                             |
| `src/performance/`   | 外部接続をモックした日次run全体の性能と予算のprofile                                               |
| `src/persistence/`   | canonical JSON、snapshot、履歴、AI cache、通知ledger、run report、state branch transaction         |
| `src/util/`          | null検査、到達不能検査、共通エラー、Zod診断                                                        |
| `web/`               | ViteとPreactによる静的Web UIとサンプル公開DTO                                                      |
| `fixtures/`          | Golden評価と性能profileへ渡す固定入力                                                              |
| `schemas/`           | Codex分析出力とsnapshotのJSON Schema                                                               |
| `prompts/`           | Codexへ渡す固定system prompt                                                                       |
| `docs/`              | 要求定義、アーキテクチャ、デプロイ、運用、開発手順、調査資料                                       |
| `.github/workflows/` | CI、日次run、性能profile、マージゲートのGitHub Actions workflow                                    |

## コードの方針

[実装方針](../AGENTS.md)が判断の基準です。
実装するときは次の境界を守ってください。

`src/domain`と`src/graph`はネットワークやファイルシステムへ依存しないpure TypeScriptにします。
同じ入力から同じ結果を返す処理だけを置き、pureな判定層から副作用のあるadapterを呼びません。
GitHub、Codex、永続化、Pages、Discordへの副作用はそれぞれのadapterへ閉じ込め、一つのrunとしての順序制御を`src/cli`で行います。

GitHub由来の本文、コメント、label、ユーザー名は信頼できない入力として扱い、命令として解釈しません。
Codex出力は候補データとしてschema検証とsemantic検証を通し、状態や外部サービスへ直接反映しません。
追跡対象repositoryへの書き込みは実装しません。

想定外の値では例外を投げ、握りつぶさずerror boundaryまで伝播させます。
別のエラーへ変換するときは`cause`で元のエラーをつなぎます。
外部入力はZodで検証し、型アサーションとnon-null assertionは使いません。

## Web UIの表示・UX

ページ間で変える理由がない表示は変えません。

項目一覧 `/` と担当者個別 `/people/{ユーザー名}` の項目一覧では、次の規約を守ります。

- マージ済み、完了、対応しないの項目は既定で表示せず、トップページの状態で「すべて」を選ぶと表示します。
- `ResponsiveTableCardList`は画面幅だけで表とカードを切り替え、ページの種類では切り替えません。
- 切り替え幅は`breakpoint`で呼び出し側が明示します。
- 並び順の選択UIはカードを表示する幅でだけ表示し、`ResponsiveTableCardList`と同じ`breakpoint`で隠します。
- 表の列は「項目、待ち相手と状態、要対応度、重要度、停滞時間」の順に置きます。
- カードのフィールドも表の列と同じ順に置きます。
- 待ち相手と状態は、主な待ち相手、状態、主候補の理由の順に表示します。理由が空なら理由の段を省きます。
- 複数の待ち相手がいる場合は主候補だけを表示し、残りは件数で示します。
- 待ち相手の表示は`model.ts`で文字列とユーザー名の断片へ分け、文字列が必要な処理と画面表示を同じ断片から組み立てます。
- 個人のユーザー名は共通部品で人ごとのページへリンクし、teamはリンクにしません。
- 項目一覧のユーザー名には20px、担当者一覧のユーザー名には24px、人ページの見出しには40pxのGitHubアバターを添えます。項目詳細には添えません。
- アバターURLはユーザー名を`encodeURIComponent`へ通して`https://github.com/{ユーザー名}.png?size=48`の形で組み立てます。
- アバターは空の`alt`、`loading="lazy"`、`decoding="async"`、数値の`width`と`height`を持たせ、読み込み失敗時も隣のユーザー名だけで人物を識別できるようにします。
- teamにはアバターを表示しません。
- 人ページには既存のGitHubマークと文字を並べたGitHubプロフィールリンクを置き、安全な外部リンクとして新しいタブで開きます。
- トップページの主候補は`primaryWaitingOn.index`を使い、`not_applicable`では先頭候補を使います。
- 担当者個別では閲覧者本人または選択した所属teamに対応する先頭候補を使います。
- 項目見出しには共通部品の`ItemListHeading`を使います。
- 項目見出しの1行目には題名、AI警告アイコン、GitHubアイコンボタンを順に置きます。
- 項目見出しの2行目には`owner/repo#123`、種別、古い観測値のバッジを順に置きます。
- 題名の文字サイズと太さは、どのページでも、表でもカードでも同じにします。
- 一覧の要対応度と重要度はlevel名を省き、項目詳細と同じ書式の点数だけを表示します。
- 項目詳細の要対応度と重要度はlevel名と点数の両方を表示します。
- 要対応度のバッジは塗り、重要度のバッジは枠線で表し、色を見分けられなくても二つの指標を区別できるようにします。
- 重要度が低の場合もバッジを表示し、未算出と区別します。
- 表は固定レイアウトにし、項目を最も広く、待ち相手と状態を次に広くします。数値列は狭くして等幅数字を中央へ揃えます。
- 項目一覧からGitHubへの導線は題名の隣に置くアイコンボタン一つだけにし、44px以上の操作領域を確保します。
- 一覧の件数と選択中の並び替えキー名を要約表示しません。
- サイト名は`text-base font-semibold`、ページ見出しは`text-lg font-semibold`で統一し、見出しレベルは表示サイズと分けて決めます。
- 操作方法だけを説明する文章はページ見出しや一覧操作の周囲へ置きません。
- 観測時刻は公開データ全体の属性として、共通ヘッダーの「最新更新」へ一か所だけ表示します。
- 共通フッターはrun IDだけを表示します。
- 表の列見出しは画面上端に固定します。
- 絞り込みなどで待ち相手だけを指す表示は「待ち相手」、一覧の複合列は「待ち相手と状態」、要対応度を指す表示は「要対応度」に統一します。
- CSPの`img-src`は同一origin、data URL、`github.com`、`avatars.githubusercontent.com`だけを許可し、他のディレクティブは画像表示のために広げません。

## Web UIのスタイル

Tailwind CSSでスタイルを書きます。
`web/src/styles.css`にはトークン定義と全体の既定だけを置き、ページ固有の規則を足しません。

色とフォントサイズとブレークポイントは`@theme`のトークンを使います。
トークンは役割で名付けてあるので、`bg-surface-card`や`text-state-danger-text`のように意味で選びます。
生成りのページとカードに深緑のアクセントを合わせ、ライトテーマだけを提供します。
本文は端末のゴシック体、サイト名とページや項目詳細の見出しは`font-display`、点数や時間や件数は`font-mono`を使います。
Webフォントは読み込みません。
余白と角丸と影はTailwindの既定スケールへ寄せ、`clamp()`のように既定で表せないものだけ`@theme`へ足します。
カードとセクションは`rounded-2xl`で揃え、表とカード一覧だけに薄い影を付けます。
IssueとPull Requestの種別はそれぞれsuccess系とinfo系、状態はneutral系のピルで表示します。
操作できる要素は幅の狭い画面でも押せるよう、最小高さを44pxにします。

繰り返し現れる見た目は共通部品にします。

| 部品                      | 用途                                     |
| ------------------------- | ---------------------------------------- |
| `PageSection`             | カードと見出しを備えたページ内セクション |
| `ContentState`            | 空状態、読み込み中、読み込み失敗         |
| `ResponsiveTableCardList` | 広い画面のtableと狭い画面のcard一覧      |
| `Pill`                    | 意味に対応する配色のpill型label          |
| `ActionButton`            | 操作button                               |

## Pull Requestを出す前に

CIと同じ検査を手元で実行します。

```console
pnpm typecheck
pnpm lint
pnpm format:check
pnpm eval:golden
pnpm build
pnpm build:workflow-cli
pnpm build:web
```

`format:check`が失敗した場合は`pnpm format`で整形し、意図しないファイルまで変わっていないことを確認します。
サンプル公開DTOを実データで上書きしたままにしていないかも確認してください。

日次run全体の性能、API予算、Codex予算、Pages summaryのサイズに影響する変更では`pnpm perf:profile`も実行し、`artifacts/performance-profile.json`を確認します。
`.github/workflows/performance.yml`の手動workflowでも同じ検証を実行できます。
