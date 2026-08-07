import { type ComponentChildren } from "preact";

import { validateGitHubUrl } from "./model.js";

type SafeGitHubLinkVariant = "action" | "button" | "inline" | "subtle";

type SafeGitHubLinkProps = Readonly<{
  children: ComponentChildren;
  href: string;
  variant: SafeGitHubLinkVariant;
}>;

const SAFE_GITHUB_LINK_CLASS_NAMES = {
  action: "inline-flex min-h-11 items-center",
  button:
    "flex min-h-11 w-full items-center justify-center rounded-md border border-action-border bg-action-background px-3 py-2 text-sm font-bold no-underline",
  inline: "inline",
  subtle: "text-sm font-normal",
} satisfies Readonly<Record<SafeGitHubLinkVariant, string>>;

/** 許可されたGitHub URLだけを別タブで開くリンク。 */
export function SafeGitHubLink({ children, href, variant }: SafeGitHubLinkProps) {
  const result = validateGitHubUrl(href);
  if (!result.allowed) {
    return (
      <span class="unsafe-link font-bold text-state-danger-text">
        安全でないリンクを無効化しました
      </span>
    );
  }
  return (
    <a
      class={SAFE_GITHUB_LINK_CLASS_NAMES[variant]}
      href={result.url}
      target="_blank"
      rel="noopener noreferrer"
    >
      {children}
    </a>
  );
}
