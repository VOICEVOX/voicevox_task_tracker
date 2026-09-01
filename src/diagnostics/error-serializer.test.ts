import { strict as assert } from "node:assert";
import { test } from "node:test";

import { serializeDiagnosticError, type SerializedDiagnosticErrorValue } from "./index.js";

void test("Errorの標準情報とAggregateError.errorsだけを直列化する", () => {
  const error = new Error("outer");
  const cause = new Error("inner");
  Object.defineProperty(error, "secretProperty", { enumerable: true, value: "do-not-save" });
  error.cause = cause;
  const aggregate = new AggregateError([error, "plain cause"], "aggregate");

  const serialized = serializeDiagnosticError(aggregate);
  if (serialized == null || !("name" in serialized)) {
    throw new Error("serialized errorがありません");
  }
  assert.equal(serialized.name, "AggregateError");
  assert.equal(serialized.message, "aggregate");
  assert.equal(serialized.stack.includes("aggregate"), true);
  assert.equal(serialized.errors.length, 2);
  assert.equal(JSON.stringify(serialized).includes("do-not-save"), false);
});

void test("Error causeのcycleを明示する", () => {
  const first = new Error("first");
  const second = new Error("second");
  first.cause = second;
  second.cause = first;

  const serialized = serializeDiagnosticError(first);
  if (serialized == null || !("cause" in serialized)) {
    throw new Error("serialized causeがありません");
  }
  const secondCause = serialized.cause;
  if (secondCause == null || !("cause" in secondCause)) {
    throw new Error("serialized nested causeがありません");
  }
  const cycle = secondCause.cause;
  if (cycle == null || !("cycle" in cycle)) {
    throw new Error("cycle markerがありません");
  }
  assert.equal(cycle.cycle, true);
});

void test("Error causeの深さ32超過を明示する", () => {
  const errors = Array.from({ length: 34 }, (_, index) => new Error(`error-${index.toString()}`));
  for (let index = 0; index < errors.length - 1; index += 1) {
    const current = errors[index];
    const next = errors[index + 1];
    assert.ok(current);
    assert.ok(next);
    current.cause = next;
  }

  const serialized = serializeDiagnosticError(errors[0]);
  let current: SerializedDiagnosticErrorValue = serialized;
  while (current != null && "name" in current) {
    current = current.cause;
  }
  if (current == null || !("depthExceeded" in current)) {
    throw new Error("depth markerがありません");
  }
  assert.equal(current.depthExceeded, true);
});

void test("undefinedをunknown type undefinedとして直列化する", () => {
  const serialized = serializeDiagnosticError(undefined);
  if (serialized == null || !("kind" in serialized) || serialized.kind !== "unknown") {
    throw new Error("undefinedのunknown markerがありません");
  }
  assert.equal(serialized.type, "undefined");
  assert.equal(serialized.value, "undefined");

  const aggregate = serializeDiagnosticError(new AggregateError([undefined], "aggregate"));
  if (aggregate == null || !("errors" in aggregate)) {
    throw new Error("AggregateErrorの直列化結果がありません");
  }
  const [unknownValue] = aggregate.errors;
  if (unknownValue == null || !("kind" in unknownValue) || unknownValue.kind !== "unknown") {
    throw new Error("AggregateErrorのundefined markerがありません");
  }
  assert.equal(unknownValue.type, "undefined");
});
