import { type WaitingOn } from "./types.js";
import { assertNonNullable } from "../util/index.js";

/** 既定値とリポジトリ別上書きを持つメンテナ設定。 */
export type MaintainerResolutionSettings = Readonly<{
  defaults: readonly string[];
  repositories: Readonly<Record<string, readonly string[]>>;
}>;

/** リポジトリ別設定を優先してメンテナのGitHub loginを解決する。 */
export function resolveRepositoryMaintainers(
  settings: MaintainerResolutionSettings,
  repositoryFullName: string,
): readonly string[] {
  if (!Object.hasOwn(settings.repositories, repositoryFullName)) {
    return settings.defaults;
  }

  const maintainers = settings.repositories[repositoryFullName];
  assertNonNullable(maintainers, "存在するリポジトリ別メンテナ設定を取得できませんでした");
  return maintainers;
}

function isRepositoryRoleWaitingOn(waitingOn: WaitingOn): boolean {
  if (waitingOn.kind !== "role") {
    return false;
  }
  return (
    waitingOn.role === "maintainer" ||
    waitingOn.role === "reviewer" ||
    (waitingOn.role === "merge_decider" && waitingOn.candidateId === "maintainer")
  );
}

/** 抽象的なリポジトリ責務のwaitingOnをメンテナのGitHub loginへ展開する。 */
export function resolveRepositoryRoleWaitingOn(
  waitingOn: WaitingOn,
  maintainers: readonly string[],
): readonly WaitingOn[] {
  if (!isRepositoryRoleWaitingOn(waitingOn)) {
    return Object.freeze([waitingOn]);
  }

  return Object.freeze(
    maintainers.map((login) =>
      Object.freeze({
        ...waitingOn,
        kind: "user",
        candidateId: login,
      } satisfies WaitingOn),
    ),
  );
}

/** waitingOnから責務を持つGitHubアカウント識別子を取り出す。 */
export function resolveWaitingOnAccountIdentifiers(
  waitingOnValues: readonly WaitingOn[],
): ReadonlySet<string> {
  return new Set(
    waitingOnValues
      .filter((waitingOn) => waitingOn.kind === "user")
      .map((waitingOn) => waitingOn.candidateId),
  );
}
