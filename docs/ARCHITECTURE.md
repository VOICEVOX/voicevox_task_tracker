# アーキテクチャ

VOICEVOX Task Trackerは、GitHubから得た確定情報を決定論的に評価し、未回答の依頼やIssue全体の実質担当のような曖昧な自然言語だけをCodexで補う日次バッチです。
結果は型付き依存グラフと追跡stateへ集約し、GitHub PagesとDiscord向けの公開データへ変換します。

## モジュール境界

| モジュール                                                               | 責務                                                                                       |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------ |
| `src/application/tracking-run`                                           | canonical stageの順序、判断、入力と出力、proof、checkpoint・receipt・markerの契約          |
| `src/domain`、`src/graph`                                                | 状態、責務、停滞、重要度、要対応度、関係と依存グラフのpureな判定                           |
| `src/infrastructure/tracking-run`                                        | stageのportをGitHub、Codex、Git、Pages、Discord、時計、digest計算へ接続する                |
| `src/cli`                                                                | 引数の検証、実アダプターの合成、applicationへのdispatch                                    |
| `src/github`、`src/codex`、`src/persistence`、`src/pages`、`src/discord` | 各サービスと保存・公開処理のadapter、個別のpure leaf契約                                   |
| `src/canonical-json`                                                     | canonical JSONの値と直列化、SHA-256値のpureな検証。Node.jsによるhash計算はleaf契約と分ける |
| `src/config`、`src/diagnostics`                                          | 設定の検証、公開要約と暗号化する詳細診断                                                   |
| `web`                                                                    | 公開DTOを検証し、項目、担当者、通知履歴を表示する                                          |

application、domain、graphからCLI、infrastructure、環境変数、ファイルシステム、ネットワークへ依存しません。
副作用を持つbarrelからpure contractをimportせず、所有するleafを直接参照します。
CLIがinfraのadapterを組み立て、applicationがportを通して副作用を要求します。
`pnpm lint`はこの依存方向を検査し、`check:dependencies`はsrcとwebの静的importとexportの循環を拒否します。
型専用のimportとexportも依存辺として検査します。

## canonical stageは直前の成果物を受け取る

業務stageの正本と順序は`src/application/tracking-run/contracts/closed-values.ts`と`engine.ts`です。
各stageは直前の成果物だけを受け取り、自分が所有する判断を確定します。
下流へ不要なbase state、session、API client、CLI requestを渡しません。
下流は確定したallowlist、AI採用、最終graph、個人原因、通知候補、固定outboxを再判断しません。

| 順序 | stage                                  | 確定する値                                                                   |
| ---- | -------------------------------------- | ---------------------------------------------------------------------------- |
| 1    | `prepared`                             | run identity、設定digest、実行policy、同じrevisionから読み移行したbase state |
| 2    | `inventory_collected`                  | 公開repository inventory、選定済みallowlistとdigest                          |
| 3    | `collected`                            | 正規化した観測値、source catalog、収集後に固定した評価時刻                   |
| 4    | `deterministically_analyzed`           | 追跡対象、初期状態・責務、関係候補、AIへ渡す確定事実                         |
| 5    | `generic_ai_planned`                   | 9要素ごとの必要性、意味入力、fingerprint、予算計画                           |
| 6    | `generic_ai_executed`                  | 実行・再利用・失敗・延期の結果と消費予算                                     |
| 7    | `generic_ai_adopted`                   | schema・semantic検証を通った要素の採用と生成元                               |
| 8    | `graph_reconciled`                     | 2回の項目統合と最終graph、重要度、要対応度、AI依存                           |
| 9    | `personal_reminder_planned`            | 最終graphに基づく個人原因、責務・根拠・時計、残予算の計画                    |
| 10   | `personal_reminder_executed`           | 個人原因の意味評価と再利用・失敗・延期                                       |
| 11   | `personal_reminder_finalized`          | 採用結果、現在対応、通知へ渡す原因の最終値                                   |
| 12   | `validated`                            | 完全性、sourceと生成元の結合、公開安全性                                     |
| 13   | `publication_planned`                  | 保存内容、通知action、固定outbox、公開計画                                   |
| 14   | `initial_state_committed`              | checkpointから保存した初回state commitのreceiptと再読込値                    |
| 15   | `initial_pages_prepared`               | 初回保存revisionから投影した公開DTO、Web出力全fileのmanifest                 |
| 16   | `initial_pages_published`              | Pages actionまたはrecording portの検証済み公開結果                           |
| 17   | `notifications_settled`                | 固定outboxの送達結果、ledger、送信履歴、settlement receipt                   |
| 18   | `run_finalized`                        | 完了時刻・実測値・追跡開始時刻を確定した最終state commit                     |
| 19   | `notification_history_pages_prepared`  | 最終stateから生成する通知履歴Pages、または不要という結果                     |
| 20   | `notification_history_pages_published` | 通知履歴Pagesの公開結果、または公開不要という結果                            |
| 21   | `completed`                            | 検証したreceipt chainとrun全体の完了結果                                     |

公開repositoryはinventoryで一度だけ選定します。
前回stateにあるrepositoryが今回非公開なら、選定前に停止します。
GitHub clientとtokenはinfra内に保持し、stage出力へ含めません。
汎用AIの選択外要素は生成・採用し直さず、採用値と生成元を下流まで保ちます。
個人催促は最終graphを使い、validationは確定済みの原因・現在対応・時計を再導出しません。

`daily`、`dry-run`、`backfill`と、直列・分割workflowは同じbusiness stageを使います。
違いは入力範囲、effect target、通知actionを表すpolicyだけです。
dry-runはrecording portで保存・公開・送達・完了まで進み、external state、Pages、Discordを変更しません。
sandboxはsandbox stateを更新し、PagesとDiscordをrecording portへ接続します。
sandboxのworkflow排他groupは対象environment ID単位です。createは新ID、resetは旧IDをgroupに使います。resetは旧環境の読込から新環境の確定まで旧groupを保持し、新branchを`preparing` manifest付きで不存在CAS作成します。`preparing`の新環境への通常continueとdisposeは副作用前に拒否します。異なるenvironmentは並行実行でき、同じenvironmentの操作にはActionsの既定のpending置換規則が適用されます。
新環境のtracking、Pagesと通知のrecording receipt、finalization、対象scenarioのcoverageを検証し、旧環境のheadを再観測してからmanifestだけをCAS commitで`ready`へ進めます。このcommitは`sandbox_manifest` scopeで、完了markerと変更pathを検証します。新branch作成後に失敗しても自動削除せず、`preparing`のまま保持します。復旧の所有者はmanifestに固定した元Actions runとcode revisionです。source branchの現在のheadから旧効果の帰属を判断しません。確定receiptがある場合だけ元runtimeでstateとreceiptを再検証して`recover-reset`でready化を再試行します。曖昧な通知で停止した場合は、元runの終了、旧環境head、現在のreusable workflowと旧定義の一致を効果前に確認し、`resume-preparing`で元runtimeの同じrunを手動解決します。外部からのstate更新にはCASとleaseの検証を維持します。
productionのPages deployはActionsのaction境界で行います。
直列production CLIにはPagesの直接deploy adapterがないため、本番の通し実行は日次workflowを使います。

## checkpoint、receipt、markerで公開順序を検証する

公開計画からschema version 24の`validated-run.cpk`とsidecarを作り、論理checkpoint digest、file digest、runtime identity、base revisionを照合して結合します。
snapshot本文は`validatedPayload.snapshot`だけへ保存し、公開計画の初回state write setはそのdigestを参照します。
復元時は同じsnapshot objectをwrite setへ渡し、保存するstateのcanonical digestまで照合します。
`.cpk`は1MiB以下のcanonical manifestと順序付きgzip frameで構成します。manifestはframeの順序、件数、非圧縮byte数とSHA-256を固定します。
非圧縮frameは32MiB以下、合計は512MiB以下、圧縮file全体は128MiB以下に制限します。論理checkpoint digestはmanifestの論理値、file digestは`.cpk`の全byteから求めます。
旧versionのcheckpointは現行codecへ移行せず、記録されたexact runtimeで検証します。
source参照の解決結果は、照合した事実または履歴recordとannotationのcanonical JSONから求めたSHA-256を`recordDigest`に保存します。
元の事実、所有範囲と保存位置を持つ履歴、AI結果の由来をwitnessに保持し、再読込時に各参照を再解決してdigestを照合します。
checkpointには前回の送信待ち通知の原因と所有範囲を示すwitnessを必ず含めます。
最終追跡項目の汎用AI状態が今回の解析値か前回からの保持値かを、全項目分の由来記録としてcheckpointへ保存します。
由来記録は項目ID順で重複を認めず、追跡項目との一対一対応、repositoryの所有、同じ項目が収集値にもある場合のAI状態の一致を再読込時に検証します。
結合時には固定baseの前回snapshotを読み直し、保持項目のrepositoryと`aiAnalysis`全体を比較します。結果が空でも実行状態、適用元、証明を省きません。
旧snapshotの移行で原因の時計が`reconfirmation_pending`になった場合は、前回通知の`event`時計と時刻、source IDが一致するときだけ対応を認めます。
前回通知のsource参照は固定baseの前回snapshotにあるEvidenceで証明し、現行観測を根拠にしません。
結合時には同じ固定baseからwitnessを再構成し、前回通知台帳との一致も検査します。
artifact内のdigestは保存値同士の整合性を検査するもので、独立した生成元の認証ではありません。
proofは非公開brandとconstructorを持つvalidatorだけが発行します。
初回commitの入力は結合済みcheckpointに限定します。
codecは検証後のraw payloadとraw公開計画を返しません。結合後は識別情報、公開計画、公開設定、repository inventory、AI候補数と結合証明だけを保存処理へ渡し、witnessや検証前後のpayload全体を保持しません。
直列runの保存待ちAI cacheと公開計画の一致は、checkpointの準備が完了する前に検証します。
保存後はメモリ上の計画を破棄し、結果revisionからsnapshot、record、markerとledgerを再読み込みます。
日次runでは、CASまたはreceiptの検証境界内でexact revisionのpath、実byte、commit metadata、検証済み値を共有します。Git祖先は一度の走査でtransaction遷移とreceiptの親を確定し、検証した親を次の周回へ渡します。
schema version 23のfileは、byteのfingerprintとschema、canonical形式、semantic検証の証明をrun内で保持します。各stageでは全pathと実byteを取得し、同じrevisionで一度でも照合したbyteやcommit metadataが変われば拒否します。新しいrevisionでは変更fileを完全検証し、親、変更manifest、marker、operation、record、通知の全message条件を検証します。
公開済みrevisionの証明は、push後の公開headとreceiptを確認してから発行します。receiptの再観測では、Git祖先の検証に使った各revisionのpath、byte、commit metadataを再取得し、一致した場合だけchain証明を使います。
証明は日次dependencyのfactory、run世代、state設定、固定したadapter実体へ結合し、runの終了時に破棄します。snapshot、transaction、tree、raw byteを長く保持せず、検証境界内のraw treeと復元した値も現在と比較対象程度に限定します。
日次runの開始時にadapterを一つ生成し、全methodの関数参照と呼出先を固定します。snapshot version 21・22は保存時の形式で完全検証し、運用通知だけのcommitは独立scopeと保護byteの検証を通します。検証済みの値はfreezeし、候補callbackには複製したbyteを渡して終了後も一致を確認します。
初回履歴と追加AI cache、個人催促AI cacheの業務値はcheckpointのdigestに結合します。初回commitでは固定baseから履歴を再構成し、保存する履歴とcacheの実byte、保存先、変更pathをcheckpointのwrite manifestと照合します。
完了済みの旧snapshot version 21・22でrecordにwrite manifestとそのdigestがない場合は、旧schemaとrecord digestを検証し、初回commitと親の全treeおよびGitの変更一覧から可視のwrite manifestを復元します。親snapshotは親treeの旧AI cacheと初回runの設定timezoneを使い、初回runの保存版に合わせて移行します。親の評価時刻には親snapshotの生成時刻を使います。初回snapshotの生成時刻とgraph timezoneは旧recordに照合します。親のgraph timezoneは初回runと異なっていても保持します。
旧recordの入力event digestは再取得した項目の全入力を対象とし、初回履歴recordには新規入力だけが残ります。親treeの全日次履歴から既存入力の属性を復元し、新規入力を含む項目は必須、既存入力だけの項目は候補として12件まで列挙します。保存済みdigestに一致する全入力が一意に定まり、その入力と親snapshotから再生成した初回履歴byteがtreeと一致するときだけ受理します。追加cacheは旧recordの集合digest、実byte、変更pathと照合します。履歴属性の欠損や競合、候補の不一致や複数一致、上限超過、変更一覧に現れない追加cache、repository除外などの根拠を証明できない場合は読み込みを停止します。旧完了runの全件を移行できる保証はありません。

