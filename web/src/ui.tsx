import { type ButtonHTMLAttributes, type ComponentChildren } from "preact";

import { appendClassName } from "./class-name.js";

const ACTION_BUTTON_CLASS =
  "min-h-11 cursor-pointer rounded-xl border border-action-border bg-action-background px-3 py-2 text-action-text enabled:hover:bg-action-background-hover disabled:cursor-not-allowed disabled:border-state-neutral-border disabled:bg-state-neutral-background disabled:text-state-neutral-text";

const PILL_CLASS =
  "inline-flex w-fit items-center gap-1.5 whitespace-nowrap rounded-full border px-2 py-0.5 text-xs leading-5 font-bold";

const PILL_TONE_CLASSES = {
  danger: "border-state-danger-border bg-state-danger-background text-state-danger-text",
  high: "border-importance-high-border bg-importance-high-background text-importance-high-text",
  info: "border-state-info-border bg-state-info-background text-state-info-text",
  low: "border-importance-low-border bg-importance-low-background text-importance-low-text",
  medium:
    "border-importance-medium-border bg-importance-medium-background text-importance-medium-text",
  neutral: "border-state-neutral-border bg-state-neutral-background text-state-neutral-text",
  success: "border-state-success-border bg-state-success-background text-state-success-text",
  warning: "border-state-warning-border bg-state-warning-background text-state-warning-text",
};

type ActionButtonProps = Readonly<
  {
    children: ComponentChildren;
    className?: string;
  } & Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children" | "class" | "className">
>;

type PillProps = Readonly<{
  children: ComponentChildren;
  className: string;
  tone: keyof typeof PILL_TONE_CLASSES;
}>;

export const FORM_CONTROL_CLASS_NAME =
  "min-h-11 min-w-0 rounded-xl border border-border-strong bg-surface-card px-3 py-2 text-text-primary";

/** 共通の操作ボタンを表示する。 */
export function ActionButton({ children, className, ...attributes }: ActionButtonProps) {
  return (
    <button {...attributes} class={appendClassName(ACTION_BUTTON_CLASS, className)}>
      {children}
    </button>
  );
}

/** 意味に対応する配色のピル型ラベルを表示する。 */
export function Pill({ children, className, tone }: PillProps) {
  return <span class={`${PILL_CLASS} ${PILL_TONE_CLASSES[tone]} ${className}`}>{children}</span>;
}
