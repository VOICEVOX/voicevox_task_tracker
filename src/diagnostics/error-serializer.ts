import { z } from "zod";

import { DiagnosticsValidationError } from "./errors.js";
import { DIAGNOSTICS_MAX_ERROR_DEPTH } from "./schema.js";

export type DiagnosticsJsonValue =
  string | number | boolean | null | readonly DiagnosticsJsonValue[] | DiagnosticsJsonObject;

export interface DiagnosticsJsonObject {
  readonly [key: string]: DiagnosticsJsonValue;
}

function isDiagnosticsJsonArray(value: unknown): value is readonly DiagnosticsJsonValue[] {
  return Array.isArray(value);
}

function isDiagnosticsJsonObject(value: unknown): value is DiagnosticsJsonObject {
  if (typeof value !== "object" || value == null) {
    return false;
  }
  try {
    return !Array.isArray(value) && isDiagnosticsJsonValue(value, new WeakSet<object>());
  } catch {
    return false;
  }
}

function isDiagnosticsJsonValue(value: unknown, ancestors: WeakSet<object>): boolean {
  if (typeof value === "undefined") {
    return false;
  }
  if (value == null) {
    return true;
  }
  switch (typeof value) {
    case "string":
    case "boolean":
      return true;
    case "number":
      return Number.isFinite(value);
    case "object": {
      if (ancestors.has(value)) {
        return false;
      }
      ancestors.add(value);
      try {
        if (Object.getOwnPropertySymbols(value).length > 0) {
          return false;
        }
        if (isDiagnosticsJsonArray(value)) {
          if (Object.keys(value).length !== value.length) {
            return false;
          }
          for (let index = 0; index < value.length; index += 1) {
            const descriptor = Object.getOwnPropertyDescriptor(value, index.toString());
            if (descriptor == null || !descriptor.enumerable || !("value" in descriptor)) {
              return false;
            }
            if (!isDiagnosticsJsonValue(descriptor.value, ancestors)) {
              return false;
            }
          }
          return true;
        }
        const prototype = Reflect.getPrototypeOf(value);
        if (prototype !== Object.prototype && prototype != null) {
          return false;
        }
        return Object.keys(value).every((key) => {
          const descriptor = Object.getOwnPropertyDescriptor(value, key);
          return (
            descriptor != null &&
            descriptor.enumerable &&
            "value" in descriptor &&
            isDiagnosticsJsonValue(descriptor.value, ancestors)
          );
        });
      } catch {
        return false;
      } finally {
        ancestors.delete(value);
      }
    }
    default:
      return false;
  }
}

export const diagnosticsJsonValueSchema = z.custom<DiagnosticsJsonValue>(
  (value) => isDiagnosticsJsonValue(value, new WeakSet<object>()),
  "JSON値として扱えない値です",
);

export const diagnosticsJsonObjectSchema = z.custom<DiagnosticsJsonObject>(
  (value) => isDiagnosticsJsonObject(value),
  "JSON objectとして扱えない値です",
);

const serializedErrorMarkerSchema = z.strictObject({
  kind: z.enum(["cycle", "depth_exceeded"]),
  cycle: z.boolean(),
  depthExceeded: z.boolean(),
  depth: z.number().int().nonnegative().max(DIAGNOSTICS_MAX_ERROR_DEPTH),
});

const serializedUnknownValueSchema = z.strictObject({
  kind: z.literal("unknown"),
  type: z.string().min(1),
  value: z.string(),
});

type SerializedErrorMarker = z.output<typeof serializedErrorMarkerSchema>;
type SerializedUnknownValue = z.output<typeof serializedUnknownValueSchema>;

export type SerializedDiagnosticError = Readonly<{
  name: string;
  message: string;
  stack: string;
  cause: SerializedDiagnosticErrorValue;
  errors: readonly SerializedDiagnosticErrorValue[];
  cycle: boolean;
  depthExceeded: boolean;
}>;

export type SerializedDiagnosticErrorValue =
  SerializedDiagnosticError | SerializedErrorMarker | SerializedUnknownValue | null;

const serializedDiagnosticErrorSchema: z.ZodType<SerializedDiagnosticError> = z.lazy(() =>
  z.strictObject({
    name: z.string(),
    message: z.string(),
    stack: z.string(),
    cause: serializedDiagnosticErrorValueSchema,
    errors: z.array(serializedDiagnosticErrorValueSchema),
    cycle: z.boolean(),
    depthExceeded: z.boolean(),
  }),
);

export const serializedDiagnosticErrorValueSchema: z.ZodType<SerializedDiagnosticErrorValue> =
  z.lazy(() =>
    z.union([
      serializedDiagnosticErrorSchema,
      serializedErrorMarkerSchema,
      serializedUnknownValueSchema,
      z.null(),
    ]),
  );

type SerializationContext = Readonly<{
  activeErrors: ReadonlySet<Error>;
  depth: number;
}>;

