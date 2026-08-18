# VOICEVOX Task Tracker

VOICEVOX Organizationの公開IssueとPull Requestを横断して、現在の状態、次に行動する主体、停滞時間、重要度、要対応度、依存関係を整理するプロジェクトです。
毎日08:00 JSTにGitHub Actionsから実行し、GitHub Pagesへ項目一覧、担当者別の停滞、項目ごとの依存関係を公開して、対応が必要な変化だけをDiscordへ通知します。
追跡対象のIssue、Pull Request、コメント、ラベル、アサイン、レビュー依頼は変更しません。

## 主要な仕組み

- GitHubのレビュー依頼、アサイン、native dependencyなどの確定情報を決定論的な規則で先に評価します。
- Codexは未回答の依頼やリンクの意味など、自然言語の解釈が必要な変更だけを分析します。
- 項目そのものの重要度を計算し、重要度と停滞の短さを掛け合わせて要対応度を求めます。重要度が主、停滞の短さが従です。
- 一覧の既定の並び順と依存グラフの優先順位は要対応度で決めます。停滞の深刻さを表すseverityはDiscord通知の判断にだけ使い、画面には出しません。
- 公開かつ非アーカイブで、無効化されていないリポジトリだけを収集対象に選びます。
- 選定を抜けた非公開データやsecretがstateや公開DTOから見つかったrunはfail closedとし、state、Pages、Discordを更新しません。
- snapshot、日次履歴、AI cache、通知ledger、run reportは専用の`tracker-state` branchへ保存します。

## はじめかた

Node.js 24.11.1とpnpm 10.33.4を使います。

```console
corepack enable
pnpm install --frozen-lockfile
pnpm dev:web
```

`pnpm dev:web`はサンプルの公開データでWeb UIを起動します。
開発コマンドの一覧とCLIの動かし方は[開発手順](docs/DEVELOPMENT.md)にあります。

## 文書

| 文書                                   | 内容                                              |
| -------------------------------------- | ------------------------------------------------- |
| [開発手順](docs/DEVELOPMENT.md)        | 手元での開発、評価、Pull Request前の確認          |
| [アーキテクチャ](docs/ARCHITECTURE.md) | モジュール境界、日次処理、公開guard、state branch |
| [デプロイ手順](docs/DEPLOYMENT.md)     | GitHub App、Actions、Pages、secretの設定          |
| [運用手順](docs/OPERATIONS.md)         | 日々の監視、stage実行、誤判定の修正、障害対応     |
| [要求定義](docs/REQUIREMENTS.md)       | 目的、状態モデル、規範要求と受入条件              |
| [実装方針](AGENTS.md)                  | 実装時に守る制約                                  |
| [参照資料](docs/RESEARCH_SOURCES.md)   | 設計の根拠にした公式資料と実例                    |
