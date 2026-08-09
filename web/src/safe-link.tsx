import { type ComponentChildren } from "preact";

import { validateGitHubUrl } from "./model.js";

type SafeGitHubLinkVariant = "action" | "icon" | "inline";

type SafeGitHubLinkProps = Readonly<{
  children: ComponentChildren;
  href: string;
}> &
  (
    | Readonly<{
        label: string;
        variant: "icon";
      }>
    | Readonly<{
        variant: Exclude<SafeGitHubLinkVariant, "icon">;
      }>
  );

const SAFE_GITHUB_LINK_CLASS_NAMES = {
  action: "inline-flex min-h-11 items-center",
  icon: "github-icon-button inline-flex size-11 min-h-11 min-w-11 shrink-0 items-center justify-center rounded-md text-accent-link no-underline hover:bg-surface-emphasis hover:text-accent-link-hover focus-visible:bg-surface-emphasis focus-visible:text-accent-link-hover",
  inline: "inline",
} satisfies Readonly<Record<SafeGitHubLinkVariant, string>>;

/** 許可されたGitHub URLだけを別タブで開くリンク。 */
export function SafeGitHubLink(props: SafeGitHubLinkProps) {
  const result = validateGitHubUrl(props.href);
  if (!result.allowed) {
    return (
      <span class="unsafe-link font-bold text-state-danger-text">
        安全でないリンクを無効化しました
      </span>
    );
  }
  const label = props.variant === "icon" ? props.label : undefined;
  return (
    <a
      aria-label={label}
      class={SAFE_GITHUB_LINK_CLASS_NAMES[props.variant]}
      href={result.url}
      target="_blank"
      rel="noopener noreferrer"
      title={label}
    >
      {props.children}
    </a>
  );
}
