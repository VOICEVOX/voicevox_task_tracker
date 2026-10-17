import { readFileSync, writeFileSync } from "node:fs";
import process from "node:process";
import { dirname, join } from "node:path";

import { z } from "zod";

import { serializeCanonicalJson } from "../../dist/canonical-json/index.js";
import { parseSandboxContext } from "../../dist/infrastructure/tracking-run/sandbox-context.js";
import {
  firstFileCacheProbeSource,
  firstAnalysisInputBinding,
} from "./sandbox-cache-probe-source.mjs";
import { resultSchema } from "./sandbox-continuity-result.mjs";
import {
  copySandboxGenericAiInputEvidence,
  writeSandboxGenericAiInputBinding,
  SANDBOX_GENERIC_AI_INPUT_BUNDLE_NAME,
  SANDBOX_GENERIC_AI_INPUT_BINDING_NAME,
} from "../../dist/infrastructure/tracking-run/sandbox-generic-ai-input-evidence.js";

const revisionSchema = z.string().regex(/^[0-9a-f]{40}$/u);
const runIdSchema = z.string().regex(/^tracker-run:[0-9a-f]{64}$/u);

function required(name) {
  const value = process.env[name];
  if (value == null || value === "") {
    throw new TypeError(`${name}が必要です`);
  }
  return value;
}

const revision = revisionSchema.parse(required("SANDBOX_FIRST_FINAL_REVISION"));
const firstRunId = runIdSchema.parse(required("SANDBOX_FIRST_TRACKING_RUN_ID"));
const source = await firstFileCacheProbeSource(
  required("SANDBOX_STATE_REPOSITORY_PATH"),
  revision,
  firstRunId,
);
const probe = {
  firstFinalStateRevision: revision,
  firstTrackingRunId: firstRunId,
  candidateDigest: source.candidateDigest,
};
switch (process.argv[2]) {
  case "select":
    writeFileSync(
      required("SANDBOX_CACHE_PROBE_OUTPUT_PATH"),
      `${serializeCanonicalJson(probe)}\n`,
      {
        mode: 0o600,
      },
    );
    break;
  case "verify": {
    const context = parseSandboxContext(
      JSON.parse(readFileSync(required("SANDBOX_CONTEXT_PATH"), "utf8")),
    );
    if (
      context.analysisMode.kind !== "cache_probe" ||
      serializeCanonicalJson(context.analysisMode.probe) !== serializeCanonicalJson(probe)
    ) {
      throw new TypeError("continuity secondのcache probe元がfirstの保存結果と一致しません");
    }
    const firstResultPath = required("SANDBOX_FIRST_RESULT_PATH");
    const result = resultSchema.parse(JSON.parse(readFileSync(firstResultPath, "utf8")));
    if (
      result.trackingRunId !== firstRunId ||
      context.environmentId !== `env-${result.actionsRunId}-${result.actionsRunAttempt}`
    ) {
      throw new TypeError("firstの実入力証拠のActions実行とcache probe元が一致しません");
    }
    const binding = firstAnalysisInputBinding(
      required("SANDBOX_STATE_REPOSITORY_PATH"),
      revision,
      result,
      context,
    );
    const contextDirectory = dirname(required("SANDBOX_CONTEXT_PATH"));
    await copySandboxGenericAiInputEvidence(
      join(dirname(firstResultPath), SANDBOX_GENERIC_AI_INPUT_BUNDLE_NAME),
      join(contextDirectory, SANDBOX_GENERIC_AI_INPUT_BUNDLE_NAME),
    );
    await writeSandboxGenericAiInputBinding(
      join(contextDirectory, SANDBOX_GENERIC_AI_INPUT_BINDING_NAME),
      binding,
    );
    break;
  }
  default:
    throw new TypeError("cache probe commandが不正です");
}
