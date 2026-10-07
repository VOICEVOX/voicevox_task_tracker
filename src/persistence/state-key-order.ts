/** stateの文字列keyを環境に依存しない順序で比較する。 */
export function compareStateKeys(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}
