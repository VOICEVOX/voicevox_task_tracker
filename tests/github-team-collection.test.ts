import { z } from "zod";
import { describe, expect, it } from "vitest";

import { ConfigError } from "../src/config/index.js";
import { type TeamResolutionSettings } from "../src/domain/index.js";
import {
  collectGitHubTeamDirectory,
  type GitHubRestRequest,
  type GitHubRestResponse,
} from "../src/github/index.js";

type TeamFixture = Readonly<{
  nodeId: string;
  org: string;
  slug: string;
  members: readonly Readonly<{
    nodeId: string;
    login: string;
  }>[];
}>;

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
  },
} satisfies TeamResolutionSettings;

const detailParametersSchema = z.object({
  org: z.string(),
  team_slug: z.string(),
});

const memberParametersSchema = detailParametersSchema.extend({
  role: z.literal("all"),
  per_page: z.literal(100),
  page: z.number().int().positive(),
});

function createResponse(
  data: unknown,
  status: number,
  headers: Readonly<Record<string, string | number | undefined>>,
): GitHubRestResponse {
  return {
    data,
    headers,
    status,
    url: "https://api.github.test/team",
  };
}

function createTeamFixture(slug: string, memberCount: number): TeamFixture {
  return {
    nodeId: `T_${slug}`,
    org: "VOICEVOX",
    slug,
    members: Array.from({ length: memberCount }, (_, index) => ({
      nodeId: `U_${slug}_${index.toString()}`,
      login: `${slug}-member-${index.toString()}`,
    })),
  };
}

function createTeamRequest(fixtures: readonly TeamFixture[], calls: string[]): GitHubRestRequest {
  const fixtureByKey = new Map(
    fixtures.map((fixture) => [
      `${fixture.org.toLowerCase()}/${fixture.slug.toLowerCase()}`,
      fixture,
    ]),
  );

  return async (route, parameters): Promise<GitHubRestResponse> => {
    await Promise.resolve();

    if (route === "GET /orgs/{org}/teams/{team_slug}") {
      const parsed = detailParametersSchema.parse(parameters);
      const key = `${parsed.org.toLowerCase()}/${parsed.team_slug.toLowerCase()}`;
      calls.push(`team:${key}`);
      const fixture = fixtureByKey.get(key);
      if (fixture == null) {
        return createResponse({ message: "Not Found" }, 404, {});
      }
      return createResponse(
        {
          node_id: fixture.nodeId,
          slug: fixture.slug,
          organization: {
            login: fixture.org,
          },
        },
        200,
        {},
      );
    }

    if (route === "GET /orgs/{org}/teams/{team_slug}/members") {
      const parsed = memberParametersSchema.parse(parameters);
      const key = `${parsed.org.toLowerCase()}/${parsed.team_slug.toLowerCase()}`;
      calls.push(`members:${key}:${parsed.page.toString()}`);
      const fixture = fixtureByKey.get(key);
      if (fixture == null) {
        return createResponse({ message: "Not Found" }, 404, {});
      }
      const firstIndex = (parsed.page - 1) * 100;
      const members = fixture.members.slice(firstIndex, firstIndex + 100).map((member) => ({
        node_id: member.nodeId,
        login: member.login,
      }));
      const hasNextPage = firstIndex + members.length < fixture.members.length;
      return createResponse(
        members,
        200,
        hasNextPage
          ? {
              link: `<https://api.github.test/team/members?page=${(parsed.page + 1).toString()}>; rel="next"`,
            }
          : {},
      );
    }

    throw new Error(`想定外のGitHub API routeです: ${route}`);
  };
}

async function captureConfigError(operation: () => Promise<void>): Promise<ConfigError> {
  try {
    await operation();
  } catch (error: unknown) {
    if (error instanceof ConfigError) {
      return error;
    }
    throw error;
  }
  throw new Error("team設定エラーが発生しませんでした");
}

describe("GitHub team取得", () => {
  it("設定されたteamの存在を確認しmembershipを全ページ取得する", async () => {
    const fixtures = [
      createTeamFixture("default-maintainers", 101),
      createTeamFixture("default-reviewers", 1),
      createTeamFixture("voicevox-maintainers", 1),
      createTeamFixture("voicevox-reviewers", 1),
    ];
    const calls: string[] = [];

    const directory = await collectGitHubTeamDirectory({
      teams: teamSettings,
      request: createTeamRequest(fixtures, calls),
    });

    expect(directory.map((team) => team.slug)).toEqual([
      "default-maintainers",
      "default-reviewers",
      "voicevox-maintainers",
      "voicevox-reviewers",
    ]);
    expect(directory[0]?.members).toHaveLength(101);
    expect(directory[0]?.members[100]?.login).toBe("default-maintainers-member-100");
    expect(calls).toEqual([
      "team:voicevox/default-maintainers",
      "members:voicevox/default-maintainers:1",
      "members:voicevox/default-maintainers:2",
      "team:voicevox/default-reviewers",
      "members:voicevox/default-reviewers:1",
      "team:voicevox/voicevox-maintainers",
      "members:voicevox/voicevox-maintainers:1",
      "team:voicevox/voicevox-reviewers",
      "members:voicevox/voicevox-reviewers:1",
    ]);
  });

  it("存在しないteam slugを設定エラーにして後続の公開と通知へ進まない", async () => {
    const missingTeamSettings = {
      defaults: {
        maintainers: [{ org: "VOICEVOX", slug: "missing" }],
        reviewers: [{ org: "VOICEVOX", slug: "missing" }],
      },
      repositories: {},
    } satisfies TeamResolutionSettings;
    let publicationCount = 0;
    let notificationCount = 0;

    const run = async (): Promise<void> => {
      await collectGitHubTeamDirectory({
        teams: missingTeamSettings,
        request: createTeamRequest([], []),
      });
      publicationCount += 1;
      notificationCount += 1;
    };

    const error = await captureConfigError(run);

    expect(error.issues).toEqual([
      {
        path: "teams",
        message: "VOICEVOX/missingをGitHub上で確認できません",
      },
    ]);
    expect(publicationCount).toBe(0);
    expect(notificationCount).toBe(0);
  });
});
