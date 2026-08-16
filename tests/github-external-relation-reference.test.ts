import { describe, expect, it } from "vitest";

import {
  GitHubGraphQLResponseError,
  GitHubResponseSchemaValidationError,
  GitHubResponseValidationError,
  resolveGitHubRelationReference,
  type GitHubClient,
} from "../src/github/index.js";
import { type RelationTextReference } from "../src/graph/extract-relation-candidates.js";

type Graphql = GitHubClient["graphql"];
type GraphqlCall = Readonly<{
  query: string;
  variables: Readonly<Record<string, unknown>>;
}>;
type ItemType = "issue" | "pull_request";
type RepositoryState = Readonly<{
  visibility: "PUBLIC" | "PRIVATE" | "INTERNAL";
  isArchived: boolean;
  isDisabled: boolean;
  owner: string;
  name: string;
}>;

const issueReference = {
  repositoryOwner: "VOICEVOX",
  repositoryName: "voicevox_core",
  itemType: "issue",
  number: 1190,
} satisfies RelationTextReference;
const pullRequestReference = {
  repositoryOwner: "VOICEVOX",
  repositoryName: "voicevox_core",
  itemType: "pull_request",
  number: 64,
} satisfies RelationTextReference;
const unknownReference = {
  repositoryOwner: "VOICEVOX",
  repositoryName: "voicevox_core",
  itemType: null,
  number: 1190,
} satisfies RelationTextReference;

function createRepository(state: RepositoryState): Readonly<Record<string, unknown>> {
  return {
    id: "R_voicevox_core",
    name: state.name,
    visibility: state.visibility,
    isArchived: state.isArchived,
    isDisabled: state.isDisabled,
    owner: {
      login: state.owner,
    },
  };
}

function createItem(
  itemType: ItemType,
  number: number,
  repositoryState: RepositoryState,
): Readonly<Record<string, unknown>> {
  const common = {
    id: itemType === "issue" ? "I_relation" : "PR_relation",
    number,
    url:
      itemType === "issue"
        ? `https://github.com/${repositoryState.owner}/${repositoryState.name}/issues/${number.toString()}`
        : `https://github.com/${repositoryState.owner}/${repositoryState.name}/pull/${number.toString()}`,
    createdAt: "2026-08-01T00:00:00Z",
    repository: createRepository(repositoryState),
  };
  return itemType === "issue"
    ? {
        ...common,
        __typename: "Issue",
        issueState: "OPEN",
      }
    : {
        ...common,
        __typename: "PullRequest",
        pullRequestState: "OPEN",
      };
}

function createResponse(
  item: Readonly<Record<string, unknown>> | null,
): Readonly<Record<string, unknown>> {
  return {
    repository: {
      issueOrPullRequest: item,
    },
  };
}

function createGraphqlMock(response: Readonly<Record<string, unknown>>): Readonly<{
  graphql: Graphql;
  calls: GraphqlCall[];
}> {
  const calls: GraphqlCall[] = [];
  const graphql: Graphql = (query, variables) => {
    calls.push({ query, variables });
    return Promise.resolve(response);
  };
  return { graphql, calls };
}

async function captureError(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error: unknown) {
    return error;
  }
  throw new Error("エラーが発生しませんでした");
}

const publicRepository = {
  visibility: "PUBLIC",
  isArchived: false,
  isDisabled: false,
  owner: "VOICEVOX",
  name: "voicevox_core",
} satisfies RepositoryState;

