import { UnreachableError } from "../../src/util/index.js";
import { shouldHandleClientNavigation } from "./client-navigation.js";
import { createGitHubAvatarUrl } from "./github-avatar.js";
import { type WaitingOnDisplayPart } from "./model.js";

/** 人ごとのページへのリンク生成とクライアント遷移。 */
export type PersonNavigation = Readonly<{
  createPersonHref: (login: string) => string;
  onSelectPerson: (login: string) => void;
}>;

type PersonLinkProps = PersonNavigation & Readonly<{ login: string }>;

type WaitingOnDisplayProps = PersonNavigation &
  Readonly<{
    parts: readonly WaitingOnDisplayPart[];
    showAvatar: boolean;
  }>;

/** 人ごとのページへ遷移し、通常のリンク操作も維持する。 */
export function PersonLink({ createPersonHref, login, onSelectPerson }: PersonLinkProps) {
  return (
    <a
      class="person-link inline-flex min-h-11 min-w-0 items-center py-2 text-text-primary decoration-accent-link decoration-1 hover:text-accent-link-hover md:min-h-0 md:py-0"
      href={createPersonHref(login)}
      onClick={(event) => {
        if (!shouldHandleClientNavigation(event)) {
          return;
        }
        event.preventDefault();
        onSelectPerson(login);
      }}
    >
      @{login}
    </a>
  );
}

/** 待ち相手のloginだけを人ごとのページへのリンクとして表示する。 */
export function WaitingOnDisplay({
  createPersonHref,
  onSelectPerson,
  parts,
  showAvatar,
}: WaitingOnDisplayProps) {
  return (
    <>
      {parts.map((part, index) => {
        switch (part.kind) {
          case "text":
            return part.text;
          case "login":
            if (showAvatar) {
              return (
                <span
                  class="inline-flex min-w-0 items-center gap-1.5 align-middle"
                  key={`${index.toString()}:${part.login}`}
                >
                  <img
                    alt=""
                    class="size-5 shrink-0 rounded-full border border-border-default bg-surface-page"
                    decoding="async"
                    height={20}
                    loading="lazy"
                    src={createGitHubAvatarUrl(part.login)}
                    width={20}
                  />
                  <PersonLink
                    createPersonHref={createPersonHref}
                    login={part.login}
                    onSelectPerson={onSelectPerson}
                  />
                </span>
              );
            }
            return (
              <PersonLink
                key={`${index.toString()}:${part.login}`}
                createPersonHref={createPersonHref}
                login={part.login}
                onSelectPerson={onSelectPerson}
              />
            );
          default:
            throw new UnreachableError(part);
        }
      })}
    </>
  );
}