初回state commitではsnapshot、履歴、追加AI cache、通常通知ledger、durable record、markerをCASでまとめて保存します。
同じcommitで移行対象の旧cacheと前runの初回Pages証拠を削除します。
実際の親、変更path manifest、公開安全性をpush前に検証し、直交する運用通知commitだけを許可条件付きで跨ぎます。

receiptはrun・checkpointへの結合、operation ID、attempt ID、実測時刻、結果digest、親receiptを保持します。
receipt chainは順序と前後の結果を照合し、artifactがあるだけで外部effectの成功と見なしません。
固定pathは次の3つです。file名のV1はpath契約の識別子で、record本文のschema versionとは別です。

| 固定path                                           | 内容                                                                |
| -------------------------------------------------- | ------------------------------------------------------------------- |
| `state/durable-publication-record-v1.json`         | checkpointとruntime identity、回復計画、公開allowlist、固定outbox   |
| `state/run-transaction-marker-v1.json`             | run・checkpoint・recordのdigest、phase sequence、期待する親revision |
| `state/initial-pages-publication-evidence-v1.json` | 初回Pages buildと公開結果の結合、adapter identity                   |

markerのphaseは`initial_state_committed`、`notifications_in_progress`、`notifications_settled`、`run_finalized`の順です。
送達中のcommitでは`notifications_in_progress`を繰り返せます。送信不要なら初回phaseからsettledへ進みます。
同じrunのphaseは後戻りせず、通知開始後は同じrunの初回Pages証拠を必須にします。

初回Pages成功後だけDiscordへ進みます。
送信直前にmessage単位の`delivery_started`を保存してpushし、送信結果、ledger、履歴をcommitしてから次のmessageを送ります。
曖昧な送達は自動再送せず、同じrunのsettlementとfinalizationを停止します。
全messageの処理後にrunをfinalizeし、その後で通知履歴Pagesを公開します。
通知履歴Pagesの失敗はfinalizationを取り消さず、保存済みの通知を再送しません。

## 起動時はbootstrapからruntimeを選ぶ

現行制御runtimeは同じexact state revisionのmarkerとrecordからbootstrapだけを読みます。
両方がない場合、または整合した完了済みrunの場合はcurrent runtimeで新規runを始めます。
未完了runは記録されたexact runtimeへ渡し、current runtimeで業務payloadをparse・migrationしません。
片方の欠落、digest不一致、runtime再現不能、別runやheadの競合では停止します。

V2は二段階で起動します。
現行制御runtimeが記録されたcode revision、lockfile、toolchain、bundle manifest、全fileのbyte列とdigest、固定entrypoint、adapter identityを検証します。
exact runtimeの`inspect`がcheckpointとstateを検証して次stageを返し、`execute_stage`、Pages action後の`record_pages`を一段ずつ呼びます。
再開時にGitHub再収集やAI再計画を行いません。
bundleが消失した場合は同じsourceから再生成し、記録されたdigestに一致した場合だけ使用します。
現行Pages YAMLの実効job条件、権限、外部actionのSHAを記録元と比較します。
両Pages jobは先頭で記録されたsourceをcheckoutし、local actionと参照scriptはそのexact sourceのbyte列で照合します。
checkoutのref、配置先、取得元、実行条件、後続checkoutがこの経路を変える場合はeffect前に停止します。

V1は固定input/outputとentrypointを持つ回復protocolとして扱います。
静的action adapterへ対応付ける前に、adapter identityとaction SHAが登録値に一致することを検証します。
未知のadapterや実行不能なready-only bundleを現行CLIの業務commandへ置き換えません。
V2の手動解決も固定operationを使い、V1へCLI commandのfallbackを作りません。
凍結されたsourceの配置とpath列もdigestの入力です。選択元の配置で当時のpathとbyte列をhashし、現行の配置へ読み替えません。

## failure artifactは失敗したoperationの証拠を残す

失敗stageはcanonical stageに加え、`prepare`、`runtime_bootstrap`、`runtime_selection`、`runtime_launch`、`workflow_effect_observation`、`checkpoint_encoding`、`checkpoint_binding`を区別します。
公開failure artifactはbinding evidence、failure kind、直前の検証済みreceipt、`failedOperationEffectCertainty`、recovery disposition、暗号化診断の参照を保持します。
run IDがないpre-runと、bootstrap・pre-checkpoint・checkpoint以後では別のbindingを使います。

`failedOperationEffectCertainty`は失敗したoperation自身の`no_effect`、`committed`、`ambiguous`です。
先行stageの成功やstate変更だけで、今回の失敗をcommittedにしません。
公開境界違反は通常保存、Pages、Discord、運用障害通知を停止します。
運用通知は専用state branchの送信予約とreceiptを使い、曖昧な送達を自動再送しません。

詳細なstack、cause、Codexのstdout・stderrは公開failureへ入れず、runnerの一時JSONLへ記録します。
productionではAES-256-GCMで暗号化したdiagnostics artifactだけを保存し、平文は削除します。
暗号化処理自体の失敗も独立したfailure artifactで報告します。

## 重要度の計算

重要度は`src/domain`のpureな判定で計算します。
停滞レベルとは独立した値です。
`GraphReconciledRun`は最終graphの解析結果を`src/domain`の規則へ渡し、重要度と要対応度のscoreとlevelを確定します。

| 入力                      | 依存する情報                                               |
| ------------------------- | ---------------------------------------------------------- |
| 優先度ラベルの重み        | 現在のラベルと`labels.rules`                               |
| downstream impact         | 最終graphが算出した停止中のopen項目数とリポジトリ数        |
| Codex由来の2要因          | schema検証とsemantic検証を通った重要な機能、将来問題の判定 |
| 各要因の重みとlevelの閾値 | `config.yml`の`importance.weights`と`importance.levels`    |

Codex由来の2要因はconfidenceがmedium以上の場合だけ加点します。
そのrunで利用できる判定がない項目は前回snapshotの判定を再利用し、前回判定もなければ決定論的な要因だけを使います。
優先度ラベルとdownstream impactの決定論的な要因は現在の入力から毎run計算します。
`src/domain`は要因の加点を0から100の整数へ収め、設定した閾値からlow、medium、highを決めます。

Codexは本文とコメントから時刻を含まない期限日を抽出し、snapshotは日付と根拠を保存します。
`src/domain`は設定タイムゾーンの現在日と期限日を比較し、期限なし、30日超、30日以内、7日以内、3日以内、1日以内、期限超過の順に切迫度を決めます。
期限日を再抽出しなくても、切迫度は毎run更新されます。

## 要対応度の計算

要対応度は`src/domain`のpureな判定で、重要度、期限の切迫度、停滞の鮮度から計算します。
停滞が長い項目は対応が不要だった場合が多いという前提に立ち、重要度が低いまま最近動いただけの項目を上位へ置きません。

```text
鮮度係数 = recencyFloor + (1 - recencyFloor) × 0.5 ^ (停滞時間 ÷ watch閾値)
importanceCapacity = 100 - deadlinePoints.overdue
recencyScore = round(重要度スコア × 鮮度係数 × importanceCapacity ÷ 100)
要対応度スコア = recencyScore + 期限の切迫度加点
```

停滞時間は`stallSince`からrun開始時刻までの経過時間です。
watch閾値は項目のwait classに対応する`staleness.thresholdsHours`の`watch`で、鮮度係数の半減期として使います。
`attention.recencyFloor`の既定値は0.4で、停滞が伸びても鮮度係数は0.4を下回りません。
scoreは0から100の整数で、`attention.levels`の閾値からlow、medium、highを決めます。
既定の下限はhighが40、mediumが20です。
terminal項目と`waiting_for_unblock`の項目は、自身が動けないためscoreを0にします。

要対応度はGitHub側の変更有無にかかわらず、最新の重要度、期限の切迫度、停滞時間、設定から毎run全項目で再計算します。
Codexとgraphは要対応度のscoreとlevelを直接決めません。

## 判定規則の変更と再判定

増分収集はGitHub由来の項目fingerprintが前回と一致する項目の詳細取得を省きます。
詳細を取得しない項目は状態機械へ渡らず、前回snapshotの判定結果をそのまま引き継ぎます。
このままでは判定規則を変えても、GitHub側が動いていない項目の判定が古いまま残ります。

そのため、項目ごとに判定規則fingerprintをsnapshotへ保存し、現在値と異なる項目を詳細取得の対象へ加えます。
判定規則の比較では、項目種別に対応する決定論的規則versionと、AI要素ごとの意味上のrevision、revisionごとの関連入力projection、実際の意味依存を区別します。
各変更は項目と要素ごとに`unaffected`、`deterministic`、`interpretation_required`、`unknown`の影響を宣言します。複数revisionの変換は旧値から一つずつ現在値まで照合し、途中の対応を確認できない場合は`unknown`とします。新しい抽出は採用済みかどうかにかかわらず対象にし、取消だけは採用対象がない場合に限り再判定対象から除外できます。
Issueの規則だけを変えた場合はIssueを再取得します。
AIの規則変更は判定要素ごとに調べ、コードだけで確定できる判定や、影響しない保存結果を巻き込みません。
詳細取得前に必要性を確定できない場合は情報を取得し、その後の要素選別でAI呼び出しの要否を決めます。

判定規則fingerprintを現在値で保存するのは、そのrunで実際に再判定した項目だけです。
再判定していない項目に現在値を書くと、古い判定のまま最新規則で判定済みと記録され、以後再判定されなくなります。
検査するのは前回snapshotに判定結果を持つ項目だけです。追跡対象外の列挙項目には引き継ぐ判定がないため、毎回の再取得を避けます。

汎用AIの要素への影響が`unknown`なら前回の採用値を履歴として保持し、現在の項目判定や通知へ使いません。前回の推定relationは、今回も同じ候補があり、判定が欠けている場合だけ未検証の辺として保持します。

前回の`aiAnalysis.status`が`failed`か`deferred`の項目も、GitHub側の変化と判定規則fingerprintにかかわらず詳細取得の対象へ加えます。
AI分析の失敗と延期はGitHub側を動かさないため、この扱いがなければ縮退した判定が固着します。
terminal項目も同じ扱いにし、次回runで必ずAI分析を再試行します。
正常に完了した低信頼または棄権の評価も完了結果として保持します。失敗や延期から新しい完了proofは作らず、現在の条件で未完了の要素を再試行します。

