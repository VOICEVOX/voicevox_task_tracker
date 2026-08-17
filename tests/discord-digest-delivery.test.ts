import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  buildSourceId,
  createGitHubNodeId,
  createGitHubRepositoryId,
  createUtcIsoDateTime,
  type GitHubItemDisplayReference,
  type GitHubItemUrl,
  type NotificationLedgerEntry,
  type OperationsAlertLedgerEntry,
  type Severity,
  type SourceId,
  type TrackedItem,
  type UtcIsoDateTime,
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
  type DiscordDeliveryLedger,
  type DiscordDeliverySettings,
  type DiscordNotificationCandidate,
  type DiscordNotificationReasonCode,
  type DiscordOperationsIncident,
  type DiscordWebhookHttpClient,
  type DiscordWebhookHttpRequest,
  type DiscordWebhookHttpResponse,
  type DiscordWebhookRuntime,
} from "../src/discord/index.js";

const GENERATED_AT = createUtcIsoDateTime("2026-08-10T00:00:00.000Z");
const RESERVATION_EXPIRES_AT = createUtcIsoDateTime("2026-08-11T00:00:00.000Z");
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

type ItemOptions = Readonly<{
  title: string;
  waitingOn: readonly WaitingOn[];
  stallSince: UtcIsoDateTime;
}>;

type DigestFixture = Readonly<{
  items: readonly TrackedItem[];
  candidates: readonly DiscordNotificationCandidate[];
  reservations: readonly NotificationLedgerEntry[];
}>;

type LedgerFixture = Readonly<{
  ledger: DiscordDeliveryLedger;
  notifications: NotificationLedgerEntry[];
  operationsAlerts: Map<string, OperationsAlertLedgerEntry>;
  events: string[];
}>;

function createWaitingOn(kind: WaitingOnKind, candidateId: string, role: WaitingOnRole): WaitingOn {
  const sourceIds: readonly [SourceId] = [buildSourceId("discord_digest_fixture", candidateId)];
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
  const nodeId = createGitHubNodeId(`I_discord_${number.toString()}`);
  const numberText = number.toString();
  const displayReference = displayReferenceSchema.parse(
    `VOICEVOX/repository_${numberText}#${numberText}`,
  );
  const url = githubItemUrlSchema.parse(
    `https://github.com/VOICEVOX/repository_${numberText}/issues/${numberText}`,
  );
  return Object.freeze({
    nodeId,
    type: "issue",
    repositoryId: createGitHubRepositoryId(`R_discord_${number.toString()}`),
    displayReference,
    number,
    url,
    title: options.title,
    milestone: null,
    importance: Object.freeze({
      score: 0,
      level: "low",
      factors: Object.freeze([]),
    }),
    author: Object.freeze({
      status: "identified",
      actor: Object.freeze({
        type: "human",
        nodeId: createGitHubNodeId(`U_author_${numberText}`),
        login: `author-${numberText}`,
      }),
    }),
    latestEventActor: Object.freeze({
      status: "absent",
    }),
    state: "open",
    notificationClass: "standard",
    status: "waiting_for_review",
    waitingOn: Object.freeze([...options.waitingOn]),
    primaryWaitingOn:
      options.waitingOn.length === 0
        ? Object.freeze({
            index: "not_applicable",
            selectionReason: "waitingOnがないためprimaryはありません",
          })
        : Object.freeze({
            index: 0,
            selectionReason: "waitingOnの先頭候補をprimaryとして選びました",
          }),
    nextAction: "次の対応を行う",
    createdAt: STALL_SINCE,
    githubUpdatedAt: STALL_SINCE,
    lastHumanActivityAt: STALL_SINCE,
    lastProgressAt: STALL_SINCE,
    statusSince: STALL_SINCE,
    ownerSince: STALL_SINCE,
    stallSince: options.stallSince,
    observedAt: GENERATED_AT,
    labels: Object.freeze([]),
    assignees: Object.freeze([]),
    reviewState: "requested",
    checkState: "not_applicable",
    aiAnalysis: Object.freeze({
      status: "not_required",
    }),
    inputEvents: Object.freeze([]),
    confidence: 1,
    evidence: Object.freeze([]),
    uncertainties: Object.freeze([]),
  });
}

