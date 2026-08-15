import { describe, expect, it } from "vitest";

import {
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
  issue: Readonly<Record<string, unknown>> | null,
  pullRequest: Readonly<Record<string, unknown>> | null,
): Readonly<Record<string, unknown>> {
  return {
    repository: {
      issue,
      pullRequest,
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
      createResponse(createItem("issue", issueReference.number, publicRepository), null),
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
    expect(mock.calls[0]?.query).toContain("issue(number: $number)");
    expect(mock.calls[0]?.query).not.toContain("pullRequest(number: $number)");
    expect(mock.calls[0]?.variables).toEqual({
      owner: "VOICEVOX",
      name: "voicevox_core",
      number: 1190,
    });
  });

  it("公開Pull Requestのmetadataを正規化して返す", async () => {
    const mock = createGraphqlMock(
      createResponse(
        null,
        createItem("pull_request", pullRequestReference.number, publicRepository),
      ),
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
    expect(mock.calls[0]?.query).toContain("pullRequest(number: $number)");
    expect(mock.calls[0]?.query).not.toContain("issue(number: $number)");
  });

  it("型不明の参照はIssueとPull Requestを照合して解決する", async () => {
    const mock = createGraphqlMock(
      createResponse(createItem("issue", unknownReference.number, publicRepository), null),
    );

    const result = await resolveGitHubRelationReference({
      reference: unknownReference,
      graphql: mock.graphql,
    });

    expect(result).toMatchObject({ status: "public", item: { type: "issue", number: 1190 } });
    expect(mock.calls[0]?.query).toContain("issue(number: $number)");
    expect(mock.calls[0]?.query).toContain("pullRequest(number: $number)");
  });

  it("型不明の参照から公開Pull Requestを解決する", async () => {
    const mock = createGraphqlMock(
      createResponse(null, createItem("pull_request", unknownReference.number, publicRepository)),
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
      name: "repositoryがnull",
      response: { repository: null },
      reference: issueReference,
    },
    {
      name: "itemがnull",
      response: createResponse(null, null),
      reference: issueReference,
    },
    {
      name: "private repository",
      response: createResponse(
        createItem("issue", issueReference.number, {
          ...publicRepository,
          visibility: "PRIVATE",
        }),
        null,
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
        null,
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
        null,
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
        null,
      ),
      reference: issueReference,
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

  it("型不明の参照でIssueとPull Requestがともにnullなら未検証として返す", async () => {
    const mock = createGraphqlMock(createResponse(null, null));

    const result = await resolveGitHubRelationReference({
      reference: unknownReference,
      graphql: mock.graphql,
    });

    expect(result).toEqual({ status: "unverified" });
  });

  it("指定型と応答型が一致しない参照は未検証として返す", async () => {
    const mock = createGraphqlMock(
      createResponse(null, createItem("pull_request", issueReference.number, publicRepository)),
    );

    const result = await resolveGitHubRelationReference({
      reference: issueReference,
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

  it("型不明の応答でIssueとPull Requestが同時に返る場合はcause付きで失敗する", async () => {
    const mock = createGraphqlMock(
      createResponse(
        createItem("issue", unknownReference.number, publicRepository),
        createItem("pull_request", unknownReference.number, publicRepository),
      ),
    );

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
      createResponse(
        {
          ...createItem("issue", issueReference.number, publicRepository),
          number: "1190",
        },
        null,
      ),
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

  it.each([
    {
      name: "owner不一致",
      response: createResponse(
        createItem("issue", issueReference.number, {
          ...publicRepository,
          owner: "other-owner",
        }),
        null,
      ),
    },
    {
      name: "repository name不一致",
      response: createResponse(
        createItem("issue", issueReference.number, {
          ...publicRepository,
          name: "other-repository",
        }),
        null,
      ),
    },
    {
      name: "number不一致",
      response: createResponse(
        createItem("issue", issueReference.number + 1, publicRepository),
        null,
      ),
    },
  ] satisfies readonly Readonly<{
    name: string;
    response: Readonly<Record<string, unknown>>;
  }>[])("$nameはcause付きで失敗する", async ({ response }) => {
    const mock = createGraphqlMock(response);

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
    expect(error.message).toContain("GitHubの関係参照");
    expect(error.message).not.toContain("GitHub relation reference");
    expect(error.message).not.toContain("VOICEVOX");
    expect(error.message).not.toContain("voicevox_core");
    expect(error.message).not.toContain("1190");
  });

  it("URLとmetadataの不一致はnormalizeReferencedItemのcause付き検証エラーとして伝播する", async () => {
    const mock = createGraphqlMock(
      createResponse(
        {
          ...createItem("issue", issueReference.number, publicRepository),
          url: "https://github.com/VOICEVOX/voicevox_core/pull/1190",
        },
        null,
      ),
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