汎用AIの判定は状態、待ち相手、次の行動、関係、進捗、重要度、期限、通知推奨、selfCommitmentの9要素で選別します。
入力schemaは5、出力schemaは7、snapshotは23とします。
旧snapshotは保存時のschemaと意味revisionで検証してから移行します。現行の入力投影versionで検証できない採用値は理由を付けて履歴に保持し、現在値へ採用しません。その値に基づくAI依存を未検証として再分類した後、最終graph投影を確定します。
各要素のrevision、必要条件、入力投影、利用先、出力schemaは`src/codex/generic-ai-definition.ts`で対応付けます。`GenericAiPlannedRun`が選択要素と理由を項目ごとに固定し、`GenericAiAdoptedRun`が新規結果、cache、前回snapshotを同じ規則で採用します。表の意味入力は要素別fingerprintの対象であり、汎用AIへ渡す入力全体ではありません。

| 要素             | revision | 必要条件                                                                                       | 意味入力fingerprintの対象                                                  | 主な利用先                     |
| ---------------- | -------: | ---------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- | ------------------------------ |
| `status`         |        1 | 状態を決定論的に確定できないか、未解決の依頼・CI失敗・実質担当候補がある                       | 項目全体、待ち相手候補、本文・コメント・レビュー、状態系の確定signal       | 状態と停滞の判定               |
| `waitingOn`      |        3 | 待ち相手を決定論的に確定できないか、未解決の依頼・CI失敗・実質担当候補がある                   | 項目全体、待ち相手候補、本文・コメント・レビュー、状態系の確定signal       | 待ち相手、実質担当、停滞の判定 |
| `nextAction`     |        1 | 次の行動を決定論的に確定できないか、未解決の依頼・CI失敗・実質担当候補がある                   | 項目全体、待ち相手候補、本文・コメント・レビュー、状態系の確定signal       | 次の行動の表示                 |
| `relations`      |        2 | 未解決の推定関係候補がある                                                                     | 項目基本情報、関係候補、関係・本文・コメント・レビュー、関係系の確定signal | 関係の採否とgraph              |
| `progress`       |        1 | 本文のあるhuman commentイベントがある                                                          | 項目基本情報、本文・コメント・レビュー                                     | 進捗評価と停滞起点             |
| `importance`     |        1 | 確定判定以外・実質担当候補・人の進捗候補・推定関係候補のいずれかがあるか、前回の評価が利用可能 | 項目基本情報、本文・コメント・レビュー                                     | 重要度と要対応度               |
| `deadline`       |        1 | 確定判定以外・実質担当候補・人の進捗候補・推定関係候補のいずれかがあるか、前回の評価が利用可能 | 項目基本情報、本文・コメント・レビュー                                     | 期限日と要対応度               |
| `notification`   |        1 | 非terminalのCodex候補で、native blocker・自動化ノイズ・通知抑制ラベルがない                    | 項目基本情報、全候補、本文・コメント・レビュー、状態系の確定signal         | 通知推奨                       |
| `selfCommitment` |        1 | 観測期間内の未編集human comment候補がある                                                      | 項目全体、自己申告候補、本文・コメント・レビュー                           | 自己申告原因による通知抑制     |

要素別の計画は意味入力そのものと、そのcanonical JSONから作ったfingerprintを一緒に保持します。入力投影version 2では、要素に意味のある選択状態と、自身以外の固定contextも意味入力に含めます。statusとwaitingOnは互いの選択状態を含みます。評価時刻の経過だけではfingerprintを変えません。決定論的な値と現在入力で再利用を証明した保存済みAI値だけを固定contextに使い、要素別の最終意味入力を確定してからcacheを照合します。cache hitの値を照合後の輸送入力へ追加せず、missだけを選択した実輸送入力で費用を予約します。statusとwaitingOnの片方だけがcache hitなら両方を実行し、ほかの要素は個別に再利用します。AI無効、不要、現在の完了結果の再利用、強制解析による延期も要素ごとに区別します。
採用段階は要素ごとに実行状態、採用値、保持値、生成元、現在性、適用元、AI依存を一つの記録へ確定します。失敗や延期の後も現在の入力に一致する前回の完了値を使い、入力が一致しない値は未検証理由を付けて履歴に保持し、現在値には採用しません。採用後のrunはAI送信用の厳密入力を保持しません。

selfCommitmentは他の要素から独立して扱い、他の要素のprojectionへ専用の観測期間を混ぜません。
selfCommitmentの候補は前回`observedAt`より後、今回の評価時刻以前の未編集human commentに限り、source authorとtimeline event actorが同じhumanであることを確認します。前回観測がない場合は追加推論を行いません。通知時は現在の`waitingOn`が単独のhuman userであり、そのactorと一致することを決定論的に確認し、他者、混在、不明、依存解消の原因は通知を残します。
該当する申し出がない場合、selfCommitmentの値と根拠はともに空配列にし、正常に完了した評価として保持します。申し出がある場合は、値と根拠を同じ候補コメントのsource IDで結び付けます。
各要素の必要性を既存の確定情報と利用箇所から判断し、必要な要素だけ保存済み結果と比較します。
根拠、信頼度、不確実性は所有する判定にまとめ、生成したrevision、入力、実行条件、実行時刻を保持します。
期限なしや通知を推奨しないという結果も、有効な分析結果として比較します。
relation候補を否定した結果、意味のある進捗ではないという結果、重要度要因に該当しないという結果も、反対の判定なら最終値が変わる間はAI依存のproofに含めます。
snapshotに有効な結果があればcache欠落だけで再生成しません。
生成結果と生成時の情報は変更しません。正常に完了した評価は値と`evaluationProof`、現在採用している結果は値と`reuseProof`を組にして保存します。
新しい結果が低信頼でも、保持する以前の値の根拠や生成元を失わないためです。

一項目で必要になった要素は1回の呼び出しにまとめます。
選択外の保存値は再採用し直さず保持し、選択結果と合成した状態の整合性を検証します。
AIへ渡す固定値の文脈と、保存する判定結果は分けます。
固定値の文脈には値、信頼度、不確実性を含め、過去の根拠への参照は保存する判定結果に保持します。
新しい判定の根拠は、その呼び出しの入力に含まれるGitHub情報で検証します。
選択結果がすべて検証を通った場合だけまとめて保存し、失敗・延期した結果を適用済みのrevisionで記録しません。
状態、待ち相手、次の行動を同時に再評価した結果の一部を採用できない場合は、依存する新しい判定も採用せず、以前の整合した組合せを保持します。
既存のIssue・PR間グラフは確定関係や依存先の判断に使いますが、AI要素の必要性や入力依存は別に定義します。
収集には判定計画の規則fingerprintを保存し、確定規則やAI規則が変わった項目を必要性の再評価へ届けます。
判定要否を確認するための詳細取得が終わっていない項目は、計画済みとして記録しません。計画の完了とAI分析の成功は別に扱います。
このfingerprintはAI結果の再利用条件には使わず、呼び出しの要否は各要素の入力、revision、実行条件で決めます。

決定論的規則versionとAI判定要素のrevisionは、コードで管理する定数です。
AIのrevisionは意味上の判定規則を表し、プロンプトの共通本文の変更だけで全要素を無効化しません。
変更する開発者が全要素への影響を判断し、必要なrevisionだけを上げます。
具体的な判断基準は[開発手順](DEVELOPMENT.md)の「Codexプロンプトのversionを判断する」を参照してください。
現行の決定論的規則versionはIssueが`issue-v14`、Pull Requestが`pull-request-v12`です。

要対応度は前回の判定結果を引き継がず毎run全項目で再計算するため、要対応度だけの変更ではIssueとPull Requestの決定論的規則versionを上げません。

詳細取得対象に選んだ項目は、理由にかかわらずtimelineを`since`なしの全履歴で取得します。
停滞起点はtimelineイベントの再生から決めるため、過去のイベントが見えていないと下限まで落ちてしまいます。
同じGitHub状態ならtimeline sourceとrelationが毎回一致し、AI入力hashと隣接graph hashも安定します。

## 個人催促の原因と意味評価

個人催促は、`personal_reminder_planned`、`personal_reminder_executed`、`personal_reminder_finalized`の3段階で処理します。

1. `src/application/tracking-run/stages/personal-reminder-plan.ts`は、型付きの収集結果、Issue・PRのローカル判定、前回state、最終graphから原因を計画します。責務の範囲と時計の入力を組み立て、原因がない項目も項目計画へ含めます。
2. `src/application/tracking-run/stages/personal-reminder-execution.ts`は、計画した原因ごとに決定論的判定、再利用、AI試行の結果を結び付け、共有予算のledgerを更新します。
3. `src/application/tracking-run/stages/personal-reminder-finalization.ts`は、実行結果と保持結果を項目ごとに確定します。保持値のAI依存を最終適用元へ照合し、原因が参照する根拠を所有項目へ集めて、列挙計画と原因ごとの停滞を確定します。

最終正本は`PersonalReminderFinalizedRun.data.items`です。
各項目は原因と停滞の組を`causeResults`へ持ち、同じ項目の`evidence`と`planning`を一緒に保持します。cause、staleness、evidence、planningを別々の正本へ分離しません。
finalizationは、計画と最終項目の集合、原因の計画・判断・実行結果の集合が一致することを検証します。原因の所有項目ID、原因IDの一意性、原因と採用済み評価が参照する根拠の閉包も検証します。
これらの契約違反は例外として既存の診断経路へ伝播させ、AI失敗時の`fallback`へ変換しません。

`src/application/tracking-run/stages/`の個人催促stageは直前の成果物から結果を確定し、validationへ渡します。validationは通知候補とsnapshotへ結果を反映し、原因、現在性、停滞、根拠、列挙計画の最終値を再導出しません。
`PersonalReminderFinalizedRun`の項目、関係、AI採用値に、保存予定の履歴、AI cache、通知原因、未送信候補を加えて`EvidenceCatalog`で参照を閉じます。同じsource IDの不変fieldが衝突する場合や、参照元が欠落、非公開、未来時刻、別項目の所有に当たる場合は、保存、Pages生成、Discord通知の前に停止します。今回のsource事実と前回から保持する根拠を区別し、保持値から今回の根拠を作りません。
保持する汎用AI結果は、前回snapshotの追跡項目または収集項目に保存された同じ所有者・要素・result全体へ照合します。今回も同じsource IDを収集した場合に、この照合を省きません。今回の実行結果とcache採用結果は、確定した生成元と入力fingerprint、現行source事実へ照合します。分割workflowの初期保存前には基準revisionのsnapshotを読み直し、artifactの履歴AI記録と照合します。
閉包済みの項目と関係をsnapshotへ渡します。`src/persistence`は保存値の形と公開安全性を独立に検証し、根拠を補いません。
PagesとDiscordは、同じ保存済みの原因と現在性を表示・通知の判断に使います。

`src/domain/personal-reminder-causes.ts`の原因は、実行対象、責任主体の集合、行動、通知理由、責務期間を持ちます。`causeId`は同じ責務期間で安定させ、入力fingerprintや表示文の変化で作り直しません。複数reviewerの同じ依頼を人ごとの別原因へ分解せず、責任主体の集合として扱います。
公式のアサイン・レビュー依頼・担当決定などの規則による義務は`fixed`、自然言語の解釈を要する義務は`semantic`として区別します。採用済みの推定`implements`からIssue作業の候補を作る場合も、専用の意味評価で義務と実行可能性を確認します。これは項目全体の実質担当を変更しません。
責務の範囲は項目自身、関連PRだけ、両方を区別します。関連PRだけに由来する責務はそのPRの終了時に終え、独立したIssueの責務と時計は保持します。収集失敗や一時的なblock、意味評価の未確定を責務の終了にしません。

