import { z } from "zod";
import { REASONING_EFFORTS } from "../domain/index.js";
import { CODEX_AUTHENTICATIONS } from "./authentication.js";
import type { CodexAttemptBudget, CodexInitialAttemptTicket } from "./attempt-budget.js";
import type { CodexDiagnosticsContext } from "./diagnostics.js";
import type { CodexProcessRunner } from "./process-runner.js";
import type { CodexSemanticGenerationObserver } from "./transport-alias.js";

const MAX_TIMEOUT_SECONDS = Math.floor(Number.MAX_SAFE_INTEGER / 1000);
const codexAuthenticationSchema = z.enum(CODEX_AUTHENTICATIONS);

export const codexAdapterConfigurationSchema = z.strictObject({
  authentication: codexAuthenticationSchema,
  model: z.string().min(1, "modelは空にできません"),
  inputCostUsdPerMillionTokens: z.number().positive(),
  execution: z.strictObject({
    timeoutSeconds: z.number().int().positive().max(MAX_TIMEOUT_SECONDS),
    maxAttempts: z.number().int().positive(),
    maxSemanticGenerations: z.number().int().min(1).max(3),
    sandbox: z.literal("read-only"),
    approvalPolicy: z.literal("never"),
    reasoningEffort: z.enum(REASONING_EFFORTS),
  }),
  retry: z
    .strictObject({
      initialDelaySeconds: z.number().nonnegative(),
      maxDelaySeconds: z.number().nonnegative(),
    })
    .refine((retry) => retry.initialDelaySeconds <= retry.maxDelaySeconds, {
      message: "Codex retryの初期待機時間は最大待機時間以下にしてください",
    }),
});

/** Codex adapterのモデルと隔離実行設定。 */
export type CodexAdapterConfiguration = z.output<typeof codexAdapterConfigurationSchema>;

/** Codex adapterへ注入する副作用境界。 */
export type CodexAdapterDependencies = Readonly<{
  environment: NodeJS.ProcessEnv;
  processRunner: CodexProcessRunner;
  attemptBudget: CodexAttemptBudget;
  initialAttemptTicket?: CodexInitialAttemptTicket;
  attemptOwner?: Readonly<{ kind: "generic" | "personal"; id: string }>;
  runtime: Readonly<{
    sleep: (delayMilliseconds: number) => Promise<void>;
    random: () => number;
  }>;
  diagnostics?: CodexDiagnosticsContext;
  semanticGenerationObserver?: CodexSemanticGenerationObserver;
}>;
