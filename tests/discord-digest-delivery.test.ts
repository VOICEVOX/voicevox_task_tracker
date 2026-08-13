import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  buildSourceId,
  createGitHubNodeId,
  createGitHubRepositoryId,
  createUtcIsoDateTime,
  type GitHubItemDisplayReference,
  type GitHubItemUrl,
  type TrackedItem,
  type WaitingOn,
  type WaitingOnKind,
  type WaitingOnRole,
} from "../src/domain/index.js";
import {
  assertDiscordWebhookPayloadWithinLimits,
  buildDiscordDigestPlan,
  calculateDiscordPayloadSize,
  DiscordDigestDeliveryError,
  DiscordWebhookRequestError,
  DiscordWebhookSecretMissingError,
  sendDiscordDigest,
  sendDiscordOperationsAlert,
  type DiscordDeliveryDependencies,
  type DiscordDeliverySettings,
  type DiscordMentionSettings,
  type DiscordNotificationCandidate,
  type DiscordNotificationReasonCode,
  type DiscordOperationsIncident,
  type DiscordWebhookHttpClient,
  type DiscordWebhookHttpRequest,
  type DiscordWebhookHttpResponse,
  type DiscordWebhookRetrySettings,
  type DiscordWebhookRuntime,
} from "../src/discord/index.js";
import { assertNonNullable } from "../src/util/index.js";

const GENERATED_AT = createUtcIsoDateTime("2026-08-10T00:00:00.000Z");
const STALL_SINCE = createUtcIsoDateTime("2026-08-01T00:00:00.000Z");
const NORMAL_SECRET_NAME = "DISCORD_WEBHOOK_URL";
const OPERATIONS_SECRET_NAME = "DISCORD_OPERATIONS_WEBHOOK_URL";
const NORMAL_WEBHOOK_URL =
  "https://discord.com/api/webhooks/123456789012345678/normal-canary-secret";
const OPERATIONS_WEBHOOK_URL =
  "https://discord.com/api/webhooks/223456789012345678/operations-canary-secret";