原因ごとにAIの必要性を選び、同じ項目で必要な原因を1回の呼び出しにまとめます。確定した義務で、関係による実行可能性・必要性・重複の解釈も不要なら決定論的に判定します。
専用の入力・出力schemaは1とし、`prompts/personal-reminder-causes.md`で判定を指示します。項目、active relation、その根拠の本文・会話・timeline、review・check・draft・merge状態、解決・撤回、収集完全性を、ローカル参照と原因別allowlistで渡します。GitHubの文章は非信頼データとし、旧AIの自由文や通知推薦を肯定根拠に使いません。
意味入力は全件の構造と意味を検証し、AI送信時の容量判定と分けます。送信する`scopes`の上限は、`sources`と`sourceRefs`と同じ500件です。型、ID、一意性、参照先の閉包、意味の整合性の違反や、容量内のschema違反は例外にします。
AIは各`causeId`について、`actionable`、`waiting`、`duplicate`、`not_required`、`unknown`のいずれかを返します。責任主体・行動・理由・時刻・閾値は変更させません。`actionable`には義務と実行可能性の双方の根拠が必要です。`fixed`の義務を`not_required`にはできず、情報不足は義務の否定に変換しません。
待機先と重複先は提示したoptionだけを選べます。同じPRのmergeがreviewを待つような同一項目の別行動も待機先にできます。異なる項目を待つ場合は、その行動に効くrelationの根拠を必須にします。native blockの事実はgraphと項目状態へ残し、その依存中にも特定行動が可能かだけを評価します。`related_to`だけでは個人催促を抑止しません。
optionの`targetScope`はrelationが接続する責務範囲で、`itemNodeId`は待機・表示の主項目です。relationは原因の責務範囲と`targetScope`の間を接続し、主項目への直接接続は必須にしません。候補は`current_draft`から作り、責務範囲全体の文脈と、`targetScope`の全nodeが入力の`items`に含まれることを保証します。未収集の端点は不完全な入力として扱います。保存する`waitingFor`と公開DTOが示す待機先は主項目です。

意味入力のfingerprintは、原因の責務範囲とoptionの`targetScope`を含む原因ごとの参照入力から作り、同じbatchの別原因や無関係な項目の変化では無効化しません。AI送信用の入力にも同じ責務範囲を渡し、relationの接続と参照先を検証します。時間の経過、閾値到達、説明文だけの変更は再推論の理由にしません。
個人催促AIの出力構造は、`src/codex/personal-reminder-output-schema.ts`のZod定義を正本とします。AIへ渡すJSON Schemaと受信時の型は、この定義から導出します。
出力の構造検証と対象項目の一致確認は別の段階で行い、失敗したbatchは採用しません。通過したbatchは、原因ごとの根拠や選択肢を意味検証して採用します。一つの原因の失敗で、他の原因の採用値とcacheを失いません。
`currentInput`、`latestAttempt`、`adoptedAssessment`を分けて保存します。実行状態は`not_evaluated`、`completed`、`failed`、`deferred`で表し、正常な`unknown`も`completed`です。採用値の入力fingerprintと規則版が現在値へ一致する場合だけ表示と通知に使います。新しい実行が失敗・延期しても、この一致を満たす採用値は有効です。不一致の旧採用値は根拠を追跡するため保持し、現在対応は未確定にします。

人物所属の表示現在性は、原因が現在存在するかと責任主体に必要な入力を常に含めます。意味評価は`semantic`原因で必須とし、`fixed`原因では現在有効な`duplicate` optionによって非canonicalになり得る場合だけ必須とします。評価が必要な原因は、行動と根拠に必要な入力と、最新assessmentを現在入力へ利用できるかも含めます。
有効な`duplicate` optionがある場合は、canonicalな原因を選ぶすべての候補について、必要な依存と直接relationを含めます。人物所属を変え得る`pending`候補は応答計画用候補と別に選び、その依存を含めます。待機中であることだけを理由とする候補は除き、その上流関係の未検証を人物所属へ伝播させません。

再利用は有効なsnapshotの採用値、専用cache、新しい呼び出しの順で判断します。正常な`unknown`は同一入力で再利用し、必要性が残る未評価・失敗・延期は入力不変でも再試行します。
不完全な入力はcache照合前に保留します。cache miss後、既知のcollection容量上限を超えた入力だけを`input_cardinality_limit`で延期し、他の原因やbatchは継続します。容量超過で`complete`を変更せず、内容の切断やbatch分割もしません。送信容量を超えていても、cache hitと決定論的判定は利用できます。
意味入力に既存schemaのいずれかの不足がある原因は終了させず、項目の個人原因計画を`pending`として次回の収集と再計画へ戻し、runを`fallback`にします。AIを実行しない場合も同じ扱いとします。原因単位では不完全なcauseだけAI・cache採用を延期し、同じ項目の完全な別causeは通常どおり更新します。一方、planning・再計画・fallback・個人催促通知は項目単位で、その項目に未確定入力が残る間は保留します。terminal項目でも未終了原因の入力が不完全なら`pending`を維持し、原因がないterminal項目だけを`excluded`にします。sourceの不在や`requestedAt`の不明だけでは原因を終了せず、完全な入力で既存の構造的終了条件が成立した場合だけ終了します。構造終了は最終候補集合へ投影した入力で確定し、不適格になった終了候補を同じ処理内で一方向に取り消します。
現在の意味入力と保存する根拠は分けます。現在のitem・relation・personal evidenceと前回snapshotのitem・relation evidenceをsource IDごとの全recordとしてunionし、保持causeまたは採用済みassessmentが参照する各sourceの全recordをcauseを所有するitemのevidenceへ加えます。同じsource IDでもrecord全体が異なれば保持し、完全一致だけを重複除去してcanonical JSON順に並べます。source IDだけを保存せず、旧recordへ現在のruntime source、時刻、意味入力を補いません。検証済みcurrent sourceからの決定論的なEvidence生成は許可しますが、staleな採用値だけから新しい根拠recordを生成しません。terminal項目にcauseが残る場合は詳細を再取得して再計画し、保持経路だけでcompletedにはしません。
new_draftのcause IDが旧cause IDと単独で衝突した場合も項目全体の継続競合とし、構造終了候補を全て取り消します。new seedとentryは作らず、旧causeと根拠を保持してplanning・再計画・fallback・個人催促通知を項目単位で保留し、次回へ回します。
関係AIと原因AIはCodex exec実試行数、入力量、見積費用のrun上限を共有し、後段は前段の使用量を引いた残予算から実行します。認証preflightは両段を通して必要なrunで1回だけ実行します。関係だけ成功した場合も採用済みrelationを保存し、原因の失敗・延期だけを再試行できます。関係入力が変わって前段が未確定なら、古い不適合relationで後段を実行せず`upstream_relation`で延期します。`pendingRelations`はこの判別とfingerprintに使い、AIへは送りません。
個人原因のcall数はrunnerの`executedBatchCount`を使い、preflightを含めません。全体のcall数と見積入力は両段とpreflightの累積値を使います。
初回は現在の収集結果にある責務と採用済み関係から有限個の原因を作り、意味評価が必要なものだけを選びます。列挙の完了とAI評価の成否は別に記録し、有効な採用値がなく必要性が残る未評価・失敗・延期は入力不変でも再試行します。以後は新しい原因と関連入力の変化も同じ規則で選びます。
runtimeの分析対象に含まれ、継続競合がない項目は`evaluated`経路へ渡します。今回の代表候補に現れない未終了の旧原因も最新入力で再評価します。たとえば同じPRがreview待ちに変わった場合も、継続中のmerge原因をそのreview待ちとして評価できます。
それ以外の追跡項目は`retained`経路で前回snapshotの原因・根拠・採用済み評価・時計を保持します。保持経路だけでは評価完了にせず、原因がないterminal項目だけを`excluded`にし、それ以外の列挙計画は`pending`にします。採用値を`unknown`へ書き換えず、AI依存を最終適用元へ照合したうえで根拠と停滞を確定します。

前回の項目、原因、意味入力、列挙計画が関係候補を参照している場合は、保存した両端を収集し直します。原因または列挙計画の両端と判定担当項目を今回の公開収集結果で確認できた場合は、今回の候補一覧に同じ候補がなくても、原因の親項目と保存した判定担当項目を汎用分析と個人原因の列挙へ戻します。取得できない端点がある場合は、前回の原因・根拠・採用済み評価・時計を保持し、項目の列挙計画を`pending`にします。

保持する原因と項目のAI依存は、最終的な項目の`applications`とactive relationへ照合します。関係候補の依存は保存したID・両端・判定担当を維持し、判定担当の最終`applications.relations`が`retained_ai`または`unavailable`なら`unverified`、`unknown`なら同じ理由を記録します。`current_ai`またはAI非依存でも、保持値に使った候補判定の現在性は証明できないため`proof_unknown`にします。今回入力と保持入力は生成時に区別し、合成が終わるまでその区別を保ちます。今回の候補依存は最終graphの判定へ、保持依存は最終適用元へ照合してから合成し、候補の再出現だけで保持値を`current`へ昇格させません。

保持値に記録された`migration`と`not_recorded`は、producerを照合できても理由として残します。`proof_unknown`は入力の由来と判定担当の最終適用元から再計算します。判定担当項目がないなど、解決できないproducerがある場合は`not_recorded`を加え、解決できたproducerと理由は保持します。`stale_repository`は履歴から持ち越さず、現在もstaleと確認した専用の経路でだけ付けます。
取得不能で保持するactiveな推定relationでは、理由を`migration`と`proof_unknown`に限ります。今回の候補に付いた`not_recorded`や`stale_repository`は、保持relationの履歴理由へ流用しません。
保持した推定relationの根拠、confidence、最終確認時刻は更新しません。今回の判定が`none`の場合や、同じ候補がなくなった場合はactiveな辺として保持しません。

open項目の列挙計画は`pending`にし、今回組み立て直していない値・採用済み評価・根拠・confidence・時計は保持します。この照合にはAIの追加実行を必要とせず、call上限に達した場合も行います。候補IDに対する両端や判定担当の不一致、今回使った候補や適用元の欠落は構造矛盾として例外にします。

前回の未終了原因に、項目・行動・責任主体・責務の`authority`が同じで継続一致が競合し得る複数の原因がある場合は、その項目を毎回、詳細収集と再計画へ戻します。今回の原因draftが複数の前回原因へ継続一致した場合だけ、その項目全体の前回原因・根拠・採用済み評価・時計を保持し、個人催促のAI候補から外してrunを`fallback`として診断します。継続競合は`retained`経路へ`force_pending`として渡し、保持依存を最終適用元へ照合して列挙計画を`pending`にします。毎回新しい原因draftで判定し、一致する前回原因が1件以下になれば通常計画へ戻します。永続的な除外markerは保存しません。

## 停滞起点の決定論性

項目全体の停滞起点`stallSince`はGitHub由来の時刻だけから決めます。
走査した時刻も、過去に何度走査したかも、起点には影響しません。
同じGitHubデータなら、いつ走査しても同じ停滞時間になります。

状態機械は、現在の状態が始まった時点をtimelineイベントの再生で求めます。
担当区間はassignとunassign、および未アサインIssueの実質担当が成立した根拠source、draft区間はdraft変換とready for review、
merge queue区間は追加と削除、ラベル区間は付与と削除をそれぞれ時系列で再生します。
実質担当はIssue全体への根拠が最新の状態で有効な場合だけ成立し、撤回、延期、引継ぎ、正式assigneeの設定などの最新情報で再判定します。正式assigneeを解除した場合は、解除前の根拠を再利用しません。単なる活動時刻は実質担当を成立させません。

