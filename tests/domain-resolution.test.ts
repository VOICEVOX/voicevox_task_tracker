import { describe, expect, expectTypeOf, it } from "vitest";

import {
  buildSourceId,
  createGitHubBotPredicate,
  createGitHubNodeId,
  createLabelEffectsResolver,
  listConfiguredTeamReferences,
  resolveRepositoryRoleWaitingOn,
  resolveRepositoryTeamReferences,
  resolveRepositoryTeams,
  type GitHubTeamDirectory,
  type ResolvedGitHubTeam,
  type TeamResolutionSettings,
  type WaitingOn,
} from "../src/domain/index.js";
import {
  normalizeGitHubActor,
  type GitHubBotPredicate,
  type GitHubDetailActor,
} from "../src/github/index.js";

const teamSettings = {
  defaults: {
    maintainers: [{ org: "VOICEVOX", slug: "default-maintainers" }],
    reviewers: [{ org: "VOICEVOX", slug: "default-reviewers" }],
  },
  repositories: {
    "VOICEVOX/voicevox": {
      maintainers: [{ org: "VOICEVOX", slug: "voicevox-maintainers" }],
      reviewers: [{ org: "VOICEVOX", slug: "voicevox-reviewers" }],
    },
    "VOICEVOX/shared": {
      maintainers: [{ org: "VOICEVOX", slug: "default-maintainers" }],
      reviewers: [{ org: "VOICEVOX", slug: "default-reviewers" }],
    },
  },
} satisfies TeamResolutionSettings;

function createTeam(
  nodeId: string,
  slug: string,
  memberLogins: readonly string[],
): ResolvedGitHubTeam {
  return Object.freeze({
    nodeId: createGitHubNodeId(nodeId),
    org: "VOICEVOX",
    slug,
    members: Object.freeze(
      memberLogins.map((login, index) =>
        Object.freeze({
          nodeId: createGitHubNodeId(`${nodeId}_member_${index.toString()}`),
          login,
        }),
      ),
    ),
  });
}

const teamDirectory = Object.freeze([
  createTeam("T_default_maintainers", "default-maintainers", ["default-maintainer", "both"]),
  createTeam("T_default_reviewers", "default-reviewers", ["default-reviewer", "both"]),
  createTeam("T_voicevox_maintainers", "voicevox-maintainers", ["voicevox-maintainer"]),
  createTeam("T_voicevox_reviewers", "voicevox-reviewers", ["voicevox-reviewer"]),
]) satisfies GitHubTeamDirectory;

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

describe("team解決", () => {
  it("リポジトリ別設定がない場合は既定teamを解決する", () => {
    const references = resolveRepositoryTeamReferences("VOICEVOX/other", teamSettings);
    const teams = resolveRepositoryTeams("VOICEVOX/other", teamSettings, teamDirectory);

    expect(references).toEqual(teamSettings.defaults);
    expect(teams.maintainers.map((team) => team.slug)).toEqual(["default-maintainers"]);
    expect(teams.reviewers.map((team) => team.slug)).toEqual(["default-reviewers"]);
  });

  it("リポジトリ別設定がある場合はmaintainerとreviewerを上書きする", () => {
    const references = resolveRepositoryTeamReferences("VOICEVOX/voicevox", teamSettings);
    const teams = resolveRepositoryTeams("VOICEVOX/voicevox", teamSettings, teamDirectory);

    expect(references).toEqual(teamSettings.repositories["VOICEVOX/voicevox"]);
    expect(teams.maintainers.map((team) => team.slug)).toEqual(["voicevox-maintainers"]);
    expect(teams.reviewers.map((team) => team.slug)).toEqual(["voicevox-reviewers"]);
  });

  it("抽象roleを既定と上書きのteamへ解決しGitHub由来の実体は維持する", () => {
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
    const requestedUser = {
      ...reviewer,
      kind: "user",
      candidateId: "requested-reviewer",
    } satisfies WaitingOn;
    const defaultTeams = resolveRepositoryTeams("VOICEVOX/other", teamSettings, teamDirectory);
    const overrideTeams = resolveRepositoryTeams("VOICEVOX/voicevox", teamSettings, teamDirectory);

    expect(
      [
        resolveRepositoryRoleWaitingOn(defaultTeams, maintainer),
        resolveRepositoryRoleWaitingOn(defaultTeams, reviewer),
        resolveRepositoryRoleWaitingOn(overrideTeams, maintainer),
        resolveRepositoryRoleWaitingOn(overrideTeams, reviewer),
      ].map((waitingOnValues) =>
        waitingOnValues.map((waitingOn) => [waitingOn.kind, waitingOn.candidateId]),
      ),
    ).toEqual([
      [["team", "VOICEVOX/default-maintainers"]],
      [["team", "VOICEVOX/default-reviewers"]],
      [["team", "VOICEVOX/voicevox-maintainers"]],
      [["team", "VOICEVOX/voicevox-reviewers"]],
    ]);
    expect(resolveRepositoryRoleWaitingOn(defaultTeams, requestedUser)).toEqual([requestedUser]);
  });

  it("既定値と上書きで重複するteamを一度だけ列挙する", () => {
    expect(
      listConfiguredTeamReferences(teamSettings).map((team) => `${team.org}/${team.slug}`),
    ).toEqual([
      "VOICEVOX/default-maintainers",
      "VOICEVOX/default-reviewers",
      "VOICEVOX/voicevox-maintainers",
      "VOICEVOX/voicevox-reviewers",
    ]);
  });
});