const PAGES_URL = "https://voicevox.github.io/voicevox_task_tracker/";
const NORMAL_MESSAGE_ID = "323456789012345678";
const OPERATIONS_MESSAGE_ID = "423456789012345678";
const displayReferenceSchema = z.custom<GitHubItemDisplayReference>(
  (value) => typeof value === "string" && /^[^/\s]+\/[^#\s]+#[1-9]\d*$/u.test(value),
);
const githubItemUrlSchema = z.custom<GitHubItemUrl>(
  (value) => typeof value === "string" && value.startsWith("https://github.com/"),
);
const DEFAULT_MENTIONS = Object.freeze({ enabled: false, users: {} });
const DEFAULT_RETRY = Object.freeze({
  maxAttempts: 3,
  initialDelaySeconds: 0,
  maxDelaySeconds: 0,
});

type ItemOptions = Readonly<{
  title: string;
  waitingOn: readonly WaitingOn[];
  stallSince: typeof STALL_SINCE;
}>;

function createWaitingOn(kind: WaitingOnKind, candidateId: string, role: WaitingOnRole): WaitingOn {
  const sourceId = buildSourceId("discord_digest_fixture", candidateId);
  const sourceIds: readonly [typeof sourceId] = [sourceId];
  return Object.freeze({
    kind,
    candidateId,
    role,
    reasonSummary: "Discord digest fixtureの待機理由です",
    sourceIds,
    confidence: 1,
  });
}

function createTrackedItem(number: number, options: ItemOptions): TrackedItem {
  const numberText = number.toString();
  const nodeId = createGitHubNodeId(`I_discord_${numberText}`);
  return Object.freeze({
    nodeId,
    type: "issue",
    repositoryId: createGitHubRepositoryId(`R_discord_${numberText}`),
    displayReference: displayReferenceSchema.parse(
      `VOICEVOX/repository_${numberText}#${numberText}`,
    ),
    number,
    url: githubItemUrlSchema.parse(
      `https://github.com/VOICEVOX/repository_${numberText}/issues/${numberText}`,
    ),
    title: options.title,
    milestone: null,
    importance: { score: 0, level: "low", factors: [] },
    author: {
      status: "identified",
      actor: {
        type: "human",
        nodeId: createGitHubNodeId(`U_author_${numberText}`),
        login: `author-${numberText}`,
      },
    },
    latestEventActor: { status: "absent" },
    state: "open",
    notificationClass: "standard",
    status: "waiting_for_review",
    waitingOn: Object.freeze([...options.waitingOn]),
    primaryWaitingOn: Object.freeze({ index: 0, selectionReason: "fixture" }),
    nextAction: "次の対応を行う",
    createdAt: STALL_SINCE,
    githubUpdatedAt: STALL_SINCE,
    lastHumanActivityAt: STALL_SINCE,
    lastProgressAt: STALL_SINCE,
    statusSince: STALL_SINCE,
    ownerSince: STALL_SINCE,
    stallSince: options.stallSince,
    observedAt: GENERATED_AT,
    labels: [],
    assignees: [],
    reviewState: "requested",
    checkState: "not_applicable",
    aiAnalysis: { status: "not_required" },
    inputEvents: [],
    confidence: 1,
    evidence: [],
    uncertainties: [],
  } satisfies TrackedItem);
}

function defaultItemOptions(index: number): ItemOptions {
  return Object.freeze({
    title: `通知項目${index.toString()}`,
    waitingOn: Object.freeze([createWaitingOn("role", "reviewer", "reviewer")]),
    stallSince: STALL_SINCE,
  });
}

function createCandidate(
  item: TrackedItem,
  reasonCode: DiscordNotificationReasonCode,
  severity: DiscordNotificationCandidate["severity"],
): DiscordNotificationCandidate {
  const reasons: DiscordNotificationCandidate["reasons"] = Object.freeze([{ reasonCode }]);
  return Object.freeze({
    itemNodeId: item.nodeId,
    reasonCode,
    reasons,
    severity,
    downstreamImpact: { nodeId: item.nodeId, openNodeCount: 0, repositoryCount: 0 },
    priorityWeight: 0,
  });
}

function createSettings(
  enabled: boolean,
  mentions: DiscordMentionSettings,
  retry: DiscordWebhookRetrySettings,
  webhookSecretName: string,
  operationsWebhookSecretName: string,
): DiscordDeliverySettings {
  return Object.freeze({
    enabled,
    webhookSecretName,
    operationsWebhookSecretName,
    mentions,
    retry,
  });
}

function createRuntime(delays: number[], randomValue: number): DiscordWebhookRuntime {
  return createRuntimeWithRandom(delays, randomValue);
}

function createRuntimeWithRandom(delays: number[], randomValue: number): DiscordWebhookRuntime {
  return Object.freeze({
    sleep: (delayMilliseconds) => {
      delays.push(delayMilliseconds);
      return Promise.resolve();
    },
    random: () => randomValue,
    now: () => new Date(GENERATED_AT),
  });
}

function createDependencies(
  httpClient: DiscordWebhookHttpClient,
  runtime: DiscordWebhookRuntime,
  secrets: ReadonlyMap<string, string>,
  secretReads: string[],
): DiscordDeliveryDependencies {
  return Object.freeze({
    secretProvider: {
      read: (secretName) => {
        secretReads.push(secretName);
        return secrets.get(secretName);
      },
    },
    httpClient,
    runtime,
  });
}

function createHttpClient(
  requests: DiscordWebhookHttpRequest[],
  execute: (
    request: DiscordWebhookHttpRequest,
    requestNumber: number,
  ) => DiscordWebhookHttpResponse | Promise<DiscordWebhookHttpResponse>,
): DiscordWebhookHttpClient {
  return Object.freeze({
    execute: (request) => {
      requests.push(request);
      return Promise.resolve(execute(request, requests.length));
    },
  });
}

function successfulResponse(discordMessageId: string): DiscordWebhookHttpResponse {
  return Object.freeze({
    status: 200,
    retryAfter: undefined,
    body: { id: discordMessageId },
  });
}

function defaultSecrets(): ReadonlyMap<string, string> {
  return new Map([
    [NORMAL_SECRET_NAME, NORMAL_WEBHOOK_URL],
    [OPERATIONS_SECRET_NAME, OPERATIONS_WEBHOOK_URL],
  ]);
}

function successfulPagesDeployment(): Readonly<{
  status: "succeeded";
  pagesUrl: string;
}> {
  return Object.freeze({ status: "succeeded", pagesUrl: PAGES_URL });
}

function incident(): DiscordOperationsIncident {
  return {
    incidentId: "run-1:pages",
    kind: "pages",
    occurredAt: GENERATED_AT,
    retryAttempts: 3,
  };
}

async function captureError(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error: unknown) {
    if (error instanceof Error) {
      return error;
    }
    throw new TypeError("Error以外がthrowされました");
  }
  throw new TypeError("期待したエラーが発生しませんでした");
}

