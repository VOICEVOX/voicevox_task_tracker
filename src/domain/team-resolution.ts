import { type GitHubNodeId, type WaitingOn } from "./types.js";
import { assertNonNullable, UnreachableError } from "../util/index.js";

/** 設定で参照するOrganization team。 */
export type TeamReference = Readonly<{
  org: string;
  slug: string;
}>;

/** maintainerとreviewerへ割り当てるteam一覧。 */
export type RepositoryTeamReferences = Readonly<{
  maintainers: readonly TeamReference[];
  reviewers: readonly TeamReference[];
}>;

/** 既定値とリポジトリ別上書きを持つteam設定。 */
export type TeamResolutionSettings = Readonly<{
  defaults: RepositoryTeamReferences;
  repositories: Readonly<Record<string, RepositoryTeamReferences>>;
}>;

/** GitHub teamに所属するユーザー。 */
export type GitHubTeamMember = Readonly<{
  nodeId: GitHubNodeId;
  login: string;
}>;

/** GitHub上で存在確認とmembership取得を終えたteam。 */
export type ResolvedGitHubTeam = Readonly<{
  nodeId: GitHubNodeId;
  org: string;
  slug: string;
  members: readonly GitHubTeamMember[];
}>;

/** 取得済みteamを検索するための一覧。 */
export type GitHubTeamDirectory = readonly ResolvedGitHubTeam[];

/** リポジトリへ割り当てた存在確認済みteam。 */
export type ResolvedRepositoryTeams = Readonly<{
  maintainers: readonly ResolvedGitHubTeam[];
  reviewers: readonly ResolvedGitHubTeam[];
}>;

function createTeamKey(team: TeamReference): string {
  return `${team.org.toLowerCase()}/${team.slug.toLowerCase()}`;
}

function freezeTeamReference(team: TeamReference): TeamReference {
  return Object.freeze({
    org: team.org,
    slug: team.slug,
  });
}

function freezeRepositoryTeamReferences(
  references: RepositoryTeamReferences,
): RepositoryTeamReferences {
  return Object.freeze({
    maintainers: Object.freeze(references.maintainers.map(freezeTeamReference)),
    reviewers: Object.freeze(references.reviewers.map(freezeTeamReference)),
  });
}

function compareTeamReferences(left: TeamReference, right: TeamReference): -1 | 0 | 1 {
  const leftKey = createTeamKey(left);
  const rightKey = createTeamKey(right);
  if (leftKey < rightKey) {
    return -1;
  }
  if (leftKey > rightKey) {
    return 1;
  }
  return 0;
}

/** 既定値と上書きに現れるteamを重複なしで列挙する。 */
export function listConfiguredTeamReferences(
  settings: TeamResolutionSettings,
): readonly TeamReference[] {
  const references = [
    ...settings.defaults.maintainers,
    ...settings.defaults.reviewers,
    ...Object.values(settings.repositories).flatMap((repository) => [
      ...repository.maintainers,
      ...repository.reviewers,
    ]),
  ];
  const uniqueReferences = new Map<string, TeamReference>();

  for (const reference of references) {
    const key = createTeamKey(reference);
    if (!uniqueReferences.has(key)) {
      uniqueReferences.set(key, freezeTeamReference(reference));
    }
  }

  return Object.freeze([...uniqueReferences.values()].sort(compareTeamReferences));
}

/** リポジトリ別上書きを優先してmaintainerとreviewerのteam設定を解決する。 */
export function resolveRepositoryTeamReferences(
  repositoryFullName: string,
  settings: TeamResolutionSettings,
): RepositoryTeamReferences {
  if (!Object.hasOwn(settings.repositories, repositoryFullName)) {
    return freezeRepositoryTeamReferences(settings.defaults);
  }

  const repositorySettings = settings.repositories[repositoryFullName];
  assertNonNullable(repositorySettings, "存在するリポジトリ別team設定を取得できませんでした");
  return freezeRepositoryTeamReferences(repositorySettings);
}

