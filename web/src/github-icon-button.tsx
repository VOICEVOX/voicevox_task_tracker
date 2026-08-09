import { SafeGitHubLink } from "./safe-link.js";

type GitHubIconButtonProps = Readonly<{
  href: string;
}>;

function GitHubMarkIcon() {
  return (
    <svg
      class="block size-5"
      viewBox="0 0 24 24"
      width="20"
      height="20"
      fill="currentColor"
      aria-hidden="true"
    >
      <path d="M12 2C6.477 2 2 6.477 2 12c0 4.42 2.865 8.166 6.839 9.489.5.092.682-.217.682-.482 0-.237-.008-.866-.013-1.7-2.782.604-3.369-1.341-3.369-1.341-.455-1.156-1.11-1.464-1.11-1.464-.908-.62.069-.608.069-.608 1.003.071 1.531 1.03 1.531 1.03.892 1.529 2.341 1.087 2.91.831.091-.646.349-1.087.635-1.337-2.221-.253-4.555-1.111-4.555-4.943 0-1.092.39-1.984 1.029-2.683-.103-.253-.446-1.27.098-2.647 0 0 .84-.269 2.75 1.025A9.56 9.56 0 0 1 12 6.833a9.56 9.56 0 0 1 2.504.337c1.909-1.294 2.748-1.025 2.748-1.025.546 1.377.203 2.394.1 2.647.64.699 1.028 1.591 1.028 2.683 0 3.842-2.337 4.687-4.566 4.935.359.309.679.92.679 1.855 0 1.338-.012 2.419-.012 2.748 0 .267.18.578.688.48A10.003 10.003 0 0 0 22 12c0-5.523-4.477-10-10-10Z" />
    </svg>
  );
}

/** GitHubの項目をアイコンだけのリンクで開く。 */
export function GitHubIconButton({ href }: GitHubIconButtonProps) {
  return (
    <SafeGitHubLink href={href} label="GitHubで開く" variant="icon">
      <GitHubMarkIcon />
    </SafeGitHubLink>
  );
}

/** GitHubプロフィールへのリンクをマークと文字で表示する。 */
export function GitHubProfileLink({ href }: GitHubIconButtonProps) {
  return (
    <SafeGitHubLink href={href} variant="action">
      <span class="inline-flex items-center gap-2">
        <GitHubMarkIcon />
        <span>GitHubプロフィール</span>
      </span>
    </SafeGitHubLink>
  );
}