GitHubが時刻を持たない場面では、決定論的に決まる下限を使います。

| 場面                      | 下限                                 |
| ------------------------- | ------------------------------------ |
| 区間の開始イベントが無い  | 項目の作成時刻                       |
| native dependencyの成立   | 関係の両端の作成時刻のうち遅い方     |
| conflictやmerge可能の成立 | head commitのpush時刻                |
| Codex由来の判定           | 判定根拠となったsourceの時刻の最大値 |

遷移根拠の`precision`はこの区別を表します。
`event`はGitHubのイベント時刻そのもの、`inferred`はGitHub由来の時刻から導いた下限です。

停滞起点は一度確定するとstateへ保存し、statusと責務が変わるまで引き継ぎます。
起点からrun開始時刻までの経過時間を毎回求め直し、停滞レベルと要対応度の算出に使います。

停滞起点には、現在の待ち先本人がGitHub上で活動した時刻も下限として効きます。
`kind: "user"`の候補だけが責務アカウントを持ち、そのGitHubアカウントの活動を対象にします。
`kind: "team"`の候補は責務アカウントを持たず、コメントした人のteam所属から責務主体の活動とみなすことはしません。
第三者の一般コメントやbotの活動、draft戻しやmerge queueの出し入れは対象外で、停滞を解除しません。
活動は既存の待ち先の停滞起点にだけ使い、新しい実質担当者の推定には使いません。

PRのレビュー担当選定待ちとレビュー待ちでは、全体の進捗と、待っている対応の進展を分けます。
`lastProgressAt`は作者のpushなどを含む全体の進捗を記録します。
この2状態の`stallSince`には、待ち期間の開始、現在の待ち相手本人の活動、人間のレビューを反映します。作者のpushや第三者の一般コメントは反映しません。
teamへの依頼でも人間のレビューは進展として扱いますが、コメントした人のteam所属は推定しません。
同じレビュワーへの新しいレビュー依頼は、GitHubの依頼イベントを根拠に新しい待ち期間とします。

Issueの議論・作業、PRの修正・返答・自動処理・マージ・Draft、依存項目待ちは、各状態の進捗判定を使います。
規則versionの更新で上記2状態を再判定するときは、状態と責務の開始時刻を維持し、停滞起点を取得したイベントから再計算します。
詳細取得に失敗して保持する項目は、保存済みの起点を維持します。
待ち先本人が動いていない項目は作成時刻まで下限が落ち、長い停滞として残ります。

人間コメントを意味のある進捗と認めるかはCodexの判定に委ねているため、
AI判定を行わなかった項目では`lastProgressAt`が作成時刻のままになります。
待ち先本人の活動を下限に加えることで、AI判定の有無によらず停滞時間が決まります。

関係edgeが成立した時刻は、根拠となったsourceの発生時刻のうち最も古いものにします。
Pull Requestのtimelineとheadにあるcommitは、Pull Requestとcommitの組で識別します。
同じcommitでも別のPull Requestへの追加は、所属する項目や発生時刻が異なる根拠として扱います。
レビューのcommit参照には、commit object自体を表すsource IDを使います。
最も古い時刻はsourceの集合だけで決まるので、収集した項目の順番が変わっても同じ値になります。

個人原因では、責務が発生した`obligationSince`、実行可能になった`actionableSince`、通知の計算に使う`stallSince`を分けます。
個人催促時計のイベント時刻は、source ID、所有項目、種類、GitHub詳細の実測時刻と正規化イベントの一致を確認して使います。本文、native関係の合成時刻、push時刻が不明なcommitや作成時刻へ切り上げたcommitは時計の活動に含めません。これらのsourceはAI入力とgraphの時刻下限には残します。
同じ行動に関する進捗や責任主体の活動を既存の理由別規則で評価し、`actionableSince`、継続中の停滞起点、有効な進捗時刻の最大値を`stallSince`にします。reviewでは人間のレビューも進捗に含めます。関連項目の活動は、その原因の進捗や待機解消と確認できる場合だけ反映します。
block中も独立した行動が継続して可能なら両起点を保持し、実際に待たされた行動だけ待機解消の因果イベントを新しい実行可能性の起点にします。
イベント時刻が不明な場合は、規則上の責務や実行可能性を最初に確認できた入力snapshotの`observedAt`を一度だけ保存し、時刻の出典を`first_observation`とします。AI評価時刻で代用せず、後日の再評価でも更新しません。証拠なしに義務発生時点まで遡らせることもしません。
保存済み時計のイベントsourceが今回収集した詳細に再出現し、前回の所有項目を特定できる場合は、最終時計から外れても前回の所有項目、sourceの種類、実時刻を今回の詳細と該当する正規化イベントで照合します。新たに採用するイベント時計は現行の根拠で証明します。
旧Pull Request commit時計のsourceが今回のcommit所属から消えた場合、公開許可済みの同じPull Requestについて全ページを取得し、取得前後のhead SHAと総件数が一致したときだけ不在を確定します。所有項目や取得結果を確認できない場合は保存と公開を停止します。
旧commitの実push時刻を確認できない場合は、今回の詳細の`observedAt`を`reconfirmed_observation`として一度だけ保存します。旧source IDと旧時計時刻は監査用に保持し、現在の時刻を支持するEvidenceとして扱いません。後続の収集で同じsourceが再出現し、実push時刻が旧時計時刻と異なる場合や所有項目、種類が矛盾する場合は保存と公開を停止します。原因ID、責務ID、採用済み評価、既存Evidenceは保持します。
旧snapshotのreview requestがEvidenceや時計以外の参照を持たない場合は、source ID単位で時計を再確認します。公開許可済みの旧nodeから所有Pull Requestと依頼先を確認し、今回の詳細で同じ所有項目の現行review requestを全ページ取得します。旧IDが現行一覧にない場合や、現行IDから実時刻を確認できない場合は、今回の詳細の`observedAt`を`reconfirmed_observation`として一度だけ保存します。同じ依頼先のtimeline eventと旧時刻が一致しても、旧nodeとの対応を一意に確認できなければ旧時刻の証明には使いません。旧nodeの読取結果を現行Evidenceへ変換せず、旧source IDと旧時計時刻を監査値として保持します。後続の収集で旧IDが再出現した場合も時計を旧時刻へ戻さず、所有項目、種類、依頼先、取得できた実時刻の矛盾を検出したら保存と公開を停止します。
再確認によって時計の時刻が変わっても、同じ原因と責務に対する送信済みの個人催促は旧時計時刻で計算した通知keyで照合します。新しい進捗や責務期間、severityが変わった通知は別のkeyにします。
再確認後に行動可能時刻や停滞起点を義務発生時刻以後へそろえる場合、監査用のsource IDと`previousAt`は同じ旧イベント事実に対応させます。最初の観測時刻を旧イベントの発生時刻として記録しません。
未送信の個人催促は通知keyが同じでも、旧対象の項目、理由、原因ID、責務ID、行動可能時刻と停滞起点を現行原因と照合します。両時計は時刻、出典、旧時刻、source IDまで比較します。不一致が確定した旧対象は失効させ、現行候補があれば置き換えます。現行原因や時計を照合できない場合は保存と公開を停止します。前回の通知管理記録は保存時の値のまま照合します。今回の送信待ちから外れた旧対象でも、event時計のsourceは前回snapshotに保存されたEvidenceだけで閉じ、前回の原因、関係、実行面から所有範囲を確定します。今回のsource事実や原因で前回の欠落を補いません。公開前には固定した基準revisionから前回snapshotと通知管理記録を読み直し、根拠の保存位置、所有者、原因、時計、関係を照合します。
正常な`unknown`、失敗、延期を挟んでも、最後に確認できた実行可能性と時計を保持します。入力fingerprintの変化は意味結果の再検証に使い、同じ責務期間の原因や時計を終了させません。

## 公開DTOとWeb UI

`src/pages`はsnapshotの各項目を公開DTO schema version 10の`PublicItemSummaryDto`へ変換し、重要度、期限日、期限の切迫度、要対応度、`currentResponses`を公開します。
現在対応の根拠文は対象項目のsnapshotに保存された一致する根拠から写し、評価理由の文章や別項目の根拠から作りません。通知原因は今回のイベントと一致するsource事実を用い、同じsource IDに異なる時刻や行為者があれば停止します。
summaryとdetailsは同じ項目summaryを持ち、Web UIは両者の一致を検証します。
各項目の`aiAnalysis`は、項目単位のAI実行状態を表す`runStatus`、判定要素の一部または全部を決定論的に不要としたかを表す`omission`、現在入力で未検証の表示値を列挙する`aiAnalysis.unverifiedValues`を分けて公開します。
`runStatus`が成功でも保持したAI結果に依存する値は未検証になり得ます。反対に、確定規則だけで決まった表示値は、別の判定要素の失敗や延期だけを理由に未検証にしません。
期限の切迫度のようにAIが抽出した値から決定論的に導出する値は、抽出値に寄与したAI producerの現在性を引き継ぎます。
詳細のblocker表示行は、effective graphから得るblocker集合Eと、保持中の`waitingOn`が指す項目集合Wの和集合です。`blockers`の現在性とfrontierはEだけから決めます。WのうちEに含まれない保持項目は、`waitingOn`の現在性と、対応する`retained_waiting`または`waiting_value`を行へ反映します。行ごとの未検証理由は`blockerUnverifiedReasons`へ`relation_support`、`retained_waiting`、`waiting_value`の3種類で保持し、該当する行だけに警告します。staleな`waitingOn`だけを理由にfrontierへ警告を広げません。
`currentResponses`は、原因ごとの値を`currentResponses[].unverifiedValues`、表示中の責任主体を人物集計へ含めるかを`currentResponses[].subjectMembershipUnverified`、対応の集合そのものが増減し得るかを`currentResponsesUnverified`として別々に公開します。
`currentResponseSubjectChanges`は、人物集計へ追加され得るuserとteamを`addableSubjects`、削除され得るuserとteamを`removableSubjects`として公開します。変化する主体を特定できない場合だけ`unbounded`とします。roleだけの現在対応が増減しても人物集計は変わらないため、責任主体が検証済みなら`bounded`の空配列にします。責任主体自体が未検証ならkindを特定できないため`unbounded`とします。
公開DTOには内部のproducerを含めず、実行状態、不要判定、未検証の表示値へ縮約します。
`currentResponses`は個人通知と同じ原因の採用値を正本とし、責任主体、行動、根拠、`actionable`・`waiting`・`unknown`を表示します。再計画待ちは確認待ちとして扱い、以前の個人対応を現在対応の表示や人物別一覧へ出しません。有効な`duplicate`と`not_required`は現在対応から除きます。採用値が現在入力と不一致なら実行可能とは表示せず、未評価、失敗、延期、入力不一致などの理由を持つ`unknown`にします。待機先や根拠の参照先が公開データ内で解決できることも検証します。
Issue向けの`PublicItemSummaryDto.currentImplementations`は、from nodeがfreshなopen Pull Request、to nodeがfreshなopen Issueであるactiveなnative `implements`関係から導出します。
導出結果は公開DTOのsummaryとdetailsに同じ値として含め、snapshot、履歴、責務判定、停滞、通知へ伝播させません。
関係するPull Requestが複数ある場合はすべて公開し、詳細には各PRの現在対応を示します。Pull Requestの状態や対応をIssue自身の状態へ変換しません。
日次履歴の送信済み通知は公開schema version 5の`notification-history.json`へ変換し、通知履歴ページを開いたときだけ取得します。`acknowledge-current`の確認済み状態は通知管理記録へだけ保存し、`notification_sent`履歴やWeb UIの表示へ変換しません。
通知後のPages公開が成功した同じrunから送信済み通知が公開されます。summary、details、notification historyのmetadataは、通知がある場合はそのrunの最新の送信時刻へ揃えます。項目の停滞時間や期限の計算はsnapshot時刻を使います。
個人通知の履歴には送信時の責任主体と行動を保存し、現在の`currentResponses`から再構成しません。過去の通知で保存されていない情報も現在値から補いません。

