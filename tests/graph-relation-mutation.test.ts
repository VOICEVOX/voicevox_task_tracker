import { describe, expect, it } from "vitest";

import { buildSourceId, createUtcIsoDateTime, type SourceId } from "../src/domain/index.js";
import { extractRelationMutations } from "../src/graph/index.js";
import {
  type RelationMutationEdit,
  type RelationMutationHistory,
  type RelationMutationInput,
} from "../src/graph/relation-mutation.js";

function contentSourceId(value: string): SourceId {
  return buildSourceId("github_item_body", value);
}

function edit(options: {
  id: string;
  sequence: number;
  createdAt: string;
  editedAt: string;
  diff: string | null;
  deletedAt?: string | null;
}): RelationMutationEdit {
  return {
    sourceId: buildSourceId("github_user_content_edit", options.id),
    sequence: options.sequence,
    createdAt: createUtcIsoDateTime(options.createdAt),
    editedAt: createUtcIsoDateTime(options.editedAt),
    diff: options.diff,
    deletedAt: options.deletedAt == null ? null : createUtcIsoDateTime(options.deletedAt),
  };
}

function availableHistory(edits: readonly RelationMutationEdit[]): RelationMutationHistory {
  return {
    availability: "available",
    edits,
  };
}

function input(
  currentMarkdown: string,
  history: RelationMutationHistory,
  contentCreatedAt: string | null,
): RelationMutationInput {
  return {
    contentSourceId: contentSourceId("relation-mutation"),
    contentCreatedAt: contentCreatedAt == null ? null : createUtcIsoDateTime(contentCreatedAt),
    currentMarkdown,
    history,
  };
}

