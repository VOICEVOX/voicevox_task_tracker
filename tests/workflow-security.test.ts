import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";

import { parse } from "yaml";
import { describe, expect, it } from "vitest";
import { z } from "zod";

const WORKFLOW_DIRECTORY = join(import.meta.dirname, "..", ".github", "workflows");
const DAILY_WORKFLOW_PATH = join(WORKFLOW_DIRECTORY, "daily.yml");
const CI_WORKFLOW_PATH = join(WORKFLOW_DIRECTORY, "ci.yml");
const MERGE_GATEKEEPER_WORKFLOW_PATH = join(WORKFLOW_DIRECTORY, "merge_gatekeeper.yml");
const PERFORMANCE_WORKFLOW_PATH = join(WORKFLOW_DIRECTORY, "performance.yml");
const CODEX_AUTH_MASK_SCRIPT_PATH = join(
  import.meta.dirname,
  "..",
  ".github",
  "scripts",
  "mask-codex-auth-values.sh",
);
const CODEX_AUTH_MASK_COMMAND =
  '.github/scripts/mask-codex-auth-values.sh "${{ runner.temp }}/codex-home/auth.json"';
const CONFIG_PATH = join(import.meta.dirname, "..", "config.yml");
const PACKAGE_PATH = join(import.meta.dirname, "..", "package.json");
const FULL_COMMIT_ACTION_PATTERN = /^[^@\s]+@[0-9a-f]{40}$/u;
const VERSIONED_USES_LINE_PATTERN =
  /^\s*uses:\s+[^@\s]+@[0-9a-f]{40}\s+#\s+(?:v\d+(?:\.\d+){0,2}|main)\s*$/gmu;

const permissionSchema = z.enum(["read", "write", "none"]);
const permissionsSchema = z.record(z.string(), permissionSchema);
const stepSchema = z
  .object({
    env: z.record(z.string(), z.string()).optional(),
    id: z.string().optional(),
    if: z.string().optional(),
    name: z.string().optional(),
    uses: z.string().optional(),
    run: z.string().optional(),
    with: z.record(z.string(), z.unknown()).optional(),
  })
  .loose();
const needsSchema = z.union([z.string(), z.array(z.string())]);
const jobSchema = z
  .object({
    permissions: permissionsSchema,
    needs: needsSchema.optional(),
    if: z.string().optional(),
    steps: z.array(stepSchema),
  })
  .loose();
const workflowSchema = z
  .object({
    on: z.record(z.string(), z.unknown()),
    jobs: z.record(z.string(), jobSchema),
  })
  .loose();
const pullRequestTargetSchema = z
  .object({
    types: z.array(z.string()),
  })
  .loose();
const dailyWorkflowSchema = workflowSchema.extend({
  on: z
    .object({
      schedule: z.array(
        z
          .object({
            cron: z.string(),
          })
          .loose(),
      ),
      workflow_dispatch: z
        .object({
          inputs: z
            .object({
              backfill: z
                .object({
                  type: z.literal("choice"),
                  options: z.array(z.string()),
                })
                .loose(),
              repository_filter: z
                .object({
                  type: z.literal("string"),
                })
                .loose(),
            })
            .loose(),
        })
        .loose(),
    })
    .loose(),
  concurrency: z
    .object({
      group: z.string(),
      "cancel-in-progress": z.boolean(),
    })
    .loose(),
});
const configSchema = z
  .object({
    notifications: z
      .object({
        discord: z
          .object({
            webhookSecretName: z.string(),
            operationsWebhookSecretName: z.string(),
          })
          .loose(),
      })
      .loose(),
  })
  .loose();

type Workflow = z.output<typeof workflowSchema>;
type WorkflowJob = z.output<typeof jobSchema>;

async function readWorkflow(path: string): Promise<Workflow> {
  return workflowSchema.parse(parse(await readFile(path, "utf8")));
}

async function readDailyWorkflow(): Promise<z.output<typeof dailyWorkflowSchema>> {
  return dailyWorkflowSchema.parse(parse(await readFile(DAILY_WORKFLOW_PATH, "utf8")));
}

