import { type ComponentChildren } from "preact";

import { shouldHandleClientNavigation } from "./client-navigation.js";

type ItemDetailsLinkProps = Readonly<{
  children: ComponentChildren;
  href: string;
  nodeId: string;
  onSelect: (nodeId: string) => void;
}>;

/** 項目詳細pageへ遷移し、通常のリンク操作も維持する。 */
export function ItemDetailsLink({ children, href, nodeId, onSelect }: ItemDetailsLinkProps) {
  return (
    <a
      href={href}
      onClick={(event) => {
        if (!shouldHandleClientNavigation(event)) {
          return;
        }
        event.preventDefault();
        onSelect(nodeId);
      }}
    >
      {children}
    </a>
  );
}
