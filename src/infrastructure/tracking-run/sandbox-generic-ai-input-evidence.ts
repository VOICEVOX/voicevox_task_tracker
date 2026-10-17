import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import type { GenericAiAdoptedRun } from "../../application/tracking-run/stages/generic-ai-adoption.js";
import type { GenericAiCacheProbeSource } from "../../application/tracking-run/stages/generic-ai-cache-plan.js";
import type { GenericAiExecutedRun } from "../../application/tracking-run/stages/generic-ai-execution.js";
import {
  serializeCanonicalJson,
  serializeCanonicalJsonBounded,
} from "../../canonical-json/value.js";
import {
  decryptDiagnosticsBundle,
  encryptDiagnosticsBundle,
} from "../../diagnostics/encrypted-bundle.js";
import {
  decodeDiagnosticsKey,
  DIAGNOSTICS_KEY_ENVIRONMENT_VARIABLE,
  DIAGNOSTICS_MAX_HEADER_BYTES,
} from "../../diagnostics/schema.js";
import { assertNonNullable } from "../../util/assert-non-nullable.js";
import type { SandboxRunContext } from "./sandbox-context.js";
import {
  createSandboxGenericAiInputComparison,
  createSandboxGenericAiInputProof,
  parseSandboxGenericAiInputProof,
  sandboxGenericAiInputBindingSchema,
} from "./sandbox-generic-ai-input-proof.js";

export const SANDBOX_GENERIC_AI_INPUT_BUNDLE_NAME = "sandbox-generic-ai-inputs.bundle";
export const SANDBOX_GENERIC_AI_INPUT_BINDING_NAME = "sandbox-generic-ai-input-binding.json";
const MAX_INPUT_EVIDENCE_BYTES = 8 * 1024 * 1024;
const MAX_INPUT_BUNDLE_BYTES = MAX_INPUT_EVIDENCE_BYTES + DIAGNOSTICS_MAX_HEADER_BYTES + 28;

function requiredEnvironment(environment: Readonly<NodeJS.ProcessEnv>, name: string): string {
  const value = environment[name];
  assertNonNullable(value, "汎用AIの実入力証拠に必要な環境値がありません");
  if (value.length === 0) {
    throw new TypeError("汎用AIの実入力証拠に必要な環境値が空です");
  }
  return value;
}

function assertActionsExecution(
  context: SandboxRunContext,
  environment: Readonly<NodeJS.ProcessEnv>,
): void {
  if (
    requiredEnvironment(environment, "GITHUB_JOB") !== "analyze" ||
    requiredEnvironment(environment, "GITHUB_RUN_ID") !== context.workflowRunId ||
    requiredEnvironment(environment, "GITHUB_RUN_ATTEMPT") !==
      context.workflowRunAttempt.toString() ||
    requiredEnvironment(environment, "GITHUB_SHA") !== context.codeRevision ||
    requiredEnvironment(environment, "GITHUB_REPOSITORY") !== context.sourceRepository
  ) {
    throw new TypeError("汎用AIの実入力証拠とActions実行のbindingが一致しません");
  }
}

async function readBoundedEvidenceFile(path: string, maxBytes: number): Promise<Buffer> {
  const file = await stat(path);
  if (!file.isFile() || file.size > maxBytes) {
    throw new TypeError("汎用AIの実入力証拠が通常fileでないかbyte上限を超えています");
  }
  const bytes = await readFile(path);
  if (bytes.byteLength > maxBytes) {
    throw new TypeError("汎用AIの実入力証拠がbyte上限を超えています");
  }
  return bytes;
}

async function withEvidenceDirectory<Result>(
  operation: (path: string) => Promise<Result>,
): Promise<Result> {
  const directory = await mkdtemp(join(tmpdir(), "voicevox-generic-ai-input-"));
  let result: Result;
  try {
    result = await operation(directory);
  } catch (error: unknown) {
    try {
      await rm(directory, { recursive: true });
    } catch (cleanupError: unknown) {
      throw new AggregateError([error, cleanupError], "汎用AIの実入力証拠の後処理に失敗しました", {
        cause: error,
      });
    }
    throw error;
  }
  await rm(directory, { recursive: true });
  return result;
}

/** firstの採用直後に実入力証拠を暗号化し、平文の一時fileを削除する。 */
export async function writeSandboxGenericAiInputEvidence(
  executed: GenericAiExecutedRun,
  adopted: GenericAiAdoptedRun,
  context: SandboxRunContext,
  environment: Readonly<NodeJS.ProcessEnv>,
  outputPath: string,
): Promise<void> {
  assertActionsExecution(context, environment);
  const keyBase64 = requiredEnvironment(environment, DIAGNOSTICS_KEY_ENVIRONMENT_VARIABLE);
  const proof = createSandboxGenericAiInputProof(
    executed,
    adopted,
    context,
    decodeDiagnosticsKey(keyBase64),
  );
  const source = serializeCanonicalJsonBounded(proof, MAX_INPUT_EVIDENCE_BYTES - 1);
  assertNonNullable(source, "汎用AIの実入力証拠が8MiBを超えています");
  await withEvidenceDirectory(async (directory) => {
    const inputPath = join(directory, "input.jsonl");
    await writeFile(inputPath, `${source}\n`, { mode: 0o600, flag: "wx" });
    await encryptDiagnosticsBundle({
      inputPath,
      outputPath,
      keyBase64,
      runId: proof.binding.actionsRunId,
      runAttempt: proof.binding.actionsRunAttempt,
      job: proof.binding.job,
      invocationId: proof.binding.invocationId,
    });
  });
}