function errorMessages(error: Error): string {
  const messages = [error.message, error.stack ?? ""];
  let cause: unknown = error.cause;
  while (cause instanceof Error) {
    messages.push(cause.message, cause.stack ?? "");
    cause = cause.cause;
  }
  return messages.join("\n");
}

describe("Discord digest payload", () => {
  it("3分類と各項目の必須情報、Pages URL、JST時刻を含める", () => {
    const items = [1, 2, 3].map((number) => createTrackedItem(number, defaultItemOptions(number)));
    const firstItem = items[0];
    const secondItem = items[1];
    const thirdItem = items[2];
    assertNonNullable(firstItem, "digest fixtureの1件目がありません");
    assertNonNullable(secondItem, "digest fixtureの2件目がありません");
    assertNonNullable(thirdItem, "digest fixtureの3件目がありません");
    const candidates = [
      createCandidate(firstItem, "blocker_overdue", "urgent"),
      createCandidate(secondItem, "owner_unknown", "watch"),
      createCandidate(thirdItem, "newly_unblocked", "watch"),
    ];
    const plan = buildDiscordDigestPlan({
      candidates,
      items,
      pagesUrl: PAGES_URL,
      generatedAt: GENERATED_AT,
      mentions: DEFAULT_MENTIONS,
    });
    const serialized = JSON.stringify(plan.messages.map((message) => message.payload));

    expect(serialized).toContain("停止要因");
    expect(serialized).toContain("内容確認または担当が未確定");
    expect(serialized).toContain("新規解消や重要な変化");
    expect(serialized).toContain(PAGES_URL);
    expect(serialized).toContain("2026年8月10日 09:00 JST");
    expect(serialized).toContain("2026年8月1日 09:00 JSTから");
    expect(serialized).toContain("経過時間: 9日、");
    for (const item of items) {
      expect(serialized).toContain(item.displayReference);
      expect(serialized).toContain(item.title);
      expect(serialized).toContain(`GitHub: ${item.url}`);
    }
    expect(serialized).toContain("waitingOn:");
    expect(serialized).toContain("理由:");
    expect(plan.digestId).toMatch(/^discord-digest:v1:[a-f0-9]{24}$/u);
  });

  it.each([
    ["assessment_overdue", "内容確認待ちが基準時間を超えました"],
    ["owner_overdue", "担当決め待ちが基準時間を超えました"],
    ["decision_overdue", "方針判断待ちが基準時間を超えました"],
    ["review_overdue", "レビュー待ちが基準時間を超えました"],
    ["revision_overdue", "修正待ちが基準時間を超えました"],
    ["reply_overdue", "返答待ちが基準時間を超えました"],
    ["merge_overdue", "マージ待ちが基準時間を超えました"],
    ["automation_stuck", "自動処理待ちが基準時間を超えました"],
    ["owner_unknown", "待ち先不明です"],
  ] satisfies readonly [DiscordNotificationReasonCode, string][])(
    "$0の日本語理由をpayloadへ含める",
    (reasonCode, expectedReason) => {
      const item = createTrackedItem(1, defaultItemOptions(1));
      const plan = buildDiscordDigestPlan({
        candidates: [createCandidate(item, reasonCode, "watch")],
        items: [item],
        pagesUrl: PAGES_URL,
        generatedAt: GENERATED_AT,
        mentions: DEFAULT_MENTIONS,
      });
      expect(JSON.stringify(plan.messages.map((message) => message.payload))).toContain(
        `理由: ${expectedReason}`,
      );
    },
  );

  it("長文20件を安全上限内の複数payloadへ分割する", () => {
    const items = Array.from({ length: 20 }, (_, index) =>
      createTrackedItem(index + 1, {
        title: `${index.toString()} ${"非常に長いタイトル".repeat(80)}`,
        waitingOn: [
          createWaitingOn("user", `long-user-${"x".repeat(500)}-${index.toString()}`, "reviewer"),
        ],
        stallSince: STALL_SINCE,
      }),
    );
    const plan = buildDiscordDigestPlan({
      candidates: items.map((item) => createCandidate(item, "review_overdue", "watch")),
      items,
      pagesUrl: PAGES_URL,
      generatedAt: GENERATED_AT,
      mentions: DEFAULT_MENTIONS,
    });

    expect(plan.messages.length).toBeGreaterThan(1);
    expect(plan.messages.flatMap((message) => message.itemNodeIds)).toHaveLength(20);
    for (const message of plan.messages) {
      expect(() => {
        assertDiscordWebhookPayloadWithinLimits(message.payload);
      }).not.toThrow();
      const size = calculateDiscordPayloadSize(message.payload);
      expect(size.contentCharacters).toBeLessThanOrEqual(1800);
      expect(size.embedCount).toBeLessThanOrEqual(8);
      expect(size.embedCharacters).toBeLessThanOrEqual(5500);
      expect(size.fieldCount).toBeLessThanOrEqual(20);
      expect(size.fieldsPerEmbed.every((count) => count <= 20)).toBe(true);
    }
  });

  it("既定payloadではmentionを無効化する", () => {
    const item = createTrackedItem(1, {
      title: "@everyone を含むタイトル",
      waitingOn: [createWaitingOn("user", "everyone", "reviewer")],
      stallSince: STALL_SINCE,
    });
    const plan = buildDiscordDigestPlan({
      candidates: [createCandidate(item, "review_overdue", "watch")],
      items: [item],
      pagesUrl: PAGES_URL,
      generatedAt: GENERATED_AT,
      mentions: DEFAULT_MENTIONS,
    });
    const payload = plan.messages[0]?.payload;

    expect(payload?.allowed_mentions).toEqual({
      parse: [],
      roles: [],
      users: [],
      replied_user: false,
    });
    expect(JSON.stringify(payload)).toContain("@everyone");
  });

  it("mention有効時も登録済みIDだけを許可する", () => {
    const registeredUserId = "523456789012345678";
    const item = createTrackedItem(1, {
      title: "mention確認",
      waitingOn: [
        createWaitingOn("user", "RegisteredUser", "reviewer"),
        createWaitingOn("user", "plain-user", "reviewer"),
      ],
      stallSince: STALL_SINCE,
    });
    const plan = buildDiscordDigestPlan({
      candidates: [createCandidate(item, "review_overdue", "watch")],
      items: [item],
      pagesUrl: PAGES_URL,
      generatedAt: GENERATED_AT,
      mentions: {
        enabled: true,
        users: {
          registereduser: registeredUserId,
          unusedUser: "623456789012345678",
        },
      },
    });
    const payload = plan.messages[0]?.payload;
    const serialized = JSON.stringify(payload);

    expect(payload?.allowed_mentions).toEqual({
      parse: [],
      roles: [],
      users: [registeredUserId],
      replied_user: false,
    });
    expect(serialized).toContain(`<@${registeredUserId}>`);
    expect(serialized).toContain("@plain-user");
    expect(serialized).not.toContain("<@623456789012345678>");
  });
});

