/** 基本classへ任意のclassを追加する。 */
export function appendClassName(baseClassName: string, className: string | undefined): string {
  if (className == null) {
    return baseClassName;
  }
  return `${baseClassName} ${className}`;
}