function collectUses(value: unknown): readonly string[] {
  if (Array.isArray(value)) {
    return value.flatMap((entry) => collectUses(entry));
  }
  if (typeof value !== "object" || value == null) {
    return [];
  }
  const uses: string[] = [];
  for (const [name, entry] of Object.entries(value)) {
    if (name === "uses") {
      if (typeof entry !== "string") {
        throw new TypeError("workflowのusesは文字列にしてください");
      }
      uses.push(entry);
    } else {
      uses.push(...collectUses(entry));
    }
  }
  return uses;
}

function needs(job: WorkflowJob): readonly string[] {
  if (job.needs == null) {
    return [];
  }
  return typeof job.needs === "string" ? [job.needs] : job.needs;
}

function secretJobNames(workflow: Workflow): readonly string[] {
  return Object.entries(workflow.jobs)
    .filter(([, job]) => JSON.stringify(job).includes("${{ secrets."))
    .map(([name]) => name)
    .sort();
}

function runCommands(job: WorkflowJob): readonly string[] {
  return job.steps.flatMap((step) => (step.run == null ? [] : [step.run]));
}

function environmentVariableNames(job: WorkflowJob): readonly string[] {
  return job.steps.flatMap((step) => (step.env == null ? [] : Object.keys(step.env)));
}

function requiredStep(job: WorkflowJob, name: string): WorkflowJob["steps"][number] {
  const step = job.steps.find((candidate) => candidate.name === name);
  if (step == null) {
    throw new TypeError(`workflowに${name} stepがありません`);
  }
  return step;
}

