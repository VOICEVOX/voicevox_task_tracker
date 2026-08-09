import { describe, expect, it } from "vitest";

import sampleSummarySource from "../public/data/summary.json";
import {
  createPublicSummaryDto,
  type PublicItemSummaryDto,
  type PublicSummaryDto,
} from "../../src/pages/public-dto.js";
import { assertNonNullable } from "../../src/util/index.js";
import {
  aiAnalysisNotice,
  collectWaitingSubjectRows,
  collectWaitingTeamIds,
  createEmptyTableFilters,
  createItemTableRows,
  createTableFilterOptions,
  filterAndSortTableRows,
  formatStallDuration,
  formatWaitingOnCandidate,
  resolveWaitingSubjects,
  selectPrimaryWaitingOnCandidate,
  selectWaitingSubjectItemNodeIds,
  selectWaitingSubjectReasons,
  statusLabel,
  waitingOnHistoryLabel,
  waitingOnLabel,
  waitingSubjectKey,
  waitingSubjectLabel,
  type ItemSortKey,
} from "./model.js";

type WaitingOnCandidate = PublicItemSummaryDto["waitingOn"][number];

const sampleSummary = createPublicSummaryDto(sampleSummarySource);

describe("AI推定の利用状況", () => {
  it("全statusを一覧と詳細の注記へ変換する", () => {
    expect(aiAnalysisNotice("used")).toEqual({ kind: "none" });
    expect(aiAnalysisNotice("disabled")).toEqual({ kind: "none" });
    expect(aiAnalysisNotice("not_recorded")).toEqual({ kind: "none" });
    expect(aiAnalysisNotice("not_required")).toEqual({
      kind: "skipped",
      description: "確定ルールだけで判定できたため、AI推定を省いています。",
    });
    expect(aiAnalysisNotice("failed")).toEqual({
      kind: "outdated",
      description:
        "AI推定に失敗したため、状態、待ち相手、重要度、停滞に最新のAI推定を反映できていません。",
    });
    expect(aiAnalysisNotice("deferred")).toEqual({
      kind: "outdated",
      description:
        "AI推定を今回実行しなかったため、状態、待ち相手、重要度、停滞に最新のAI推定を反映できていません。",
    });
  });
});

describe("返答待ち表示", () => {
  it("返答待ちと回答者を表示しstatusフィルタへ追加する", () => {
    const sourceItem = sampleSummary.items[0];
    assertNonNullable(sourceItem, "返答待ち表示用の項目がありません");
    const sourceWaitingOn = sourceItem.waitingOn[0];
    assertNonNullable(sourceWaitingOn, "返答待ち表示用のwaitingOnがありません");
    const summary = createPublicSummaryDto({
      ...sampleSummary,
      items: [
        {
          ...sourceItem,
          status: "waiting_for_reply",
          waitingOn: [
            {
              ...sourceWaitingOn,
              kind: "user",
              candidateId: "requested-user",
              role: "respondent",
            },
          ],
        },
      ],
    });
    const item = summary.items[0];
    assertNonNullable(item, "返答待ち表示用の公開項目がありません");
    const waitingOn = item.waitingOn[0];
    assertNonNullable(waitingOn, "返答待ち表示用の公開waitingOnがありません");

    expect(statusLabel(item.status)).toBe("返答待ち");
    expect(waitingOnLabel(waitingOn, item, summary)).toBe("回答者 @requested-user");
    expect(createTableFilterOptions(summary).status).toEqual([
      {
        label: "返答待ち",
        value: "waiting_for_reply",
      },
    ]);
  });
});

describe("停滞時間表示", () => {
  const now = new Date("2026-08-01T00:00:00.000Z");

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
  ])("$boundaryを切り捨てて整形する", ({ elapsedMinutes, expected }) => {
    const stallSince = new Date(now.getTime() - elapsedMinutes * 60 * 1000).toISOString();

    expect(formatStallDuration(stallSince, now)).toBe(expected);
  });
});

