import { type ComponentChildren, type JSX } from "preact";

import { UnreachableError } from "../../src/util/index.js";
import { appendClassName } from "./class-name.js";

type PageSectionProps = Readonly<{
  children: ComponentChildren;
  className?: string;
  description?: string | undefined;
  heading: string;
  headingAccessory?: ComponentChildren;
  headingId: string;
}>;

type ContentStateProps = Readonly<
  {
    children?: ComponentChildren;
    className: string;
    message: string;
    status: "empty" | "failed" | "loading";
  } & Omit<
    JSX.HTMLAttributes<HTMLDivElement>,
    "aria-live" | "children" | "class" | "className" | "role"
  >
>;

const PAGE_SECTION_CLASS =
  "section-card min-w-0 rounded-2xl border border-border-subtle bg-surface-card p-[clamp(1rem,2.5vw,2rem)] shadow-card max-narrow:rounded-xl";

/** カードと見出しを備えたページ内セクションを表示する。 */
export function PageSection({
  children,
  className,
  description,
  heading,
  headingAccessory,
  headingId,
}: PageSectionProps) {
  return (
    <section aria-labelledby={headingId} class={appendClassName(PAGE_SECTION_CLASS, className)}>
      <div class="section-heading mb-6 flex items-end justify-between gap-6 max-shell:flex-col max-shell:items-start">
        <div>
          <h2 id={headingId} class="m-0 text-section-title leading-tight font-bold">
            {heading}
          </h2>
          {description != null && <p class="mt-2 mb-0 max-w-2xl text-text-muted">{description}</p>}
        </div>
        {headingAccessory}
      </div>
      {children}
    </section>
  );
}

/** 空状態、読み込み中、読み込み失敗を共通の表示で通知する。 */
export function ContentState({
  children,
  className,
  message,
  status,
  ...attributes
}: ContentStateProps) {
  let role: "alert" | "status" | undefined;
  let ariaLive: "polite" | undefined;
  switch (status) {
    case "empty":
      role = undefined;
      ariaLive = undefined;
      break;
    case "loading":
      role = "status";
      ariaLive = "polite";
      break;
    case "failed":
      role = "alert";
      ariaLive = undefined;
      break;
    default:
      throw new UnreachableError(status);
  }

  return (
    <div
      {...attributes}
      class={`grid min-h-32 place-content-center justify-items-center gap-3 rounded-xl border border-dashed border-border-strong bg-surface-sunken p-6 text-center text-text-muted ${className}`}
      role={role}
      aria-live={ariaLive}
    >
      <p class="m-0">{message}</p>
      {children}
    </div>
  );
}