describe("Discord digest delivery", () => {
  it("成功送信でmessage IDを取得しledger情報を返さない", async () => {
    const requests: DiscordWebhookHttpRequest[] = [];
    const secretReads: string[] = [];
    const item = createTrackedItem(1, defaultItemOptions(1));
    const result = await sendDiscordDigest({
      candidates: [createCandidate(item, "owner_overdue", "urgent")],
      items: [item],
      generatedAt: GENERATED_AT,
      pagesDeployment: successfulPagesDeployment(),
      settings: createSettings(
        true,
        DEFAULT_MENTIONS,
        DEFAULT_RETRY,
        NORMAL_SECRET_NAME,
        OPERATIONS_SECRET_NAME,
      ),
      dependencies: createDependencies(
        createHttpClient(requests, () => successfulResponse(NORMAL_MESSAGE_ID)),
        createRuntime([], 0),
        defaultSecrets(),
        secretReads,
      ),
    });

    expect(result).toMatchObject({ status: "sent", discordMessageIds: [NORMAL_MESSAGE_ID] });
    expect(new URL(requests[0]?.url ?? "").searchParams.get("wait")).toBe("true");
    expect(JSON.stringify(result)).not.toContain("ledger");
  });

  it("通常webhookのsecretが無ければ値を露出せず明示エラーにする", async () => {
    const requests: DiscordWebhookHttpRequest[] = [];
    const secretReads: string[] = [];
    const item = createTrackedItem(1, defaultItemOptions(1));
    const error = await captureError(
      sendDiscordDigest({
        candidates: [createCandidate(item, "review_overdue", "watch")],
        items: [item],
        generatedAt: GENERATED_AT,
        pagesDeployment: successfulPagesDeployment(),
        settings: createSettings(
          true,
          DEFAULT_MENTIONS,
          DEFAULT_RETRY,
          NORMAL_SECRET_NAME,
          OPERATIONS_SECRET_NAME,
        ),
        dependencies: createDependencies(
          createHttpClient(requests, () => successfulResponse(NORMAL_MESSAGE_ID)),
          createRuntime([], 0),
          new Map(),
          secretReads,
        ),
      }),
    );

    expect(error).toBeInstanceOf(DiscordWebhookSecretMissingError);
    expect(error.message).toContain(NORMAL_SECRET_NAME);
    expect(requests).toHaveLength(0);
    expect(secretReads).toEqual([NORMAL_SECRET_NAME]);
  });

  it("HTTP errorとtransport errorへwebhook secretを露出しない", async () => {
    const item = createTrackedItem(1, defaultItemOptions(1));
    const settings = createSettings(
      true,
      DEFAULT_MENTIONS,
      DEFAULT_RETRY,
      NORMAL_SECRET_NAME,
      OPERATIONS_SECRET_NAME,
    );
    const httpError = await captureError(
      sendDiscordDigest({
        candidates: [createCandidate(item, "review_overdue", "watch")],
        items: [item],
        generatedAt: GENERATED_AT,
        pagesDeployment: successfulPagesDeployment(),
        settings,
        dependencies: createDependencies(
          createHttpClient([], () => ({
            status: 400,
            retryAfter: undefined,
            body: `失敗 ${NORMAL_WEBHOOK_URL}`,
          })),
          createRuntime([], 0),
          defaultSecrets(),
          [],
        ),
      }),
    );
    const transportError = await captureError(
      sendDiscordDigest({
        candidates: [createCandidate(item, "review_overdue", "watch")],
        items: [item],
        generatedAt: GENERATED_AT,
        pagesDeployment: successfulPagesDeployment(),
        settings: createSettings(
          true,
          DEFAULT_MENTIONS,
          Object.freeze({ maxAttempts: 1, initialDelaySeconds: 0, maxDelaySeconds: 0 }),
          NORMAL_SECRET_NAME,
          OPERATIONS_SECRET_NAME,
        ),
        dependencies: createDependencies(
          Object.freeze({
            execute: () => Promise.reject(new Error(`transport ${NORMAL_WEBHOOK_URL}`)),
          }),
          createRuntime([], 0),
          defaultSecrets(),
          [],
        ),
      }),
    );

    expect(httpError).toBeInstanceOf(DiscordWebhookRequestError);
    expect(transportError).toBeInstanceOf(DiscordDigestDeliveryError);
    expect(errorMessages(httpError)).not.toContain(NORMAL_WEBHOOK_URL);
    expect(errorMessages(transportError)).not.toContain(NORMAL_WEBHOOK_URL);
    expect(errorMessages(transportError)).not.toContain("normal-canary-secret");
  });

  it("一時的なtransport失敗を上限付き指数backoffで再試行する", async () => {
    const requests: DiscordWebhookHttpRequest[] = [];
    const delays: number[] = [];
    const item = createTrackedItem(1, defaultItemOptions(1));
    let attempts = 0;
    const result = await sendDiscordDigest({
      candidates: [createCandidate(item, "review_overdue", "watch")],
      items: [item],
      generatedAt: GENERATED_AT,
      pagesDeployment: successfulPagesDeployment(),
      settings: createSettings(
        true,
        DEFAULT_MENTIONS,
        Object.freeze({ maxAttempts: 4, initialDelaySeconds: 2, maxDelaySeconds: 5 }),
        NORMAL_SECRET_NAME,
        OPERATIONS_SECRET_NAME,
      ),
      dependencies: createDependencies(
        Object.freeze({
          execute: (request) => {
            requests.push(request);
            attempts += 1;
            if (attempts < 4) {
              return Promise.reject(new TypeError("一時的なtransport失敗"));
            }
            return Promise.resolve(successfulResponse(NORMAL_MESSAGE_ID));
          },
        }),
        createRuntimeWithRandom(delays, 0.5),
        defaultSecrets(),
        [],
      ),
    });

    expect(result.status).toBe("sent");
    expect(requests).toHaveLength(4);
    expect(delays).toEqual([1500, 3000, 3750]);
  });

  it("恒久的なHTTPエラーは再試行しない", async () => {
    const requests: DiscordWebhookHttpRequest[] = [];
    const delays: number[] = [];
    const item = createTrackedItem(1, defaultItemOptions(1));
    const error = await captureError(
      sendDiscordDigest({
        candidates: [createCandidate(item, "review_overdue", "watch")],
        items: [item],
        generatedAt: GENERATED_AT,
        pagesDeployment: successfulPagesDeployment(),
        settings: createSettings(
          true,
          DEFAULT_MENTIONS,
          DEFAULT_RETRY,
          NORMAL_SECRET_NAME,
          OPERATIONS_SECRET_NAME,
        ),
        dependencies: createDependencies(
          createHttpClient(requests, () => ({
            status: 400,
            retryAfter: undefined,
            body: {},
          })),
          createRuntime(delays, 0),
          defaultSecrets(),
          [],
        ),
      }),
    );

    expect(error).toBeInstanceOf(DiscordWebhookRequestError);
    expect(requests).toHaveLength(1);
    expect(delays).toEqual([]);
  });

  it("Pages失敗時は通常digestを送らず運用障害を送る", async () => {
    const requests: DiscordWebhookHttpRequest[] = [];
    const item = createTrackedItem(1, defaultItemOptions(1));
    const result = await sendDiscordDigest({
      candidates: [createCandidate(item, "review_overdue", "watch")],
      items: [item],
      generatedAt: GENERATED_AT,
      pagesDeployment: {
        status: "failed",
        incidentId: "pages-run-20260810",
        kind: "pages",
        failedAt: GENERATED_AT,
        retryAttempts: 4,
      },
      settings: createSettings(
        true,
        DEFAULT_MENTIONS,
        DEFAULT_RETRY,
        NORMAL_SECRET_NAME,
        OPERATIONS_SECRET_NAME,
      ),
      dependencies: createDependencies(
        createHttpClient(requests, () => successfulResponse(OPERATIONS_MESSAGE_ID)),
        createRuntime([], 0),
        defaultSecrets(),
        [],
      ),
    });

    expect(result).toMatchObject({
      status: "skipped",
      reason: "pages_deployment_failed",
      operationsAlert: { status: "sent" },
    });
    expect(requests).toHaveLength(1);
    expect(new URL(requests[0]?.url ?? "").pathname).toContain("223456789012345678");
    expect(requests[0]?.payload.content).toContain("運用障害");
    expect(requests[0]?.payload.content).not.toContain("日次digest");
  });

  it("候補0件ならsecretを読まずwebhookを呼ばない", async () => {
    const requests: DiscordWebhookHttpRequest[] = [];
    const secretReads: string[] = [];
    const result = await sendDiscordDigest({
      candidates: [],
      items: [],
      generatedAt: GENERATED_AT,
      pagesDeployment: successfulPagesDeployment(),
      settings: createSettings(
        true,
        DEFAULT_MENTIONS,
        DEFAULT_RETRY,
        NORMAL_SECRET_NAME,
        OPERATIONS_SECRET_NAME,
      ),
      dependencies: createDependencies(
        createHttpClient(requests, () => successfulResponse(NORMAL_MESSAGE_ID)),
        createRuntime([], 0),
        new Map(),
        secretReads,
      ),
    });

    expect(result).toEqual({ status: "skipped", reason: "no_candidates" });
    expect(secretReads).toHaveLength(0);
    expect(requests).toHaveLength(0);
  });

  it("同じ運用障害をledgerなしで毎回送信する", async () => {
    const requests: DiscordWebhookHttpRequest[] = [];
    const input = {
      incident: incident(),
      settings: createSettings(
        true,
        DEFAULT_MENTIONS,
        DEFAULT_RETRY,
        NORMAL_SECRET_NAME,
        OPERATIONS_SECRET_NAME,
      ),
      dependencies: createDependencies(
        createHttpClient(requests, () => successfulResponse(OPERATIONS_MESSAGE_ID)),
        createRuntime([], 0),
        defaultSecrets(),
        [],
      ),
    };
    const first = await sendDiscordOperationsAlert(input);
    const second = await sendDiscordOperationsAlert(input);

    expect(first.status).toBe("sent");
    expect(second.status).toBe("sent");
    expect(requests).toHaveLength(2);
  });
});