describe("relation mutation replay", () => {
  it("編集後snapshot間の明示URLとowner/repository短縮表記を時刻付き区間化する", () => {
    const result = extractRelationMutations(
      input(
        "https://github.com/VOICEVOX/example/issues/1",
        availableHistory([
          edit({
            id: "edit-1",
            sequence: 0,
            createdAt: "2026-07-01T00:00:00Z",
            editedAt: "2026-08-01T00:00:00Z",
            diff: "https://github.com/VOICEVOX/example/issues/1",
          }),
          edit({
            id: "edit-2",
            sequence: 1,
            createdAt: "2026-07-01T00:00:00Z",
            editedAt: "2026-08-02T00:00:00Z",
            diff: "",
          }),
          edit({
            id: "edit-3",
            sequence: 2,
            createdAt: "2026-07-01T00:00:00Z",
            editedAt: "2026-08-03T00:00:00Z",
            diff: "VOICEVOX/example#1",
          }),
        ]),
        "2026-07-01T00:00:00Z",
      ),
    );

    expect(result.status).toBe("available");
    if (result.status !== "available") {
      throw new TypeError("relation mutationがavailableではありません");
    }
    expect(result.consistency).toBe("consistent");
    expect(result.mutations.map((mutation) => mutation.action)).toEqual(["removed", "added"]);
    expect(result.mutations.map((mutation) => mutation.editedAt)).toEqual([
      "2026-08-02T00:00:00.000Z",
      "2026-08-03T00:00:00.000Z",
    ]);
    if (result.temporalKnowledge.status !== "exact") {
      throw new TypeError("relation mutationのtemporal knowledgeがexactではありません");
    }
    expect(result.temporalKnowledge.intervals.map((interval) => interval.status)).toEqual([
      "removed",
      "active",
    ]);
    expect(result.temporalKnowledge.intervals[0]?.addedAt).toBe("2026-07-01T00:00:00.000Z");
    expect(result.currentReferences).toEqual([
      {
        repositoryOwner: "VOICEVOX",
        repositoryName: "example",
        itemType: "issue",
        number: 1,
      },
    ]);
    expect(result.replayedReferences).toEqual([
      {
        repositoryOwner: "VOICEVOX",
        repositoryName: "example",
        itemType: null,
        number: 1,
      },
    ]);
  });

  it("同時刻の編集をsequenceとsource IDで決定的に並べる", () => {
    const first = edit({
      id: "edit-a",
      sequence: 1,
      createdAt: "2026-08-01T00:00:00Z",
      editedAt: "2026-08-01T00:00:00Z",
      diff: "https://github.com/VOICEVOX/example/issues/1",
    });
    const second = edit({
      id: "edit-b",
      sequence: 1,
      createdAt: "2026-08-01T00:00:00Z",
      editedAt: "2026-08-01T00:00:00Z",
      diff: "https://github.com/VOICEVOX/example/issues/1\nhttps://github.com/VOICEVOX/example/issues/2",
    });
    const firstResult = extractRelationMutations(
      input(second.diff ?? "", availableHistory([second, first]), null),
    );
    const secondResult = extractRelationMutations(
      input(second.diff ?? "", availableHistory([first, second]), null),
    );

    expect(firstResult).toEqual(secondResult);
  });

  it("diffがnull、削除済み、取得不能ならunknownを保持する", () => {
    const nullDiff = extractRelationMutations(
      input(
        "",
        availableHistory([
          edit({
            id: "null-diff",
            sequence: 0,
            createdAt: "2026-08-01T00:00:00Z",
            editedAt: "2026-08-01T00:00:00Z",
            diff: null,
          }),
        ]),
        null,
      ),
    );
    const deleted = extractRelationMutations(
      input(
        "",
        availableHistory([
          edit({
            id: "deleted",
            sequence: 0,
            createdAt: "2026-08-01T00:00:00Z",
            editedAt: "2026-08-01T00:00:00Z",
            diff: "",
            deletedAt: "2026-08-02T00:00:00Z",
          }),
        ]),
        null,
      ),
    );
    const unavailable = extractRelationMutations(
      input(
        "",
        {
          availability: "unavailable",
          reason: "connection_unavailable",
        },
        null,
      ),
    );

    expect(nullDiff).toMatchObject({ status: "unknown", reason: "diff_null" });
    expect(deleted).toMatchObject({ status: "unknown", reason: "deleted_edit" });
    expect(unavailable).toEqual({
      status: "unknown",
      contentSourceId: contentSourceId("relation-mutation"),
      reason: "connection_unavailable",
    });
  });

  it("未知のpatch形式とMarkdown参照定義を空配列にせずunknownにする", () => {
    const patch = extractRelationMutations(
      input(
        "",
        availableHistory([
          edit({
            id: "patch",
            sequence: 0,
            createdAt: "2026-08-01T00:00:00Z",
            editedAt: "2026-08-01T00:00:00Z",
            diff: "@@ -1 +1 @@\n-old\n+new",
          }),
        ]),
        null,
      ),
    );
    const referenceDefinition = extractRelationMutations(
      input(
        "",
        availableHistory([
          edit({
            id: "reference-definition",
            sequence: 0,
            createdAt: "2026-08-01T00:00:00Z",
            editedAt: "2026-08-01T00:00:00Z",
            diff: "[related][missing]",
          }),
        ]),
        null,
      ),
    );

    expect(patch).toMatchObject({ status: "unknown", reason: "unsupported_diff_format" });
    expect(referenceDefinition).toMatchObject({
      status: "unknown",
      reason: "markdown_reference_definition",
    });
  });

  it("現在本文は最終状態として保持し、history不足と不一致を区別する", () => {
    const incomplete = extractRelationMutations(
      input("https://github.com/VOICEVOX/example/issues/1", availableHistory([]), null),
    );
    const mismatch = extractRelationMutations(
      input(
        "https://github.com/VOICEVOX/example/issues/2",
        availableHistory([
          edit({
            id: "old",
            sequence: 0,
            createdAt: "2026-08-01T00:00:00Z",
            editedAt: "2026-08-01T00:00:00Z",
            diff: "https://github.com/VOICEVOX/example/issues/1",
          }),
        ]),
        null,
      ),
    );
    const currentWithRule = extractRelationMutations(
      input("---\nhttps://github.com/VOICEVOX/example/issues/1", availableHistory([]), null),
    );

    expect(incomplete).toMatchObject({
      status: "available",
      consistency: "history_incomplete",
      temporalKnowledge: { status: "unknown", reason: "history_incomplete" },
    });
    expect(mismatch).toMatchObject({
      status: "available",
      consistency: "mismatch",
      temporalKnowledge: { status: "unknown", reason: "current_mismatch" },
    });
    expect(incomplete).not.toHaveProperty("intervals");
    expect(mismatch).not.toHaveProperty("intervals");
    expect(currentWithRule).toMatchObject({ status: "available" });
  });

  it("raw diffを結果へ流出させない", () => {
    const result = extractRelationMutations(
      input(
        "https://github.com/VOICEVOX/example/issues/1",
        availableHistory([
          edit({
            id: "secret",
            sequence: 0,
            createdAt: "2026-08-01T00:00:00Z",
            editedAt: "2026-08-01T00:00:00Z",
            diff: "secret raw snapshot\nhttps://github.com/VOICEVOX/example/issues/1",
          }),
        ]),
        null,
      ),
    );

    expect(JSON.stringify(result)).not.toContain("secret raw snapshot");
    expect(result).not.toHaveProperty("diff");
  });

  it("初期relationの時刻を確認できない場合はtemporal knowledgeをunknownにする", () => {
    const result = extractRelationMutations(
      input(
        "https://github.com/VOICEVOX/example/issues/1",
        availableHistory([
          edit({
            id: "preexisting",
            sequence: 0,
            createdAt: "2026-08-01T00:00:00Z",
            editedAt: "2026-08-01T00:00:00Z",
            diff: "https://github.com/VOICEVOX/example/issues/1",
          }),
        ]),
        null,
      ),
    );

    expect(result).toMatchObject({
      status: "available",
      temporalKnowledge: { status: "unknown", reason: "preexisting_relation" },
    });
    expect(result).not.toHaveProperty("intervals");
  });

  it("同一source IDの重複はcollectorの不変条件違反として例外にする", () => {
    const duplicated = edit({
      id: "duplicate",
      sequence: 0,
      createdAt: "2026-08-01T00:00:00Z",
      editedAt: "2026-08-01T00:00:00Z",
      diff: "",
    });

    expect(() =>
      extractRelationMutations(input("", availableHistory([duplicated, duplicated]), null)),
    ).toThrowError(/source IDが重複/u);
  });
});
