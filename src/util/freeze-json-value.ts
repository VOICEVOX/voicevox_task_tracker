const frozenValues = new WeakSet<object>();

/** JSON値を入れ子まで一度だけ変更不能にする。 */
export function freezeJsonValue(value: unknown): void {
  if (typeof value !== "object" || value == null || frozenValues.has(value)) return;
  for (const nested of Object.values(value)) freezeJsonValue(nested);
  Object.freeze(value);
  frozenValues.add(value);
}
