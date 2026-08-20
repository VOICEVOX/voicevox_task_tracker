import { PageSection } from "./layout.js";

const GUIDE_SECTION_CLASS = "grid gap-3 border-t border-border-subtle pt-5";

/** 指標の目的とおおまかな算出方法を表示する。 */
export function LogicGuidePage() {
  return (
    <PageSection className="logic-guide-page" heading="指標の見方" headingId="logic-guide-heading">
      <div class="grid max-w-4xl gap-6">
        <p class="m-0 text-text-secondary">
          これらの指標は、大量の項目から「今どこへ目を向け、誰または何の次の行動を待っているか」を共有するための補助です。人やチームを評価する数字ではありません。
        </p>
        <section aria-labelledby="attention-guide-heading" class={GUIDE_SECTION_CLASS}>
          <h3
            id="attention-guide-heading"
            class="m-0 font-display text-base leading-snug font-semibold"
          >
            要対応度
          </h3>
          <p class="m-0">
            一覧で先に目を向ける順序を表します。項目そのものの重要度に、現在の待ち状態の鮮度係数を掛けてから四捨五入します。
          </p>
          <p class="m-0 rounded-xl bg-surface-sunken px-3 py-2 text-sm wrap-anywhere">
            <code>要対応度 = Math.round(重要度 × 鮮度係数)</code>
          </p>
          <ul class="m-0 grid gap-2 pl-5">
            <li>
              鮮度係数は待ちの種類ごとの基準時間に応じて下がり、設定された下限を下回りません。
            </li>
            <li>終了項目と、ブロック解除待ちの親項目の要対応度は 0 です。</li>
          </ul>
        </section>

        <section aria-labelledby="importance-guide-heading" class={GUIDE_SECTION_CLASS}>
          <h3
            id="importance-guide-heading"
            class="m-0 font-display text-base leading-snug font-semibold"
          >
            重要度
          </h3>
          <p class="m-0">
            項目そのものの影響や期限の大きさを表します。要対応度の基礎になる値ですが、待ち状態の鮮度は含めません。
          </p>
          <p class="m-0 rounded-xl bg-surface-sunken px-3 py-2 text-sm wrap-anywhere">
            <code>重要度 = min(100, max(0, 固定ルールによる加点の合計))</code>
          </p>
          <ul class="m-0 grid gap-2 pl-5">
            <li>優先度ラベルによる加点を使います。</li>
            <li>止めている項目やリポジトリへの影響を加点します。</li>
            <li>期限付きマイルストーンの期限を加点要因にします。</li>
            <li>
              必要に応じて Codex が読み取った重要性を候補として取り込み、固定ルールで加点します。
            </li>
          </ul>
          <p class="m-0 text-sm text-text-secondary">
            加点を合計した値を 0 から 100 に収めます。Codex
            が最終スコアを直接決めるのではなく、検証済みの候補を実装済みのルールへ渡します。
          </p>
        </section>

        <section aria-labelledby="stall-guide-heading" class={GUIDE_SECTION_CLASS}>
          <h3
            id="stall-guide-heading"
            class="m-0 font-display text-base leading-snug font-semibold"
          >
            停滞時間
          </h3>
          <p class="m-0">
            現在の待ち状態で、意味のある進捗または責務主体の活動が最後にあってからの連続時間です。
          </p>
          <p class="m-0 rounded-xl bg-surface-sunken px-3 py-2 text-sm wrap-anywhere">
            <code>停滞時間 = 現在時刻 − 現在の待ち状態における活動の起点</code>
          </p>
          <ul class="m-0 grid gap-2 pl-5">
            <li>GitHub の updated_at をそのまま停滞時間には使いません。</li>
            <li>状態または待ち相手が変われば、その時点から数え直します。</li>
          </ul>
        </section>

        <section aria-labelledby="waiting-guide-heading" class={GUIDE_SECTION_CLASS}>
          <h3
            id="waiting-guide-heading"
            class="m-0 font-display text-base leading-snug font-semibold"
          >
            待ち相手と状態
          </h3>
          <p class="m-0">
            状態と待ち相手は、項目の次の行動を誰が担うかを読み取るための組み合わせです。
          </p>
          <dl class="m-0 grid gap-3">
            <div class="border-l-2 border-border-default pl-3">
              <dt class="font-bold text-text-secondary">状態</dt>
              <dd class="mt-1 mb-0">次に何の行動を待つかを表します。</dd>
            </div>
            <div class="border-l-2 border-border-default pl-3">
              <dt class="font-bold text-text-secondary">待ち相手</dt>
              <dd class="mt-1 mb-0">
                誰または何が次に動くかを表します。ユーザー、チーム、役割、依存項目、自動処理などがあり、GitHub
                の担当者と同じとは限りません。
              </dd>
            </div>
          </dl>
          <p class="m-0 text-sm text-text-secondary">
            Issue と Pull Request では、使う確定情報と判定順が異なります。Issue と Pull Request
            それぞれの状態、依頼、依存関係、レビュー、チェックなど、種類に応じた確定情報を実装済みの判定順で確認します。
          </p>
        </section>

        <section aria-labelledby="decision-flow-guide-heading" class={GUIDE_SECTION_CLASS}>
          <h3
            id="decision-flow-guide-heading"
            class="m-0 font-display text-base leading-snug font-semibold"
          >
            判定の流れ
          </h3>
          <ol class="m-0 grid gap-3 pl-5">
            <li>GitHub から得た確定情報を先に使い、状態、待ち相手、重要度の土台を決めます。</li>
            <li>本文やコメントの自然言語解釈など、曖昧な部分だけを Codex の候補判定に渡します。</li>
            <li>Codex の出力は形式と内容の整合性を検証してから、候補データとして扱います。</li>
            <li>
              検証済みの候補と確定情報を、実装済みのルールへ渡して最終スコアと状態を決めます。
            </li>
          </ol>
        </section>

        <aside
          aria-labelledby="metric-notice-heading"
          class="grid gap-3 rounded-xl border-l-4 border-state-info-border bg-state-info-background px-4 py-3"
        >
          <h3
            id="metric-notice-heading"
            class="m-0 font-display text-base leading-snug font-semibold"
          >
            注意
          </h3>
          <ul class="m-0 grid gap-2 pl-5">
            <li>
              要対応度と重要度は別の指標です。待ち状態が長く続くほど鮮度係数が下がり、要対応度も下がることがあります。
            </li>
            <li>severity は停滞が通知基準を超えたかを見る Discord 通知用の別指標です。</li>
          </ul>
        </aside>
      </div>
    </PageSection>
  );
}
