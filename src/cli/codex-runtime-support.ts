import type { Config } from "../config/index.js";
import type {
  CodexAdapterConfiguration,
  CodexAdapterDependencies,
  CodexAttemptBudget,
  CodexDiagnosticsContext,
  CodexProcessRunner,
  CodexSemanticGenerationObserver,
} from "../codex/index.js";
type CodexRuntimeAdapterDependencies = Readonly<{
  codexProcessRunner: CodexProcessRunner;
  sleep: (delayMilliseconds: number) => Promise<void>;
  random: () => number;
}>;

type CodexRuntimeCredentials = Readonly<{
  environment: Readonly<NodeJS.ProcessEnv>;
}>;

type CodexSemanticGenerationCounts = Readonly<{
  generationCount: number;
  correctionStartedCount: number;
  correctionSucceededCount: number;
  correctionExhaustedCount: number;
  processAttemptCount: number;
}>;

type CodexSemanticGenerationCounter = Readonly<{
  observer: CodexSemanticGenerationObserver;
  read: () => CodexSemanticGenerationCounts;
}>;

/** Codex adapterの設定を構築する。 */
export function createCodexAdapterConfiguration(config: Config): CodexAdapterConfiguration {
  return Object.freeze({
    authentication: config.ai.authentication,
    model: config.ai.model,
    execution: {
      timeoutSeconds: config.ai.execution.timeoutSeconds,
      maxAttempts: config.ai.execution.maxAttempts,
      maxSemanticGenerations: config.ai.execution.maxSemanticGenerations,
      sandbox: config.ai.execution.sandbox,
      approvalPolicy: config.ai.execution.approvalPolicy,
      reasoningEffort: config.ai.execution.reasoningEffort,
    },
    retry: {
      initialDelaySeconds: config.operations.retry.initialDelaySeconds,
      maxDelaySeconds: config.operations.retry.maxDelaySeconds,
    },
  }) satisfies CodexAdapterConfiguration;
}

/** Codex adapterの依存を構築する。 */
export function createCodexAdapterDependencies(
  adapters: CodexRuntimeAdapterDependencies,
  credentials: CodexRuntimeCredentials,
  attemptBudget: CodexAttemptBudget,
  diagnostics: CodexDiagnosticsContext | undefined,
  semanticGenerationObserver: CodexSemanticGenerationObserver | undefined,
): CodexAdapterDependencies {
  return Object.freeze({
    environment: credentials.environment,
    processRunner: adapters.codexProcessRunner,
    attemptBudget,
    runtime: {
      sleep: adapters.sleep,
      random: adapters.random,
    },
    ...(diagnostics == null ? {} : { diagnostics }),
    ...(semanticGenerationObserver == null ? {} : { semanticGenerationObserver }),
  });
}

function assertSemanticGenerationNumber(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > 3) {
    throw new RangeError("Codex semantic generationは1から3の整数にしてください");
  }
}

/** Codex semantic generationの実行回数を記録する。 */
export function createCodexSemanticGenerationCounter(): CodexSemanticGenerationCounter {
  const counts = {
    generationCount: 0,
    correctionStartedCount: 0,
    correctionSucceededCount: 0,
    correctionExhaustedCount: 0,
    processAttemptCount: 0,
  };
  const observer = Object.freeze({
    onGenerationStarted: (generation: number): void => {
      assertSemanticGenerationNumber(generation);
      counts.generationCount += 1;
    },
    onCorrectionStarted: (generation: number): void => {
      assertSemanticGenerationNumber(generation);
      counts.correctionStartedCount += 1;
    },
    onCorrectionSucceeded: (generation: number): void => {
      assertSemanticGenerationNumber(generation);
      counts.correctionSucceededCount += 1;
    },
    onCorrectionExhausted: (generation: number): void => {
      assertSemanticGenerationNumber(generation);
      counts.correctionExhaustedCount += 1;
    },
    onProcessAttemptStarted: (generation: number, attempt: number): void => {
      assertSemanticGenerationNumber(generation);
      if (!Number.isSafeInteger(attempt) || attempt < 1) {
        throw new RangeError("Codex process attemptは正の整数にしてください");
      }
      counts.processAttemptCount += 1;
    },
  }) satisfies CodexSemanticGenerationObserver;
  return Object.freeze({
    observer,
    read: (): CodexSemanticGenerationCounts => Object.freeze({ ...counts }),
  });
}

/** Codex semantic generationの診断文字列を構築する。 */
export function codexSemanticGenerationDiagnostic(counts: CodexSemanticGenerationCounts): string {
  return [
    "codex_semantic_generations",
    `generationCount=${counts.generationCount.toString()}`,
    `correctionStartedCount=${counts.correctionStartedCount.toString()}`,
    `correctionSucceededCount=${counts.correctionSucceededCount.toString()}`,
    `correctionExhaustedCount=${counts.correctionExhaustedCount.toString()}`,
    `processAttemptCount=${counts.processAttemptCount.toString()}`,
  ].join(" ");
}

/** Codex認証事前確認の診断情報を構築する。 */
export function createCodexPreflightDiagnostics(
  diagnostics: CodexDiagnosticsContext | undefined,
  invocation: Readonly<{ runId: string }>,
): CodexDiagnosticsContext | undefined {
  if (diagnostics == null) {
    return undefined;
  }
  return Object.freeze({
    recorder: diagnostics.recorder,
    ...(diagnostics.runId == null ? {} : { runId: diagnostics.runId }),
    invocationId: `${invocation.runId}:codex:authentication-preflight`,
  });
}