function createCandidate(
  item: TrackedItem,
  reasonCode: DiscordNotificationReasonCode,
  severity: Severity,
): DiscordNotificationCandidate {
  const notificationKey = `discord-notification:test:${item.nodeId}:${reasonCode}`;
  const selectedReason = Object.freeze({
    reasonCode,
    notificationKey,
    cooldownUntil: createUtcIsoDateTime("2026-08-13T00:00:00.000Z"),
  });
  const reasons: DiscordNotificationCandidate["reasons"] = Object.freeze([selectedReason]);
  return Object.freeze({
    itemNodeId: item.nodeId,
    reasonCode,
    reasons,
    severity,
    downstreamImpact: Object.freeze({
      nodeId: item.nodeId,
      openNodeCount: 0,
      repositoryCount: 0,
    }),
    priorityWeight: 0,
  });
}

function createReservation(candidate: DiscordNotificationCandidate): NotificationLedgerEntry {
  const reason = candidate.reasons[0];
  return Object.freeze({
    notificationKey: reason.notificationKey,
    itemNodeId: candidate.itemNodeId,
    reasonCode: reason.reasonCode,
    severity: candidate.severity,
    reservedAt: GENERATED_AT,
    expiresAt: RESERVATION_EXPIRES_AT,
    cooldownUntil: reason.cooldownUntil,
    status: "reserved",
  });
}

function createDigestFixture(
  reasons: readonly DiscordNotificationReasonCode[],
  itemFactory: (index: number) => ItemOptions,
): DigestFixture {
  const items = reasons.map((_, index) => createTrackedItem(index + 1, itemFactory(index)));
  const candidates = items.map((item, index) => {
    const reason = reasons[index];
    if (reason == null) {
      throw new TypeError("fixtureの通知理由を取得できません");
    }
    return createCandidate(item, reason, reason === "blocker_overdue" ? "urgent" : "watch");
  });
  return Object.freeze({
    items: Object.freeze(items),
    candidates: Object.freeze(candidates),
    reservations: Object.freeze(candidates.map(createReservation)),
  });
}