describe("項目一覧の並び替え", () => {
  const source = sampleSummary.items[0];
  assertNonNullable(source, "並び替えテスト用の項目がありません");
  const summary: PublicSummaryDto = {
    ...sampleSummary,
    items: [
      {
        ...source,
        nodeId: "a",
        attention: { score: 50, level: "medium" },
        importance: { score: 40, level: "medium" },
        stallSince: "2026-07-02T00:00:00.000Z",
      },
      {
        ...source,
        nodeId: "b",
        attention: { score: 40, level: "medium" },
        importance: { score: 40, level: "medium" },
        stallSince: "2026-07-03T00:00:00.000Z",
      },
      {
        ...source,
        nodeId: "c",
        attention: { score: 50, level: "medium" },
        importance: { score: 40, level: "medium" },
        stallSince: "2026-07-01T00:00:00.000Z",
      },
      {
        ...source,
        nodeId: "d",
        attention: { score: 60, level: "high" },
        importance: { score: 30, level: "medium" },
        stallSince: "2026-07-01T00:00:00.000Z",
      },
    ],
  };
  const rows = createItemTableRows(summary, new Date("2026-08-01T00:00:00.000Z"));

  function sortedNodeIds(
    key: ItemSortKey,
    direction: "ascending" | "descending",
  ): readonly string[] {
    return filterAndSortTableRows(rows, createEmptyTableFilters(), { key, direction }).map(
      (row) => row.item.nodeId,
    );
  }

  it("要対応度だけを反転し、同値なら停滞時間の長い順とnode IDの昇順を保つ", () => {
    expect(sortedNodeIds("attention", "descending")).toEqual(["d", "c", "a", "b"]);
    expect(sortedNodeIds("attention", "ascending")).toEqual(["b", "c", "a", "d"]);
  });

  it("重要度だけを反転し、同値なら要対応度の降順とnode IDの昇順を保つ", () => {
    expect(sortedNodeIds("importance", "descending")).toEqual(["a", "c", "b", "d"]);
    expect(sortedNodeIds("importance", "ascending")).toEqual(["d", "a", "c", "b"]);
  });

  it("停滞時間だけを反転し、同値ならnode IDの昇順を保つ", () => {
    expect(sortedNodeIds("stall", "descending")).toEqual(["c", "d", "a", "b"]);
    expect(sortedNodeIds("stall", "ascending")).toEqual(["b", "a", "c", "d"]);
  });
});

function createWaitingOnCandidate(
  kind: WaitingOnCandidate["kind"],
  role: WaitingOnCandidate["role"],
  candidateId: string,
): WaitingOnCandidate {
  return {
    kind,
    role,
    candidateId,
    reasonSummary: "表示テスト",
    confidence: 1,
  };
}

function readSampleItem(nodeId: string): PublicItemSummaryDto {
  const item = sampleSummary.items.find((candidate) => candidate.nodeId === nodeId);
  assertNonNullable(item, `sample項目 ${nodeId} がありません`);
  return item;
}