function createTeamDirectoryLookup(
  directory: GitHubTeamDirectory,
): ReadonlyMap<string, ResolvedGitHubTeam> {
  const lookup = new Map<string, ResolvedGitHubTeam>();
  for (const team of directory) {
    const key = createTeamKey(team);
    if (lookup.has(key)) {
      throw new TypeError(`team directoryにteamが重複しています: ${team.org}/${team.slug}`);
    }
    lookup.set(key, team);
  }
  return lookup;
}

function resolveTeams(
  references: readonly TeamReference[],
  directory: ReadonlyMap<string, ResolvedGitHubTeam>,
): readonly ResolvedGitHubTeam[] {
  return Object.freeze(
    references.map((reference) => {
      const team = directory.get(createTeamKey(reference));
      assertNonNullable(
        team,
        `team directoryに設定済みteamがありません: ${reference.org}/${reference.slug}`,
      );
      return team;
    }),
  );
}

/** team設定と取得済みmembershipからリポジトリのteamを解決する。 */
export function resolveRepositoryTeams(
  repositoryFullName: string,
  settings: TeamResolutionSettings,
  directory: GitHubTeamDirectory,
): ResolvedRepositoryTeams {
  const references = resolveRepositoryTeamReferences(repositoryFullName, settings);
  const lookup = createTeamDirectoryLookup(directory);

  return Object.freeze({
    maintainers: resolveTeams(references.maintainers, lookup),
    reviewers: resolveTeams(references.reviewers, lookup),
  });
}

function teamCandidateId(team: ResolvedGitHubTeam): string {
  return `${team.org}/${team.slug}`;
}

/** waitingOnを現在の責務主体に含まれるGitHubアカウント識別子へ解決する。 */
export function resolveWaitingOnAccountIdentifiers(
  waitingOnValues: readonly WaitingOn[],
  teams: ResolvedRepositoryTeams,
): ReadonlySet<string> {
  const identifiers = new Set<string>();
  const configuredTeams = [...teams.maintainers, ...teams.reviewers];

  for (const waitingOn of waitingOnValues) {
    switch (waitingOn.kind) {
      case "user":
        identifiers.add(waitingOn.candidateId);
        break;
      case "team": {
        const candidateTeamKey = waitingOn.candidateId.toLowerCase();
        for (const team of configuredTeams) {
          if (createTeamKey(team) !== candidateTeamKey) {
            continue;
          }
          for (const member of team.members) {
            identifiers.add(member.login);
            identifiers.add(member.nodeId);
          }
        }
        break;
      }
      case "role":
      case "item":
      case "automation":
      case "unknown":
        break;
      default:
        throw new UnreachableError(waitingOn.kind);
    }
  }

  return identifiers;
}

function resolveWaitingOnRoleTeams(
  teams: ResolvedRepositoryTeams,
  waitingOn: WaitingOn,
): readonly ResolvedGitHubTeam[] | undefined {
  if (waitingOn.kind !== "role") {
    return undefined;
  }
  if (waitingOn.role === "maintainer") {
    return teams.maintainers;
  }
  if (waitingOn.role === "reviewer") {
    return teams.reviewers;
  }
  if (waitingOn.role === "merge_decider" && waitingOn.candidateId === "maintainer") {
    return teams.maintainers;
  }
  return undefined;
}

/** 抽象的なmaintainerとreviewerのwaitingOnをリポジトリの設定済みteamへ解決する。 */
export function resolveRepositoryRoleWaitingOn(
  teams: ResolvedRepositoryTeams,
  waitingOn: WaitingOn,
): readonly WaitingOn[] {
  const resolvedTeams = resolveWaitingOnRoleTeams(teams, waitingOn);
  if (resolvedTeams == null) {
    return Object.freeze([waitingOn]);
  }
  if (resolvedTeams.length === 0) {
    throw new TypeError(`解決済み${waitingOn.role} teamは1件以上必要です`);
  }

  return Object.freeze(
    resolvedTeams.map((team) =>
      Object.freeze({
        ...waitingOn,
        kind: "team",
        candidateId: teamCandidateId(team),
      } satisfies WaitingOn),
    ),
  );
}
