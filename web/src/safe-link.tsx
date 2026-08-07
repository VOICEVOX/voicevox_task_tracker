import { type ComponentChildren } from "preact";

import { validateGitHubUrl } from "./model.js";

type SafeGitHubLinkProps = Readonly<{
  children: ComponentChildren;
  href: string;
}>;

/** 許可されたGitHub URLだけを別タブで開くリンク。 */
export function SafeGitHubLink({ children, href }: SafeGitHubLinkProps) {
  const result = validateGitHubUrl(href);
  if (!result.allowed) {
    return (
      <span class="unsafe-link font-bold text-state-danger-text">
        安全でないリンクを無効化しました
      </span>
    );
  }
  return (
    <a href={result.url} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  );
}