/** 暗号化済み実入力証拠をbyte上限内で次のartifactへ渡す。 */
export async function copySandboxGenericAiInputEvidence(
  sourcePath: string,
  outputPath: string,
): Promise<void> {
  const bytes = await readBoundedEvidenceFile(sourcePath, MAX_INPUT_BUNDLE_BYTES);
  await writeFile(outputPath, bytes, { mode: 0o600, flag: "wx" });
}

/** exact first recordから確定したbindingをsecondのcontext artifactへ保存する。 */
export async function writeSandboxGenericAiInputBinding(
  path: string,
  binding: unknown,
): Promise<void> {
  await writeFile(
    path,
    `${serializeCanonicalJson(sandboxGenericAiInputBindingSchema.parse(binding))}\n`,
    { mode: 0o600, flag: "wx" },
  );
}

/** first証拠の認証とbinding照合を終えて、secondのカテゴリ比較を作る。 */
export async function readSandboxGenericAiInputComparison(
  context: SandboxRunContext,
  source: GenericAiCacheProbeSource,
  environment: Readonly<NodeJS.ProcessEnv>,
): Promise<ReturnType<typeof createSandboxGenericAiInputComparison>> {
  assertActionsExecution(context, environment);
  if (context.analysisMode.kind !== "cache_probe") {
    throw new TypeError("実入力のカテゴリ比較にはcache probeが必要です");
  }
  const directory = requiredEnvironment(environment, "RUNNER_TEMP");
  const bindingBytes = await readBoundedEvidenceFile(
    join(directory, SANDBOX_GENERIC_AI_INPUT_BINDING_NAME),
    DIAGNOSTICS_MAX_HEADER_BYTES,
  );
  const parseJson: (source: string) => unknown = JSON.parse;
  const binding = sandboxGenericAiInputBindingSchema.parse(
    parseJson(bindingBytes.toString("utf8")),
  );
  if (
    binding.runId !== context.analysisMode.probe.firstTrackingRunId ||
    binding.environmentId !== context.environmentId ||
    binding.environmentId !==
      `env-${binding.actionsRunId}-${binding.actionsRunAttempt.toString()}` ||
    binding.actionsRunId === context.workflowRunId ||
    binding.sourceRef !== context.sourceRef ||
    binding.codeRevision !== context.codeRevision ||
    binding.seedRevision !== context.seedRevision
  ) {
    throw new TypeError("firstの実入力証拠のbindingがsecondのcontextと一致しません");
  }
  const inputPath = join(directory, SANDBOX_GENERIC_AI_INPUT_BUNDLE_NAME);
  await readBoundedEvidenceFile(inputPath, MAX_INPUT_BUNDLE_BYTES);
  const keyBase64 = requiredEnvironment(environment, DIAGNOSTICS_KEY_ENVIRONMENT_VARIABLE);
  const proof = await withEvidenceDirectory(async (temporaryDirectory) => {
    const outputPath = join(temporaryDirectory, "input.jsonl");
    const header = await decryptDiagnosticsBundle({ inputPath, outputPath, keyBase64 });
    if (
      header.runId !== binding.actionsRunId ||
      header.runAttempt !== binding.actionsRunAttempt ||
      header.job !== binding.job ||
      header.invocationId !== binding.invocationId
    ) {
      throw new TypeError("firstの実入力証拠の暗号化headerが期待するbindingと一致しません");
    }
    const bytes = await readBoundedEvidenceFile(outputPath, MAX_INPUT_EVIDENCE_BYTES);
    const proof = parseSandboxGenericAiInputProof(parseJson(bytes.toString("utf8")));
    if (serializeCanonicalJson(proof.binding) !== serializeCanonicalJson(binding)) {
      throw new TypeError("firstの実入力証拠の認証済みbindingが一致しません");
    }
    return proof;
  });
  return createSandboxGenericAiInputComparison(proof, source, decodeDiagnosticsKey(keyBase64));
}

/** checkpointと同じ保存先から実入力証拠をresult artifactへ渡す。 */
export async function copySandboxCheckpointInputEvidence(
  checkpointPath: string,
  resultPath: string,
): Promise<void> {
  await copySandboxGenericAiInputEvidence(
    join(dirname(checkpointPath), SANDBOX_GENERIC_AI_INPUT_BUNDLE_NAME),
    join(dirname(resultPath), SANDBOX_GENERIC_AI_INPUT_BUNDLE_NAME),
  );
}