describe("GitHub external relation reference adapter", () => {
  it("公開Issueのmetadataを正規化して返す", async () => {
    const mock = createGraphqlMock(
      createResponse(createItem("issue", issueReference.number, publicRepository)),
    );

    const result = await resolveGitHubRelationReference({
      reference: issueReference,
      graphql: mock.graphql,
    });

    expect(result).toMatchObject({
      status: "public",
      item: {
        repositoryOwner: "VOICEVOX",
        repositoryName: "voicevox_core",
        type: "issue",
        number: 1190,
        state: "open",
      },
    });
    expect(mock.calls).toHaveLength(1);
    expect(mock.calls[0]?.query).toContain("issueOrPullRequest(number: $number)");
    expect(mock.calls[0]?.query).not.toContain("issue(number: $number)");
    expect(mock.calls[0]?.query).not.toContain("pullRequest(number: $number)");
    expect(mock.calls[0]?.variables).toEqual({
      owner: "VOICEVOX",
      name: "voicevox_core",
      number: 1190,
    });
  });

  it("公開Pull Requestのmetadataを正規化して返す", async () => {
    const mock = createGraphqlMock(
      createResponse(createItem("pull_request", pullRequestReference.number, publicRepository)),
    );

    const result = await resolveGitHubRelationReference({
      reference: pullRequestReference,
      graphql: mock.graphql,
    });

    expect(result).toMatchObject({
      status: "public",
      item: {
        type: "pull_request",
        number: 64,
        state: "open",
      },
    });
    expect(mock.calls[0]?.query).toContain("issueOrPullRequest(number: $number)");
    expect(mock.calls[0]?.query).not.toContain("issue(number: $number)");
  });

  it("型不明の参照をunionのIssueとして解決する", async () => {
    const mock = createGraphqlMock(
      createResponse(createItem("issue", unknownReference.number, publicRepository)),
    );

    const result = await resolveGitHubRelationReference({
      reference: unknownReference,
      graphql: mock.graphql,
    });

    expect(result).toMatchObject({ status: "public", item: { type: "issue", number: 1190 } });
    expect(mock.calls[0]?.query).toContain("issueOrPullRequest(number: $number)");
    expect(mock.calls[0]?.query).not.toContain("issue(number: $number)");
    expect(mock.calls[0]?.query).not.toContain("pullRequest(number: $number)");
  });

  it("型不明の参照をunionのPull Requestとして解決する", async () => {
    const mock = createGraphqlMock(
      createResponse(createItem("pull_request", unknownReference.number, publicRepository)),
    );

    const result = await resolveGitHubRelationReference({
      reference: unknownReference,
      graphql: mock.graphql,
    });

    expect(result).toMatchObject({
      status: "public",
      item: { type: "pull_request", number: 1190 },
    });
  });

  it.each([
    {
      name: "Issueのowner変更",
      itemType: "issue",
      reference: issueReference,
      repositoryState: {
        ...publicRepository,
        owner: "canonical-owner",
      },
    },
    {
      name: "Issueのrepository name変更",
      itemType: "issue",
      reference: issueReference,
      repositoryState: {
        ...publicRepository,
        name: "canonical-repository",
      },
    },
    {
      name: "Issueのownerとrepository name変更",
      itemType: "issue",
      reference: issueReference,
      repositoryState: {
        ...publicRepository,
        owner: "canonical-owner",
        name: "canonical-repository",
      },
    },
    {
      name: "Pull Requestのowner変更",
      itemType: "pull_request",
      reference: pullRequestReference,
      repositoryState: {
        ...publicRepository,
        owner: "canonical-owner",
      },
    },
    {
      name: "Pull Requestのrepository name変更",
      itemType: "pull_request",
      reference: pullRequestReference,
      repositoryState: {
        ...publicRepository,
        name: "canonical-repository",
      },
    },
    {
      name: "Pull Requestのownerとrepository name変更",
      itemType: "pull_request",
      reference: pullRequestReference,
      repositoryState: {
        ...publicRepository,
        owner: "canonical-owner",
        name: "canonical-repository",
      },
    },
  ] satisfies readonly Readonly<{
    name: string;
    itemType: ItemType;
    reference: RelationTextReference;
    repositoryState: RepositoryState;
  }>[])(
    "$nameはcanonical metadataで公開として返す",
    async ({ itemType, reference, repositoryState }) => {
      const item = createItem(itemType, reference.number, repositoryState);
      const mock = createGraphqlMock(createResponse(item));

      const result = await resolveGitHubRelationReference({
        reference,
        graphql: mock.graphql,
      });

      expect(result).toMatchObject({
        status: "public",
        item: {
          repositoryId: "R_voicevox_core",
          repositoryOwner: repositoryState.owner,
          repositoryName: repositoryState.name,
          type: itemType,
          number: reference.number,
          url:
            "https://github.com/" +
            repositoryState.owner +
            "/" +
            repositoryState.name +
            "/" +
            (itemType === "issue" ? "issues" : "pull") +
            "/" +
            reference.number.toString(),
        },
      });
      expect(mock.calls).toHaveLength(1);
      expect(mock.calls[0]?.variables).toEqual({
        owner: reference.repositoryOwner,
        name: reference.repositoryName,
        number: reference.number,
      });
    },
  );

  it.each([
    {
      name: "repositoryがnull",
      response: { repository: null },
      reference: issueReference,
    },
    {
      name: "itemがnull",
      response: createResponse(null),
      reference: issueReference,
    },
    {
      name: "private repository",
      response: createResponse(
        createItem("issue", issueReference.number, {
          ...publicRepository,
          visibility: "PRIVATE",
        }),
      ),
      reference: issueReference,
    },
    {
      name: "internal repository",
      response: createResponse(
        createItem("issue", issueReference.number, {
          ...publicRepository,
          visibility: "INTERNAL",
        }),
      ),
      reference: issueReference,
    },
    {
      name: "archived repository",
      response: createResponse(
        createItem("issue", issueReference.number, {
          ...publicRepository,
          isArchived: true,
        }),
      ),
      reference: issueReference,
    },
    {
      name: "disabled repository",
      response: createResponse(
        createItem("issue", issueReference.number, {
          ...publicRepository,
          isDisabled: true,
        }),
      ),
      reference: issueReference,
    },
    {
      name: "canonical owner/nameのprivate repository",
      response: createResponse(
        createItem("issue", issueReference.number, {
          ...publicRepository,
          visibility: "PRIVATE",
          owner: "canonical-owner",
          name: "canonical-repository",
        }),
      ),
      reference: issueReference,
    },
    {
      name: "canonical owner/nameのarchived repository",
      response: createResponse(
        createItem("issue", issueReference.number, {
          ...publicRepository,
          isArchived: true,
          owner: "canonical-owner",
          name: "canonical-repository",
        }),
      ),
      reference: issueReference,
    },
    {
      name: "canonical owner/nameのdisabled repository",
      response: createResponse(
        createItem("issue", issueReference.number, {
          ...publicRepository,
          isDisabled: true,
          owner: "canonical-owner",
          name: "canonical-repository",
        }),
      ),
      reference: issueReference,
    },
    {
      name: "型不明のprivate repository",
      response: createResponse(
        createItem("issue", unknownReference.number, {
          ...publicRepository,
          visibility: "PRIVATE",
        }),
      ),
      reference: unknownReference,
    },
    {
      name: "型不明のarchived repository",
      response: createResponse(
        createItem("issue", unknownReference.number, {
          ...publicRepository,
          isArchived: true,
        }),
      ),
      reference: unknownReference,
    },
    {
      name: "型不明のdisabled repository",
      response: createResponse(
        createItem("issue", unknownReference.number, {
          ...publicRepository,
          isDisabled: true,
        }),
      ),
      reference: unknownReference,
    },
  ] satisfies readonly Readonly<{
    name: string;
    response: Readonly<Record<string, unknown>>;
    reference: RelationTextReference;
  }>[])("$nameは未検証として返す", async ({ response, reference }) => {
    const mock = createGraphqlMock(response);

    const result = await resolveGitHubRelationReference({
      reference,
      graphql: mock.graphql,
    });

    expect(result).toEqual({ status: "unverified" });
  });

  it("型不明unionの項目がnullなら未検証として返す", async () => {
    const mock = createGraphqlMock(createResponse(null));

    const result = await resolveGitHubRelationReference({
      reference: unknownReference,
      graphql: mock.graphql,
    });

    expect(result).toEqual({ status: "unverified" });
  });

  it.each([
    {
      name: "Issue要求にPull Requestだけが返る",
      reference: issueReference,
      response: createResponse(createItem("pull_request", issueReference.number, publicRepository)),
    },
    {
      name: "Pull Request要求にIssueだけが返る",
      reference: pullRequestReference,
      response: createResponse(createItem("issue", pullRequestReference.number, publicRepository)),
    },
  ] satisfies readonly Readonly<{
    name: string;
    reference: RelationTextReference;
    response: Readonly<Record<string, unknown>>;
  }>[])("$nameの場合は未検証として返す", async ({ reference, response }) => {
    const mock = createGraphqlMock(response);

    const result = await resolveGitHubRelationReference({
      reference,
      graphql: mock.graphql,
    });

    expect(result).toEqual({ status: "unverified" });
  });

  it("要求したGraphQL fieldが欠落した応答はcause付きで失敗する", async () => {
    const mock = createGraphqlMock({ repository: {} });

    const error = await captureError(
      resolveGitHubRelationReference({
        reference: issueReference,
        graphql: mock.graphql,
      }),
    );

    expect(error).toBeInstanceOf(GitHubResponseValidationError);
    if (!(error instanceof GitHubResponseValidationError)) {
      throw new Error("GitHub response validation errorではありません");
    }
    expect(error.cause).toBeInstanceOf(TypeError);
  });

  it("型不明queryのunion fieldが欠落した応答はcause付きで失敗する", async () => {
    const mock = createGraphqlMock({ repository: {} });

    const error = await captureError(
      resolveGitHubRelationReference({
        reference: unknownReference,
        graphql: mock.graphql,
      }),
    );

    expect(error).toBeInstanceOf(GitHubResponseValidationError);
    if (!(error instanceof GitHubResponseValidationError)) {
      throw new Error("GitHub response validation errorではありません");
    }
    expect(error.cause).toBeInstanceOf(TypeError);
  });

  it("Zod schemaに適合しない応答はcause付きで失敗する", async () => {
    const mock = createGraphqlMock(
      createResponse({
        ...createItem("issue", issueReference.number, publicRepository),
        number: "1190",
      }),
    );

    const error = await captureError(
      resolveGitHubRelationReference({
        reference: issueReference,
        graphql: mock.graphql,
      }),
    );

    expect(error).toBeInstanceOf(GitHubResponseSchemaValidationError);
    if (!(error instanceof GitHubResponseSchemaValidationError)) {
      throw new Error("GitHub response schema validation errorではありません");
    }
    expect(error.cause).toBeInstanceOf(TypeError);
  });

  it("number不一致はfield名を示すcause付きで失敗する", async () => {
    const mock = createGraphqlMock(
      createResponse(createItem("issue", issueReference.number + 1, publicRepository)),
    );

    const error = await captureError(
      resolveGitHubRelationReference({
        reference: issueReference,
        graphql: mock.graphql,
      }),
    );

    expect(error).toBeInstanceOf(GitHubResponseValidationError);
    if (!(error instanceof GitHubResponseValidationError)) {
      throw new Error("GitHub response validation errorではありません");
    }
    expect(error.cause).toBeInstanceOf(TypeError);
    if (!(error.cause instanceof TypeError)) {
      throw new Error("GitHub response validation errorのcauseがTypeErrorではありません");
    }
    expect(error.cause.message).toBe("応答項目の番号が要求値と一致しません");
    expect(error.message).toContain("GitHubの関係参照");
    expect(error.message).not.toContain("GitHub relation reference");
    expect(error.message).not.toContain("VOICEVOX");
    expect(error.message).not.toContain("voicevox_core");
    expect(error.message).not.toContain("1190");
  });

  it("URLとmetadataの不一致はnormalizeReferencedItemのcause付き検証エラーとして伝播する", async () => {
    const mock = createGraphqlMock(
      createResponse({
        ...createItem("issue", issueReference.number, publicRepository),
        url: "https://github.com/VOICEVOX/voicevox_core/pull/1190",
      }),
    );

    const error = await captureError(
      resolveGitHubRelationReference({
        reference: issueReference,
        graphql: mock.graphql,
      }),
    );

    expect(error).toBeInstanceOf(GitHubResponseValidationError);
    if (!(error instanceof GitHubResponseValidationError)) {
      throw new Error("GitHub response validation errorではありません");
    }
    expect(error.cause).toBeInstanceOf(TypeError);
  });

  it("GraphQLのNOT_FOUNDを未検証へ変換せずそのまま伝播する", async () => {
    const upstreamError = new GitHubGraphQLResponseError(
      {
        operationName: "GitHubRelationReference",
        queryHash: "0123456789abcdef",
        errorCount: 1,
        errors: [
          {
            path: ["repository", "pullRequest"],
            type: "NOT_FOUND",
          },
        ],
      },
      {
        cause: new Error("GraphQL NOT_FOUND"),
      },
    );
    const graphql: Graphql = () => Promise.reject(upstreamError);

    const error = await captureError(
      resolveGitHubRelationReference({
        reference: unknownReference,
        graphql,
      }),
    );

    expect(error).toBe(upstreamError);
  });

  it("GraphQLの取得失敗は未検証へ変換せずそのまま伝播する", async () => {
    const upstreamError = new Error("transient failure");
    const graphql: Graphql = () => Promise.reject(upstreamError);

    const error = await captureError(
      resolveGitHubRelationReference({
        reference: issueReference,
        graphql,
      }),
    );

    expect(error).toBe(upstreamError);
  });
});
