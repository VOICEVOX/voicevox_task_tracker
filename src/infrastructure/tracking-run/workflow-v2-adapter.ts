import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { parseDocument } from "yaml";
import { z } from "zod";

import { assertNonNullable } from "../../util/assert-non-nullable.js";

const deployAction = "actions/deploy-pages@d6db90164ac5ed86f2b6aed7e0febac5b3c0c03e";
const uploadAction = "actions/upload-pages-artifact@56afc609e74202658d3ffba0e8f6dda462b719fa";
const stepSchema = z.looseObject({
  id: z.string().optional(),
  name: z.string().optional(),
  run: z.string().optional(),
  uses: z.string().optional(),
  with: z.record(z.string(), z.unknown()).optional(),
  if: z.string().optional(),
  "continue-on-error": z.boolean().optional(),
});
const jobSchema = z.looseObject({
  name: z.string().optional(),
  uses: z.string().optional(),
  with: z.record(z.string(), z.unknown()).optional(),
  needs: z.union([z.string(), z.array(z.string())]).optional(),
  if: z.string().optional(),
  steps: z.array(stepSchema).optional(),
  permissions: z.record(z.string(), z.string()).optional(),
  environment: z.looseObject({ name: z.string() }).optional(),
  outputs: z.record(z.string(), z.string()).optional(),
});
const workflowCallInputSchema = z.looseObject({
  type: z.string(),
  required: z.boolean().optional(),
  default: z.unknown().optional(),
});
const workflowCallOutputSchema = z.looseObject({ value: z.string() });
const workflowSchema = z.looseObject({
  on: z.looseObject({
    workflow_call: z.looseObject({
      inputs: z.record(z.string(), workflowCallInputSchema),
      outputs: z.record(z.string(), workflowCallOutputSchema).optional(),
    }),
  }),
  jobs: z.record(z.string(), jobSchema),
});

function executionFields(value: Record<string, unknown>): object {
  return Object.fromEntries(Object.entries(value).filter(([name]) => name !== "name"));
}

function executionJob(job: z.output<typeof jobSchema>): object {
  return {
    ...executionFields(job),
    ...(job.steps == null ? {} : { steps: job.steps.map((step) => executionFields(step)) }),
  };
}

function hasProtocolCall(run: string | undefined, operation: string): boolean {
  if (run == null) {
    return false;
  }
  return run.split("\n").some((line) => {
    const source = line.trim();
    return (
      !source.startsWith("#") &&
      new RegExp(`(?:^|\\s)runtime-recovery-v2\\s+--operation\\s+${operation}(?:\\s|$)`, "u").test(
        source,
      )
    );
  });
}

async function readWorkflow(repositoryPath: string, relativePath: string) {
  const source = await readFile(resolve(repositoryPath, relativePath), "utf8");
  const document = parseDocument(source, {
    prettyErrors: true,
    schema: "core",
    uniqueKeys: true,
  });
  if (document.errors.length > 0) {
    throw new TypeError("V2 workflow adapterのYAMLが不正です", { cause: document.errors[0] });
  }
  return workflowSchema.parse(document.toJS());
}

function assertPagesSteps(
  deploySteps: readonly z.output<typeof stepSchema>[],
  recordSteps: readonly z.output<typeof stepSchema>[],
): void {
  const preflight = deploySteps.findIndex((step) => step.id === "preflight");
  const upload = deploySteps.findIndex((step) => step.uses === uploadAction);
  const sandboxUpload = deploySteps.findIndex((step) =>
    /^actions\/upload-artifact@[0-9a-f]{40}$/u.test(step.uses ?? ""),
  );
  const deploy = deploySteps.findIndex((step) => step.uses === deployAction);
  const observe = recordSteps.findIndex(
    (step) => step.uses === "./.github/actions/observe-pages-deployment",
  );
  const record = recordSteps.findIndex(
    (step) =>
      hasProtocolCall(step.run, "record_pages") &&
      step.run?.includes("--phase initial") === true &&
      step.run.includes("--phase notification_history") &&
      step.if?.includes("always()") === true,
  );
  const preflightRun = deploySteps[preflight]?.run;
  if (
    preflight < 0 ||
    !hasProtocolCall(preflightRun, "execute_stage") ||
    preflightRun?.includes("preflight-initial-pages-deployment") !== true ||
    !preflightRun.includes("preflight-history-pages-deployment") ||
    upload <= preflight ||
    sandboxUpload <= preflight ||
    deploy <= upload ||
    deploy <= sandboxUpload ||
    observe < 0 ||
    record <= observe ||
    recordSteps[observe]?.["continue-on-error"] !== true
  ) {
    throw new TypeError("V2 Pagesのdeploy jobとalways観測jobが接続されていません");
  }
  const adapterSteps = [
    ...deploySteps.slice(preflight, deploy + 1),
    ...recordSteps.slice(0, record + 1),
  ];
  if (
    adapterSteps.some(
      (step) =>
        (step.uses?.startsWith("actions/") === true &&
          !/^actions\/[a-z0-9-]+@[0-9a-f]{40}$/u.test(step.uses)) ||
        (step.uses?.startsWith("./") === true && !step.uses.startsWith("./.github/actions/")),
    )
  ) {
    throw new TypeError("V2 Pagesの静的adapterに固定されないactionがあります");
  }
}

