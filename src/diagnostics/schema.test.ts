import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  decodeDiagnosticsKey,
  decodeDiagnosticsNonce,
  DiagnosticsFormatError,
  DiagnosticsValidationError,
} from "./index.js";

void test("AES-256鍵base64は44文字に限定する", () => {
  const keyBase64 = Buffer.alloc(32, 0x41).toString("base64");
  assert.equal(keyBase64.length, 44);
  assert.equal(decodeDiagnosticsKey(keyBase64).byteLength, 32);
  assert.throws(() => decodeDiagnosticsKey(keyBase64.slice(0, -1)), DiagnosticsValidationError);
});

void test("nonce base64は16文字に限定する", () => {
  const nonceBase64 = Buffer.alloc(12, 0x41).toString("base64");
  assert.equal(nonceBase64.length, 16);
  assert.equal(decodeDiagnosticsNonce(nonceBase64).byteLength, 12);
  assert.throws(() => decodeDiagnosticsNonce(nonceBase64.slice(0, -1)), DiagnosticsFormatError);
});
