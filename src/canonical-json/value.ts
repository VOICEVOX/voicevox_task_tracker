function serializeString(value: string): string {
  return JSON.stringify(value);
}

function serializeNumber(value: number): string {
  if (!Number.isFinite(value)) {
    throw new TypeError("JSONの数値は有限値にしてください");
  }
  return JSON.stringify(value);
}

function compareStrings(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}

function* serializePieces(value: unknown, ancestors: WeakSet<object>): Iterable<string> {
  if (value == null) {
    if (typeof value === "undefined") {
      throw new TypeError("JSONへ直列化できない値です。型: undefined");
    }
    yield "null";
    return;
  }

  switch (typeof value) {
    case "boolean":
      yield value ? "true" : "false";
      return;
    case "number":
      yield serializeNumber(value);
      return;
    case "string":
      yield serializeString(value);
      return;
    case "object": {
      if (ancestors.has(value)) {
        throw new TypeError("循環参照を含む値はJSONへ直列化できません");
      }
      ancestors.add(value);
      try {
        if (Array.isArray(value)) {
          yield "[";
          for (const [index, item] of value.entries()) {
            if (index > 0) yield ",";
            yield* serializePieces(item, ancestors);
          }
          yield "]";
          return;
        }

        const prototype: unknown = Object.getPrototypeOf(value);
        if (prototype !== Object.prototype && prototype != null) {
          throw new TypeError("JSONへ直列化できるのはplain objectだけです");
        }
        yield "{";
        for (const [index, [key, propertyValue]] of Object.entries(value)
          .sort(([left], [right]) => compareStrings(left, right))
          .entries()) {
          if (index > 0) yield ",";
          yield serializeString(key);
          yield ":";
          yield* serializePieces(propertyValue, ancestors);
        }
        yield "}";
        return;
      } finally {
        ancestors.delete(value);
      }
    }
    case "bigint":
    case "function":
    case "symbol":
    case "undefined":
      throw new TypeError(`JSONへ直列化できない値です。型: ${typeof value}`);
  }
  throw new TypeError("JSONへ直列化できない値です");
}

function serializeValue(value: unknown, ancestors: WeakSet<object>): string {
  if (value == null) {
    if (typeof value === "undefined") {
      throw new TypeError("JSONへ直列化できない値です。型: undefined");
    }
    return "null";
  }
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "number":
      return serializeNumber(value);
    case "string":
      return serializeString(value);
    case "object": {
      if (ancestors.has(value)) {
        throw new TypeError("循環参照を含む値はJSONへ直列化できません");
      }
      ancestors.add(value);
      try {
        if (Array.isArray(value)) {
          return `[${value.map((item) => serializeValue(item, ancestors)).join(",")}]`;
        }
        const prototype: unknown = Object.getPrototypeOf(value);
        if (prototype !== Object.prototype && prototype != null) {
          throw new TypeError("JSONへ直列化できるのはplain objectだけです");
        }
        const properties = Object.entries(value)
          .sort(([left], [right]) => compareStrings(left, right))
          .map(
            ([key, propertyValue]) =>
              `${serializeString(key)}:${serializeValue(propertyValue, ancestors)}`,
          );
        return `{${properties.join(",")}}`;
      } finally {
        ancestors.delete(value);
      }
    }
    case "bigint":
    case "function":
    case "symbol":
    case "undefined":
      throw new TypeError(`JSONへ直列化できない値です。型: ${typeof value}`);
  }
  throw new TypeError("JSONへ直列化できない値です");
}

/** JSON値のcanonical表現を小さな文字列片として順に返す。 */
export function canonicalJsonPieces(value: unknown): Iterable<string> {
  return serializePieces(value, new WeakSet<object>());
}

/** JSON値を全文文字列に展開せずcanonical表現で比較する。 */
export function canonicalJsonEquals(left: unknown, right: unknown): boolean {
  const leftPieces = canonicalJsonPieces(left)[Symbol.iterator]();
  const rightPieces = canonicalJsonPieces(right)[Symbol.iterator]();
  for (;;) {
    const leftPiece = leftPieces.next();
    const rightPiece = rightPieces.next();
    if (leftPiece.done || rightPiece.done) return leftPiece.done === rightPiece.done;
    if (leftPiece.value !== rightPiece.value) return false;
  }
}

/** 上限を超える場合はJSON値を展開せずに通知する。 */
export function serializeCanonicalJsonBounded(
  value: unknown,
  maxBytes: number,
): string | undefined {
  const pieces: string[] = [];
  let byteLength = 0;
  const encoder = new TextEncoder();
  for (const piece of canonicalJsonPieces(value)) {
    byteLength += encoder.encode(piece).length;
    if (byteLength > maxBytes) return undefined;
    pieces.push(piece);
  }
  return pieces.join("");
}

/** JSON値をobjectのキー順に依存しない文字列へ正規化する。 */
export function serializeCanonicalJson(value: unknown): string {
  return serializeValue(value, new WeakSet<object>());
}

/** JSON値を末尾改行付きcanonical JSONへ直列化する。 */
export function serializeCanonicalJsonLine(value: unknown): string {
  return `${serializeCanonicalJson(value)}\n`;
}
