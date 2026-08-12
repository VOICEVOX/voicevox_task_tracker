import { z } from "zod";

import { ConfigError, type ConfigIssue } from "./config-error.js";
import { CODEX_AUTHENTICATIONS } from "../codex/index.js";
import { REASONING_EFFORTS } from "../domain/index.js";
import { assertNonNullable } from "../util/assert-non-nullable.js";

const SUPPORTED_SCHEMA_MAJOR = 1;
const TARGET_ORGANIZATION = "VOICEVOX";
const SUPPORTED_AI_PROVIDER = "codex";
const STATE_BRANCH = "tracker-state";
const DEFAULT_HIGH_CONFIDENCE = 0.85;
const DEFAULT_MEDIUM_CONFIDENCE = 0.65;
const SCHEMA_VERSION_PATTERN = /^(?:0|[1-9]\d*)(?:\.\d+)*$/;
const GITHUB_ITEM_URL_PATTERN =
  /^https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/(?:issues|pull)\/[1-9]\d*\/?$/u;
const GITHUB_LOGIN_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/u;
const REPOSITORY_FULL_NAME_PATTERN = /^[^/\s]+\/[^/\s]+$/u;
const WEB_BASE_PATH_PATTERN = /^\/(?:[A-Za-z0-9._~-]+\/)*$/u;

const requiredStringSchema = z.string().min(1, "空文字は指定できません");
const positiveIntegerSchema = z.number().int().positive();
const nonNegativeIntegerSchema = z.number().int().nonnegative();
const nonNegativeNumberSchema = z.number().nonnegative();
const positiveNumberSchema = z.number().positive();
const probabilitySchema = z.number().min(0).max(1);
const statePathSchema = requiredStringSchema.superRefine((value, context) => {
  const segments = value.split("/");
  if (
    !value.startsWith("state/") ||
    value.endsWith("/") ||
    value.includes("\\") ||
    !/^[A-Za-z0-9._/-]+$/u.test(value) ||
    segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")
  ) {
    context.addIssue({
      code: "custom",
      message: "state配下の正規化された相対パスを指定してください",
    });
  }
});
const stateJsonPathSchema = statePathSchema.refine((value) => value.endsWith(".json"), {
  message: ".jsonで終わるパスを指定してください",
});
const webBasePathSchema = requiredStringSchema
  .regex(WEB_BASE_PATH_PATTERN, "先頭と末尾がスラッシュの絶対base pathを指定してください")
  .refine(
    (value) => !value.split("/").some((segment) => segment === "." || segment === ".."),
    "正規化されたbase pathを指定してください",
  );
const localeSchema = requiredStringSchema.superRefine((value, context) => {
  try {
    Intl.getCanonicalLocales(value);
  } catch (error: unknown) {
    if (!(error instanceof RangeError)) {
      throw error;
    }
    context.addIssue({
      code: "custom",
      message: "有効なlocaleを指定してください",
    });
  }
});

const schemaVersionSchema = z.union([z.string(), z.number()]).transform((value, context) => {
  const version = String(value);
  if (!SCHEMA_VERSION_PATTERN.test(version)) {
    context.addIssue({
      code: "custom",
      message: "1または1.0のようなversionを指定してください",
    });
    return z.NEVER;
  }

  const majorText = version.split(".").at(0);
  assertNonNullable(majorText, "schemaVersionからmajor versionを取得できませんでした");
  const major = Number(majorText);
  if (!Number.isSafeInteger(major)) {
    context.addIssue({
      code: "custom",
      message: "major versionは安全な整数の範囲で指定してください",
    });
    return z.NEVER;
  }
  if (major !== SUPPORTED_SCHEMA_MAJOR) {
    context.addIssue({
      code: "custom",
      message: `major version ${major.toString()}は未対応です。対応しているmajor versionは${SUPPORTED_SCHEMA_MAJOR.toString()}です`,
    });
    return z.NEVER;
  }

  return SUPPORTED_SCHEMA_MAJOR;
});

const organizationSchema = requiredStringSchema.transform((value, context) => {
  if (value !== TARGET_ORGANIZATION) {
    context.addIssue({
      code: "custom",
      message: `${TARGET_ORGANIZATION}を指定してください`,
    });
    return z.NEVER;
  }

  return TARGET_ORGANIZATION;
});

