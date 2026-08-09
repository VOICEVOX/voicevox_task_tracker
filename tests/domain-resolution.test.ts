import { describe, expect, expectTypeOf, it } from "vitest";

import {
  buildSourceId,
  createGitHubBotPredicate,
  createGitHubNodeId,
  createLabelEffectsResolver,
  resolveRepositoryMaintainers,
  resolveRepositoryRoleWaitingOn,
  resolveWaitingOnAccountIdentifiers,
  type MaintainerResolutionSettings,
  type WaitingOn,
} from "../src/domain/index.js";
import {
  normalizeGitHubActor,
  type GitHubBotPredicate,
  type GitHubDetailActor,
} from "../src/github/index.js";

const maintainerSettings = {
  defaults: ["default-maintainer", "shared-maintainer"],
  repositories: {
    "VOICEVOX/voicevox": ["voicevox-maintainer"],
  },
} satisfies MaintainerResolutionSettings;

function createDetailActor(login: string, apiType: "Bot" | "User"): GitHubDetailActor {
  const nodeId = createGitHubNodeId(`U_${login}`);
  return {
    status: "identified",
    account: {
      sourceId: buildSourceId("github_actor", nodeId),
      nodeId,
      login,
      apiType,
    },
  };
}

describe("bot判定", () => {
  const predicate = createGitHubBotPredicate({
    loginPatterns: ["-automation$", "\\[bot\\]$"],
    knownLogins: ["known-bot", "trusted-automation"],
    treatAsHuman: ["trusted-automation", "exception[bot]"],
  });

  it("既知loginとlogin patternに一致するアカウントをbotと判定する", () => {
    expect(predicate({ login: "known-bot", apiType: "User" })).toBe(true);
    expect(predicate({ login: "preview-automation", apiType: "User" })).toBe(true);
    expect(predicate({ login: "dependabot[bot]", apiType: "User" })).toBe(true);
  });

  it("未知のloginをhumanと判定する", () => {
    expect(predicate({ login: "unknown-human", apiType: "User" })).toBe(false);
    expect(predicate({ login: "Known-Bot", apiType: "User" })).toBe(false);
  });

  it("treatAsHumanを完全一致とpatternより優先する", () => {
    expect(predicate({ login: "trusted-automation", apiType: "User" })).toBe(false);
    expect(predicate({ login: "exception[bot]", apiType: "User" })).toBe(false);
  });

  it("treatAsHumanをGitHub APIのBot型より優先する", () => {
    expect(predicate({ login: "exception[bot]", apiType: "Bot" })).toBe(false);
  });

  it("T08のpredicateとして渡せて例外指定のないGitHub APIのBot型をbotとする", () => {
    expectTypeOf(predicate).toExtend<GitHubBotPredicate>();
    expect(predicate({ login: "api-bot", apiType: "Bot" })).toBe(true);

    const actor = normalizeGitHubActor(createDetailActor("api-bot", "Bot"), predicate);

    expect(actor.type).toBe("bot");
  });

  it("設定検証を経ず不正な正規表現が渡っても明示的な例外にする", () => {
    expect(() =>
      createGitHubBotPredicate({
        loginPatterns: ["["],
        knownLogins: [],
        treatAsHuman: [],
      }),
    ).toThrow("bot login patternを正規表現として解釈できません");
  });
});

describe("ラベル効果解決", () => {
  const resolveLabelEffects = createLabelEffectsResolver([
    {
      repository: "VOICEVOX/editor",
      namePattern: "^優先度高$",
      effects: {
        priorityWeight: 20,
      },
    },
    {
      repository: "VOICEVOX/engine",
      namePattern: "^優先度高$",
      effects: {
        priorityWeight: 5,
        suppressNotifications: true,
      },
    },
    {
      repository: "VOICEVOX/*",
      namePattern: "^優先度",
      effects: {
        priorityWeight: 3,
        severityLift: 1,
      },
    },
    {
      repository: "VOICEVOX/engine",
      namePattern: "高$",
      effects: {
        priorityWeight: 7,
        severityLift: 0,
        requiresMaintainerDecision: true,
      },
    },
    {
      repository: "VOICEVOX/*",
      namePattern: "^進捗確認済み$",
      effects: {
        countsAsProgress: true,
      },
    },
  ]);

  it("同名ラベルをリポジトリ別に異なる意味へ解決する", () => {
    expect(resolveLabelEffects("VOICEVOX/editor", ["優先度高"])).toEqual({
      priorityWeight: 23,
      severityLift: 1,
      requiresMaintainerDecision: false,
      maintainerDecisionLabelNames: [],
      suppressNotifications: false,
      countsAsProgress: false,
    });
    expect(resolveLabelEffects("VOICEVOX/engine", ["優先度高"])).toEqual({
      priorityWeight: 15,
      severityLift: 1,
      requiresMaintainerDecision: true,
      maintainerDecisionLabelNames: ["優先度高"],
      suppressNotifications: true,
      countsAsProgress: false,
    });
  });

  it("複数ルール一致時に重みを合算しseverityを最大化してbooleanをor合成する", () => {
    const effects = resolveLabelEffects("VOICEVOX/engine", ["優先度高"]);

    expect(effects).toEqual({
      priorityWeight: 15,
      severityLift: 1,
      requiresMaintainerDecision: true,
      maintainerDecisionLabelNames: ["優先度高"],
      suppressNotifications: true,
      countsAsProgress: false,
    });
  });

  it("同じルールに複数ラベルが一致しても効果を一度だけ適用する", () => {
    const effects = resolveLabelEffects("VOICEVOX/other", ["優先度高", "優先度中"]);

    expect(effects.priorityWeight).toBe(3);
    expect(effects.severityLift).toBe(1);
    expect(effects.maintainerDecisionLabelNames).toEqual([]);
  });

  it("maintainer判断を成立させたラベル名を重複なく返す", () => {
    const effects = resolveLabelEffects("VOICEVOX/engine", ["対応要否高", "優先度高", "優先度高"]);

    expect(effects.maintainerDecisionLabelNames).toEqual(["優先度高", "対応要否高"]);
  });

  it("一致するルールがない場合は効果なしを返す", () => {
    expect(resolveLabelEffects("OTHER/example", ["優先度高"])).toEqual({
      priorityWeight: 0,
      severityLift: 0,
      requiresMaintainerDecision: false,
      maintainerDecisionLabelNames: [],
      suppressNotifications: false,
      countsAsProgress: false,
    });
  });

  it("設定したラベルだけを意味のある進捗として解決する", () => {
    expect(resolveLabelEffects("VOICEVOX/other", ["進捗確認済み"]).countsAsProgress).toBe(true);
    expect(resolveLabelEffects("VOICEVOX/other", ["優先度高"]).countsAsProgress).toBe(false);
  });

  it("設定検証を経ず不正な正規表現が渡っても明示的な例外にする", () => {
    expect(() =>
      createLabelEffectsResolver([
        {
          repository: "VOICEVOX/*",
          namePattern: "[",
          effects: {
            priorityWeight: 1,
          },
        },
      ]),
    ).toThrow("label name patternを正規表現として解釈できません");
  });
});

