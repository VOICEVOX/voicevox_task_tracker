/** クリックをクライアント内遷移として扱うか判定する。 */
export function shouldHandleClientNavigation(
  event: Readonly<{
    altKey: boolean;
    button: number;
    ctrlKey: boolean;
    metaKey: boolean;
    shiftKey: boolean;
  }>,
): boolean {
  return event.button === 0 && !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey;
}
