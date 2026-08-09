import { type AiAnalysisNotice } from "./model.js";

type AiAnalysisNoticeIconProps = Readonly<{
  notice: AiAnalysisNotice;
}>;

/** 最新でないAI推定を小さな警告アイコンで示す。 */
export function AiAnalysisNoticeIcon({ notice }: AiAnalysisNoticeIconProps) {
  if (notice.kind !== "outdated") {
    return null;
  }
  return (
    <span
      class="ai-analysis-notice-icon inline-flex size-4 shrink-0 align-[-0.125em] leading-none text-state-warning-text"
      title={notice.description}
    >
      <svg
        class="block size-full"
        viewBox="0 0 24 24"
        width="16"
        height="16"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M12 3 22 21H2Z" />
        <path d="M12 9V14" />
        <circle cx="12" cy="17.5" r="1" fill="currentColor" stroke="none" />
      </svg>
      <span class="sr-only">{notice.description}</span>
    </span>
  );
}