function assertExactSourceCheckout(steps: readonly z.output<typeof stepSchema>[]): void {
  const checkout = steps[0];
  if (
    checkout?.uses == null ||
    !/^actions\/checkout@[0-9a-f]{40}$/u.test(checkout.uses) ||
    checkout.with?.["ref"] !== "${{ inputs.code_revision }}" ||
    checkout.with["path"] != null ||
    checkout.with["repository"] != null ||
    checkout.if != null ||
    checkout["continue-on-error"] === true ||
    steps.slice(1).some((step) => step.uses?.startsWith("actions/checkout@") === true)
  ) {
    throw new TypeError("V2 Pagesのlocal actionは先頭のexact source checkoutで固定してください");
  }
}

async function readWorkflowV2AdapterCurrentProjection(repositoryPath: string): Promise<{
  projection: object;
  deploy: z.output<typeof jobSchema>;
  record: z.output<typeof jobSchema>;
  workflowCallOutputs: Record<string, z.output<typeof workflowCallOutputSchema>> | undefined;
}> {
  const [tracking, pages] = await Promise.all([
    readWorkflow(repositoryPath, ".github/workflows/_tracking-run.yml"),
    readWorkflow(repositoryPath, ".github/workflows/_tracking-pages.yml"),
  ]);
  const trackingSteps = Object.values(tracking.jobs).flatMap((job) => job.steps ?? []);
  if (
    !trackingSteps.some((step) => hasProtocolCall(step.run, "inspect")) ||
    !trackingSteps.some((step) => hasProtocolCall(step.run, "execute_stage"))
  ) {
    throw new TypeError("V2固定入口のinspectまたはexecute_stageが実stepにありません");
  }
  const initial = tracking.jobs["initial-pages"];
  const history = tracking.jobs["notification-history-pages"];
  const deploy = pages.jobs["deploy"];
  const record = pages.jobs["record"];
  if (
    initial?.uses !== "./.github/workflows/_tracking-pages.yml" ||
    initial.with?.["phase"] !== "initial" ||
    history?.uses !== "./.github/workflows/_tracking-pages.yml" ||
    history.with?.["phase"] !== "notification_history" ||
    deploy?.steps == null ||
    deploy.permissions?.["pages"] !== "write" ||
    deploy.permissions["id-token"] !== "write" ||
    deploy.environment == null ||
    record?.steps == null ||
    record.permissions?.["pages"] !== "read" ||
    record.permissions["actions"] !== "read" ||
    record.if?.includes("always()") !== true ||
    record.needs !== "deploy"
  ) {
    throw new TypeError("V2 Pagesの静的jobまたは権限がありません");
  }
  assertPagesSteps(deploy.steps, record.steps);
  return {
    projection: {
      adapterVersion: "tracking-run-pages-actions-v2",
      calls: [executionJob(initial), executionJob(history)],
      workflowCallInputs: Object.fromEntries(
        Object.entries(pages.on.workflow_call.inputs).map(([name, input]) => [
          name,
          {
            type: input.type,
            ...(input.required == null ? {} : { required: input.required }),
            ...(Object.hasOwn(input, "default") ? { default: input.default } : {}),
          },
        ]),
      ),
      workflowContext: {
        ...(pages["env"] == null ? {} : { env: pages["env"] }),
        ...(pages["defaults"] == null ? {} : { defaults: pages["defaults"] }),
        ...(pages["permissions"] == null ? {} : { permissions: pages["permissions"] }),
        ...(pages["concurrency"] == null ? {} : { concurrency: pages["concurrency"] }),
      },
      deploy: executionJob(deploy),
      record: executionJob(record),
    },
    deploy,
    record,
    workflowCallOutputs: pages.on.workflow_call.outputs,
  };
}

