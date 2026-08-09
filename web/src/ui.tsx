import { type ButtonHTMLAttributes, type ComponentChildren } from "preact";

import { appendClassName } from "./class-name.js";

const ACTION_BUTTON_CLASS =
  "min-h-11 cursor-pointer rounded-xl border border-action-border bg-action-background px-3 py-2 text-action-text enabled:hover:bg-action-background-hover disabled:cursor-not-allowed disabled:border-state-neutral-border disabled:bg-state-neutral-background disabled:text-state-neutral-text";

const PILL_CLASS =
  "inline-flex w-fit items-center gap-1.5 whitespace-nowrap rounded-full border px-2 py-0.5 text-xs leading-5 font-bold";

const PILL_TONE_CLASSES = {
  danger: {
    filled: "border-state-danger-border bg-state-danger-background text-state-danger-text",
    outlined: "border-state-danger-border text-state-danger-text",
  },
  high: {
    filled: "border-importance-high-border bg-importance-high-background text-importance-high-text",
    outlined: "border-importance-high-border text-importance-high-text",
  },
  info: {
    filled: "border-state-info-border bg-state-info-background text-state-info-text",
    outlined: "border-state-info-border text-state-info-text",
  },
  low: {
    filled: "border-importance-low-border bg-importance-low-background text-importance-low-text",
    outlined: "border-importance-low-border text-importance-low-text",
  },
  medium: {
    filled:
      "border-importance-medium-border bg-importance-medium-background text-importance-medium-text",
    outlined: "border-importance-medium-border text-importance-medium-text",
  },
  neutral: {
    filled: "border-state-neutral-border bg-state-neutral-background text-state-neutral-text",
    outlined: "border-state-neutral-border text-state-neutral-text",
  },
  success: {
    filled: "border-state-success-border bg-state-success-background text-state-success-text",
    outlined: "border-state-success-border text-state-success-text",
  },
  warning: {
    filled: "border-state-warning-border bg-state-warning-background text-state-warning-text",
    outlined: "border-state-warning-border text-state-warning-text",
  },
};

export type PillVariant = keyof (typeof PILL_TONE_CLASSES)["neutral"];

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
  variant: PillVariant;
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
export function Pill({ children, className, tone, variant }: PillProps) {
  return (
    <span class={`${PILL_CLASS} ${PILL_TONE_CLASSES[tone][variant]} ${className}`}>{children}</span>
  );
}