const aiProviderSchema = requiredStringSchema.transform((value, context) => {
  if (value !== SUPPORTED_AI_PROVIDER) {
    context.addIssue({
      code: "custom",
      message: `${value}は未対応です。${SUPPORTED_AI_PROVIDER}を指定してください`,
    });
    return z.NEVER;
  }

  return SUPPORTED_AI_PROVIDER;
});

const regexPatternSchema = requiredStringSchema.superRefine((value, context) => {
  try {
    new RegExp(value);
  } catch (error: unknown) {
    if (!(error instanceof SyntaxError)) {
      throw error;
    }
    context.addIssue({
      code: "custom",
      message: "正規表現として解釈できません",
    });
  }
});

const trackingIncludeSchema = requiredStringSchema.superRefine((value, context) => {
  if (value.includes("://") && !GITHUB_ITEM_URL_PATTERN.test(value)) {
    context.addIssue({
      code: "custom",
      message: "GitHub IssueかPull RequestのHTTPS URLまたはnode IDを指定してください",
    });
  } else if (/\s/u.test(value)) {
    context.addIssue({
      code: "custom",
      message: "node IDに空白は使えません",
    });
  }
});

const startAtSchema = z.iso
  .datetime({
    offset: true,
    error: "タイムゾーンを含むISO 8601日時を指定してください",
  })
  .transform((value) => new Date(value).toISOString());

const maintainerLoginSchema = z
  .string()
  .regex(GITHUB_LOGIN_PATTERN, "GitHub loginの形式で指定してください");
const maintainerLoginListSchema = z
  .array(maintainerLoginSchema)
  .min(1, "メンテナのGitHub loginを1件以上指定してください")
  .superRefine((logins, context) => {
    const seenLogins = new Set<string>();
    for (const [index, login] of logins.entries()) {
      const normalizedLogin = login.toLowerCase();
      if (seenLogins.has(normalizedLogin)) {
        context.addIssue({
          code: "custom",
          path: [index],
          message: "メンテナのGitHub loginが重複しています",
        });
      }
      seenLogins.add(normalizedLogin);
    }
  });
const maintainersSchema = z
  .strictObject({
    defaults: maintainerLoginListSchema,
    repositories: z.record(requiredStringSchema, maintainerLoginListSchema),
  })
  .superRefine((maintainers, context) => {
    for (const repositoryFullName of Object.keys(maintainers.repositories)) {
      if (!REPOSITORY_FULL_NAME_PATTERN.test(repositoryFullName)) {
        context.addIssue({
          code: "custom",
          path: ["repositories", repositoryFullName],
          message: "owner/repo形式で指定してください",
        });
      }
    }
  });

const thresholdSchema = z
  .strictObject({
    watch: nonNegativeNumberSchema,
    urgent: nonNegativeNumberSchema,
    critical: nonNegativeNumberSchema,
  })
  .superRefine((thresholds, context) => {
    if (thresholds.watch > thresholds.urgent) {
      context.addIssue({
        code: "custom",
        path: ["urgent"],
        message: "urgentはwatch以上にしてください",
      });
    }
    if (thresholds.urgent > thresholds.critical) {
      context.addIssue({
        code: "custom",
        path: ["critical"],
        message: "criticalはurgent以上にしてください",
      });
    }
  });

const importanceLevelsSchema = z
  .strictObject({
    high: nonNegativeNumberSchema,
    medium: nonNegativeNumberSchema,
  })
  .superRefine((levels, context) => {
    if (levels.high < levels.medium) {
      context.addIssue({
        code: "custom",
        path: ["high"],
        message: "highはmedium以上にしてください",
      });
    }
  });

const aiConfidenceSchema = z
  .strictObject({
    high: probabilitySchema.default(DEFAULT_HIGH_CONFIDENCE),
    medium: probabilitySchema.default(DEFAULT_MEDIUM_CONFIDENCE),
  })
  .superRefine((confidence, context) => {
    if (confidence.high < confidence.medium) {
      context.addIssue({
        code: "custom",
        path: ["high"],
        message: "highはmedium以上にしてください",
      });
    }
  });