describe("waitingOn表示", () => {
  const identifiedItem: PublicItemSummaryDto = {
    ...readSampleItem("sample-item-editor-101"),
    author: {
      status: "identified",
      actor: {
        type: "human",
        nodeId: "actor:hiho",
        login: "hiho",
      },
    },
    assignees: [
      {
        type: "human",
        nodeId: "actor:hiho",
        login: "hiho",
      },
      {
        type: "human",
        nodeId: "actor:aoirint",
        login: "aoirint",
      },
    ],
  };
  const unavailableAuthorItem: PublicItemSummaryDto = {
    ...identifiedItem,
    author: {
      status: "unavailable",
      reason: "deleted_account",
    },
  };
  const unassignedItem: PublicItemSummaryDto = {
    ...identifiedItem,
    assignees: [],
  };

  it("現在値の役割と対象を一つのラベルへ統一する", () => {
    const cases: readonly Readonly<{
      candidate: WaitingOnCandidate;
      item: PublicItemSummaryDto;
      expected: string;
    }>[] = [
      {
        candidate: createWaitingOnCandidate("user", "reviewer", "hiho"),
        item: identifiedItem,
        expected: "レビュワー @hiho",
      },
      {
        candidate: createWaitingOnCandidate("team", "reviewer", "VOICEVOX/maintainers"),
        item: identifiedItem,
        expected: "レビュワー チーム VOICEVOX/maintainers",
      },
      {
        candidate: createWaitingOnCandidate("role", "author", "author"),
        item: identifiedItem,
        expected: "作成者 @hiho",
      },
      {
        candidate: createWaitingOnCandidate("role", "author", "author"),
        item: unavailableAuthorItem,
        expected: "作成者 アカウント削除済み",
      },
      {
        candidate: createWaitingOnCandidate("role", "assignee", "assignee"),
        item: identifiedItem,
        expected: "担当者 @hiho、@aoirint",
      },
      {
        candidate: createWaitingOnCandidate("role", "assignee", "assignee"),
        item: unassignedItem,
        expected: "担当者 未割り当て",
      },
      {
        candidate: createWaitingOnCandidate("role", "maintainer", "maintainer"),
        item: identifiedItem,
        expected: "メンテナーの誰か",
      },
      {
        candidate: createWaitingOnCandidate("role", "reviewer", "reviewer"),
        item: identifiedItem,
        expected: "レビュワーの誰か",
      },
      {
        candidate: createWaitingOnCandidate("role", "merge_decider", "merge_decider"),
        item: identifiedItem,
        expected: "マージ判断者の誰か",
      },
      {
        candidate: createWaitingOnCandidate("role", "ci", "ci"),
        item: identifiedItem,
        expected: "CI",
      },
      {
        candidate: createWaitingOnCandidate("role", "dependency", "dependency"),
        item: identifiedItem,
        expected: "依存項目",
      },
      {
        candidate: createWaitingOnCandidate("role", "unknown", "unknown"),
        item: identifiedItem,
        expected: "不明",
      },
      {
        candidate: createWaitingOnCandidate("item", "dependency", "sample-item-editor-103"),
        item: identifiedItem,
        expected: "VOICEVOX/sample-editor#103",
      },
      {
        candidate: createWaitingOnCandidate(
          "item",
          "dependency",
          "external:github:sample-distribution-42",
        ),
        item: identifiedItem,
        expected: "example/sample-distribution#42",
      },
      {
        candidate: createWaitingOnCandidate("automation", "ci", "required_checks"),
        item: identifiedItem,
        expected: "自動処理 required_checks",
      },
      {
        candidate: createWaitingOnCandidate("unknown", "unknown", "unknown"),
        item: identifiedItem,
        expected: "不明",
      },
    ];

    for (const testCase of cases) {
      expect(waitingOnLabel(testCase.candidate, testCase.item, sampleSummary)).toBe(
        testCase.expected,
      );
    }
  });

  it("履歴の役割と対象を過去時点に適したラベルへ統一する", () => {
    const cases: readonly Readonly<{
      candidate: WaitingOnCandidate;
      item: PublicItemSummaryDto;
      expected: string;
    }>[] = [
      {
        candidate: createWaitingOnCandidate("role", "author", "author"),
        item: identifiedItem,
        expected: "作成者 @hiho",
      },
      {
        candidate: createWaitingOnCandidate("role", "author", "author"),
        item: unavailableAuthorItem,
        expected: "作成者 アカウント削除済み",
      },
      {
        candidate: createWaitingOnCandidate("role", "assignee", "assignee"),
        item: identifiedItem,
        expected: "当時の担当者",
      },
      {
        candidate: createWaitingOnCandidate("role", "maintainer", "maintainer"),
        item: identifiedItem,
        expected: "メンテナーの誰か",
      },
      {
        candidate: createWaitingOnCandidate("role", "reviewer", "reviewer"),
        item: identifiedItem,
        expected: "レビュワーの誰か",
      },
      {
        candidate: createWaitingOnCandidate("role", "merge_decider", "maintainer"),
        item: identifiedItem,
        expected: "マージ判断者の誰か",
      },
      {
        candidate: createWaitingOnCandidate("role", "ci", "ci"),
        item: identifiedItem,
        expected: "CI",
      },
      {
        candidate: createWaitingOnCandidate("role", "dependency", "dependency"),
        item: identifiedItem,
        expected: "依存項目",
      },
      {
        candidate: createWaitingOnCandidate("role", "unknown", "unknown"),
        item: identifiedItem,
        expected: "不明",
      },
      {
        candidate: createWaitingOnCandidate("item", "dependency", "sample-item-editor-103"),
        item: identifiedItem,
        expected: "VOICEVOX/sample-editor#103",
      },
    ];

    for (const testCase of cases) {
      expect(waitingOnHistoryLabel(testCase.candidate, testCase.item, sampleSummary)).toBe(
        testCase.expected,
      );
    }
  });

  it("項目参照を解決できない場合は例外を投げる", () => {
    expect(() =>
      waitingOnLabel(
        createWaitingOnCandidate("item", "dependency", "missing-item"),
        identifiedItem,
        sampleSummary,
      ),
    ).toThrowError("waitingOn項目 missing-item がありません");

    const summaryWithoutTarget: PublicSummaryDto = {
      ...sampleSummary,
      items: sampleSummary.items.filter((item) => item.nodeId !== "sample-item-editor-103"),
    };
    expect(() =>
      waitingOnLabel(
        createWaitingOnCandidate("item", "dependency", "sample-item-editor-103"),
        identifiedItem,
        summaryWithoutTarget,
      ),
    ).toThrowError("waitingOn項目 sample-item-editor-103 の表示名がありません");
  });

  it("primary候補を選び、未選定なら先頭候補へ戻す", () => {
    const firstCandidate = createWaitingOnCandidate("role", "maintainer", "maintainer");
    const secondCandidate = createWaitingOnCandidate("role", "reviewer", "reviewer");
    const selectedItem: PublicItemSummaryDto = {
      ...identifiedItem,
      waitingOn: [firstCandidate, secondCandidate],
      primaryWaitingOn: {
        index: 0,
        selectionReason: "先頭候補を選定しました",
      },
    };
    const fallbackItem: PublicItemSummaryDto = {
      ...selectedItem,
      primaryWaitingOn: {
        index: "not_applicable",
        selectionReason: "primary候補は未選定です",
      },
    };
    const completedItem: PublicItemSummaryDto = {
      ...selectedItem,
      status: "terminal_completed",
      waitingOn: [],
      primaryWaitingOn: {
        index: "not_applicable",
        selectionReason: "完了項目にprimary候補はありません",
      },
    };

    expect(selectPrimaryWaitingOnCandidate(selectedItem)).toBe(firstCandidate);
    expect(selectPrimaryWaitingOnCandidate(fallbackItem)).toBe(firstCandidate);
    expect(selectPrimaryWaitingOnCandidate(completedItem)).toBeUndefined();
    expect(formatWaitingOnCandidate(firstCandidate, selectedItem, sampleSummary)).toBe(
      "メンテナーの誰か",
    );
  });
});