function describeUnknownValue(value: unknown): SerializedUnknownValue {
  if (typeof value === "string") {
    return {
      kind: "unknown",
      type: "string",
      value,
    };
  }
  if (typeof value === "number") {
    return {
      kind: "unknown",
      type: "number",
      value: Number.isFinite(value) ? value.toString() : "non-finite",
    };
  }
  if (typeof value === "boolean") {
    return {
      kind: "unknown",
      type: "boolean",
      value: value ? "true" : "false",
    };
  }
  if (typeof value === "bigint") {
    return {
      kind: "unknown",
      type: "bigint",
      value: value.toString(),
    };
  }
  if (typeof value === "symbol") {
    return {
      kind: "unknown",
      type: "symbol",
      value: value.description ?? "",
    };
  }
  if (typeof value === "function") {
    return {
      kind: "unknown",
      type: "function",
      value: "[function]",
    };
  }
  if (typeof value === "undefined") {
    return {
      kind: "unknown",
      type: "undefined",
      value: "undefined",
    };
  }
  if (value == null) {
    return {
      kind: "unknown",
      type: "null",
      value: "null",
    };
  }
  return {
    kind: "unknown",
    type: Object.prototype.toString.call(value),
    value: "[object]",
  };
}

function createMarker(kind: "cycle" | "depth_exceeded", depth: number): SerializedErrorMarker {
  return {
    kind,
    cycle: kind === "cycle",
    depthExceeded: kind === "depth_exceeded",
    depth,
  };
}

function serializeErrorValue(
  value: unknown,
  context: SerializationContext,
): SerializedDiagnosticErrorValue {
  if (typeof value === "undefined") {
    return describeUnknownValue(value);
  }
  if (value == null) {
    return null;
  }
  if (!(value instanceof Error)) {
    return describeUnknownValue(value);
  }
  if (context.activeErrors.has(value)) {
    return createMarker("cycle", context.depth);
  }
  if (context.depth >= DIAGNOSTICS_MAX_ERROR_DEPTH) {
    return createMarker("depth_exceeded", DIAGNOSTICS_MAX_ERROR_DEPTH);
  }

  const activeErrors = new Set(context.activeErrors);
  activeErrors.add(value);
  const nextContext: SerializationContext = {
    activeErrors,
    depth: context.depth + 1,
  };
  const cause = serializeErrorValue(value.cause, nextContext);
  let errors: SerializedDiagnosticErrorValue[] = [];
  if (value instanceof AggregateError) {
    const aggregateErrorsResult = z.array(z.unknown()).safeParse(value.errors);
    if (!aggregateErrorsResult.success) {
      throw new DiagnosticsValidationError("AggregateError.errorsが不正です", {
        cause: aggregateErrorsResult.error,
      });
    }
    errors = aggregateErrorsResult.data.map((item) => serializeErrorValue(item, nextContext));
  }
  const serialized: SerializedDiagnosticError = {
    name: value.name,
    message: value.message,
    stack: value.stack ?? "",
    cause,
    errors,
    cycle:
      hasSerializationMarker(cause, "cycle") ||
      errors.some((item) => hasSerializationMarker(item, "cycle")),
    depthExceeded:
      hasSerializationMarker(cause, "depthExceeded") ||
      errors.some((item) => hasSerializationMarker(item, "depthExceeded")),
  };
  const result = serializedDiagnosticErrorSchema.safeParse(serialized);
  if (!result.success) {
    throw new DiagnosticsValidationError("Errorの直列化結果が不正です", { cause: result.error });
  }
  return result.data;
}

function hasSerializationMarker(
  value: SerializedDiagnosticErrorValue,
  marker: "cycle" | "depthExceeded",
): boolean {
  if (value == null) {
    return false;
  }
  if ("kind" in value) {
    return marker === "cycle" ? value.kind === "cycle" : value.kind === "depth_exceeded";
  }
  if (marker === "cycle" && value.cycle) {
    return true;
  }
  if (marker === "depthExceeded" && value.depthExceeded) {
    return true;
  }
  if (hasSerializationMarker(value.cause, marker)) {
    return true;
  }
  return value.errors.some((item) => hasSerializationMarker(item, marker));
}

/** Errorの標準情報だけを再帰的に直列化する。 */
export function serializeDiagnosticError(error: unknown): SerializedDiagnosticErrorValue {
  const value = serializeErrorValue(error, {
    activeErrors: new Set<Error>(),
    depth: 0,
  });
  const result = serializedDiagnosticErrorValueSchema.safeParse(value);
  if (!result.success) {
    throw new DiagnosticsValidationError("Errorの直列化結果が不正です", { cause: result.error });
  }
  return result.data;
}

/** structured detailsがJSON値として直列化できることを検証する。 */
export function validateStructuredDetails(value: unknown): DiagnosticsJsonObject {
  const result = diagnosticsJsonObjectSchema.safeParse(value);
  if (!result.success) {
    throw new DiagnosticsValidationError("structured detailsはobjectにしてください", {
      cause: result.error,
    });
  }
  return result.data;
}