const labelEffectsSchema = z
  .strictObject({
    priorityWeight: z.number().optional(),
    severityLift: z.number().int().min(0).max(1).optional(),
    requiresMaintainerDecision: z.boolean().optional(),
    suppressNotifications: z.boolean().optional(),
    countsAsProgress: z.boolean().optional(),
  })
  .refine((effects) => Object.keys(effects).length > 0, {
    message: "effectを1件以上指定してください",
  });

const mentionsSchema = z
  .strictObject({
    enabled: z.boolean().default(false),
    users: z
      .record(
        requiredStringSchema,
        z.string().regex(/^\d{17,20}$/, "Discord user IDを数字17桁から20桁で指定してください"),
      )
      .default(() => ({})),
  })
  .default(() => ({
    enabled: false,
    users: {},
  }));

const stateSchema = z
  .strictObject({
    branch: z.literal(STATE_BRANCH, {
      error: `${STATE_BRANCH}を指定してください`,
    }),
    snapshotPath: stateJsonPathSchema,
    historyDirectory: statePathSchema,
    aiCacheDirectory: statePathSchema,
    notificationLedgerPath: stateJsonPathSchema,
    runReportsDirectory: statePathSchema,
    canonicalJson: z.literal(true, {
      error: "canonicalJsonはtrueにしてください",
    }),
  })
  .superRefine((state, context) => {
    const paths: readonly (readonly [string, string])[] = [
      ["snapshotPath", state.snapshotPath],
      ["historyDirectory", state.historyDirectory],
      ["aiCacheDirectory", state.aiCacheDirectory],
      ["notificationLedgerPath", state.notificationLedgerPath],
      ["runReportsDirectory", state.runReportsDirectory],
    ];
    const seen = new Set<string>();
    for (const [name, path] of paths) {
      if (seen.has(path)) {
        context.addIssue({
          code: "custom",
          path: [name],
          message: "state内の別の保存先と同じパスは指定できません",
        });
      }
      seen.add(path);
    }
  });

const webConfigSchema = z.strictObject({
  basePath: webBasePathSchema,
  title: requiredStringSchema,
  defaultLocale: localeSchema,
  graph: z.strictObject({
    maxInitialNodes: positiveIntegerSchema,
  }),
});

