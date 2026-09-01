import { strict as assert } from "node:assert";
import { test } from "node:test";

import { effectiveCodexMaxConcurrentCalls } from "./production-runtime.js";

void test("Codex認証方式別に実効並列度を決める", () => {
  const authJsonConfiguration = {
    authentication: "auth-json",
    execution: {
      maxConcurrentCalls: 4,
    },
  } satisfies Parameters<typeof effectiveCodexMaxConcurrentCalls>[0];
  const apiKeyConfiguration = {
    authentication: "api-key",
    execution: {
      maxConcurrentCalls: 4,
    },
  } satisfies Parameters<typeof effectiveCodexMaxConcurrentCalls>[0];

  assert.equal(effectiveCodexMaxConcurrentCalls(authJsonConfiguration), 1);
  assert.equal(effectiveCodexMaxConcurrentCalls(apiKeyConfiguration), 4);
});