共通ヘッダーは16px相当のサイト名、グローバルナビゲーション、「最新更新」と相対時刻を表示します。
各ページの見出しは見出しレベルを保ったまま18px相当へ統一し、操作を説明する補助文は置きません。
共通フッターは公開DTOのrun IDだけを表示します。

項目一覧と担当者ごとのページは要対応度、重要度、期限の切迫度、停滞時間の四つを並び替えキーとし、既定は要対応度の降順です。
repository、種別、項目状態、重要度、現在対応の責任主体と実行可能性、停滞時間、AI利用状況による絞り込みは項目一覧で独立して適用します。
両ページはマージ済み、完了、対応しないの項目を既定で除外します。
トップページは状態で「すべて」を選ぶと、完了済みの項目も表示します。
両ページの表とカードは、項目、現在対応と項目状態、要対応度、重要度、期限、停滞時間の順で同じ列定義を使います。
一覧の件数と選択中の並び替えキー名は表示しません。
表を表示する幅では列見出しを並び替え操作に使い、カードを表示する幅でだけ専用の並び順選択UIを表示します。
専用UIの表示切り替えには表とカードと同じbreakpointを使います。
現在対応には原因の責任主体、行動、実行可能性を表示します。項目全体の状態とblockerも併記し、個人原因がない項目でも依存項目や自動処理への待ちを失わないようにします。一覧の要対応度と重要度にはlevel名を付けずscoreだけを表示します。
設定したメンテナのGitHubユーザー名は公開情報として、規則から生じた現在対応の責任主体にも載せます。
個人のユーザー名は共通部品で人ごとのページへリンクし、teamはプレーンテキストで表示します。
人ページのhref生成とクライアント遷移はWeb UIのルートで一元化し、一覧、詳細、担当者一覧へ渡します。
項目一覧の個人のユーザー名、担当者一覧の個人行、人ページの見出しには、ユーザー名から組み立てたGitHubアバターURLを表示します。
アバターは装飾として扱い、文字のユーザー名を常に併記するため、外部画像を読み込めなくても人物を識別できます。
`img-src`は同一originとdata URLに加えて`github.com`と`avatars.githubusercontent.com`だけを許可します。
人ページのGitHubプロフィールリンクは、GitHub URLの検証と外部リンクの安全属性を共通部品へ委ねます。
人物ごとの表示、絞り込み、担当者一覧の集計は`currentResponses`の責任主体にそろえ、`waitingOn`を代用しません。同じuserやteamが同じ項目に複数の原因を持っていても項目数は1件と数えます。担当者一覧は「現在の対応者一覧」とし、項目全体の時計を使う数値は「項目の最長停滞時間」と示します。
所属teamの選択肢は、公開summaryの`currentResponses`に現れるteam識別子から作り、閲覧者が自身の所属を選びます。teamを個人へ展開しません。
項目一覧は、現在入力で未検証の表示値や現在対応を持つ項目と、`runStatus`が`failed`または`deferred`の項目へ行単位の警告マークを表示します。
項目詳細は未検証の値のそばにも警告マークを表示し、項目単位の処理状態だけでは警告箇所を決めません。
判定要素が決定論的に不要だったことは警告にせず、`omission`の`partial`と`all`を情報として区別します。
項目一覧のAI利用状況は、未検証、AI推定が一部不要、AI推定がすべて不要を別々に絞り込みます。
Web UIは停滞レベルを表示、絞り込み、並び替え、依存グラフのnode選定に使いません。

公開summaryの依存グラフは要対応度を最初の優先順位として初期nodeを選びます。
項目詳細の依存グラフは中心項目を必ず残し、表示上限内の候補をfrontier、要対応度の順で優先します。
残りの同順位はdownstream impact、停滞時間、node IDなどの決定論的なキーで解決します。

## 公開境界の三重guard

公開境界は一つのfilterへ依存せず、三つの段階で検証します。

1. 収集guardはrepository metadataだけを先に取得し、`public`、非アーカイブ、非disabledを満たすrepository IDをallowlistへ固定します。選定前に前回stateと既知の非公開repositoryを照合し、構造化されたrepository IDの完全一致と、境界を区切ったowner/nameまたはGitHub URLの一致で停止します。IDのない旧履歴と改名済みrepositoryの同一性は判定しません。Organization外の参照先は詳細応答で`public`を検証し、関係候補の解決時にarchive済みとdisabledを除外します。
2. 永続化guardはcommit直前にcheckpointの公開allowlistと公開inventory、snapshot、付随データを照合し、allowlist外ID、allowlist外GitHub URL、既知secret、credential field、不要な全文を拒否します。allowlistを再生成しません。
3. Pages guardはDTO生成直前に別実装で公開allowlist、公開inventory、snapshotを照合し、repository identity、allowlist外GitHub URL、secret、安全でないURL、不要な全文を再検査します。

非公開repositoryを含む収集時のinventoryは、収集runのsession内で既知の非公開repository参照の検査に使い、checkpointへ保存しません。後続の永続化guardとPages guardは公開inventoryを使います。

自然文のURLは共通の規則で候補を抽出し、GitHubのhostとowner/nameを正規化してから公開allowlistと検証済み外部参照に照合します。hostはWHATWG URLによるIDNA正規化後のhostnameで判定します。外部参照の公開証明は今回取得したrepository metadataへ結合します。明示的なschemeまたは`//`で始まるURLは、userinfoとportを含むauthority全体を先に確定します。hostとして解釈される句読点や記号の後ろから別の候補を開始しません。裸のdomain名は原文の句読点とMarkdownの境界から候補を開始し、曖昧な連接では参照を見逃さない側に判定します。authority内の空白を境界にするかどうかは、候補の開始と終端で同じ規則に従います。WHATWG URLが入力から取り除くTAB、LF、CRと、IDNA変換でhost内部から無視される文字は、明示的なURLのauthorityを区切らず、後続のhost断片を別の候補として開始しません。path、query、fragmentの構文的な開始位置は検査します。GitHub候補の符号化を一意に解析できない場合、または現在の公開状態を確認できない場合は、保存と公開を停止します。
Markdownはlinkとimageのラベル、ラベル内のnode、参照先、title、definitionの原文位置で候補を区切り、別の部分をURLとして連結しません。code、HTML、imageのaltも省略せず、各部分と各復号段階でURLの全開始位置を検査します。Markdownの段落や見出しなどのblock境界とfenced codeの物理行末は、原文、表示text、復号後のviewに引き継ぐURL候補の境界とし、両側をURLや裸名として連結しません。同じ段落内のsoft LF、CR、TABとMarkdownの参照先に含まれる改行は、URL入力の規則に従います。
段落と見出しの表示textを原文位置へ対応付けたviewを追加し、linkの前後やラベルに分割された参照も検査します。文字参照、escape、装飾、inline code、画像のaltは表示値と原文の対応を検証します。行の継続記号と空白はparserが示す原文範囲から除外します。表示textはMarkdownとして再解析せず、inline codeの改行、記号、文字参照をliteralとして保持します。
段落と見出しの画像は表示textを区切る別要素として扱い、`owner/![repo](参照先)`の本文とaltを一つの裸名へ連結しません。linkラベル内では、画像のaltをaccessible nameの一部として構成します。どちらの場合もalt、参照先、title、原文を個別に検査します。
`br`、`p`、`h1`から`h6`は属性を含むtag全体の文法を検証し、表示textを改行で区切ります。Markdownのbreakとこれらのtagが表示用に挿入した改行は、原文のLFと区別してURL候補も区切ります。属性のないinline装飾tagは表示textでは透明として扱い、原文も検査します。ラベル外の完全な`a` tagも表示textでは透明として扱います。これらのtagの各属性値を原文位置へ対応付け、HTML文字参照を復号したviewで個別に検査します。`href`はliteralのURL、ほかの属性値はliteralのtextとして扱い、Markdownのescapeとして再解釈しません。semicolonのない文字参照などで属性値の解釈を確定できない場合は停止します。ラベル外では開始と終了の対応だけを理由に停止しません。ラベル内では属性のない`br`と`p`を改行として扱い、属性のない装飾tagの対応を検証します。それ以外のHTMLをラベル内で検出した場合は停止します。ラベル外にあるそれ以外のHTMLは原文を保持して検査します。連続する未対応HTMLは一つの境界として扱い、その前後に参照の断片を連結し得る文字が続く場合は停止します。literalの角括弧はURLと裸名を区切るため、参照の断片へ含めません。表示値や原文位置を一意に構成できない境界では、保存と公開を停止します。
linkとimage、definitionの参照先は、その原文範囲とMarkdownが解釈した値を検査します。title、definitionのラベル、imageのaltも、原文に加えて解釈した値を検査します。これらの値をMarkdownとして再解析せず、参照先の末尾の記号もURLの一部として保持します。
正規化後のhostがGitHubのURL候補と、URLとして解析できずGitHubのhostになり得る候補は、対応するすべての原文範囲のpercent escapeとUTF-8を厳密に検証します。解析できない候補もauthority全体を使ってGitHubのhostになり得るか判定し、明示的なURLと裸のdomain名で同じ判定を使います。TAB、LF、CRはURL入力と各原文範囲から取り除いて検証し、原文位置は保持します。有効な`%25`の復号で生じたliteral `%`は由来を保持して原文の不正なescapeと区別し、復号後に残るpercent escape列の不正なUTF-8も拒否します。GitHub以外の候補にある不正なpercentだけでは停止しません。裸のowner/nameは原文、表示text、解釈した各値と、それらの全復号段階でURL候補を除いた連続領域から検査します。URL内ではhostがGitHub以外でも、WHATWG URL入力からTAB、LF、CRを除いたpath、queryの各keyとvalue、fragmentにあるowner/nameを検査します。末尾の`.git`を除いた参照も照合します。文末の`.`は裸名の境界とし、その後に名前の文字が続く場合は同じ名前の一部として扱います。`repo.git`のような裸domain候補の開始位置をowner/nameがまたぐ場合は、URL外の同じtext領域またはURL内の同じ成分で追加照合します。URL候補内から始まるowner/nameを、候補外の断片と連結しません。入れ子のURL候補は外側のpath、queryのkeyまたはvalue、fragmentの範囲で区切り、外側の成分の裸名照合から除いて内側のURLとして検査します。percent復号で現れた区切り文字は外側URLの成分境界に使いません。hostとpath、異なる成分、別のquery fieldは連結しません。構造化されたrepository IDの検査を維持し、文字数、候補総文字数、候補数、復号深度の上限はすべてのviewで共有します。候補数は同じURLの重複出現も数えます。

`config.yml`の`maintainers`に書いたGitHubユーザー名と、GitHubのreview requestや本文とコメントから得たteam識別子は公開情報としてguardを通過できます。
GitHubのteam member一覧は収集しないため、snapshot、公開DTO、Discord通知の入力にも含まれません。