/** V2固定入口とPages実actionの静的接続を検証してidentity入力を返す。 */
export async function readWorkflowV2Adapter(repositoryPath: string): Promise<object> {
  const { projection, deploy, record, workflowCallOutputs } =
    await readWorkflowV2AdapterCurrentProjection(repositoryPath);
  for (const job of [deploy, record]) {
    const steps = job.steps;
    assertNonNullable(steps, "V2 Pages jobのstepがありません");
    assertExactSourceCheckout(steps);
    const prior = steps.findIndex(
      (step) => step.uses === "./.github/actions/download-prior-initial-pages-outcome",
    );
    const preflight = steps.findIndex((step) => step.id === "preflight");
    if (
      prior < 0 ||
      preflight <= prior ||
      steps[prior]?.id !== "prior_initial" ||
      steps[preflight]?.if?.includes("steps.prior_initial.outcome == 'success'") !== true
    ) {
      throw new TypeError("V2初回Pagesの保存済み結果取得とpreflightが接続されていません");
    }
  }
  if (
    !record.steps?.some(
      (step) =>
        step.uses === "actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02" &&
        step.if?.includes("steps.initial_record.outputs.upload == 'true'") === true,
    )
  ) {
    throw new TypeError("V2初回Pagesの個別結果artifactが保存されません");
  }
  const deploymentSteps = deploy.steps?.filter((step) => step.uses === deployAction);
  if (
    deploy.name !==
      "${{ inputs.phase == 'initial' && 'initial-pages-deploy' || 'notification-history-pages-deploy' }}" ||
    deploymentSteps?.length !== 1 ||
    deploymentSteps[0]?.name !== "Pagesへdeploy" ||
    workflowCallOutputs?.["run_id"]?.value !== "${{ jobs.record.outputs.run_id }}" ||
    record.outputs?.["run_id"] !== "${{ steps.route.outputs.run_id }}"
  ) {
    throw new TypeError("V2 Pagesのdeploy名またはrun ID出力の接続が不正です");
  }
  return {
    ...projection,
    deployJobName: deploy.name,
    deployActionStepName: deploymentSteps[0].name,
    workflowCallOutputs: Object.fromEntries(
      Object.entries(workflowCallOutputs).map(([name, output]) => [name, output.value]),
    ),
  };
}

/** 旧現行V2 digestが記録した実効contextの投影をそのまま返す。 */
export async function readWorkflowV2AdapterCurrentLegacy(repositoryPath: string): Promise<object> {
  const { projection } = await readWorkflowV2AdapterCurrentProjection(repositoryPath);
  return projection;
}

/** 旧V2 digestが記録したjobだけの投影をそのまま返す。 */
export async function readWorkflowV2AdapterLegacy(repositoryPath: string): Promise<object> {
  const [tracking, pages] = await Promise.all([
    readWorkflow(repositoryPath, ".github/workflows/_tracking-run.yml"),
    readWorkflow(repositoryPath, ".github/workflows/_tracking-pages.yml"),
  ]);
  const initial = tracking.jobs["initial-pages"];
  const history = tracking.jobs["notification-history-pages"];
  const deploy = pages.jobs["deploy"];
  const record = pages.jobs["record"];
  if (initial == null || history == null || deploy == null || record == null) {
    throw new TypeError("旧V2 Pages adapterのjobがありません");
  }
  return {
    adapterVersion: "tracking-run-pages-actions-v2",
    calls: [initial, history],
    deploy,
    record,
  };
}

/** V2固定入口とPages実actionの静的接続をworkflow構造で検証する。 */
export async function assertWorkflowV2Adapter(repositoryPath: string): Promise<void> {
  await readWorkflowV2Adapter(repositoryPath);
}