describe("待ち相手", () => {
  const identifiedItem: PublicItemSummaryDto = {
    ...readSampleItem("sample-item-editor-101"),
    author: {
      status: "identified",
      actor: {
        type: "human",
        nodeId: "actor:HiHo",
        login: "HiHo",
      },
    },
    assignees: [
      {
        type: "human",
        nodeId: "actor:AOIRINT",
        login: "AOIRINT",
      },
      {
        type: "human",
        nodeId: "actor:hiho",
        login: "hiho",
      },
    ],
  };

  it("userとteamを入力順の相手へ解決して重複をまとめる", () => {
    const item: PublicItemSummaryDto = {
      ...identifiedItem,
      waitingOn: [
        createWaitingOnCandidate("user", "reviewer", "HiHo"),
        createWaitingOnCandidate("team", "reviewer", "VOICEVOX/Maintainers"),
        createWaitingOnCandidate("user", "reviewer", "hiho"),
      ],
    };

    expect(resolveWaitingSubjects(item)).toEqual([
      { kind: "user", login: "HiHo" },
      { kind: "team", teamId: "VOICEVOX/Maintainers" },
    ]);
  });

  it("authorとassigneeのroleを具体的なloginへ解決する", () => {
    const item: PublicItemSummaryDto = {
      ...identifiedItem,
      waitingOn: [
        createWaitingOnCandidate("role", "author", "author"),
        createWaitingOnCandidate("role", "assignee", "assignee"),
      ],
    };

    expect(resolveWaitingSubjects(item)).toEqual([
      { kind: "user", login: "HiHo" },
      { kind: "user", login: "AOIRINT" },
    ]);
  });

  it("具体的な相手を特定できないroleとkindを除外する", () => {
    const item: PublicItemSummaryDto = {
      ...identifiedItem,
      author: {
        status: "unavailable",
        reason: "deleted_account",
      },
      assignees: [],
      waitingOn: [
        createWaitingOnCandidate("role", "author", "author"),
        createWaitingOnCandidate("role", "assignee", "assignee"),
        createWaitingOnCandidate("role", "maintainer", "maintainer"),
        createWaitingOnCandidate("role", "reviewer", "reviewer"),
        createWaitingOnCandidate("role", "merge_decider", "merge_decider"),
        createWaitingOnCandidate("role", "ci", "ci"),
        createWaitingOnCandidate("role", "dependency", "dependency"),
        createWaitingOnCandidate("role", "unknown", "unknown"),
        createWaitingOnCandidate("item", "dependency", "item"),
        createWaitingOnCandidate("automation", "ci", "automation"),
        createWaitingOnCandidate("unknown", "unknown", "unknown"),
      ],
    };

    expect(resolveWaitingSubjects(item)).toEqual([]);
  });

  it("比較キーだけを小文字化し表示ラベルは元の表記を保つ", () => {
    expect(waitingSubjectKey({ kind: "user", login: "HiHo" })).toBe("user:hiho");
    expect(waitingSubjectKey({ kind: "team", teamId: "VOICEVOX/Maintainers" })).toBe(
      "team:voicevox/maintainers",
    );
    expect(waitingSubjectLabel({ kind: "user", login: "HiHo" })).toBe("@HiHo");
    expect(waitingSubjectLabel({ kind: "team", teamId: "VOICEVOX/Maintainers" })).toBe(
      "チーム VOICEVOX/Maintainers",
    );
  });

  it("team識別子を比較キーで重複排除して識別子の昇順で集める", () => {
    const summary: PublicSummaryDto = {
      ...sampleSummary,
      items: [
        {
          ...readSampleItem("sample-item-editor-101"),
          waitingOn: [
            createWaitingOnCandidate("team", "reviewer", "VOICEVOX/zeta"),
            createWaitingOnCandidate("user", "reviewer", "hiho"),
          ],
        },
        {
          ...readSampleItem("sample-item-engine-202"),
          waitingOn: [
            createWaitingOnCandidate("team", "reviewer", "VOICEVOX/Alpha"),
            createWaitingOnCandidate("team", "reviewer", "voicevox/ZETA"),
          ],
        },
      ],
    };

    expect(collectWaitingTeamIds(summary)).toEqual(["VOICEVOX/Alpha", "VOICEVOX/zeta"]);
  });

  it("項目数の降順とラベルの昇順で集計する", () => {
    const summary: PublicSummaryDto = {
      ...sampleSummary,
      items: [
        {
          ...readSampleItem("sample-item-editor-101"),
          stallSince: "2026-07-20T00:00:00.000Z",
          waitingOn: [
            createWaitingOnCandidate("user", "reviewer", "beta"),
            createWaitingOnCandidate("team", "reviewer", "VOICEVOX/reviewers"),
          ],
        },
        {
          ...readSampleItem("sample-item-engine-202"),
          stallSince: "2026-07-15T00:00:00.000Z",
          waitingOn: [
            createWaitingOnCandidate("user", "reviewer", "BETA"),
            createWaitingOnCandidate("user", "reviewer", "alpha"),
          ],
        },
        {
          ...readSampleItem("sample-item-editor-103"),
          stallSince: "2026-07-01T00:00:00.000Z",
          waitingOn: [createWaitingOnCandidate("user", "reviewer", "alpha")],
        },
      ],
    };

    expect(collectWaitingSubjectRows(summary, new Date("2026-07-31T00:00:00.000Z"))).toEqual([
      {
        subject: { kind: "user", login: "alpha" },
        label: "@alpha",
        itemCount: 2,
        longestStallDuration: "30日",
      },
      {
        subject: { kind: "user", login: "beta" },
        label: "@beta",
        itemCount: 2,
        longestStallDuration: "16日",
      },
      {
        subject: { kind: "team", teamId: "VOICEVOX/reviewers" },
        label: "チーム VOICEVOX/reviewers",
        itemCount: 1,
        longestStallDuration: "11日",
      },
    ]);
  });

  it("loginと所属teamのどちらかを待つ項目を選ぶ", () => {
    const summary: PublicSummaryDto = {
      ...sampleSummary,
      items: [
        {
          ...readSampleItem("sample-item-editor-101"),
          waitingOn: [createWaitingOnCandidate("user", "reviewer", "HIHO")],
        },
        {
          ...readSampleItem("sample-item-engine-202"),
          waitingOn: [createWaitingOnCandidate("team", "reviewer", "VOICEVOX/Maintainers")],
        },
        {
          ...readSampleItem("sample-item-editor-103"),
          waitingOn: [createWaitingOnCandidate("team", "reviewer", "VOICEVOX/Reviewers")],
        },
      ],
    };

    expect(selectWaitingSubjectItemNodeIds(summary, "hiho", ["voicevox/maintainers"])).toEqual(
      new Set(["sample-item-editor-101", "sample-item-engine-202"]),
    );
  });

  it("loginまたは所属teamに一致する候補の待ち理由だけを入力順で返す", () => {
    const item: PublicItemSummaryDto = {
      ...identifiedItem,
      waitingOn: [
        {
          ...createWaitingOnCandidate("user", "reviewer", "other"),
          reasonSummary: "別の人を待っています",
        },
        {
          ...createWaitingOnCandidate("user", "reviewer", "HIHO"),
          reasonSummary: "本人の確認を待っています",
        },
        {
          ...createWaitingOnCandidate("team", "reviewer", "VOICEVOX/Maintainers"),
          reasonSummary: "所属チームの確認を待っています",
        },
        {
          ...createWaitingOnCandidate("team", "reviewer", "VOICEVOX/Reviewers"),
          reasonSummary: "別のチームを待っています",
        },
        {
          ...createWaitingOnCandidate("role", "assignee", "assignee"),
          reasonSummary: "担当者の対応を待っています",
        },
        {
          ...createWaitingOnCandidate("user", "reviewer", "hiho"),
          reasonSummary: "本人の確認を待っています",
        },
      ],
    };

    expect(selectWaitingSubjectReasons(item, "hiho", ["voicevox/maintainers"])).toEqual([
      "本人の確認を待っています",
      "所属チームの確認を待っています",
      "担当者の対応を待っています",
    ]);
  });
});
