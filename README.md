# VOICEVOX Task Tracker

VOICEVOX Organizationの公開IssueとPull Requestを、GitHubの現在値と全timeline・編集履歴から決定論的に再生して整理するプロジェクトです。
現在の状態、次に行動する主体、停滞時間、重要度、要対応度、依存関係をGitHub Pagesへ公開し、条件に合う変化だけをDiscordへ通知します。
追跡対象のIssue、Pull Request、コメント、ラベル、アサイン、レビュー依頼は変更しません。

## 主要な仕組み

- GitHubの状態、draft、assignee、review request、dependency、コメント、レビュー、commitを全ページ取得し、発生時刻と安定したsource IDで再生します。取得できない actor や対象は推測せず、影響する事実だけを unknown として保持します。
- GitHubの確定情報を先に評価し、Codexは本文やコメントの意味など自然言語の解釈が必要な候補だけを扱います。Codex出力はschema検証とsemantic検証を通した候補です。
- 公開かつ非アーカイブで無効化されていないリポジトリだけをallowlistに入れます。収集後、cache保存前、Pages生成前、Discord送信前にallowlistを再検証し、違反が一件でもあればcache、Pages、Discordをすべて停止します。
- `tracker-state-v4` branchにはcacheだけを保存します。配置は`state/github-repositories`、`state/github-items`、`state/ai-latest-importance`、`state/ai-results`です。canonical JSONを使い、snapshot、日次履歴、notification ledger、run reportは保存しません。
- 終了項目のcacheは終了時刻から180日を上限に保持します。GitHubが503を返しcacheがある場合はstaleとして使いますが、影響する通常通知から除外します。cacheがない場合はrunを失敗させます。
- AIは入力、model、reasoning effort、backend、prompt、schema、規則versionが一致するcacheだけを通常結果に使います。失敗時に許されるlatest fallbackは同じnodeの重要度だけで、現在の状態、責務、関係には使いません。現在の関係に必要なAI結果が欠けた場合はPagesと通常通知を停止します。
- 通知はworkflowから渡す基準時刻`S`で決めます。一回限りの変化は`S - 24時間 < 発生時刻 <= S`で選び、urgentは3日、criticalは2日の固定周期で再通知します。各schedule runの`github.run_attempt == 1`だけ、一回限りの変化と停滞の繰り返しを含む通常digestを送り、`workflow_dispatch`とrerunでは送りません。

cache保存はPagesのdeployとDiscord送信が完了した後に行います。run reportはstate branchではなくActions artifactとjob summaryへ出力します。
cold runの性能受入条件は5,000 items、10,000 edgesを30分以内に処理することです。

## はじめかた

Node.js 24.11.1とpnpm 10.33.4を使います。

```console
corepack enable
pnpm install --frozen-lockfile
pnpm dev:web
```

`pnpm dev:web`はサンプルの公開データでWeb UIを起動します。開発コマンド、テスト、CLIの動かし方は[開発手順](docs/DEVELOPMENT.md)にあります。

## 文書

| 文書                                   | 内容                                          |
| -------------------------------------- | --------------------------------------------- |
| [開発手順](docs/DEVELOPMENT.md)        | 手元での開発、テスト、Pull Request前の確認    |
| [アーキテクチャ](docs/ARCHITECTURE.md) | モジュール境界、再生、公開guard、cache branch |
| [デプロイ手順](docs/DEPLOYMENT.md)     | GitHub App、Actions、Pages、secretの設定      |
| [運用手順](docs/OPERATIONS.md)         | 日々の監視、stage実行、通知、障害対応         |
| [要求定義](docs/REQUIREMENTS.md)       | 目的、状態モデル、規範要求と受入条件          |
| [実装方針](AGENTS.md)                  | 実装時に守る制約                              |
| [参照資料](docs/RESEARCH_SOURCES.md)   | 設計の根拠にした公式資料と実例                |