Organization外のIssueとPull Requestは、今回取得したrepository metadataで公開・非アーカイブ・非disabledを確認した候補だけを検証済み外部参照としてsnapshotへ保存します。外部候補が最終graphに残らなくても証拠を保持し、Codexの自然言語、state、公開DTO、Discord送信前の検査では、その項目URLとrepository URLだけを許可します。今回の確認でarchive済みまたはdisabledと確定した外部repositoryは、前回の検証済み参照からも失効させます。残存URLがあれば公開前に停止します。旧snapshotの外部ghostも今回のmetadataで再確認し、未確認のURLを推測で追加しません。

収集時の公開allowlist、公開inventory、digestはcheckpointへ保存します。後続jobはsnapshotからinventoryを作らず、checkpointに保存された値の形、digest、所属とsnapshotのrepository参照を照合します。既知の非公開repositoryへの参照は履歴も含めて検査します。

guard違反は例外として日次トランザクションへ伝播します。
新しいPages公開と通常digestは実行されず、最後に成功した公開結果が残ります。
Pages guardを含む公開境界違反では、通常digestも運用障害通知も送信しません。通常のPages障害では運用障害通知を試みます。
通常digestにはPages guardを通過したsnapshot由来の通知候補だけを使います。
通常digestの送信前には、checkpointのsnapshotとtracker-state branchへ永続化済みのsnapshotでrun IDが一致することを検証し、既存履歴と通知台帳を含む公開安全性を再検査します。不一致や公開境界違反では送信せず失敗します。運用障害通知も既存snapshot、履歴、通知台帳、送信予定値をHTTP呼出前に検査します。

## Codexの隔離

汎用AIの本番経路は要素別の評価結果と採用結果をsnapshotへ保存し、次回の候補選別へ渡します。
確定情報だけで判断できる要素と、有効な保存結果を再利用できる要素を除外し、推論が必要な要素が残った項目だけを呼び出し候補にします。
呼び出し候補でも同じ実行条件の検証済み結果がcontent-addressed cacheにあれば再利用し、Codex processを実行しません。
snapshotの評価結果と採用結果の再利用は、要素の意味上のrevision、revisionごとの関連入力projection hash、実際の意味依存の一致で決めます。model、reasoning effort、backend、schemaの変更だけでは再推論しません。これらの実行条件は生成時のprovenanceとして記録します。
cacheは生成時のmodel、reasoning effort、backend、schema、対象要素のrevisionと入力hashで識別します。cache keyが変わっても、有効なsnapshotの結果があれば再推論しません。
promptを変更するときは、要素の意味への影響を宣言します。意味が変わらない表記の修正は再評価を求めず、再評価しない要素の生成結果と採用結果を保持します。
このcache再利用と重要度の前回判定利用は別の規則です。
そのrunで利用できる重要度判定がない場合は、前回の判定を現在の決定論的な要因と組み合わせます。
Codex入力の判定時刻は未来のsource参照を拒否するsemantic検証にだけ使い、時間依存の状態と停滞時間は決定論的処理で算出します。
判定時刻を入力hashから除外するため、run開始時刻だけが異なる入力は同じcache keyになります。
run共有のCodex exec実試行数、候補選択時の入力文字数と見積費用の上限を超える候補は、優先順位に従って延期します。
本番経路は候補の入力から費用を見積もり、blocker変化と前回graphのdownstream impactを予算不足時の優先順位へ反映します。入力文字数と費用の見積は追加入力と出力tokenを含む実課金の上限ではありません。
これらの条件が同じ候補では、前回延期された項目をnode ID順より先にします。

`auth-json`で実行候補が1件以上あるrunだけ、候補workerより先にCodex認証preflightを1論理call実行します。preflightは固定した短文を、候補データと通常のsystem promptを含めず、空の一時directoryで実行します。計画時にpreflightと最優先候補の初回試行に2枠を確保し、他の候補の初回試行枠も優先順に予約します。実行時はpreflightの完了後に候補workerを開始します。予算計画で選ばれた候補は`ai.execution.maxConcurrentCalls`の設定値まで並列実行します。
`api-key`、候補なし、cache hitだけのrun、全候補が予算延期されたrunではpreflightを実行しません。preflightに失敗した場合は候補を開始せず、実行段階に応じて`generic_ai_executed`または`personal_reminder_executed`を失敗させます。
preflightはrun全体の入力文字数と見積費用へ1論理callとして計上し、項目ごとの入力文字数上限には含めません。現行の`ai.budget.maxCodexExecAttemptsPerRun`は50回で、preflightを実行するrunでは初回試行を最大49候補へ配れます。汎用AI、個人原因AI、preflight、transport retry、semantic補正がprocessRunnerへ渡す`codex exec`を合算し、呼び出し後の起動失敗やtimeoutも数えます。`codex --version`と呼び出し前の失敗は数えません。retryとsemantic補正には未予約枠だけを使います。

予算計画で選ばれた候補は`ai.execution.maxConcurrentCalls`件まで同時に実行します。
判定結果と失敗の並びは完了順ではなく予算計画順へ再構成します。retryとsemantic補正は未予約の実試行枠を到着順で確保するため、枠を競合した候補の採用結果は完了順によって変わり得ます。この場合、並列度を変えたrun reportとstateのbyte列一致は保証しません。
実行中に予期しない例外が出た場合は新しい候補の実行を始めず、実行中の候補の完了を待ってから例外を伝播します。

実行時は空の一時directoryを作り、`codex exec`へ次の制約を渡します。

- `read-only` sandbox
- approval policy `never`
- `ai.execution.reasoningEffort`で指定したmodel reasoning effort
- ephemeral実行
- user configとrulesの無視
- Git repository検査の無効化
- 固定system prompt
- repository内JSON Schemaによる最終出力の拘束

現行の`config.yml`は`ai.authentication: auth-json`を指定します。
`ai.authentication: api-key`ではsubprocessへ`HOME`、`OPENAI_API_KEY`、`PATH`だけを渡します。
`ai.authentication: auth-json`では`CODEX_HOME`、`HOME`、`PATH`だけを渡し、起動前に`CODEX_HOME`直下の`auth.json`がファイルとして存在することを確認します。
workflowの解析stepでは、`node_modules/.bin`の絶対pathを`PATH`へ追加してtracker CLIを起動します。
Codex subprocessは空の一時directoryから起動するため、CLIの場所を相対pathで渡しません。
アプリケーション側のCodex認証providerは`auth.json`の存在だけを確認し、内容を読みません。
GitHub App private key、installation token、Discord Webhook URL、`CODEX_AUTH_SYNC_TOKEN`は渡しません。
Issue本文、コメント、ラベル、ユーザー名はID付きの信頼できない入力データとして渡し、命令として扱いません。
`deterministicSignals`にはnative relation候補のIDを`nativeBlockedBy`、`nativeBlocking`、`nativeParent`、`nativeSubIssues`、`nativeImplements`へ分けて渡します。
未アサインIssueの実質担当候補も、候補IDとsource IDを`deterministicSignals`へ渡します。Codexは入力された候補からIssue全体の担当可否だけを返し、候補を追加しません。

Codexのtimeout、rate limit、不正JSON、一時的なprocess起動失敗、signal終了は`ai.execution.maxAttempts`まで再試行します。
APIエラーも、構造化されたエラー情報から認証不正、不正なリクエスト、利用上限超過などの恒久失敗と判定できない場合は、同じ上限で再試行します。
HTTP 400から499は、408、409、429を除いて恒久失敗として扱います。
待機時間は`operations.retry`の初期待機時間と最大待機時間を使い、指数backoffとjitterを適用します。
API情報のない非ゼロ終了、固定資材や設定の不備、恒久的なprocess起動失敗は再試行しません。
成功runの`aiCallCount`と`estimatedInputTokens`には、実行したpreflightを含めます。preflight失敗runでも`aiProcessAttemptCount`はrun reportへ記録し、attemptの詳細は暗号化診断で確認します。
preflightは必要時のtoken更新機会を先に設ける緩和策であり、refreshを強制しません。preflight後に各並列processが更新条件へ入れば、認証競合は残ります。
DiscordはHTTP 429だけを同じ設定で再試行します。通信例外、HTTP 5xx、応答不正は送信結果を確定できないため、自動再送せず停止します。secret不備とその他のHTTPエラーも直ちに失敗します。

Codex出力はJSON Schema検証の後にsemantic validationを通します。
要素別Codex出力の構造制約は、新規生成用のドメインZod schemaと、それを組み合わせたCodex出力の共有Zod構造を正本にします。
Codexへ渡すJSON Schemaは共有構造から選択要素だけを必須として生成し、値・根拠・長さの制約を手書きで重複させません。
候補や根拠参照の整合は別のsemantic validationで確認し、移行済みの保存値には新規生成用と異なる移行用schemaを使います。
入力にないsource ID、user、team、relation targetは拒否し、native relationは変更させません。
`prompts/codex-system.md`の出力制約は同じsemantic validation規則をAIへ明示し、指定した要素以外の返却を禁止します。
relationの向きは`current=input.item`から`target=candidate.targetUrl`を基準にします。
`current_implements_target`はcurrentがPull Request、targetがIssueの場合だけ使います。
currentがIssueでtargetがその実装Pull Requestの場合、チェックリストや作業分割の根拠があるときだけ`target_is_subtask_of_current`を使い、根拠がなければ`related`か`none`にします。
意味上の規則のrevisionは`src/codex/analysis-elements.ts`で判定要素ごとに管理します。
base prompt、補正prompt、semantic issue codeのglossaryは`CODEX_PROMPT_BUNDLE_VERSION`でまとめて識別し、prompt fingerprintへ反映します。

汎用AIの出力がschema検証を通り、semantic違反がすべて補正可能な場合は、選択要素の出力全体を再生成します。個人催促AIはこのsemantic補正の対象外です。
世代間ではtransport aliasに変換した入力、出力schema、`selectedElements`を固定し、各世代を新しいsubprocessで実行します。
初回は入力JSONをそのまま渡します。第2世代以降は同じ`analysisInput`、直前のschema-validな`previousOutput`、世代番号`generation`、validatorが生成した`path`と`code`だけを持つ`issues`を渡します。
入力と前回出力は未信頼データであり、違反の`message`、stack、stdout、stderr、credentialsは補正envelopeに含めません。

必須設定`ai.execution.maxSemanticGenerations`は初回を含む総世代数で、1から3までの整数です。1は補正無効で、現行値3では2回まで補正できます。
各世代のtransport retryには、それぞれ`ai.execution.maxAttempts`を適用します。候補1件あたりのprocess試行数は最大`maxSemanticGenerations * maxAttempts`です。
semantic補正は候補1件の論理call内で行うため、追加世代を`aiCallCount`へ加算せず、補正envelopeの増分も論理入力予算と`estimatedInputTokens`へ含めません。processRunnerへ渡した追加世代は`aiProcessAttemptCount`へ加え、runの実試行枠から消費します。実際の入力文字数は世代ごとの暗号化診断で確認します。

`unknown_native_relation`のような入力の不変条件違反、schema検証失敗、process失敗、alias変換失敗、canonical IDへ戻した後の検証失敗はsemantic補正しません。process失敗のtransport retryは前述の規則に従い、alias変換失敗はrun全体を停止します。
上限まで補正してもsemantic検証を通らない場合は、最後のsemantic errorを項目ごとの縮退処理へ渡します。
中間出力はcache、state、Pages、Discordへ反映しません。最終出力だけをcanonical IDへ戻して再検証し、runnerで非対象の保存値との合成結果も検証した後にcacheへ保存します。
補正の世代数や中間出力はcache、snapshot、run reportの保存schemaへ追加せず、診断で観測します。
検証済み出力も候補データであり、reducerを通さずstateや外部サービスへ反映しません。

## state branch

`main`にはsource、設定、schema、prompt、Web UI、fixture、文書を置きます。
日次stateはorphan branchの`tracker-state`へcanonical JSONとして保存し、外部databaseは使いません。