describe("メンテナ解決", () => {
  it("リポジトリ別設定がない場合は既定メンテナを解決する", () => {
    expect(resolveRepositoryMaintainers(maintainerSettings, "VOICEVOX/other")).toEqual(
      maintainerSettings.defaults,
    );
  });

  it("リポジトリ別設定がある場合は既定値とmergeせず一覧全体を上書きする", () => {
    expect(resolveRepositoryMaintainers(maintainerSettings, "VOICEVOX/voicevox")).toEqual([
      "voicevox-maintainer",
    ]);
  });

  it("リポジトリ名の大文字小文字を区別して照合する", () => {
    expect(resolveRepositoryMaintainers(maintainerSettings, "voicevox/voicevox")).toEqual(
      maintainerSettings.defaults,
    );
  });

  it("リポジトリ責務の抽象roleを各メンテナのuser候補へ展開する", () => {
    const sourceId = buildSourceId("github_item_detail", "I_team_role");
    const maintainer = {
      kind: "role",
      candidateId: "maintainer",
      role: "maintainer",
      reasonSummary: "maintainerの対応待ちです",
      sourceIds: [sourceId],
      confidence: 1,
    } satisfies WaitingOn;
    const reviewer = {
      kind: "role",
      candidateId: "reviewer",
      role: "reviewer",
      reasonSummary: "reviewerの対応待ちです",
      sourceIds: [sourceId],
      confidence: 1,
    } satisfies WaitingOn;
    const mergeDecider = {
      ...maintainer,
      role: "merge_decider",
    } satisfies WaitingOn;
    const requestedUser = {
      ...reviewer,
      kind: "user",
      candidateId: "requested-reviewer",
    } satisfies WaitingOn;
    const requestedTeam = {
      ...reviewer,
      kind: "team",
      candidateId: "VOICEVOX/reviewers",
    } satisfies WaitingOn;

    expect(
      [
        resolveRepositoryRoleWaitingOn(maintainer, maintainerSettings.defaults),
        resolveRepositoryRoleWaitingOn(reviewer, maintainerSettings.defaults),
        resolveRepositoryRoleWaitingOn(mergeDecider, maintainerSettings.defaults),
      ].map((waitingOnValues) =>
        waitingOnValues.map((waitingOn) => [waitingOn.kind, waitingOn.candidateId, waitingOn.role]),
      ),
    ).toEqual([
      [
        ["user", "default-maintainer", "maintainer"],
        ["user", "shared-maintainer", "maintainer"],
      ],
      [
        ["user", "default-maintainer", "reviewer"],
        ["user", "shared-maintainer", "reviewer"],
      ],
      [
        ["user", "default-maintainer", "merge_decider"],
        ["user", "shared-maintainer", "merge_decider"],
      ],
    ]);
    expect(resolveRepositoryRoleWaitingOn(requestedUser, maintainerSettings.defaults)).toEqual([
      requestedUser,
    ]);
    expect(resolveRepositoryRoleWaitingOn(requestedTeam, maintainerSettings.defaults)).toEqual([
      requestedTeam,
    ]);
  });

  it("user候補だけを責務アカウント識別子として返す", () => {
    const sourceId = buildSourceId("github_item_detail", "I_account_identifiers");
    const waitingOnValues = [
      {
        kind: "user",
        candidateId: "maintainer-login",
        role: "maintainer",
        reasonSummary: "メンテナの対応待ちです",
        sourceIds: [sourceId],
        confidence: 1,
      },
      {
        kind: "team",
        candidateId: "VOICEVOX/reviewers",
        role: "reviewer",
        reasonSummary: "teamの対応待ちです",
        sourceIds: [sourceId],
        confidence: 1,
      },
    ] satisfies readonly WaitingOn[];

    expect([...resolveWaitingOnAccountIdentifiers(waitingOnValues)]).toEqual(["maintainer-login"]);
  });
});
