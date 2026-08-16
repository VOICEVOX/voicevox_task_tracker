import { readFile } from "node:fs/promises";

import { stringify } from "yaml";
import { describe, expect, it } from "vitest";

import { ConfigError, loadConfig, loadWebConfig, parseConfig } from "../src/config/index.js";
import { TaskTrackerError } from "../src/util/index.js";

const validConfigUrl = new URL("./fixtures/config.valid.yml", import.meta.url);
const developmentConfigUrl = new URL("../config.yml", import.meta.url);
const validConfigSource = await readFile(validConfigUrl, "utf8");

function replaceRequired(source: string, target: string, replacement: string): string {
  const replaced = source.replace(target, replacement);
  if (replaced === source) {
    throw new Error(`テストfixture内に置換対象がありません: ${target}`);
  }
  return replaced;
}

function captureConfigError(source: string): ConfigError {
  try {
    parseConfig(source);
  } catch (error: unknown) {
    if (error instanceof ConfigError) {
      return error;
    }
    throw error;
  }
  throw new Error("設定エラーが発生しませんでした");
}

describe("設定の読み込みと検証", () => {
  it("YAMLファイルを型付き設定として読み込む", async () => {
    const config = await loadConfig(validConfigUrl);

    expect(config.schemaVersion).toBe(1);
    expect(config.organization).toBe("VOICEVOX");
    expect(config.maintainers.defaults).toEqual(["default-maintainer"]);
    expect(config.maintainers.repositories["VOICEVOX/voicevox"]).toEqual([
      "voicevox-maintainer",
      "VoicevoxReviewer",
    ]);
    expect(config.ai.provider).toBe("codex");
    expect(config.ai.authentication).toBe("api-key");
    expect(config.ai.budget.maxEstimatedCostUsdPerRun).toBe(10);
    expect(config.ai.budget.estimatedInputCostUsdPerMillionTokens).toBe(1.25);
    expect(config.ai.execution.reasoningEffort).toBe("medium");
    expect(config.importance).toEqual({
      weights: {
        priorityLabelMultiplier: 1,
        blockedItem: 3,
        blockedRepository: 5,
        downstreamImpactMax: 30,
        milestoneWithDueDate: 10,
        milestoneDueSoon: 15,
        significantFeature: 20,
        explicitDeadline: 15,
        futureRisk: 15,
      },
      dueSoonDays: 14,
      levels: {
        high: 40,
        medium: 20,
      },
    });
    expect(config.attention).toEqual({
      recencyFloor: 0.4,
      levels: {
        high: 40,
        medium: 20,
      },
    });
    expect(config.notifications.automationNoiseTitles).toEqual([
      "Dependency Dashboard",
      "Renovate Dashboard",
    ]);
    expect(config.notifications.discord.mentions.enabled).toBe(false);
    expect(config.notifications.discord.repeatDays).toEqual({
      urgent: 3,
      critical: 2,
    });
    expect(config.state.branch).toBe("tracker-state-v4");
    expect(config.state.repositoryCacheDirectory).toBe("state/github-repositories");
    expect(config.state.itemCacheDirectory).toBe("state/github-items");
    expect(config.state.latestImportanceDirectory).toBe("state/ai-latest-importance");
    expect(config.state.aiCacheDirectory).toBe("state/ai-results");
    expect(config.state.canonicalJson).toBe(true);
  });

  it("関係先展開の1 run上限を読み込む", () => {
    const config = parseConfig(validConfigSource);

    expect(config.tracking.relationExpansion.maxItemsPerRun).toBe(500);
  });

  it("関係先展開の1 run上限に0以下を指定できない", () => {
    for (const maxItemsPerRun of [0, -1]) {
      const source = replaceRequired(
        validConfigSource,
        "  relationExpansion:\n    maxItemsPerRun: 500",
        `  relationExpansion:\n    maxItemsPerRun: ${maxItemsPerRun.toString()}`,
      );
      const error = captureConfigError(source);

      expect(error.message).toContain("tracking.relationExpansion.maxItemsPerRun");
    }
  });

  it("関係先展開の1 run上限に非整数を指定できない", () => {
    const source = replaceRequired(
      validConfigSource,
      "  relationExpansion:\n    maxItemsPerRun: 500",
      "  relationExpansion:\n    maxItemsPerRun: 1.5",
    );
    const error = captureConfigError(source);

    expect(error.message).toContain("tracking.relationExpansion.maxItemsPerRun");
  });

  it("未設定値が残る開発用設定からWeb設定だけを読み込む", async () => {
    const webConfig = await loadWebConfig(developmentConfigUrl);

    expect(webConfig).toMatchObject({
      basePath: "/voicevox_task_tracker/",
      title: "VOICEVOX Task Tracker",
      defaultLocale: "ja-JP",
    });
  });

  it("未知のschema major versionを明示的に拒否する", () => {
    const source = replaceRequired(validConfigSource, "schemaVersion: 1", 'schemaVersion: "2.0"');
    const error = captureConfigError(source);

    expect(error).toBeInstanceOf(TaskTrackerError);
    expect(error.message).toContain("schemaVersion");
    expect(error.message).toContain("major version 2は未対応です");
  });

  it("VOICEVOX以外のorganizationを拒否する", () => {
    const source = replaceRequired(
      validConfigSource,
      "organization: VOICEVOX",
      "organization: OTHER",
    );
    const error = captureConfigError(source);

    expect(error.message).toContain("organization");
    expect(error.message).toContain("VOICEVOXを指定してください");
  });

  it("GitHub Pagesで使えないWeb base pathを拒否する", () => {
    const source = replaceRequired(
      validConfigSource,
      "basePath: /voicevox_task_tracker/",
      "basePath: voicevox_task_tracker",
    );
    const error = captureConfigError(source);

    expect(error.message).toContain("web.basePath");
    expect(error.message).toContain("絶対base path");
  });

  it("不正なWeb localeを拒否する", () => {
    const source = replaceRequired(
      validConfigSource,
      "defaultLocale: ja-JP",
      "defaultLocale: invalid_locale",
    );
    const error = captureConfigError(source);

    expect(error.message).toContain("web.defaultLocale");
    expect(error.message).toContain("有効なlocale");
  });

  it("codex以外のAI providerを未対応として拒否する", () => {
    const source = replaceRequired(validConfigSource, "  provider: codex", "  provider: other");
    const error = captureConfigError(source);

    expect(error.message).toContain("ai.provider");
    expect(error.message).toContain("otherは未対応です");
  });

  it.each(["api-key", "auth-json"])("AI認証方式%sを受け入れる", (authentication) => {
    const source = replaceRequired(
      validConfigSource,
      "  authentication: api-key",
      `  authentication: "${authentication}"`,
    );
    const config = parseConfig(source);

    expect(config.ai.authentication).toBe(authentication);
  });

  it("未対応のAI認証方式を拒否する", () => {
    const source = replaceRequired(
      validConfigSource,
      "  authentication: api-key",
      "  authentication: unsupported",
    );
    const error = captureConfigError(source);

    expect(error.message).toContain("ai.authentication");
  });

  it("AIが有効な場合はplaceholderのmodelを拒否する", () => {
    const source = replaceRequired(
      validConfigSource,
      "  model: codex-model",
      "  model: YOUR_PINNED_CODEX_MODEL",
    );
    const error = captureConfigError(source);

    expect(error.message).toContain("ai.model");
    expect(error.message).toContain("placeholderは使用できません");
  });

  it("AIが無効な場合はplaceholderのmodelを許可する", () => {
    const disabledSource = replaceRequired(
      validConfigSource,
      "ai:\n  provider: codex\n  enabled: true",
      "ai:\n  provider: codex\n  enabled: false",
    );
    const source = replaceRequired(
      disabledSource,
      "  model: codex-model",
      "  model: YOUR_PINNED_CODEX_MODEL",
    );
    const config = parseConfig(source);

    expect(config.ai.model).toBe("YOUR_PINNED_CODEX_MODEL");
  });

  it.each(["none", "minimal", "low", "medium", "high", "xhigh", "max"])(
    "reasoning effortの対応値%sを受け入れる",
    (reasoningEffort) => {
      const source = replaceRequired(
        validConfigSource,
        "    reasoningEffort: medium",
        `    reasoningEffort: "${reasoningEffort}"`,
      );
      const config = parseConfig(source);

      expect(config.ai.execution.reasoningEffort).toBe(reasoningEffort);
    },
  );

  it("未対応のreasoning effortを拒否する", () => {
    const source = replaceRequired(
      validConfigSource,
      "    reasoningEffort: medium",
      "    reasoningEffort: extreme",
    );
    const error = captureConfigError(source);

    expect(error.message).toContain("ai.execution.reasoningEffort");
  });

  it("Codexの最大同時呼び出し数を読み込む", () => {
    const config = parseConfig(validConfigSource);

    expect(config.ai.execution.maxConcurrentCalls).toBe(4);
  });

  it.each([0, -1, 1.5])("Codexの最大同時呼び出し数に%sを指定できない", (value) => {
    const source = replaceRequired(
      validConfigSource,
      "    maxConcurrentCalls: 4",
      `    maxConcurrentCalls: ${value.toString()}`,
    );
    const error = captureConfigError(source);

    expect(error.message).toContain("ai.execution.maxConcurrentCalls");
  });

  it.each(["-invalid", "invalid-", "invalid--login", "invalid_login", "a".repeat(40)])(
    "GitHub loginとして不正な%sを拒否する",
    (login) => {
      const source = replaceRequired(
        validConfigSource,
        "  defaults: [default-maintainer]",
        `  defaults: [${login}]`,
      );
      const error = captureConfigError(source);

      expect(error.message).toContain("maintainers.defaults[0]");
      expect(error.message).toContain("GitHub loginの形式");
    },
  );

  it("メンテナを1件も指定できない", () => {
    const source = replaceRequired(
      validConfigSource,
      "  defaults: [default-maintainer]",
      "  defaults: []",
    );
    const error = captureConfigError(source);

    expect(error.message).toContain("maintainers.defaults");
    expect(error.message).toContain("1件以上");
  });

  it("GitHub loginの大文字小文字だけが違う重複を拒否する", () => {
    const source = replaceRequired(
      validConfigSource,
      "  defaults: [default-maintainer]",
      "  defaults: [Maintainer, maintainer]",
    );
    const error = captureConfigError(source);

    expect(error.message).toContain("maintainers.defaults[1]");
    expect(error.message).toContain("重複しています");
  });

  it("リポジトリ別メンテナ設定のキーをowner/repo形式へ制限する", () => {
    const source = replaceRequired(
      validConfigSource,
      "    VOICEVOX/voicevox: [voicevox-maintainer, VoicevoxReviewer]",
      "    VOICEVOX: [voicevox-maintainer]",
    );
    const error = captureConfigError(source);

    expect(error.message).toContain("maintainers.repositories.VOICEVOX");
    expect(error.message).toContain("owner/repo形式");
  });

  it("AI confidenceのhighがmedium未満なら拒否する", () => {
    const source = replaceRequired(
      validConfigSource,
      "    high: 0.85\n    medium: 0.65",
      "    high: 0.60\n    medium: 0.65",
    );
    const error = captureConfigError(source);

    expect(error.message).toContain("ai.confidence.high");
    expect(error.message).toContain("highはmedium以上にしてください");
  });

  it("AI runの見積費用上限に負数を指定できない", () => {
    const source = replaceRequired(
      validConfigSource,
      "    maxEstimatedCostUsdPerRun: 10",
      "    maxEstimatedCostUsdPerRun: -0.01",
    );
    const error = captureConfigError(source);

    expect(error.message).toContain("ai.budget.maxEstimatedCostUsdPerRun");
    expect(error.message).toContain("0以上");
  });

  it("AI入力token単価に0を指定できない", () => {
    const source = replaceRequired(
      validConfigSource,
      "    estimatedInputCostUsdPerMillionTokens: 1.25",
      "    estimatedInputCostUsdPerMillionTokens: 0",
    );
    const error = captureConfigError(source);

    expect(error.message).toContain("ai.budget.estimatedInputCostUsdPerMillionTokens");
    expect(error.message).toContain("0より大きい必要があります");
  });

  it("停滞閾値がwatch、urgent、criticalの順でなければ拒否する", () => {
    const source = replaceRequired(
      validConfigSource,
      "review: { watch: 48, urgent: 120, critical: 240 }",
      "review: { watch: 121, urgent: 120, critical: 119 }",
    );
    const error = captureConfigError(source);

    expect(error.message).toContain("staleness.thresholdsHours.review.urgent");
    expect(error.message).toContain("urgentはwatch以上にしてください");
    expect(error.message).toContain("staleness.thresholdsHours.review.critical");
    expect(error.message).toContain("criticalはurgent以上にしてください");
  });

  it.each([
    ["priorityLabelMultiplier", "1.0"],
    ["blockedItem", "3"],
    ["blockedRepository", "5"],
    ["downstreamImpactMax", "30"],
    ["milestoneWithDueDate", "10"],
    ["milestoneDueSoon", "15"],
    ["significantFeature", "20"],
    ["explicitDeadline", "15"],
    ["futureRisk", "15"],
  ])("重要度の重み%sに負数を指定できない", (weightName, configuredValue) => {
    const source = replaceRequired(
      validConfigSource,
      `    ${weightName}: ${configuredValue}`,
      `    ${weightName}: -1`,
    );
    const error = captureConfigError(source);

    expect(error.message).toContain(`importance.weights.${weightName}`);
    expect(error.message).toContain("0以上");
  });

  it("重要度levelのhighがmedium未満なら拒否する", () => {
    const source = replaceRequired(
      validConfigSource,
      "    high: 40\n    medium: 20",
      "    high: 19\n    medium: 20",
    );
    const error = captureConfigError(source);

    expect(error.message).toContain("importance.levels.high");
    expect(error.message).toContain("highはmedium以上にしてください");
  });

  it.each([-0.1, 1.1])("要対応度のrecencyFloorに範囲外の値%fを指定できない", (value) => {
    const source = replaceRequired(
      validConfigSource,
      "  recencyFloor: 0.4",
      `  recencyFloor: ${value.toString()}`,
    );
    const error = captureConfigError(source);

    expect(error.message).toContain("attention.recencyFloor");
  });

  it("要対応度levelのhighがmedium未満なら拒否する", () => {
    const source = replaceRequired(
      validConfigSource,
      "attention:\n  recencyFloor: 0.4\n  levels:\n    high: 40\n    medium: 20",
      "attention:\n  recencyFloor: 0.4\n  levels:\n    high: 19\n    medium: 20",
    );
    const error = captureConfigError(source);

    expect(error.message).toContain("attention.levels.high");
    expect(error.message).toContain("highはmedium以上にしてください");
  });

  it("ラベル変更を意味のある進捗として設定できる", () => {
    const source = replaceRequired(
      validConfigSource,
      "        requiresMaintainerDecision: true",
      "        requiresMaintainerDecision: true\n        countsAsProgress: true",
    );
    const config = parseConfig(source);

    expect(config.labels.rules[1]?.effects.countsAsProgress).toBe(true);
  });

  it("startAtをUTCへ正規化し、再解析しても変化させない", () => {
    const source = replaceRequired(
      validConfigSource,
      'startAt: "2026-01-01T00:00:00+09:00"',
      'startAt: "2026-07-31T08:30:45+09:00"',
    );

    const firstConfig = parseConfig(source);
    const secondConfig = parseConfig(stringify(firstConfig));

    expect(firstConfig.tracking.startAt).toBe("2026-07-30T23:30:45.000Z");
    expect(secondConfig.tracking.startAt).toBe(firstConfig.tracking.startAt);
  });

  it.each(["startAt: null", 'startAt: "2026-01-01T00:00:00"'])(
    "tracking.startAtを必須の日時文字列として検証する: %s",
    (startAt) => {
      const source = replaceRequired(
        validConfigSource,
        'startAt: "2026-01-01T00:00:00+09:00"',
        startAt,
      );
      const error = captureConfigError(source);

      expect(error.message).toContain("tracking.startAt");
    },
  );

  it("追跡対象の明示includeへGitHub node IDを指定できる", () => {
    const source = replaceRequired(
      validConfigSource,
      "    - https://github.com/VOICEVOX/voicevox/issues/1",
      "    - I_kwDOExplicitInclude",
    );
    const config = parseConfig(source);

    expect(config.tracking.include).toEqual(["I_kwDOExplicitInclude"]);
  });

  it("追跡対象の明示includeへGitHub以外のURLを指定できない", () => {
    const source = replaceRequired(
      validConfigSource,
      "    - https://github.com/VOICEVOX/voicevox/issues/1",
      "    - https://example.com/issues/1",
    );
    const error = captureConfigError(source);

    expect(error.message).toContain("tracking.include[0]");
    expect(error.message).toContain("GitHub IssueかPull Request");
  });

  it("mentions.enabledを省略した場合はfalseにする", () => {
    const source = replaceRequired(validConfigSource, "      enabled: false\n", "");
    const config = parseConfig(source);

    expect(config.notifications.discord.mentions.enabled).toBe(false);
  });

  it("automation noise titleに空文字を指定できない", () => {
    const source = replaceRequired(validConfigSource, "    - Renovate Dashboard", '    - ""');
    const error = captureConfigError(source);

    expect(error.message).toContain("notifications.automationNoiseTitles[1]");
    expect(error.message).toContain("空文字は指定できません");
  });

  it("通知のrepeatDaysに0以下の値を指定できない", () => {
    for (const [name, target] of [
      ["urgent", "      urgent: 3"],
      ["critical", "      critical: 2"],
    ] satisfies readonly [string, string][]) {
      const source = replaceRequired(validConfigSource, target, target.replace(/: \d+$/u, ": 0"));
      const error = captureConfigError(source);

      expect(error.message).toContain(`notifications.discord.repeatDays.${name}`);
    }
  });

  it("通知設定の旧キーを拒否する", () => {
    const legacySettingKey = ["cooldown", "Days"].join("");
    const source = replaceRequired(
      validConfigSource,
      "    repeatDays:",
      `    ${legacySettingKey}:`,
    );
    const error = captureConfigError(source);

    expect(error.message).toContain(legacySettingKey);
  });

  it("state保存先をtracker-state-v4 branchのstate配下へ制限する", () => {
    const invalidBranch = replaceRequired(
      validConfigSource,
      "branch: tracker-state-v4",
      "branch: main",
    );
    const invalidPath = replaceRequired(
      invalidBranch,
      "repositoryCacheDirectory: state/github-repositories",
      "repositoryCacheDirectory: ../github-repositories",
    );
    const error = captureConfigError(invalidPath);

    expect(error.message).toContain("state.branch");
    expect(error.message).toContain("tracker-state-v4");
    expect(error.message).toContain("state.repositoryCacheDirectory");
    expect(error.message).toContain("state配下");
  });

  it.each([
    "/state/github-repositories",
    "state/github-repositories/",
    "state/github-repositories/../other",
    "state//github-repositories",
    "state\\github-repositories",
  ])("stateの保存先へ正規化されていない相対path %sを指定できない", (path) => {
    const source = replaceRequired(validConfigSource, "state/github-repositories", path);
    const error = captureConfigError(source);

    expect(error.message).toContain("state.repositoryCacheDirectory");
    expect(error.message).toContain("state配下");
  });

  it.each([
    "snapshotPath: state/snapshot.json",
    "historyDirectory: state/history",
    "notificationLedgerPath: state/notification-ledger.json",
    "runReportsDirectory: state/run-reports",
  ])("stateの旧キー%sを拒否する", (legacyEntry) => {
    const source = replaceRequired(
      validConfigSource,
      "  canonicalJson: true",
      `  ${legacyEntry}\n  canonicalJson: true`,
    );
    const error = captureConfigError(source);

    expect(error.message).toContain(legacyEntry.split(":")[0]);
  });

  it.each([
    ["同一", "state/shared", "state/shared"],
    [
      "repositoryCacheDirectoryの配下",
      "state/github-repositories",
      "state/github-repositories/items",
    ],
    ["itemCacheDirectoryの配下", "state/github-items/repositories", "state/github-items"],
  ])("stateの保存先の%sを拒否する", (_description, repositoryPath, itemPath) => {
    let source = validConfigSource;
    if (repositoryPath !== "state/github-repositories") {
      source = replaceRequired(source, "state/github-repositories", repositoryPath);
    }
    if (itemPath !== "state/github-items") {
      source = replaceRequired(source, "state/github-items", itemPath);
    }
    const error = captureConfigError(source);

    expect(error.message).toContain("state.itemCacheDirectory");
    expect(error.message).toContain("同一または入れ子");
  });

  it("複数フィールドの不正を1件の設定エラーへまとめる", () => {
    const invalidOrganization = replaceRequired(
      validConfigSource,
      "organization: VOICEVOX",
      "organization: OTHER",
    );
    const invalidProvider = replaceRequired(
      invalidOrganization,
      "  provider: codex",
      "  provider: other",
    );
    const source = replaceRequired(invalidProvider, "default-maintainer", "invalid-");
    const error = captureConfigError(source);
    const paths = error.issues.map((issue) => issue.path);

    expect(paths).toEqual(
      expect.arrayContaining(["organization", "maintainers.defaults[0]", "ai.provider"]),
    );
  });
});