根拠閉包は、保存時と同じ正規化を通したoutward値から参照pathを作ります。
追跡項目の`inputEvents`はsource ID順にそろえ、snapshotの保存と再読み込みでも同じ順序を保ちます。

| 既定パス                                         | 内容                                                                                                                                           |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `state/snapshot.json`                            | 要対応度、期限日、AI状態、AI要素の適用元、値別のAI依存、trackingStartAt、個人催促の原因と検証済み外部参照を含むschema version 23の最新snapshot |
| `state/history/YYYY-MM-DD.jsonl`                 | schema version 7。前回snapshotとの差分と送信済み通知を持つ日次履歴。確認済み状態は記録しない                                                   |
| `state/ai-cache/<sha256>.json`                   | 汎用AIのcontent-addressed cache                                                                                                                |
| `state/personal-reminder-ai-cache/<sha256>.json` | 個人原因ごとの意味評価cache。`state.personalReminderAiCacheDirectory`で配置先を指定する                                                        |
| `state/notification-ledger.json`                 | schema version 10。予約期限、送信開始済み、送信済み、確認済みの記録を持つ通知管理記録                                                          |
| `state/run-reports/YYYY-MM-DD.json`              | 初回Pagesと通知の確定後、finalizationで保存する実績指標と診断                                                                                  |

snapshot 23の各項目は、原因の列挙計画を表す`personalReminderCausePlanning`を必須で持ちます。`status`は`pending`、`completed`、`excluded`のいずれかとし、すべて`planningVersion`を保持します。`completed`には列挙に使った観測時刻`observedAt`、`excluded`には`reason: terminal_without_cause`を持たせます。
freshなopen項目の列挙が完了すれば原因0件でも`completed`にし、原因がないterminal項目だけを`excluded`にします。staleを含む分析対象外の項目は、前述の保持規則に従います。入口では旧`planningVersion`も受け入れ、現在版との不一致を再計画の選定へ渡します。

追跡項目の`aiAnalysis.status`は次の利用状況を表します。

| status         | 意味                                               |
| -------------- | -------------------------------------------------- |
| `used`         | 検証済みのAI分析結果を利用した                     |
| `failed`       | AI分析の実行または出力検証に失敗した               |
| `deferred`     | run予算によりAI分析を延期した                      |
| `not_required` | 決定論的判定だけで確定し、AI分析を必要としなかった |
| `disabled`     | 設定でAI分析が無効だった                           |
| `not_recorded` | 項目単位のAI利用状況が記録されていない             |

要素ごとの生成結果と正常に完了した評価を`aiAnalysis.elements`へ保存します。現在入力で検証済みのAI採用値だけを`aiAnalysis.adoptedElements`へ、現在使わない採用履歴を`aiAnalysis.retainedElements`へ保存します。各要素の最終適用元は`aiAnalysis.applications`へ保存し、`current_ai`以外の要素に現在採用値を持たせません。graph、Pages、通知、個人催促は採用履歴を現在値として読みません。
`current_ai`の再利用証明は、汎用AIの要素定義と同じrevisionと入力投影versionを必須とします。旧snapshotは保存時のschemaと生成記録を検証してから入口で移行します。旧21・22の証明は書き換えずに採用値を履歴へ移し、依存する項目・関係・個人原因を未検証にして、最終graph投影も更新します。Git commitの遷移検証では、移行前のsnapshotを保存時の形式で読み書きし、digestを保ちます。
汎用AIの採用記録は今回解析した項目だけに作り、失敗・延期も含めて解析対象と一対一で照合します。今回解析しなかった追跡項目は、前回snapshotの同じ項目と`aiAnalysis`全体が一致する場合に保持します。保存前とcheckpointの結合時にこの一致を検証します。保持した`adoptedElements`の適用元が`current_ai`でも、このrunのAI生成元としては扱いません。各AI結果は前回snapshotの所有項目、repository、要素、resultと照合します。
追跡項目の`aiDependencies`は、状態、待ち相手、期限、重要度、要対応度、blocker、関係集合などの最終値ごとに、AI非依存、現在入力で検証済み、未検証、proof不明を区別します。producerを識別できる依存は寄与したproducerを保持し、旧形式から識別できない依存はproducerを推測せずproof不明として保持します。関係と個人原因もそれぞれのAI依存を保存します。
AI依存の`unknown`は、空でない`reasons`配列に理由を保存します。理由とproducerは合成時に和集合を取り、理由は重複を除いて`migration`、`not_recorded`、`proof_unknown`、`stale_repository`の順で保存します。この順序は直列化のためのもので、理由の優先度を表しません。`proof_unknown`を含む依存にはproducerが必須です。AI要素の適用元を表す`applications`は単一の`reason`を使います。
保存時はproducerから依存を再計算し、要素ごとに許可した移行・未記録・staleの理由だけを加えた結果と照合します。`proof_unknown`を含む場合は関係候補を未判定として照合し、理由の合成によって検証済みへ変わることを防ぎます。producerのない移行値の特例は、理由が`migration`だけの場合に限ります。blocker、関係集合、下流影響、severity、attentionの依存が必要なproducerと状態を含むことも検証します。
Pagesのsummaryとdetailsは`aiAnalysis.status`を`runStatus`として公開し、生成元のcache keyと内部producerは公開しません。

永続化sessionはbranch headを開始時に固定し、snapshot、履歴、汎用AIと個人原因の追加cache、通知候補選別後の通知管理記録を通常stateの最初のGit commitへまとめます。個人原因の採用結果と実行状態を永続化できる前に外部通知へ進みません。
旧形式は入口で現行形式へ移行し、必要な旧cacheの削除もsnapshot更新と同じcommitへ含めます。snapshot 11から21を22へ移行した後、22を23へ移行します。snapshot 18のAI依存は単一の`reason`を1要素の`reasons`配列へ変換し、値・producer・適用元・採用済み評価・根拠・時計を保持します。snapshot 14以前の移行では個人原因を空配列として追加し、open項目の列挙計画を`pending`、原因がないterminal項目を`excluded`にします。PRの`inputEvents`は旧commit IDだけをそのPRに紐づく現行IDへ移行し、発生時刻を保持します。このID移行では既存の履歴、通知管理記録、現行cache、AIの採用値と根拠を書き換えません。旧AIの自由文から責務・時刻・意味結果を補填しません。
読み込みやCI検証だけでは本番へ保存せず、workflowによるpushまで完了してから移行済みとします。
移行したAIの採用値は新しい生成結果と区別し、旧generationのresult、metadata、outputHashを改変せず、再推論の失敗・延期だけで消しません。
本人起因の通知抑制は新しいsignalからnotification keyまたは未送信候補を作る前だけに適用し、既存pendingとnotification ledgerへ今回の原因を転用しません。既存のpending、reserved、delivery_started、sent、acknowledgedは通常の有効性・送信・失効規則でだけ更新します。
通知予約はrun開始時刻から24時間だけ有効です。
予約期限はworkflow内の排他用leaseであり通知方針ではないため、設定項目にせず、4時間周期をまたぐ重複送信を抑える24時間へ固定します。
送信開始前の期限内の予約は重複送信を抑え、期限切れの予約は次回の候補選別で抑制しません。
通常digestのHTTP送信前に、メッセージ単位の識別子と開始時刻を持つ`delivery_started`を保存してpushします。送信開始済みの記録は期限では解除せず、同じnotification keyの自動再送を抑えます。明確なHTTP拒否を受けた場合は予約へ戻し、送信成功時は`sent`へ進めます。通信が途切れた場合やプロセスが停止した場合は、送信開始済みの記録を残します。
`sent`と`acknowledged`のentryは同じnotification keyを期限なく通知対象から除外します。
新規の個人通知は、現行の列挙計画が`completed`の項目からだけ選びます。個人通知は原因の責務期間、責任主体の集合、行動、時計、停滞レベルと閾値からkeyを作ります。保存済みの従来のkeyを使えるのは、実行対象、理由、行動の種類、相手、実行可能性と停滞の起点、閾値が一致し、起点をイベント根拠から確認できる場合だけです。その場合は保存済み記録と同じ生成規則を使います。説明文、意味入力fingerprint、評価時刻、関連項目一覧だけではkeyを変えず、異なる実在原因が同じkeyへ衝突した場合はエラーにします。
個人通知の記録照合は同じkeyに限定し、進捗や待機解消で時計が変われば現在の閾値から選び直します。system通知のkeyは項目全体の`status`、`severity`、`waitingOn`、各種開始時刻から作ります。
systemの時間系通知と待ち先不明の通知では、同じ項目・通知理由・停滞レベルについて、現在の待ち期間内に予約した記録も照合します。期間内の送信開始済み・送信済み・確認済み記録があれば除外し、予約中の記録は期限まで再送を抑えます。
待ち期間は`statusSince`と`ownerSince`の新しい方から始まります。照合には`reservedAt`を使い、送信完了が次の待ち期間に遅れた記録を新しい期間の通知と取り違えないようにします。
system通知は進捗で停滞起点だけが変わっても、同じ待ち期間の同じ停滞レベルを再送しません。新しい待ち期間や停滞レベルの上昇は再び選別対象とします。依存解消・循環検出などの非時間系通知は、それぞれのトリガーを使います。
個人原因の未送信候補は、旧対象と現行原因の一致を、列挙計画や評価状態による保留と現行候補との統合より先に判定します。一致する旧対象は、列挙計画が`pending`なら保留し、`excluded`なら失効させ、`completed`の場合に現在の原因を再検証します。同じkeyなら検出時刻を保ちます。入力不一致や`waiting`・`unknown`は保留し、失敗・延期だけでは削除しません。時計の変化でkeyが変わる場合は候補と検出時刻を更新し、閾値未満なら古い候補を失効させます。責務の終了、`not_required`、`duplicate`、責任主体・行動・責務期間の交代でも旧候補を失効させます。
送信段階は保存済みsnapshotと通知管理記録を読み、run IDと選別済み原因の内容を照合します。自分の予約を含む通知選別全体は再実行せず、GitHubの再収集も行いません。各メッセージの送信直前にも、個人通知は現行の列挙計画が`completed`であることを確認します。原因、key、停滞レベル、予約時刻を検証し、同じstate headに対して`delivery_started`をatomic commitしてpushできた場合だけWebhookへ進みます。system通知には個人原因の列挙計画を適用せず、各通知の条件で検証します。送信文面と履歴はこの検証済み文脈を共有します。
run reportはDiscord送信結果が確定してから、実送信数と完了時刻を含めて保存します。
初回の通常state commitでは、未指定の`tracking.startAt`を`not_fixed`のまま保存します。
初回Pagesと通知のsettlementが完了した場合だけ、`resolveTrackingStartAt`で完全成功時刻を確定します。
Discordの各メッセージを送信した後、送信済みの通知管理記録と日次履歴を同じGit commitへ保存し、`origin`の`tracker-state`へpushします。pushが成功してから次のメッセージを送信します。
全メッセージの処理が完了した後、追跡開始時刻の確定値、最新の通知管理記録、run reportを保存してpushします。送信履歴は各メッセージの送信後に保存済みなので、完了時に再度追加しません。
`resolve-discord-delivery`は指定した送信開始済みメッセージを確認済みにするか、開始済みの記録を解除し、同じrunの固定outboxを検証した再開で再試行可能にします。解除だけで通知を送らず、送信済み履歴も作りません。
各commitの前にheadが変わった場合は競合として失敗し、不完全なcommitへ切り替えません。
GitHub Pagesはbranchを公開元にせず、ActionsのPages artifactからdeployします。
