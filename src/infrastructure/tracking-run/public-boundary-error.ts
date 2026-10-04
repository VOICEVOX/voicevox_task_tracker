import { RunCompletenessError } from "../../application/tracking-run/stages/run-completeness-error.js";
import { GitHubPublicBoundaryViolationError } from "../../github/errors.js";
import { PagesPublicSafetyError } from "../../pages/errors.js";
import { StatePublicSafetyError } from "../../persistence/errors.js";

/** 原因連鎖から公開境界違反を判定する。 */
export function isPublicBoundaryViolation(error: unknown): boolean {
  const pending: unknown[] = [error];
  const visited = new Set<Error>();
  while (pending.length > 0) {
    const current = pending.pop();
    if (!(current instanceof Error) || visited.has(current)) {
      continue;
    }
    if (
      current instanceof GitHubPublicBoundaryViolationError ||
      current instanceof StatePublicSafetyError ||
      current instanceof PagesPublicSafetyError ||
      (current instanceof RunCompletenessError &&
        (current.code === "private_source" || current.code === "unsafe_public_value"))
    ) {
      return true;
    }
    visited.add(current);
    pending.push(current.cause);
    if (current instanceof AggregateError) {
      const errors: readonly unknown[] = current.errors;
      pending.push(...errors);
    }
  }
  return false;
}