const configSchema = z.strictObject({
  schemaVersion: schemaVersionSchema,
  organization: organizationSchema,
  tracking: z.strictObject({
    startAt: startAtSchema,
    autoInclude: z.strictObject({
      createdAfterStart: z.boolean(),
      changedAfterStart: z.boolean(),
      referencedByTracked: z.boolean(),
      referencesTracked: z.boolean(),
      nativeRelations: z.boolean(),
      relationDepth: nonNegativeIntegerSchema,
    }),
    relationExpansion: z.strictObject({
      maxItemsPerRun: positiveIntegerSchema,
    }),
    include: z.array(trackingIncludeSchema),
    retentionDaysAfterTerminal: nonNegativeIntegerSchema,
    backfill: z.strictObject({
      maxItemsPerRun: positiveIntegerSchema,
    }),
  }),
  maintainers: maintainersSchema,
  actors: z.strictObject({
    bots: z.strictObject({
      loginPatterns: z.array(regexPatternSchema),
      knownLogins: z.array(requiredStringSchema),
      treatAsHuman: z.array(requiredStringSchema),
    }),
  }),
  labels: z.strictObject({
    rules: z.array(
      z.strictObject({
        repository: requiredStringSchema,
        namePattern: regexPatternSchema,
        effects: labelEffectsSchema,
      }),
    ),
  }),
  staleness: z.strictObject({
    timezone: requiredStringSchema,
    recentProgressGraceHours: nonNegativeNumberSchema,
    thresholdsHours: z.strictObject({
      assessment: thresholdSchema,
      owner: thresholdSchema,
      decision: thresholdSchema,
      review: thresholdSchema,
      revision: thresholdSchema,
      reply: thresholdSchema,
      work: thresholdSchema,
      merge: thresholdSchema,
      automation: thresholdSchema,
    }),
  }),
  importance: z.strictObject({
    weights: z.strictObject({
      priorityLabelMultiplier: nonNegativeNumberSchema,
      blockedItem: nonNegativeNumberSchema,
      blockedRepository: nonNegativeNumberSchema,
      downstreamImpactMax: nonNegativeNumberSchema,
      milestoneWithDueDate: nonNegativeNumberSchema,
      milestoneDueSoon: nonNegativeNumberSchema,
      significantFeature: nonNegativeNumberSchema,
      explicitDeadline: nonNegativeNumberSchema,
      futureRisk: nonNegativeNumberSchema,
    }),
    dueSoonDays: nonNegativeNumberSchema,
    levels: importanceLevelsSchema,
  }),
  attention: z.strictObject({
    recencyFloor: probabilitySchema,
    levels: importanceLevelsSchema,
  }),
  ai: z
    .strictObject({
      provider: aiProviderSchema,
      enabled: z.boolean(),
      authentication: z.enum(CODEX_AUTHENTICATIONS),
      model: requiredStringSchema,
      promptVersion: requiredStringSchema,
      confidence: aiConfidenceSchema.default({
        high: DEFAULT_HIGH_CONFIDENCE,
        medium: DEFAULT_MEDIUM_CONFIDENCE,
      }),
      budget: z.strictObject({
        maxCallsPerRun: nonNegativeIntegerSchema,
        maxInputCharactersPerItem: positiveIntegerSchema,
        maxTotalInputCharactersPerRun: positiveIntegerSchema,
        maxEstimatedCostUsdPerRun: nonNegativeNumberSchema,
        estimatedInputCostUsdPerMillionTokens: positiveNumberSchema,
      }),
      execution: z.strictObject({
        timeoutSeconds: positiveIntegerSchema,
        maxAttempts: positiveIntegerSchema,
        maxConcurrentCalls: positiveIntegerSchema,
        sandbox: z.literal("read-only"),
        approvalPolicy: z.literal("never"),
        reasoningEffort: z.enum(REASONING_EFFORTS),
      }),
    })
    .superRefine((ai, context) => {
      if (ai.enabled && ai.model.startsWith("YOUR_")) {
        context.addIssue({
          code: "custom",
          path: ["model"],
          message: "YOUR_で始まるplaceholderは使用できません",
        });
      }
    }),
  notifications: z.strictObject({
    automationNoiseTitles: z.array(requiredStringSchema),
    discord: z.strictObject({
      enabled: z.boolean(),
      webhookSecretName: requiredStringSchema,
      operationsWebhookSecretName: requiredStringSchema,
      mentions: mentionsSchema,
      maxItemsPerDigest: positiveIntegerSchema,
      cooldownDays: z.strictObject({
        urgent: nonNegativeIntegerSchema,
        critical: nonNegativeIntegerSchema,
      }),
    }),
  }),
  state: stateSchema,
  web: webConfigSchema,
  operations: z.strictObject({
    githubApiBudgetRatio: probabilitySchema,
    retry: z.strictObject({
      maxAttempts: positiveIntegerSchema,
      initialDelaySeconds: nonNegativeNumberSchema,
      maxDelaySeconds: nonNegativeNumberSchema,
    }),
  }),
});

export type Config = z.output<typeof configSchema>;
export type WebConfig = z.output<typeof webConfigSchema>;

function formatPath(path: readonly PropertyKey[]): string {
  let formattedPath = "";
  for (const segment of path) {
    if (typeof segment === "number") {
      formattedPath += `[${segment.toString()}]`;
    } else {
      const separator = formattedPath.length === 0 ? "" : ".";
      formattedPath += `${separator}${String(segment)}`;
    }
  }
  return formattedPath.length === 0 ? "設定全体" : formattedPath;
}

function createConfigIssues(error: z.ZodError): ConfigIssue[] {
  return error.issues.map((issue) => ({
    path: formatPath(issue.path),
    message: issue.message,
  }));
}

/** 未検証の値を型付き設定へ変換する。 */
export function validateConfig(value: unknown): Config {
  const result = configSchema.safeParse(value, {
    error: z.locales.ja().localeError,
  });
  if (!result.success) {
    throw new ConfigError(createConfigIssues(result.error), {});
  }
  return result.data;
}

/** 未検証の設定全体からWeb設定だけを検証して取り出す。 */
export function validateWebConfig(value: unknown): WebConfig {
  const result = z
    .object({
      web: webConfigSchema,
    })
    .safeParse(value, {
      error: z.locales.ja().localeError,
    });
  if (!result.success) {
    throw new ConfigError(createConfigIssues(result.error), {});
  }
  return result.data.web;
}