describe("日次workflow", () => {
  it("08:00 JST相当のcron、手動trigger、直列化を定義する", async () => {
    const workflow = await readDailyWorkflow();

    expect(workflow.on.schedule.map((schedule) => schedule.cron)).toEqual(["0 23 * * *"]);
    expect(workflow.on.workflow_dispatch).toBeDefined();
    expect(workflow.on.workflow_dispatch.inputs.backfill.options).toEqual([
      "none",
      "linked",
      "all-open",
    ]);
    expect(workflow.on.workflow_dispatch.inputs.repository_filter.type).toBe("string");
    expect(workflow.concurrency).toEqual({
      group: "voicevox-task-tracker-daily",
      "cancel-in-progress": false,
    });
  });

  it("jobごとのGITHUB_TOKEN権限をallowlistと一致させる", async () => {
    const workflow = await readDailyWorkflow();
    const actualPermissions = Object.fromEntries(
      Object.entries(workflow.jobs).map(([name, job]) => [name, job.permissions]),
    );

    expect(actualPermissions).toEqual({
      "test-eval": {
        contents: "read",
      },
      "collect-analyze": {
        contents: "read",
      },
      "persist-state": {
        contents: "write",
      },
      "build-pages": {
        contents: "read",
      },
      "deploy-pages": {
        pages: "write",
        "id-token": "write",
      },
      "notify-discord": {
        contents: "write",
      },
      "notify-operations": {
        contents: "write",
      },
      "report-workflow": {
        contents: "read",
      },
    });
  });

  it("失敗時も収集reportを保存し全job結果を一意なworkflow reportへまとめる", async () => {
    const workflow = await readDailyWorkflow();
    const collectJob = workflow.jobs["collect-analyze"];
    const reportJob = workflow.jobs["report-workflow"];
    if (collectJob == null || reportJob == null) {
      throw new TypeError("収集またはworkflow report jobがありません");
    }

    const collectReportUpload = requiredStep(collectJob, "収集run reportを保存");
    expect(collectReportUpload.if).toContain("always()");
    expect(collectReportUpload.with?.["path"]).toBe("artifacts/run-reports/collect-analyze.json");
    expect(collectReportUpload.with?.["name"]).toContain("${{ github.run_id }}");
    expect(collectReportUpload.with?.["name"]).toContain("${{ github.run_attempt }}");

    expect([...needs(reportJob)].sort()).toEqual(
      [
        "test-eval",
        "collect-analyze",
        "persist-state",
        "build-pages",
        "deploy-pages",
        "notify-discord",
        "notify-operations",
      ].sort(),
    );
    expect(reportJob.if).toContain("always()");
    const reportCommands = runCommands(reportJob).join("\n");
    expect(reportCommands).toContain("report-workflow");
    for (const jobName of needs(reportJob)) {
      expect(JSON.stringify(reportJob)).toContain(`needs.${jobName}.result`);
    }
    const workflowReportUpload = requiredStep(reportJob, "workflow run reportを保存");
    expect(workflowReportUpload.if).toContain("always()");
    expect(workflowReportUpload.with?.["path"]).toBe("artifacts/run-reports/workflow.json");
    expect(workflowReportUpload.with?.["name"]).toContain("${{ github.run_id }}");
    expect(workflowReportUpload.with?.["name"]).toContain("${{ github.run_attempt }}");
    expect(JSON.stringify(workflow.jobs["persist-state"])).not.toContain(
      "artifacts/run-reports/workflow.json",
    );
    expect(JSON.stringify(workflow.jobs["build-pages"])).not.toContain(
      "artifacts/run-reports/workflow.json",
    );
  });

  it("Discord通知をPagesのdeploy成功後だけに実行する", async () => {
    const workflow = await readDailyWorkflow();
    const notifyJob = workflow.jobs["notify-discord"];
    const deployJob = workflow.jobs["deploy-pages"];

    expect(notifyJob).toBeDefined();
    expect(deployJob).toBeDefined();
    if (notifyJob == null || deployJob == null) {
      throw new TypeError("Pages deployまたはDiscord通知jobがありません");
    }
    expect(needs(notifyJob)).toContain("deploy-pages");
    expect(notifyJob.if).toContain("success()");
    expect(needs(deployJob)).toContain("build-pages");
  });

  it("各jobが検証済みartifactを対応するCLI stageへ渡す", async () => {
    const workflow = await readDailyWorkflow();
    const collectCommands = runCommands(
      workflow.jobs["collect-analyze"] ?? { permissions: {}, steps: [] },
    ).join("\n");
    const persistCommands = runCommands(
      workflow.jobs["persist-state"] ?? { permissions: {}, steps: [] },
    ).join("\n");
    const buildCommands = runCommands(
      workflow.jobs["build-pages"] ?? { permissions: {}, steps: [] },
    ).join("\n");
    const notifyCommands = runCommands(
      workflow.jobs["notify-discord"] ?? { permissions: {}, steps: [] },
    ).join("\n");
    const operationsCommands = runCommands(
      workflow.jobs["notify-operations"] ?? { permissions: {}, steps: [] },
    ).join("\n");

    expect(collectCommands).toContain("collect-analyze");
    expect(collectCommands).toContain('--scheduled-for "$scheduled_for"');
    expect(collectCommands).toContain('"$GITHUB_EVENT_NAME" == "schedule"');
    expect(collectCommands).toContain('"$GITHUB_EVENT_NAME" == "workflow_dispatch"');
    expect(collectCommands).toContain("today 23:00");
    expect(collectCommands).toContain("pnpm build:workflow-cli");
    expect(collectCommands).toContain(
      "git fetch --no-tags origin refs/heads/tracker-state:refs/heads/tracker-state",
    );
    expect(persistCommands).toContain("tracker-run.mjs persist-state");
    expect(persistCommands).toContain(
      "git push origin refs/heads/tracker-state:refs/heads/tracker-state",
    );
    expect(buildCommands).toContain("tracker-run.mjs build-pages");
    expect(buildCommands).toContain(
      "git fetch --no-tags origin refs/heads/tracker-state:refs/heads/tracker-state",
    );
    expect(notifyCommands).toContain("tracker-run.mjs notify-discord");
    expect(notifyCommands).not.toContain("curl");
    expect(operationsCommands).toContain("tracker:run notify-operations");
    expect(operationsCommands).toContain("git ls-remote --exit-code --heads origin tracker-state");
    expect(operationsCommands).toContain(
      "git fetch --no-tags origin refs/heads/tracker-state:refs/heads/tracker-state",
    );
    expect(operationsCommands).toContain('elif [[ "$state_branch_status" -ne 2 ]]');
    expect(operationsCommands).toContain("incident_kind=collection");
    expect(operationsCommands).toContain("incident_kind=pages");
    expect(operationsCommands).toContain("incident_kind=discord");
    expect(operationsCommands).not.toContain("curl");
    for (const jobName of ["persist-state", "build-pages", "notify-discord"] as const) {
      expect(JSON.stringify(workflow.jobs[jobName])).toContain("actions/download-artifact@");
      expect(JSON.stringify(workflow.jobs[jobName])).toContain("validated-public-run");
    }
  });

  it("Codex CLIをexact versionで固定して収集jobへinstallする", async () => {
    const workflow = await readDailyWorkflow();
    const packageDefinition: unknown = JSON.parse(await readFile(PACKAGE_PATH, "utf8"));
    const packageSchema = z
      .object({
        devDependencies: z
          .object({
            "@openai/codex": z.string(),
          })
          .loose(),
      })
      .loose();
    const parsedPackage = packageSchema.parse(packageDefinition);
    const collectCommands = runCommands(
      workflow.jobs["collect-analyze"] ?? { permissions: {}, steps: [] },
    );

    expect(parsedPackage.devDependencies["@openai/codex"]).toMatch(/^\d+\.\d+\.\d+$/u);
    expect(collectCommands).toContain("pnpm install --frozen-lockfile");
    expect(collectCommands).toContain("pnpm exec codex --version");
  });

  it("Codex認証ファイルを一時ディレクトリへ配置し同じパスをCODEX_HOMEとして渡してjob終了時に必ず削除する", async () => {
    const workflow = await readDailyWorkflow();
    const collectJob = workflow.jobs["collect-analyze"];
    if (collectJob == null) {
      throw new TypeError("収集jobがありません");
    }

    const authenticationDirectory = "${{ runner.temp }}/codex-home";
    const authenticationFingerprint = "${{ runner.temp }}/codex-auth-fingerprint";
    const placementStep = requiredStep(collectJob, "Codex認証ファイルを配置");
    const collectionStep = requiredStep(collectJob, "収集と解析を実行");
    const cleanupStep = requiredStep(collectJob, "Codex認証関連ファイルを削除");
    if (placementStep.env == null || placementStep.run == null) {
      throw new TypeError("Codex認証ファイル配置stepの設定がありません");
    }
    if (collectionStep.env == null) {
      throw new TypeError("収集stepの環境変数がありません");
    }
    if (cleanupStep.run == null) {
      throw new TypeError("Codex認証関連ファイル削除stepのコマンドがありません");
    }

    expect(placementStep.env).toEqual({
      CODEX_AUTH_JSON: "${{ secrets.CODEX_AUTH_JSON }}",
    });
    expect(placementStep.id).toBe("codex_auth_placement");
    expect(placementStep.run).toContain('[[ -z "$CODEX_AUTH_JSON" ]]');
    expect(placementStep.run).toContain("exit 1");
    expect(placementStep.run).toContain(`mkdir -p "${authenticationDirectory}"`);
    expect(placementStep.run).toContain(`chmod 700 "${authenticationDirectory}"`);
    expect(placementStep.run).toContain(
      `printf '%s' "$CODEX_AUTH_JSON" > "${authenticationDirectory}/auth.json"`,
    );
    expect(placementStep.run).toContain(`chmod 600 "${authenticationDirectory}/auth.json"`);
    expect(placementStep.run).toContain(
      `sha256sum "${authenticationDirectory}/auth.json" > "${authenticationFingerprint}"`,
    );
    expect(placementStep.run).not.toContain("${{ secrets.CODEX_AUTH_JSON }}");
    expect(collectJob.steps.indexOf(placementStep)).toBeLessThan(
      collectJob.steps.indexOf(collectionStep),
    );
    expect(Object.keys(collectionStep.env)).toEqual([
      "BACKFILL_MODE",
      "CODEX_HOME",
      "GH_APP_ID",
      "GH_APP_PRIVATE_KEY",
      "REPOSITORY_FILTER",
    ]);
    expect(collectionStep.env["CODEX_HOME"]).toBe(authenticationDirectory);
    expect(collectionStep.env).not.toHaveProperty("OPENAI_API_KEY");
    expect(cleanupStep.if).toBe("always()");
    expect(cleanupStep.run).toContain(`rm -rf "${authenticationDirectory}"`);
    expect(cleanupStep.run).toContain(`rm -f "${authenticationFingerprint}"`);
    expect(collectJob.steps.at(-1)).toEqual(cleanupStep);
  });

  it("更新されたCodex認証ファイルだけを書き戻し同期用secretを専用stepへ限定する", async () => {
    const workflow = await readDailyWorkflow();
    const collectJob = workflow.jobs["collect-analyze"];
    if (collectJob == null) {
      throw new TypeError("収集jobがありません");
    }

    const collectionStep = requiredStep(collectJob, "収集と解析を実行");
    const synchronizationStep = requiredStep(
      collectJob,
      "更新されたCodex認証ファイルをsecretへ書き戻す",
    );
    const cleanupStep = requiredStep(collectJob, "Codex認証関連ファイルを削除");
    if (synchronizationStep.run == null) {
      throw new TypeError("Codex認証ファイル書き戻しstepのコマンドがありません");
    }

    expect(synchronizationStep.if).toBe(
      "always() && steps.codex_auth_placement.outcome == 'success'",
    );
    expect(synchronizationStep.env).toEqual({
      GH_TOKEN: "${{ secrets.CODEX_AUTH_SYNC_TOKEN }}",
    });
    expect(synchronizationStep.run).toContain('[[ -z "$GH_TOKEN" ]]');
    expect(synchronizationStep.run).toContain("CODEX_AUTH_SYNC_TOKENが空");
    expect(synchronizationStep.run).toContain(">&2");
    expect(synchronizationStep.run).toContain("exit 1");
    expect(synchronizationStep.run).toContain("sha256sum --check --status");
    expect(synchronizationStep.run).toContain("gh secret set CODEX_AUTH_JSON");
    expect(synchronizationStep.run).toContain('--repo "$GITHUB_REPOSITORY"');
    expect(synchronizationStep.run).toContain('< "${{ runner.temp }}/codex-home/auth.json"');
    expect(collectJob.steps.indexOf(collectionStep)).toBeLessThan(
      collectJob.steps.indexOf(synchronizationStep),
    );
    expect(collectJob.steps.indexOf(synchronizationStep)).toBeLessThan(
      collectJob.steps.indexOf(cleanupStep),
    );
    expect(JSON.stringify(collectionStep)).not.toContain("CODEX_AUTH_SYNC_TOKEN");
    expect(
      collectJob.steps.filter((step) => JSON.stringify(step).includes("CODEX_AUTH_SYNC_TOKEN")),
    ).toEqual([synchronizationStep]);
    for (const [jobName, job] of Object.entries(workflow.jobs)) {
      if (jobName !== "collect-analyze") {
        expect(JSON.stringify(job), jobName).not.toContain("CODEX_AUTH_SYNC_TOKEN");
      }
    }
  });

  it("Codex認証ファイル内の長い文字列を配置時と更新後にマスク登録する", async () => {
    const workflow = await readDailyWorkflow();
    const collectJob = workflow.jobs["collect-analyze"];
    if (collectJob == null) {
      throw new TypeError("収集jobがありません");
    }

    const placementStep = requiredStep(collectJob, "Codex認証ファイルを配置");
    const synchronizationStep = requiredStep(
      collectJob,
      "更新されたCodex認証ファイルをsecretへ書き戻す",
    );
    if (placementStep.run == null || synchronizationStep.run == null) {
      throw new TypeError("Codex認証ファイルのマスク対象stepにコマンドがありません");
    }

    expect(placementStep.run).toContain(CODEX_AUTH_MASK_COMMAND);
    expect(placementStep.run.trimEnd().endsWith(CODEX_AUTH_MASK_COMMAND)).toBe(true);
    expect(synchronizationStep.run).toContain(CODEX_AUTH_MASK_COMMAND);
    expect(synchronizationStep.run.indexOf(CODEX_AUTH_MASK_COMMAND)).toBeGreaterThan(
      synchronizationStep.run.indexOf("exit 1"),
    );
    expect(synchronizationStep.run.indexOf(CODEX_AUTH_MASK_COMMAND)).toBeLessThan(
      synchronizationStep.run.indexOf("sha256sum --check --status"),
    );

    const scriptSource = await readFile(CODEX_AUTH_MASK_SCRIPT_PATH, "utf8");
    const scriptMode = (await stat(CODEX_AUTH_MASK_SCRIPT_PATH)).mode;
    expect(scriptMode & 0o111).not.toBe(0);
    expect(scriptSource).toContain("jq --raw-output");
    expect(scriptSource).toContain(".. | strings");
    expect(scriptSource).toContain("select(length >= 16)");
    expect(scriptSource).toContain('"$auth_file" > "$mask_values_file"');
    expect(scriptSource).toContain("while IFS= read -r value");
    expect(scriptSource).toContain('escaped_value="${value//%/%25}"');
    expect(scriptSource).toContain("printf '::add-mask::%s\\n' \"$escaped_value\"");
  });

  it("外部secretを収集とDiscordのjobだけへ分離する", async () => {
    const workflow = await readDailyWorkflow();
    const workflowSource = await readFile(DAILY_WORKFLOW_PATH, "utf8");
    const collectSource = JSON.stringify(workflow.jobs["collect-analyze"]);
    const persistSource = JSON.stringify(workflow.jobs["persist-state"]);
    const buildSource = JSON.stringify(workflow.jobs["build-pages"]);
    const notifySource = JSON.stringify(workflow.jobs["notify-discord"]);
    const operationsSource = JSON.stringify(workflow.jobs["notify-operations"]);

    expect(collectSource).toContain("GH_APP_PRIVATE_KEY");
    expect(collectSource).toContain("CODEX_AUTH_JSON");
    expect(collectSource).toContain("CODEX_AUTH_SYNC_TOKEN");
    expect(collectSource.match(/\$\{\{ secrets\./gu)).toHaveLength(3);
    expect(collectSource).not.toContain("DISCORD_OPERATIONS_WEBHOOK_URL");
    expect(collectSource).not.toContain("DISCORD_WEBHOOK_URL");
    expect(persistSource).not.toContain("secrets.");
    expect(buildSource).not.toContain("secrets.");
    expect(notifySource).toContain("DISCORD_OPERATIONS_WEBHOOK_URL");
    expect(notifySource).toContain("DISCORD_WEBHOOK_URL");
    expect(notifySource).not.toContain("GH_APP_PRIVATE_KEY");
    expect(notifySource).not.toContain("CODEX_AUTH_JSON");
    expect(operationsSource).toContain("DISCORD_OPERATIONS_WEBHOOK_URL");
    expect(operationsSource).not.toContain("DISCORD_WEBHOOK_URL");
    expect(operationsSource).not.toContain("GH_APP_PRIVATE_KEY");
    expect(operationsSource).not.toContain("CODEX_AUTH_JSON");
    expect(workflowSource).not.toContain("OPENAI_API_KEY");
  });

  it("Discord secretの設定名を必要な通知jobの環境変数へ公開する", async () => {
    const workflow = await readDailyWorkflow();
    const config = configSchema.parse(parse(await readFile(CONFIG_PATH, "utf8")));
    const discordConfig = config.notifications.discord;

    expect(
      environmentVariableNames(workflow.jobs["notify-discord"] ?? { permissions: {}, steps: [] }),
    ).toContain(discordConfig.webhookSecretName);
    expect(
      environmentVariableNames(workflow.jobs["notify-discord"] ?? { permissions: {}, steps: [] }),
    ).toContain(discordConfig.operationsWebhookSecretName);
    expect(
      environmentVariableNames(
        workflow.jobs["notify-operations"] ?? { permissions: {}, steps: [] },
      ),
    ).toContain(discordConfig.operationsWebhookSecretName);
  });
});

describe("workflow security", () => {
  it("性能profileを外部secretなしの手動workflowへ分離する", async () => {
    const workflow = await readWorkflow(PERFORMANCE_WORKFLOW_PATH);
    const profileJob = workflow.jobs["end-to-end-profile"];
    if (profileJob == null) {
      throw new TypeError("end-to-end性能profile jobがありません");
    }

    expect(Object.keys(workflow.on)).toEqual(["workflow_dispatch"]);
    expect(profileJob.permissions).toEqual({ contents: "read" });
    expect(runCommands(profileJob)).toContain("pnpm perf:profile");
    expect(JSON.stringify(workflow)).not.toContain("${{ secrets.");
  });

  it("全Actionをref付きfull commit SHAへpinする", async () => {
    const fileNames = (await readdir(WORKFLOW_DIRECTORY))
      .filter((fileName) => fileName.endsWith(".yml") || fileName.endsWith(".yaml"))
      .sort();
    for (const fileName of fileNames) {
      const path = join(WORKFLOW_DIRECTORY, fileName);
      const source = await readFile(path, "utf8");
      const workflow = await readWorkflow(path);
      const uses = collectUses(workflow);
      const versionedUsesLines = source.match(VERSIONED_USES_LINE_PATTERN) ?? [];

      expect(uses.length, fileName).toBeGreaterThan(0);
      expect(
        uses.every((value) => FULL_COMMIT_ACTION_PATTERN.test(value)),
        fileName,
      ).toBe(true);
      expect(versionedUsesLines, fileName).toHaveLength(uses.length);
    }
  });

  it("pull request eventからsecret利用jobへ到達できない", async () => {
    const fileNames = (await readdir(WORKFLOW_DIRECTORY))
      .filter((fileName) => fileName.endsWith(".yml") || fileName.endsWith(".yaml"))
      .sort();
    for (const fileName of fileNames) {
      const workflow = await readWorkflow(join(WORKFLOW_DIRECTORY, fileName));
      const triggerNames = Object.keys(workflow.on);

      if (triggerNames.includes("pull_request_target")) {
        const pullRequestTarget = pullRequestTargetSchema.parse(workflow.on["pull_request_target"]);
        const steps = Object.values(workflow.jobs).flatMap((job) => job.steps);

        expect(pullRequestTarget.types, fileName).toEqual(["auto_merge_enabled"]);
        expect(
          steps.some((step) => step.uses?.startsWith("actions/checkout") === true),
          fileName,
        ).toBe(false);
        expect(
          steps.some((step) => step.run != null),
          fileName,
        ).toBe(false);
      }
      if (triggerNames.includes("pull_request")) {
        expect(secretJobNames(workflow), fileName).toEqual([]);
      }
    }

    const dailyWorkflow = await readWorkflow(DAILY_WORKFLOW_PATH);
    expect(Object.keys(dailyWorkflow.on).sort()).toEqual(["schedule", "workflow_dispatch"]);
    expect(secretJobNames(dailyWorkflow)).toEqual([
      "collect-analyze",
      "notify-discord",
      "notify-operations",
    ]);
    for (const jobName of secretJobNames(dailyWorkflow)) {
      expect(dailyWorkflow.jobs[jobName]?.if, jobName).toContain(
        "github.event.repository.default_branch",
      );
    }
    expect(needs(dailyWorkflow.jobs["notify-discord"] ?? { permissions: {}, steps: [] })).toContain(
      "collect-analyze",
    );
    const operationsJob = dailyWorkflow.jobs["notify-operations"];
    expect(needs(operationsJob ?? { permissions: {}, steps: [] })).toContain("collect-analyze");
    expect(needs(operationsJob ?? { permissions: {}, steps: [] })).toContain("build-pages");
    expect(needs(operationsJob ?? { permissions: {}, steps: [] })).toContain("deploy-pages");
    expect(needs(operationsJob ?? { permissions: {}, steps: [] })).toContain("notify-discord");
    expect(operationsJob?.if).toContain("needs.collect-analyze.result == 'failure'");
    expect(operationsJob?.if).toContain("needs.build-pages.result == 'failure'");
    expect(operationsJob?.if).toContain("needs.deploy-pages.result == 'failure'");
    expect(operationsJob?.if).toContain("needs.notify-discord.result == 'failure'");
    expect(JSON.stringify(operationsJob)).toContain(
      '"NOTIFY_DISCORD_RESULT":"${{ needs.notify-discord.result }}"',
    );
  });

  it("マージゲートをApprove数と全CI完了の二段で構成する", async () => {
    const workflow = await readWorkflow(MERGE_GATEKEEPER_WORKFLOW_PATH);

    expect(Object.keys(workflow.on).sort()).toEqual(["merge_group", "pull_request_target"]);
    expect(Object.keys(workflow.jobs)).toEqual(["merge_gatekeeper"]);

    const mergeGatekeeperJob = workflow.jobs["merge_gatekeeper"];
    if (mergeGatekeeperJob == null) {
      throw new TypeError("マージゲートjobがありません");
    }
    const approvalStep = mergeGatekeeperJob.steps.find(
      (step) => step.uses?.startsWith("voicevox/merge-gatekeeper@") === true,
    );
    const allCiStep = mergeGatekeeperJob.steps.find(
      (step) => step.uses?.startsWith("upsidr/merge-gatekeeper@") === true,
    );
    if (approvalStep == null || allCiStep == null) {
      throw new TypeError("マージゲートのApprove数検査または全CI完了待機stepがありません");
    }

    expect(mergeGatekeeperJob.permissions).toEqual({ checks: "read", statuses: "read" });
    expect(approvalStep.with?.["required_score"]).toBe(2);
    expect(approvalStep.with?.["score_rules"]).toContain("@Hiroshiba: 2");
    expect(approvalStep.with?.["score_rules"]).toContain("#reviewer: 1");
    expect(allCiStep.with?.["self"]).toBe("merge_gatekeeper");
  });

  it("CIのqualityと実state検証を権限分離する", async () => {
    const workflow = await readWorkflow(CI_WORKFLOW_PATH);
    const qualityJob = workflow.jobs["quality"];
    const verifyStateJob = workflow.jobs["verify-state"];
    if (qualityJob == null || verifyStateJob == null) {
      throw new TypeError("CIのqualityまたは実state検証jobがありません");
    }

    const qualityCommands = runCommands(qualityJob);
    for (const command of [
      "pnpm typecheck",
      "pnpm lint",
      "pnpm format:check",
      "pnpm test",
      "pnpm eval:golden",
      "pnpm build",
      "pnpm build:workflow-cli",
      "pnpm build:web",
    ]) {
      expect(qualityCommands).toContain(command);
    }
    expect(qualityJob.permissions).toEqual({ contents: "read" });
    expect(verifyStateJob.permissions).toEqual({ contents: "read" });

    const stateCheckout = requiredStep(verifyStateJob, "永続stateを取得");
    expect(stateCheckout.uses).toBe("actions/checkout@11d5960a326750d5838078e36cf38b85af677262");
    expect(stateCheckout.with).toMatchObject({
      ref: "tracker-state",
      path: "tracker-state",
      "persist-credentials": false,
    });
    expect(stateCheckout.with).not.toHaveProperty("repository");

    const verifyStateCommands = runCommands(verifyStateJob);
    expect(verifyStateCommands).toContain("pnpm build");
    expect(verifyStateCommands).toContain(
      "pnpm tracker:run verify-state --state-directory tracker-state/state",
    );
    expect(verifyStateCommands).not.toContain("pnpm eval:golden");
    expect(verifyStateCommands).not.toContain("pnpm perf:profile");
    expect(JSON.stringify(workflow)).not.toContain("${{ secrets.");
    expect(runCommands(qualityJob).join("\n")).not.toContain("curl");
  });
});
