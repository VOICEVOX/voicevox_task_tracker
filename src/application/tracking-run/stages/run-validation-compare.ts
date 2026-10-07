import { serializeCanonicalJson } from "../../../canonical-json/value.js";
import { RunCompletenessError } from "./run-completeness-error.js";

type Path = readonly (string | number)[];

function isUnknownArray(value: unknown): value is readonly unknown[] {
  return Array.isArray(value);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value != null && !Array.isArray(value);
}

/** 値をfieldごとに比較して不一致の位置を報告する。 */
export function assertRunValueMatches(
  expected: unknown,
  actual: unknown,
  path: Path,
  id: string,
): void {
  if (Object.is(expected, actual)) return;
  if (isUnknownArray(expected) && isUnknownArray(actual)) {
    if (expected.length !== actual.length) {
      throw new RunCompletenessError("field_mismatch", id, path, undefined);
    }
    for (const [index, value] of expected.entries()) {
      assertRunValueMatches(value, actual[index], [...path, index], id);
    }
    return;
  }
  if (isRecord(expected) && isRecord(actual)) {
    const expectedKeys = Object.keys(expected).sort();
    const actualKeys = Object.keys(actual).sort();
    if (serializeCanonicalJson(expectedKeys) !== serializeCanonicalJson(actualKeys)) {
      const missing = expectedKeys.find((key) => !Object.hasOwn(actual, key));
      const extra = actualKeys.find((key) => !Object.hasOwn(expected, key));
      throw new RunCompletenessError(
        "field_mismatch",
        id,
        [...path, missing ?? extra ?? "fields"],
        undefined,
      );
    }
    for (const key of expectedKeys) {
      assertRunValueMatches(expected[key], actual[key], [...path, key], id);
    }
    return;
  }
  throw new RunCompletenessError("field_mismatch", id, path, undefined);
}

/** 識別子が重複しない値の集合を作る。 */
export function runValuesById<Value>(
  values: readonly Value[],
  idOf: (value: Value) => string,
  path: Path,
): ReadonlyMap<string, Value> {
  const indexed = new Map<string, Value>();
  for (const value of values) {
    const id = idOf(value);
    if (indexed.has(id)) {
      throw new RunCompletenessError("duplicate_id", id, path, undefined);
    }
    indexed.set(id, value);
  }
  return indexed;
}

/** 識別子付きの集合を順序によらずfield単位で照合する。 */
export function assertRunValuesMatch<Expected, Actual>(
  expected: readonly Expected[],
  actual: readonly Actual[],
  expectedId: (value: Expected) => string,
  actualId: (value: Actual) => string,
  path: Path,
): void {
  const expectedById = runValuesById(expected, expectedId, path);
  const actualById = runValuesById(actual, actualId, path);
  for (const [id, value] of expectedById) {
    const matching = actualById.get(id);
    if (matching == null) {
      throw new RunCompletenessError("missing_value", id, path, undefined);
    }
    assertRunValueMatches(value, matching, [...path, id], id);
  }
  for (const id of actualById.keys()) {
    if (!expectedById.has(id)) {
      throw new RunCompletenessError("missing_value", id, path, undefined);
    }
  }
}

/** JSON互換値の独立したcopyを深く凍結する。 */
export function frozenRunCopy<Value>(value: Value): Value {
  const copy = structuredClone(value);
  const pending: unknown[] = [copy];
  const visited = new WeakSet<object>();
  while (pending.length > 0) {
    const current = pending.pop();
    if (typeof current !== "object" || current == null || visited.has(current)) continue;
    visited.add(current);
    if (isUnknownArray(current)) {
      for (const element of current) {
        pending.push(element);
      }
    } else if (isRecord(current)) {
      for (const propertyValue of Object.values(current)) {
        pending.push(propertyValue);
      }
    }
    Object.freeze(current);
  }
  return copy;
}
