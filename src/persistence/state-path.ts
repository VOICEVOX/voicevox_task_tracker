import { StateConfigurationError } from "./errors.js";

const STATE_PATH_PREFIX = "state/";

/** state branch内で利用できる正規化済み相対パスか検証する。 */
export function assertValidStatePath(path: string): void {
  const segments = path.split("/");
  if (
    !path.startsWith(STATE_PATH_PREFIX) ||
    path.endsWith("/") ||
    path.includes("\\") ||
    !/^[A-Za-z0-9._/-]+$/u.test(path) ||
    segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")
  ) {
    throw new StateConfigurationError("state配下の正規化された相対パスが必要です");
  }
}
