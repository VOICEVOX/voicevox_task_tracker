import { PageSection } from "./layout.js";

const NOTIFICATION_SECTION_CLASS = "grid gap-3 border-t border-border-subtle pt-5";

const STALL_THRESHOLDS = [
  {
    name: "内容確認待ち",
    watch: "48時間",
    urgent: "96時間",
    critical: "168時間",
  },
  {
    name: "担当決め待ちと待ち先不明",
    watch: "48時間",
    urgent: "96時間",
    critical: "168時間",
  },
  {
    name: "方針判断待ち",
    watch: "48時間",
    urgent: "96時間",
    critical: "168時間",
  },
  {
    name: "レビュー待ち",
    watch: "48時間",
    urgent: "120時間",
    critical: "240時間",
  },
  {
    name: "変更要求後の修正待ち",
    watch: "72時間",
    urgent: "168時間",
    critical: "336時間",
  },
  {
    name: "返答待ち",
    watch: "48時間",
    urgent: "120時間",
    critical: "240時間",
  },
  {
    name: "マージ待ち",
    watch: "24時間",
    urgent: "72時間",
    critical: "168時間",
  },
  {
    name: "自動処理待ち",
    watch: "6時間",
    urgent: "24時間",
    critical: "72時間",
  },
  {
    name: "作業待ちと作業中",
    watch: "168時間",
    urgent: "336時間",
    critical: "720時間",
  },
] as const;

/** Discord通知の候補になる条件と抑制条件を表示する。 */
export function NotificationConditionsPage() {
  return (
    <PageSection
      className="notification-conditions-page"
      heading="通知条件"
      headingId="notification-conditions-heading"
    >
      <div class="grid max-w-5xl gap-6">
        <p class="m-0 text-text-secondary">
          通知は、今確認や対応が必要な項目を見落とさないための補助です。すべての更新を通知するものではありません。
        </p>

        <section aria-labelledby="notification-timing-heading" class={NOTIFICATION_SECTION_CLASS}>
          <h3
            id="notification-timing-heading"
            class="m-0 font-display text-base leading-snug font-semibold"
          >
            通知タイミング
          </h3>
          <p class="m-0">
            日本時間の毎日8時の集計または手動実行後に通知候補を確認します。公開ページの生成に成功してから送信します。候補が0件なら送信しません。
          </p>
        </section>

        <section aria-labelledby="stall-thresholds-heading" class={NOTIFICATION_SECTION_CLASS}>
          <h3
            id="stall-thresholds-heading"
            class="m-0 font-display text-base leading-snug font-semibold"
          >
            待機状態別の目安
          </h3>
          <p class="m-0">
            現在の待ち状態で意味のある進捗がない時間が長くなるほど、注意、緊急、深刻の順に停滞レベルが上がります。表の基準時間に達して停滞レベルが前回より上がった場合が、時間による通知の候補です。
          </p>
          <div class="overflow-x-auto rounded-xl border border-border-default bg-surface-card">
            <table class="w-full min-w-[40rem] table-fixed border-collapse">
              <caption class="visually-hidden sr-only">
                待機状態別に停滞レベルが上がる時間の目安
              </caption>
              <colgroup>
                <col class="w-[52%]" />
                <col class="w-[16%]" />
                <col class="w-[16%]" />
                <col class="w-[16%]" />
              </colgroup>
              <thead>
                <tr>
                  <th
                    class="border-b border-border-subtle bg-surface-sunken p-3 text-left text-sm font-bold text-text-secondary"
                    scope="col"
                  >
                    待ち状態
                  </th>
                  <th
                    class="border-b border-border-subtle bg-surface-sunken p-3 text-right text-sm font-bold text-text-secondary"
                    scope="col"
                  >
                    注意
                  </th>
                  <th
                    class="border-b border-border-subtle bg-surface-sunken p-3 text-right text-sm font-bold text-text-secondary"
                    scope="col"
                  >
                    緊急
                  </th>
                  <th
                    class="border-b border-border-subtle bg-surface-sunken p-3 text-right text-sm font-bold text-text-secondary"
                    scope="col"
                  >
                    深刻
                  </th>
                </tr>
              </thead>
              <tbody>
                {STALL_THRESHOLDS.map((threshold) => (
                  <tr key={threshold.name} class="border-b border-border-subtle last:border-b-0">
                    <th class="p-3 text-left align-top font-semibold" scope="row">
                      {threshold.name}
                    </th>
                    <td class="p-3 text-right align-top font-mono whitespace-nowrap tabular-nums">
                      {threshold.watch}
                    </td>
                    <td class="p-3 text-right align-top font-mono whitespace-nowrap tabular-nums">
                      {threshold.urgent}
                    </td>
                    <td class="p-3 text-right align-top font-mono whitespace-nowrap tabular-nums">
                      {threshold.critical}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p class="m-0 text-sm text-text-secondary">
            作業待ちと作業中は単独では通知しません。ほかの項目やリポジトリを止めていて、緊急
            以上になった場合だけ通知します。
          </p>
        </section>

        <section aria-labelledby="change-candidates-heading" class={NOTIFICATION_SECTION_CLASS}>
          <h3
            id="change-candidates-heading"
            class="m-0 font-display text-base leading-snug font-semibold"
          >
            時間以外の通知候補
          </h3>
          <ul class="m-0 grid gap-2 pl-5">
            <li>緊急以上の停止要因</li>
            <li>
              すべての依存が解消され、優先度ラベル、下流への影響、緊急以上の停滞レベル
              のいずれかがある項目だけが候補です。
            </li>
            <li>新しい依存関係の循環</li>
            <li>48時間以上停滞した後の待ち相手の変更</li>
            <li>検証済みの AI 提案</li>
          </ul>
          <p class="m-0">
            優先度：高は停滞レベル
            を1段階上げ、通知の順位にも影響します。優先度：中は通知の順位だけに影響します。
          </p>
        </section>

        <section aria-labelledby="suppression-heading" class={NOTIFICATION_SECTION_CLASS}>
          <h3
            id="suppression-heading"
            class="m-0 font-display text-base leading-snug font-semibold"
          >
            通知しない主な条件
          </h3>
          <ul class="m-0 grid gap-2 pl-5">
            <li>
              直近24時間に意味のある進捗があった停滞通知。直近24時間の進捗抑制は停滞と停止要因
              の期限超過だけに適用し、全通知を止めるものではありません。
            </li>
            <li>取得失敗で前回値を使ったリポジトリ</li>
            <li>
              bot が作成した Dependency Dashboard と Renovate Dashboard、または bot
              だけによる最新変更
            </li>
            <li>作成から24時間未満の draft PR</li>
            <li>停滞レベルが下がった項目</li>
            <li>停滞レベルが注意のまま変化しない項目</li>
            <li>公開安全性の確認や Pages 公開の失敗</li>
          </ul>
        </section>

        <section aria-labelledby="deduplication-heading" class={NOTIFICATION_SECTION_CLASS}>
          <h3
            id="deduplication-heading"
            class="m-0 font-display text-base leading-snug font-semibold"
          >
            重複抑制と上限
          </h3>
          <ul class="m-0 grid gap-2 pl-5">
            <li>1回の送信は最大10件です。</li>
            <li>通知理由と状態が同じ通知は一度だけ送信します。</li>
            <li>
              停滞レベル、待ち状態、責務の対象、停滞の起点などが変わると、新しい通知として送信します。
            </li>
          </ul>
        </section>
      </div>
    </PageSection>
  );
}
