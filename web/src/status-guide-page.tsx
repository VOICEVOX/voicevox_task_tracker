import { PageSection } from "./layout.js";

const GUIDE_SECTION_CLASS = "grid gap-3 border-t border-border-subtle pt-5";
const DEFINITION_CLASS = "border-l-2 border-border-default pl-3";

/** 状態と担当が決まる規則を表示する。 */
export function StatusGuidePage() {
  return (
    <PageSection
      className="status-guide-page"
      heading="状態の決まり方"
      headingId="status-guide-heading"
    >
      <div class="grid max-w-4xl gap-6">
        <p class="m-0 text-text-secondary">
          状態は、項目を次に進めるために必要な行動を表します。担当は、その行動をする主体です。GitHub
          の assignee
          と担当が常に同じとは限りません。判定は上から順に確認し、最初に一致した条件を現在の状態と待ち相手に反映します。
        </p>

        <section aria-labelledby="status-and-responsibility-heading" class={GUIDE_SECTION_CLASS}>
          <h3
            id="status-and-responsibility-heading"
            class="m-0 font-display text-base leading-snug font-semibold"
          >
            状態と担当は別に決まります
          </h3>
          <dl class="m-0 grid gap-3">
            <div class={DEFINITION_CLASS}>
              <dt class="font-bold text-text-secondary">状態</dt>
              <dd class="mt-1 mb-0">次に必要な行動を表します。</dd>
            </div>
            <div class={DEFINITION_CLASS}>
              <dt class="font-bold text-text-secondary">担当</dt>
              <dd class="mt-1 mb-0">
                その行動をする人、チーム、役割、依存項目、自動処理などを表します。
              </dd>
            </div>
            <div class={DEFINITION_CLASS}>
              <dt class="font-bold text-text-secondary">正式な assignee</dt>
              <dd class="mt-1 mb-0">
                Issue に設定された GitHub の assignee は確定情報として作業を待つ相手になります。Pull
                Request の assignee は状態判定に使いません。
              </dd>
            </div>
            <div class={DEFINITION_CLASS}>
              <dt class="font-bold text-text-secondary">実質担当者</dt>
              <dd class="mt-1 mb-0">
                assignee のない Issue
                全体を進めている根拠が高い場合だけ表示する推定の担当者です。GitHub へ assignee
                を書き戻すことはありません。
              </dd>
            </div>
          </dl>
        </section>

        <section aria-labelledby="maintainer-resolution-heading" class={GUIDE_SECTION_CLASS}>
          <h3
            id="maintainer-resolution-heading"
            class="m-0 font-display text-base leading-snug font-semibold"
          >
            抽象的な役割はリポジトリのメンテナーへ展開します
          </h3>
          <p class="m-0">
            メンテナー、レビュワー、マージを決める人という抽象的な役割は、対象リポジトリの公開メンテナー設定へ展開します。リポジトリ別設定があればそれを優先し、なければ既定の設定を使います。
          </p>
          <ul class="m-0 grid gap-2 pl-5">
            <li>設定されたメンテナーは全員が候補になります。</li>
            <li>GitHub のチームへのレビュー依頼はチームのまま扱い、メンバーへ展開しません。</li>
            <li>複数の担当候補を保持し、一覧では主な待ち相手と残りの候補数を示します。</li>
          </ul>
        </section>

        <section aria-labelledby="issue-status-order-heading" class={GUIDE_SECTION_CLASS}>
          <h3
            id="issue-status-order-heading"
            class="m-0 font-display text-base leading-snug font-semibold"
          >
            Issue は上から最初に一致した条件で決まります
          </h3>
          <ol class="m-0 grid gap-3 pl-5">
            <li>
              <strong>終了状態</strong>
              。クローズ理由が対応予定なしまたは重複なら「対応しない」、それ以外は「完了」として、待ち相手を置きません。
            </li>
            <li>
              <strong>ブロッカー</strong>
              。未完了で確定または高信頼のブロッカーがあれば、ブロック解消待ちとしてその項目の完了を待ちます。
            </li>
            <li>
              <strong>未回答の明示依頼</strong>
              。メンテナーの判断だけを求める依頼なら方針判断待ち、それ以外は依頼先の人、チーム、役割への返答待ちになります。
            </li>
            <li>
              <strong>GitHub の assignee</strong>。assignee
              がいれば作業待ちとして、設定された全員の作業を待ちます。
            </li>
            <li>
              <strong>高信頼の実質担当者</strong>。assignee がなくても Issue
              全体を進める人を高信頼で特定できれば、作業待ちとして推定担当者を待ちます。
            </li>
            <li>
              <strong>担当未確定</strong>
              。本文、作成者以外の人のコメント、現在のラベル、過去の担当設定のいずれかがあれば内容確認済みとして担当決め待ち、どれもなければ内容確認待ちとして、リポジトリのメンテナーを待ちます。
            </li>
          </ol>
        </section>

        <aside
          aria-labelledby="effective-assignee-heading"
          class="grid gap-3 rounded-xl border-l-4 border-state-info-border bg-state-info-background px-4 py-3"
        >
          <h3
            id="effective-assignee-heading"
            class="m-0 font-display text-base leading-snug font-semibold"
          >
            実質担当者は作業全体の根拠で判断します
          </h3>
          <p class="m-0">
            明確な着手宣言、追跡対象の Pull Request が Issue を直接解決する GitHub 上の関係、Issue
            全体を進める継続成果物などを根拠にします。
          </p>
          <p class="m-0">
            作成者であること、活動量、単なるコメント、部分的な作業、助言、検証、レビューだけでは実質担当者を決めません。複数人を表示するのは、Issue
            全体を共同で進めている根拠がある場合だけです。
          </p>
        </aside>

        <section aria-labelledby="pull-request-status-order-heading" class={GUIDE_SECTION_CLASS}>
          <h3
            id="pull-request-status-order-heading"
            class="m-0 font-display text-base leading-snug font-semibold"
          >
            Pull Request はレビューと自動処理を優先して決まります
          </h3>
          <ol class="m-0 grid gap-3 pl-5">
            <li>
              <strong>終了状態</strong>
              。マージ済みなら「マージ済み」、クローズ理由が対応予定なしまたは重複なら「対応しない」、それ以外のクローズは「完了」として、待ち相手を置きません。
            </li>
            <li>
              <strong>ブロッカー</strong>
              。未完了で確定または高信頼のブロッカーがあれば、ブロック解消待ちとしてその項目の完了を待ちます。
            </li>
            <li>
              <strong>自動処理</strong>。マージキュー、自動マージ、必須チェック
              が実行中なら、自動処理待ちになります。
            </li>
            <li>
              <strong>人による変更要求</strong>
              。現在の変更内容に対する人のレビュワーからの変更要求があれば、修正待ちとして作成者を待ちます。
            </li>
            <li>
              <strong>未解決レビュー</strong>
              。作成者以外の人による未解決のレビューコメントのスレッド
              があれば、修正待ちとして作成者を待ちます。
            </li>
            <li>
              <strong>変更後の再レビュー</strong>
              。変更要求の後に新しい変更をプッシュしたら、レビュー待ちとしてレビュワー側へ戻します。
            </li>
            <li>
              <strong>レビュー依頼</strong>。bot
              を除くユーザーまたはチームへの現在のレビュー依頼があれば、その相手のレビューを待ちます。
            </li>
            <li>
              <strong>要議論ラベル</strong>
              。設定されたラベルがメンテナーの判断を要求するなら、方針判断待ちとしてメンテナーを待ちます。
            </li>
            <li>
              <strong>下書き</strong>
              。下書きなら作業中として、完成してレビュー可能な状態になるまで作成者を待ちます。
            </li>
            <li>
              <strong>Pull Request 起因の CI 失敗</strong>。変更が原因だと高信頼に判断できる
              必須チェックの失敗なら、修正待ちとして作成者を待ちます。
            </li>
            <li>
              <strong>競合</strong>。取り込み先ブランチとのマージ競合
              があれば、修正待ちとして作成者を待ちます。
            </li>
            <li>
              <strong>マージ待ち</strong>
              。必須チェックが完了してマージ可能なら、マージ待ちとしてメンテナーを待ちます。
            </li>
            <li>
              <strong>担当未確定</strong>。ここまでに該当しない下書きではない Pull Request
              は担当決め待ちとして、レビュー担当を決めるメンテナーを待ちます。
            </li>
          </ol>
          <p class="m-0 text-sm text-text-secondary">
            Pull Request の assignee
            欄は、この判定順の入力に使いません。条件に応じて、作成者、レビュワー、チーム、CI、自動処理、依存項目、設定されたメンテナーが担当になります。
          </p>
        </section>

        <section aria-labelledby="determination-confidence-heading" class={GUIDE_SECTION_CLASS}>
          <h3
            id="determination-confidence-heading"
            class="m-0 font-display text-base leading-snug font-semibold"
          >
            確定情報を優先し、曖昧な部分だけを AI で補います
          </h3>
          <ol class="m-0 grid gap-3 pl-5">
            <li>
              GitHub
              の状態、assignee、レビュー依頼、レビュー、チェック、依存関係などの確定情報を先に使い、決定論的な判定規則を順に適用します。
            </li>
            <li>
              未回答の依頼、実質担当者、CI
              失敗の原因、コメントの意味など、自然言語の解釈が必要な部分だけを AI
              の候補判定へ渡します。
            </li>
            <li>
              AI
              の出力は形式と内容を検証してから候補として使います。低信頼の推定だけで担当を断定しません。
            </li>
            <li>
              確定できない場合は、一覧や詳細に不確実性を示し、次回の GitHub 情報で再判定します。
            </li>
          </ol>
        </section>

        <aside
          aria-labelledby="status-guide-notice-heading"
          class="grid gap-3 rounded-xl border-l-4 border-state-warning-border bg-state-warning-background px-4 py-3 text-state-warning-text"
        >
          <h3
            id="status-guide-notice-heading"
            class="m-0 font-display text-base leading-snug font-semibold"
          >
            注意
          </h3>
          <ul class="m-0 grid gap-2 pl-5">
            <li>
              この仕組みは Issue や Pull Request の assignee、コメント、ラベル、レビュー依頼
              を変更しません。
            </li>
            <li>
              チームのメンバー一覧は取得しないため、チームへの待ちは特定の個人へ置き換えません。
            </li>
            <li>状態と待ち相手は、最新の確定情報と検証済みの候補を使って実行ごとに決まります。</li>
          </ul>
        </aside>
      </div>
    </PageSection>
  );
}
