import { describe, expect, it } from "vitest";

import { createUtcIsoDateTime } from "../src/domain/index.js";
import {
  calculateStallNotificationSchedule,
  evaluateNormalDigestRun,
  evaluateStallNotificationWindow,
  isOneTimeNotificationDue,
  type StallNotificationSchedule,
} from "../src/discord/deterministic-notification-windows.js";

const REFERENCE_AT = createUtcIsoDateTime("2026-08-13T23:00:00.000Z");
const REPEAT_DAYS = { urgent: 3, critical: 2 };

function createUrgentSchedule(): StallNotificationSchedule {
  return calculateStallNotificationSchedule({
    stallSince: createUtcIsoDateTime("2026-08-10T00:00:00.000Z"),
    severity: "urgent",
    thresholdHours: 23,
    repeatDays: REPEAT_DAYS,
  });
}

function evaluateInvalidNormalDigestRun(input: unknown): void {
  Reflect.apply(evaluateNormalDigestRun, undefined, [input]);
}

describe("deterministic notification windows", () => {
  it("一回限り通知は24時間境界の内側だけを対象にする", () => {
    const start = createUtcIsoDateTime("2026-08-12T23:00:00.000Z");
    const justAfterStart = createUtcIsoDateTime("2026-08-12T23:00:00.001Z");
    const afterReference = createUtcIsoDateTime("2026-08-13T23:00:00.001Z");

    expect(isOneTimeNotificationDue({ eventAt: start, referenceAt: REFERENCE_AT })).toBe(false);
    expect(isOneTimeNotificationDue({ eventAt: justAfterStart, referenceAt: REFERENCE_AT })).toBe(
      true,
    );
    expect(isOneTimeNotificationDue({ eventAt: REFERENCE_AT, referenceAt: REFERENCE_AT })).toBe(
      true,
    );
    expect(isOneTimeNotificationDue({ eventAt: afterReference, referenceAt: REFERENCE_AT })).toBe(
      false,
    );
  });

  it("severity閾値到達後の最初の08:00 JST枠を求める", () => {
    const exactBoundary = calculateStallNotificationSchedule({
      stallSince: createUtcIsoDateTime("2026-08-10T00:00:00.000Z"),
      severity: "urgent",
      thresholdHours: 23,
      repeatDays: REPEAT_DAYS,
    });
    const afterBoundary = calculateStallNotificationSchedule({
      stallSince: createUtcIsoDateTime("2026-08-10T00:00:00.000Z"),
      severity: "urgent",
      thresholdHours: 23.00027777777778,
      repeatDays: REPEAT_DAYS,
    });

    expect(exactBoundary).toEqual({
      severity: "urgent",
      thresholdReachedAt: "2026-08-10T23:00:00.000Z",
      firstNotificationAt: "2026-08-10T23:00:00.000Z",
      repeatDays: 3,
    });
    expect(afterBoundary.firstNotificationAt).toBe("2026-08-11T23:00:00.000Z");
  });

  it("watchの閾値到達時刻を一回限り通知枠へ渡せる", () => {
    const watchThresholdReachedAt = createUtcIsoDateTime("2026-08-13T22:00:00.000Z");

    expect(
      isOneTimeNotificationDue({
        eventAt: watchThresholdReachedAt,
        referenceAt: REFERENCE_AT,
      }),
    ).toBe(true);
  });

  it("urgent 3日周期の起点、境界、取り逃しを決定論的に判定する", () => {
    const schedule = createUrgentSchedule();

    expect(
      evaluateStallNotificationWindow({
        schedule,
        referenceAt: createUtcIsoDateTime("2026-08-09T23:00:00.000Z"),
      }),
    ).toEqual({ status: "not_due", reason: "before_first_notification" });
    expect(
      evaluateStallNotificationWindow({
        schedule,
        referenceAt: createUtcIsoDateTime("2026-08-10T23:00:00.000Z"),
      }),
    ).toEqual({
      status: "eligible",
      kind: "first",
      scheduledAt: "2026-08-10T23:00:00.000Z",
    });
    expect(
      evaluateStallNotificationWindow({
        schedule,
        referenceAt: createUtcIsoDateTime("2026-08-13T23:00:00.000Z"),
      }),
    ).toEqual({
      status: "eligible",
      kind: "repeat",
      scheduledAt: "2026-08-13T23:00:00.000Z",
    });
    expect(
      evaluateStallNotificationWindow({
        schedule,
        referenceAt: createUtcIsoDateTime("2026-08-12T23:00:00.000Z"),
      }),
    ).toEqual({ status: "not_due", reason: "outside_repeat_cycle" });
    expect(
      evaluateStallNotificationWindow({
        schedule,
        referenceAt: createUtcIsoDateTime("2026-08-14T23:00:00.000Z"),
      }),
    ).toEqual({ status: "not_due", reason: "outside_repeat_cycle" });
  });

  it("criticalは設定された2日周期をurgentと独立して使う", () => {
    const schedule = calculateStallNotificationSchedule({
      stallSince: createUtcIsoDateTime("2026-08-10T00:00:00.000Z"),
      severity: "critical",
      thresholdHours: 23,
      repeatDays: REPEAT_DAYS,
    });

    expect(schedule.repeatDays).toBe(2);
    expect(
      evaluateStallNotificationWindow({
        schedule,
        referenceAt: createUtcIsoDateTime("2026-08-12T23:00:00.000Z"),
      }),
    ).toMatchObject({ status: "eligible", kind: "repeat" });
  });

  it("正規枠はJSTの固定UTC+9で扱いDSTに依存しない", () => {
    const schedule = calculateStallNotificationSchedule({
      stallSince: createUtcIsoDateTime("2026-03-08T00:00:00.000Z"),
      severity: "urgent",
      thresholdHours: 23,
      repeatDays: { urgent: 1, critical: 1 },
    });

    expect(schedule.firstNotificationAt).toBe("2026-03-08T23:00:00.000Z");
    expect(
      evaluateStallNotificationWindow({
        schedule,
        referenceAt: createUtcIsoDateTime("2026-03-09T23:00:00.000Z"),
      }),
    ).toMatchObject({ status: "eligible", kind: "repeat" });
  });

  it("Sが08:00 JSTでなければ例外にする", () => {
    expect(() =>
      isOneTimeNotificationDue({
        eventAt: REFERENCE_AT,
        referenceAt: createUtcIsoDateTime("2026-08-13T22:59:59.000Z"),
      }),
    ).toThrowError(/08:00 JST/u);
    expect(() =>
      evaluateStallNotificationWindow({
        schedule: createUrgentSchedule(),
        referenceAt: createUtcIsoDateTime("2026-08-13T22:00:00.000Z"),
      }),
    ).toThrowError(/08:00 JST/u);
  });

  it("scheduleの初回だけ通常digestを許可しmanualとrerunを抑止する", () => {
    expect(
      evaluateNormalDigestRun({
        eventName: "schedule",
        runAttempt: 1,
        scheduledFor: REFERENCE_AT,
      }),
    ).toEqual({ allowed: true, reason: "schedule", scheduledFor: REFERENCE_AT });
    expect(
      evaluateNormalDigestRun({
        eventName: "workflow_dispatch",
        runAttempt: 1,
      }),
    ).toEqual({ allowed: false, reason: "manual" });
    expect(
      evaluateNormalDigestRun({
        eventName: "schedule",
        runAttempt: 2,
        scheduledFor: REFERENCE_AT,
      }),
    ).toEqual({ allowed: false, reason: "rerun" });
  });

  it("workflow contextの不正なschedule時刻、欠落schedule、余計な入力、未知eventを拒否する", () => {
    expect(() => {
      evaluateInvalidNormalDigestRun({
        eventName: "schedule",
        runAttempt: 1,
        scheduledFor: createUtcIsoDateTime("2026-08-13T22:00:00.000Z"),
      });
    }).toThrowError(/08:00 JST/u);

    const contextWithExtraField = {
      eventName: "schedule",
      runAttempt: 1,
      scheduledFor: REFERENCE_AT,
      executionStartedAt: REFERENCE_AT,
    };
    expect(() => {
      evaluateInvalidNormalDigestRun(contextWithExtraField);
    }).toThrowError(/不正/u);
    expect(() => {
      evaluateInvalidNormalDigestRun({
        eventName: "schedule",
        runAttempt: 1,
      });
    }).toThrowError(/不正/u);
    expect(() => {
      evaluateInvalidNormalDigestRun({
        eventName: "push",
        runAttempt: 1,
      });
    }).toThrowError(/不正/u);
    expect(() => {
      evaluateInvalidNormalDigestRun({
        eventName: "workflow_dispatch",
        runAttempt: 1,
        scheduledFor: REFERENCE_AT,
      });
    }).toThrowError(/不正/u);
  });
});
