import { z } from "zod";

import {
  aiAnalysisTargetSchema,
  createAiAnalysisTarget,
  type AiAnalysisTarget,
} from "../codex/index.js";

export const SANDBOX_MANIFEST_PATH = "state/sandbox-environment.json" as const;
export const SANDBOX_BRANCH_PREFIX = "sandbox-state/" as const;
export const SANDBOX_SOURCE_REPOSITORY = "Hiroshiba/voicevox_task_tracker" as const;

const ENVIRONMENT_ID_PATTERN = /^env-[1-9][0-9]*-[1-9][0-9]*$/u;
const GIT_REVISION_PATTERN = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u;
const SOURCE_REF_PATTERN = /^\S+$/u;
const WORKFLOW_RUN_ID_PATTERN = /^[1-9][0-9]*$/u;

const environmentIdSchema = z.string().regex(ENVIRONMENT_ID_PATTERN, "environment IDが不正です");
const gitRevisionSchema = z.string().regex(GIT_REVISION_PATTERN, "Git revisionが不正です");
const sourceRefSchema = z
  .string()
  .min(1, "source refは空にできません")
  .regex(SOURCE_REF_PATTERN, "source refに空白は使えません");
const workflowRunIdSchema = z.string().regex(WORKFLOW_RUN_ID_PATTERN, "workflow run IDが不正です");
const workflowRunAttemptSchema = z.number().int().positive();
const analysisModeSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("normal"),
  }),
  z.strictObject({
    kind: z.literal("forced"),
    target: aiAnalysisTargetSchema,
  }),
]);

const sandboxManifestSchema = z.strictObject({
  schemaVersion: z.literal(1),
  environmentId: environmentIdSchema,
  sourceRepository: z.literal(SANDBOX_SOURCE_REPOSITORY),
  sourceRef: sourceRefSchema,
  seedRevision: gitRevisionSchema,
});

const sandboxContextSchema = z.strictObject({
  ...sandboxManifestSchema.shape,
  codeRevision: gitRevisionSchema,
  baseStateRevision: gitRevisionSchema,
  workflowRunId: workflowRunIdSchema,
  workflowRunAttempt: workflowRunAttemptSchema,
  analysisMode: analysisModeSchema,
});

export type SandboxManifest = Readonly<{
  schemaVersion: 1;
  environmentId: string;
  sourceRepository: typeof SANDBOX_SOURCE_REPOSITORY;
  sourceRef: string;
  seedRevision: string;
}>;

type SandboxAnalysisMode =
  | Readonly<{
      kind: "normal";
    }>
  | Readonly<{
      kind: "forced";
      target: AiAnalysisTarget;
    }>;

export type SandboxRunContext = SandboxManifest &
  Readonly<{
    codeRevision: string;
    baseStateRevision: string;
    workflowRunId: string;
    workflowRunAttempt: number;
    analysisMode: SandboxAnalysisMode;
  }>;

function freezeManifest(value: z.output<typeof sandboxManifestSchema>): SandboxManifest {
  return Object.freeze({
    schemaVersion: value.schemaVersion,
    environmentId: value.environmentId,
    sourceRepository: value.sourceRepository,
    sourceRef: value.sourceRef,
    seedRevision: value.seedRevision,
  });
}

function freezeAnalysisMode(value: z.output<typeof analysisModeSchema>): SandboxAnalysisMode {
  if (value.kind === "normal") {
    return Object.freeze({
      kind: "normal",
    });
  }
  return Object.freeze({
    kind: "forced",
    target: createAiAnalysisTarget(value.target),
  });
}

/** 未検証値からsandbox manifestを生成する。 */
export function parseSandboxManifest(value: unknown): SandboxManifest {
  return freezeManifest(sandboxManifestSchema.parse(value));
}

/** 未検証値からsandbox実行contextを生成する。 */
export function parseSandboxContext(value: unknown): SandboxRunContext {
  const parsed = sandboxContextSchema.parse(value);
  const manifest = freezeManifest({
    schemaVersion: parsed.schemaVersion,
    environmentId: parsed.environmentId,
    sourceRepository: parsed.sourceRepository,
    sourceRef: parsed.sourceRef,
    seedRevision: parsed.seedRevision,
  });
  return Object.freeze({
    ...manifest,
    codeRevision: parsed.codeRevision,
    baseStateRevision: parsed.baseStateRevision,
    workflowRunId: parsed.workflowRunId,
    workflowRunAttempt: parsed.workflowRunAttempt,
    analysisMode: freezeAnalysisMode(parsed.analysisMode),
  });
}

/** environment IDからsandbox branch名を導出する。 */
export function sandboxBranchForEnvironment(environmentId: string): string {
  const parsedEnvironmentId = environmentIdSchema.parse(environmentId);
  return `${SANDBOX_BRANCH_PREFIX}${parsedEnvironmentId}`;
}

/** manifestとsandbox contextの固定識別情報が一致することを検証する。 */
export function assertSandboxManifestMatchesContext(
  manifest: SandboxManifest,
  context: SandboxRunContext,
): void {
  const parsedManifest = parseSandboxManifest(manifest);
  const parsedContext = parseSandboxContext(context);
  if (
    parsedManifest.environmentId !== parsedContext.environmentId ||
    parsedManifest.sourceRef !== parsedContext.sourceRef ||
    parsedManifest.seedRevision !== parsedContext.seedRevision
  ) {
    throw new TypeError("sandbox manifestと実行contextの識別情報が一致しません");
  }
}

/** sandboxで許可するorigin URLか検証する。 */
export function assertSandboxOrigin(origin: string): void {
  const normalized = origin
    .trim()
    .replace(/\/$/u, "")
    .replace(/\.git$/u, "");
  const allowed = [
    `git@github.com:${SANDBOX_SOURCE_REPOSITORY}`,
    `https://github.com/${SANDBOX_SOURCE_REPOSITORY}`,
    `ssh://git@github.com/${SANDBOX_SOURCE_REPOSITORY}`,
  ];
  if (!allowed.includes(normalized)) {
    throw new TypeError("sandbox実行のoriginがHiroshiba forkではありません");
  }
}