function createRuntime(delays: number[]): DiscordWebhookRuntime {
  return createRuntimeWithRandom(delays, 0);
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

function createSettings(
  operationsWebhookSecretName: string,
  mentionsEnabled: boolean,
  mentionUsers: Readonly<Record<string, string>>,
): DiscordDeliverySettings {
  return Object.freeze({
    enabled: true,
    webhookSecretName: NORMAL_SECRET_NAME,
    operationsWebhookSecretName,
    mentions: Object.freeze({
      enabled: mentionsEnabled,
      users: Object.freeze({
        ...mentionUsers,
      }),
    }),
    retry: Object.freeze({
      maxAttempts: 3,
      initialDelaySeconds: 0,
      maxDelaySeconds: 0,
    }),
  });
}

function createLedgerFixture(events: string[]): LedgerFixture {
  const notifications: NotificationLedgerEntry[] = [];
  const operationsAlerts = new Map<string, OperationsAlertLedgerEntry>();
  const ledger = Object.freeze({
    hasOperationsAlert: (alertKey: string) => Promise.resolve(operationsAlerts.has(alertKey)),
    recordNotifications: (entries: readonly NotificationLedgerEntry[]) => {
      events.push("ledger:notification");
      notifications.push(...entries);
      return Promise.resolve();
    },
    recordOperationsAlert: (entry: OperationsAlertLedgerEntry) => {
      events.push("ledger:operations");
      operationsAlerts.set(entry.alertKey, entry);
      return Promise.resolve();
    },
  } satisfies DiscordDeliveryLedger);
  return Object.freeze({
    ledger,
    notifications,
    operationsAlerts,
    events,
  });
}

function createSecretProvider(
  values: ReadonlyMap<string, string>,
): DiscordDeliveryDependencies["secretProvider"] {
  return Object.freeze({
    read: (secretName) => values.get(secretName),
  });
}

function createDependencies(
  httpClient: DiscordWebhookHttpClient,
  ledger: DiscordDeliveryLedger,
  runtime: DiscordWebhookRuntime,
  secrets: ReadonlyMap<string, string>,
): DiscordDeliveryDependencies {
  return Object.freeze({
    secretProvider: createSecretProvider(secrets),
    httpClient,
    runtime,
    ledger,
  });
}

function successfulResponse(discordMessageId: string): DiscordWebhookHttpResponse {
  return Object.freeze({
    status: 200,
    retryAfter: undefined,
    body: {
      id: discordMessageId,
    },
  });
}

function createHttpClient(
  requests: DiscordWebhookHttpRequest[],
  execute: (
    request: DiscordWebhookHttpRequest,
    requestNumber: number,
  ) => DiscordWebhookHttpResponse,
  events: string[],
): DiscordWebhookHttpClient {
  return Object.freeze({
    execute: (request) => {
      requests.push(request);
      events.push("http");
      return Promise.resolve(execute(request, requests.length));
    },
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
  return Object.freeze({
    status: "succeeded",
    pagesUrl: PAGES_URL,
  });
}

function defaultItemOptions(index: number): ItemOptions {
  return Object.freeze({
    title: `通知項目${index.toString()}`,
    waitingOn: Object.freeze([createWaitingOn("role", "reviewer", "reviewer")]),
    stallSince: STALL_SINCE,
  });
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
    const fixture = createDigestFixture(
      ["blocker_overdue", "owner_unknown", "newly_unblocked"],
      defaultItemOptions,
    );
    const plan = buildDiscordDigestPlan({
      candidates: fixture.candidates,
      ledgerReservations: fixture.reservations,
      items: fixture.items,
      pagesUrl: PAGES_URL,
      generatedAt: GENERATED_AT,
      mentions: {
        enabled: false,
        users: {},
      },
    });
    const serialized = JSON.stringify(plan.messages.map((message) => message.payload));

    expect(serialized).toContain("停止要因");
    expect(serialized).toContain("内容確認または担当が未確定");
    expect(serialized).toContain("新規解消や重要な変化");
    expect(serialized).toContain(PAGES_URL);
    expect(serialized).toContain("2026年8月10日 09:00 JST");
    expect(serialized).toContain("2026年8月1日 09:00 JSTから");
    expect(serialized).toContain("経過時間: 9日、");
    for (const item of fixture.items) {
      expect(serialized).toContain(item.displayReference);
      expect(serialized).toContain(item.title);
      expect(serialized).toContain(`GitHub: ${item.url}`);
    }
    expect(serialized).toContain("waitingOn:");
    expect(serialized).toContain("理由:");
    expect(plan.digestId).toMatch(/^discord-digest:v1:[a-f0-9]{24}$/u);
  });

  it.each([
    {
      reasonCode: "assessment_overdue",
      statusLabel: "内容確認待ち",
      expectedReason: "内容確認待ちが基準時間を超えました",
    },
    {
      reasonCode: "owner_overdue",
      statusLabel: "担当決め待ち",
      expectedReason: "担当決め待ちが基準時間を超えました",
    },
    {
      reasonCode: "decision_overdue",
      statusLabel: "方針判断待ち",
      expectedReason: "方針判断待ちが基準時間を超えました",
    },
    {
      reasonCode: "review_overdue",
      statusLabel: "レビュー待ち",
      expectedReason: "レビュー待ちが基準時間を超えました",
    },
    {
      reasonCode: "revision_overdue",
      statusLabel: "修正待ち",
      expectedReason: "修正待ちが基準時間を超えました",
    },
    {
      reasonCode: "reply_overdue",
      statusLabel: "返答待ち",
      expectedReason: "返答待ちが基準時間を超えました",
    },
    {
      reasonCode: "merge_overdue",
      statusLabel: "マージ待ち",
      expectedReason: "マージ待ちが基準時間を超えました",
    },
    {
      reasonCode: "automation_stuck",
      statusLabel: "自動処理待ち",
      expectedReason: "自動処理待ちが基準時間を超えました",
    },
    {
      reasonCode: "owner_unknown",
      statusLabel: "待ち先不明",
      expectedReason: "待ち先不明です",
    },
  ] satisfies readonly {
    reasonCode: DiscordNotificationReasonCode;
    statusLabel: string;
    expectedReason: string;
  }[])(
    "$reasonCodeの日本語文面に状態表示名の$statusLabelを使う",
    ({ reasonCode, expectedReason }) => {
      const fixture = createDigestFixture([reasonCode], defaultItemOptions);
      const plan = buildDiscordDigestPlan({
        candidates: fixture.candidates,
        ledgerReservations: fixture.reservations,
        items: fixture.items,
        pagesUrl: PAGES_URL,
        generatedAt: GENERATED_AT,
        mentions: {
          enabled: false,
          users: {},
        },
      });

      expect(JSON.stringify(plan.messages.map((message) => message.payload))).toContain(
        `理由: ${expectedReason}`,
      );
    },
  );

  it.each([
    { boundary: "59分", elapsedMinutes: 59, expected: "59分" },
    { boundary: "1時間ちょうど", elapsedMinutes: 60, expected: "1時間" },
    { boundary: "23時間59分", elapsedMinutes: 23 * 60 + 59, expected: "23時間" },
    { boundary: "24時間ちょうど", elapsedMinutes: 24 * 60, expected: "1日" },
    { boundary: "7日直前", elapsedMinutes: (7 * 24 - 1) * 60, expected: "6日 23時間" },
    { boundary: "7日ちょうど", elapsedMinutes: 7 * 24 * 60, expected: "7日" },
    { boundary: "7日と1時間", elapsedMinutes: (7 * 24 + 1) * 60, expected: "7日" },
    { boundary: "365日ちょうど", elapsedMinutes: 365 * 24 * 60, expected: "365日" },
    { boundary: "365日と1時間", elapsedMinutes: (365 * 24 + 1) * 60, expected: "1年" },
    { boundary: "366日ちょうど", elapsedMinutes: 366 * 24 * 60, expected: "1年 1日" },
    { boundary: "2年ちょうど", elapsedMinutes: 2 * 365 * 24 * 60, expected: "2年" },
  ])("経過時間が$boundaryのとき$expectedへ整形する", ({ elapsedMinutes, expected }) => {
    const stallSince = createUtcIsoDateTime(
      new Date(Date.parse(GENERATED_AT) - elapsedMinutes * 60 * 1000).toISOString(),
    );
    const fixture = createDigestFixture(["review_overdue"], (index) => ({
      ...defaultItemOptions(index),
      stallSince,
    }));
    const plan = buildDiscordDigestPlan({
      candidates: fixture.candidates,
      ledgerReservations: fixture.reservations,
      items: fixture.items,
      pagesUrl: PAGES_URL,
      generatedAt: GENERATED_AT,
      mentions: {
        enabled: false,
        users: {},
      },
    });
    const serialized = JSON.stringify(plan.messages.map((message) => message.payload));

    expect(serialized).toContain(`経過時間: ${expected}、`);
  });

  it("長文20件をDiscord APIの制限より低い複数payloadへ分割する", () => {
    const reasons: readonly DiscordNotificationReasonCode[] = Array.from(
      { length: 20 },
      (): DiscordNotificationReasonCode => "review_overdue",
    );
    const fixture = createDigestFixture(reasons, (index) => ({
      title: `${index.toString()} ${"非常に長いタイトル".repeat(80)}`,
      waitingOn: [
        createWaitingOn("user", `long-user-${"x".repeat(500)}-${index.toString()}`, "reviewer"),
      ],
      stallSince: STALL_SINCE,
    }));
    const plan = buildDiscordDigestPlan({
      candidates: fixture.candidates,
      ledgerReservations: fixture.reservations,
      items: fixture.items,
      pagesUrl: PAGES_URL,
      generatedAt: GENERATED_AT,
      mentions: {
        enabled: false,
        users: {},
      },
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

  it("既定payloadですべてのmentionを無効化する", () => {
    const fixture = createDigestFixture(["review_overdue"], () => ({
      title: "@everyone を含むタイトル",
      waitingOn: [createWaitingOn("user", "everyone", "reviewer")],
      stallSince: STALL_SINCE,
    }));
    const plan = buildDiscordDigestPlan({
      candidates: fixture.candidates,
      ledgerReservations: fixture.reservations,
      items: fixture.items,
      pagesUrl: PAGES_URL,
      generatedAt: GENERATED_AT,
      mentions: {
        enabled: false,
        users: {},
      },
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

  it("mention有効時も登録済みIDだけを許可し、未登録loginはplain textにする", () => {
    const registeredUserId = "523456789012345678";
    const fixture = createDigestFixture(["review_overdue"], () => ({
      title: "mention確認",
      waitingOn: [
        createWaitingOn("user", "RegisteredUser", "reviewer"),
        createWaitingOn("user", "plain-user", "reviewer"),
      ],
      stallSince: STALL_SINCE,
    }));
    const plan = buildDiscordDigestPlan({
      candidates: fixture.candidates,
      ledgerReservations: fixture.reservations,
      items: fixture.items,
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
  it("wait=trueでmessage IDを取得し、HTTP成功後にledgerへ記録する", async () => {
    const fixture = createDigestFixture(["review_overdue"], defaultItemOptions);
    const requests: DiscordWebhookHttpRequest[] = [];
    const events: string[] = [];
    const ledgerFixture = createLedgerFixture(events);
    const httpClient = createHttpClient(
      requests,
      () => successfulResponse(NORMAL_MESSAGE_ID),
      events,
    );

    const result = await sendDiscordDigest({
      candidates: fixture.candidates,
      ledgerReservations: fixture.reservations,
      items: fixture.items,
      generatedAt: GENERATED_AT,
      pagesDeployment: successfulPagesDeployment(),
      settings: createSettings(OPERATIONS_SECRET_NAME, false, {}),
      dependencies: createDependencies(
        httpClient,
        ledgerFixture.ledger,
        createRuntime([]),
        defaultSecrets(),
      ),
    });

    expect(result.status).toBe("sent");
    expect(new URL(requests[0]?.url ?? "").searchParams.get("wait")).toBe("true");
    expect(events).toEqual(["http", "ledger:notification"]);
    expect(ledgerFixture.notifications).toHaveLength(1);
    expect(ledgerFixture.notifications[0]).toMatchObject({
      status: "sent",
      discordMessageId: NORMAL_MESSAGE_ID,
      sentAt: GENERATED_AT,
    });
    expect(ledgerFixture.notifications[0]).not.toHaveProperty("expiresAt");
  });

  it("通常webhookのsecretが無ければ値を露出せず明示エラーにする", async () => {
    const fixture = createDigestFixture(["review_overdue"], defaultItemOptions);
    const requests: DiscordWebhookHttpRequest[] = [];
    const ledgerFixture = createLedgerFixture([]);
    const httpClient = createHttpClient(requests, () => successfulResponse(NORMAL_MESSAGE_ID), []);
    const error = await captureError(
      sendDiscordDigest({
        candidates: fixture.candidates,
        ledgerReservations: fixture.reservations,
        items: fixture.items,
        generatedAt: GENERATED_AT,
        pagesDeployment: successfulPagesDeployment(),
        settings: createSettings(OPERATIONS_SECRET_NAME, false, {}),
        dependencies: createDependencies(
          httpClient,
          ledgerFixture.ledger,
          createRuntime([]),
          new Map(),
        ),
      }),
    );

    expect(error).toBeInstanceOf(DiscordWebhookSecretMissingError);
    expect(error.message).toContain(NORMAL_SECRET_NAME);
    expect(requests).toHaveLength(0);
  });

  it("HTTPエラーとcauseへwebhook secretを露出しない", async () => {
    const fixture = createDigestFixture(["review_overdue"], defaultItemOptions);
    const ledgerFixture = createLedgerFixture([]);
    const httpClient = Object.freeze({
      execute: () =>
        Promise.reject(new Error(`送信失敗 ${NORMAL_WEBHOOK_URL} token=normal-canary-secret`)),
    } satisfies DiscordWebhookHttpClient);
    const error = await captureError(
      sendDiscordDigest({
        candidates: fixture.candidates,
        ledgerReservations: fixture.reservations,
        items: fixture.items,
        generatedAt: GENERATED_AT,
        pagesDeployment: successfulPagesDeployment(),
        settings: createSettings(OPERATIONS_SECRET_NAME, false, {}),
        dependencies: createDependencies(
          httpClient,
          ledgerFixture.ledger,
          createRuntime([]),
          defaultSecrets(),
        ),
      }),
    );

    expect(error).toBeInstanceOf(DiscordDigestDeliveryError);
    expect(errorMessages(error)).not.toContain(NORMAL_WEBHOOK_URL);
    expect(errorMessages(error)).not.toContain("normal-canary-secret");
  });

  it("transport例外を上限付き指数backoffとjitterで再試行する", async () => {
    const fixture = createDigestFixture(["review_overdue"], defaultItemOptions);
    const delays: number[] = [];
    const ledgerFixture = createLedgerFixture([]);
    let attempts = 0;
    const httpClient = Object.freeze({
      execute: () => {
        attempts += 1;
        if (attempts < 4) {
          return Promise.reject(new TypeError("一時的なtransport失敗"));
        }
        return Promise.resolve(successfulResponse(NORMAL_MESSAGE_ID));
      },
    } satisfies DiscordWebhookHttpClient);
    const baseSettings = createSettings(OPERATIONS_SECRET_NAME, false, {});
    const settings = Object.freeze({
      ...baseSettings,
      retry: Object.freeze({
        maxAttempts: 4,
        initialDelaySeconds: 2,
        maxDelaySeconds: 5,
      }),
    });

    const result = await sendDiscordDigest({
      candidates: fixture.candidates,
      ledgerReservations: fixture.reservations,
      items: fixture.items,
      generatedAt: GENERATED_AT,
      pagesDeployment: successfulPagesDeployment(),
      settings,
      dependencies: createDependencies(
        httpClient,
        ledgerFixture.ledger,
        createRuntimeWithRandom(delays, 0.5),
        defaultSecrets(),
      ),
    });

    expect(result.status).toBe("sent");
    expect(attempts).toBe(4);
    expect(delays).toEqual([1500, 3000, 3750]);
  });

  it("恒久的なHTTPエラーは再試行しない", async () => {
    const fixture = createDigestFixture(["review_overdue"], defaultItemOptions);
    const requests: DiscordWebhookHttpRequest[] = [];
    const delays: number[] = [];
    const ledgerFixture = createLedgerFixture([]);
    const httpClient = createHttpClient(
      requests,
      () => ({
        status: 400,
        retryAfter: undefined,
        body: {},
      }),
      [],
    );

    const error = await captureError(
      sendDiscordDigest({
        candidates: fixture.candidates,
        ledgerReservations: fixture.reservations,
        items: fixture.items,
        generatedAt: GENERATED_AT,
        pagesDeployment: successfulPagesDeployment(),
        settings: createSettings(OPERATIONS_SECRET_NAME, false, {}),
        dependencies: createDependencies(
          httpClient,
          ledgerFixture.ledger,
          createRuntime(delays),
          defaultSecrets(),
        ),
      }),
    );

    expect(error).toBeInstanceOf(DiscordWebhookRequestError);
    expect(requests).toHaveLength(1);
    expect(delays).toEqual([]);
  });

  it("Pages失敗時は通常digestを送らず別の運用障害を1件送る", async () => {
    const fixture = createDigestFixture(["review_overdue"], defaultItemOptions);
    const requests: DiscordWebhookHttpRequest[] = [];
    const ledgerFixture = createLedgerFixture([]);
    const httpClient = createHttpClient(
      requests,
      () => successfulResponse(OPERATIONS_MESSAGE_ID),
      [],
    );

    const result = await sendDiscordDigest({
      candidates: fixture.candidates,
      ledgerReservations: fixture.reservations,
      items: fixture.items,
      generatedAt: GENERATED_AT,
      pagesDeployment: {
        status: "failed",
        incidentId: "pages-run-20260810",
        kind: "pages",
        failedAt: GENERATED_AT,
        retryAttempts: 4,
      },
      settings: createSettings(OPERATIONS_SECRET_NAME, false, {}),
      dependencies: createDependencies(
        httpClient,
        ledgerFixture.ledger,
        createRuntime([]),
        defaultSecrets(),
      ),
    });

    expect(result).toMatchObject({
      status: "skipped",
      reason: "pages_deployment_failed",
      operationsAlert: {
        status: "sent",
      },
    });
    expect(requests).toHaveLength(1);
    expect(new URL(requests[0]?.url ?? "").pathname).toContain("223456789012345678");
    expect(requests[0]?.payload.content).toContain("運用障害");
    expect(requests[0]?.payload.content).not.toContain("日次digest");
    expect(ledgerFixture.notifications).toHaveLength(0);
    expect(ledgerFixture.operationsAlerts.size).toBe(1);
  });

  it("候補0件ならsecretを読まずwebhookもledgerも呼ばない", async () => {
    const requests: DiscordWebhookHttpRequest[] = [];
    const secretReads: string[] = [];
    const ledgerFixture = createLedgerFixture([]);
    const dependencies = Object.freeze({
      secretProvider: Object.freeze({
        read: (secretName: string) => {
          secretReads.push(secretName);
          return undefined;
        },
      }),
      httpClient: createHttpClient(requests, () => successfulResponse(NORMAL_MESSAGE_ID), []),
      runtime: createRuntime([]),
      ledger: ledgerFixture.ledger,
    } satisfies DiscordDeliveryDependencies);

    const result = await sendDiscordDigest({
      candidates: [],
      ledgerReservations: [],
      items: [],
      generatedAt: GENERATED_AT,
      pagesDeployment: successfulPagesDeployment(),
      settings: createSettings(OPERATIONS_SECRET_NAME, false, {}),
      dependencies,
    });

    expect(result).toEqual({
      status: "skipped",
      reason: "no_candidates",
    });
    expect(secretReads).toHaveLength(0);
    expect(requests).toHaveLength(0);
    expect(ledgerFixture.notifications).toHaveLength(0);
    expect(ledgerFixture.operationsAlerts.size).toBe(0);
  });

  it("通常送信が連続retry失敗しても同じ運用障害は1件だけ送る", async () => {
    const fixture = createDigestFixture(["review_overdue"], defaultItemOptions);
    const requests: DiscordWebhookHttpRequest[] = [];
    const delays: number[] = [];
    const ledgerFixture = createLedgerFixture([]);
    const httpClient = createHttpClient(
      requests,
      (request) => {
        const webhookId = new URL(request.url).pathname.split("/").at(-2);
        if (webhookId === "123456789012345678") {
          return {
            status: 503,
            retryAfter: undefined,
            body: {},
          };
        }
        return successfulResponse(OPERATIONS_MESSAGE_ID);
      },
      [],
    );
    const input = Object.freeze({
      candidates: fixture.candidates,
      ledgerReservations: fixture.reservations,
      items: fixture.items,
      generatedAt: GENERATED_AT,
      pagesDeployment: successfulPagesDeployment(),
      settings: createSettings(OPERATIONS_SECRET_NAME, false, {}),
      dependencies: createDependencies(
        httpClient,
        ledgerFixture.ledger,
        createRuntime(delays),
        defaultSecrets(),
      ),
    });

    const firstError = await captureError(sendDiscordDigest(input));
    const secondError = await captureError(sendDiscordDigest(input));
    const normalRequests = requests.filter((request) =>
      new URL(request.url).pathname.includes("123456789012345678"),
    );
    const operationsRequests = requests.filter((request) =>
      new URL(request.url).pathname.includes("223456789012345678"),
    );

    expect(firstError).toBeInstanceOf(DiscordDigestDeliveryError);
    expect(secondError).toBeInstanceOf(DiscordDigestDeliveryError);
    expect(firstError).toMatchObject({
      operationsAlertStatus: "sent",
    });
    expect(secondError).toMatchObject({
      operationsAlertStatus: "already_recorded",
    });
    expect(normalRequests).toHaveLength(6);
    expect(operationsRequests).toHaveLength(1);
    expect(operationsRequests[0]?.payload.content).toContain("運用障害");
    expect(ledgerFixture.operationsAlerts.size).toBe(1);
    expect(ledgerFixture.notifications).toHaveLength(0);
    expect(delays).toHaveLength(4);
  });

  it("同じwebhook設定でも収集障害を通常digestと別payloadで一度だけ送る", async () => {
    const requests: DiscordWebhookHttpRequest[] = [];
    const ledgerFixture = createLedgerFixture([]);
    const httpClient = createHttpClient(
      requests,
      () => successfulResponse(OPERATIONS_MESSAGE_ID),
      [],
    );
    const incident = Object.freeze({
      incidentId: "collection-run-20260810",
      kind: "collection",
      occurredAt: GENERATED_AT,
      retryAttempts: 4,
    } satisfies DiscordOperationsIncident);
    const settings = createSettings(NORMAL_SECRET_NAME, false, {});
    const dependencies = createDependencies(
      httpClient,
      ledgerFixture.ledger,
      createRuntime([]),
      defaultSecrets(),
    );

    const first = await sendDiscordOperationsAlert({
      incident,
      settings,
      dependencies,
    });
    const second = await sendDiscordOperationsAlert({
      incident,
      settings,
      dependencies,
    });

    expect(first.status).toBe("sent");
    expect(second.status).toBe("already_recorded");
    expect(requests).toHaveLength(1);
    expect(new URL(requests[0]?.url ?? "").pathname).toContain("123456789012345678");
    expect(requests[0]?.payload.content).toContain("運用障害");
  });
});
