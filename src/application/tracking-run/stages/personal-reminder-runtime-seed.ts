import { serializeCanonicalJson } from "../../../canonical-json/value.js";
import type { AiAnalysisDependencyInput } from "../../../domain/ai-analysis-dependencies.js";
import type {
  PersonalReminderCause,
  PersonalReminderCauseSeed,
} from "../../../domain/personal-reminder-causes.js";
import type {
  PersonalReminderCauseProjection,
  PersonalReminderCauseSeedOrigin,
} from "../../../domain/personal-reminder-planning.js";
import { createPersonalReminderCauseProjectionSeed } from "../../../domain/personal-reminder-planning.js";
import type { UtcIsoDateTime } from "../../../domain/types.js";
import { UnreachableError, assertNonNullable } from "../../../util/index.js";
import {
  personalReminderDraftIdentity,
  seedAiDependencyInput,
  seedMatchesDraft,
} from "./personal-reminder-runtime-common.js";
import type {
  PersonalReminderRuntimeContextItem,
  PersonalReminderRuntimeCurrentSeed,
} from "./personal-reminder-runtime-contracts.js";

/** 今回の原因seedと前回原因の対応を保持する。 */
export function createRuntimeCurrentSeed(
  input: Readonly<{
    item: PersonalReminderRuntimeContextItem;
    seed: PersonalReminderCauseSeed;
    constructionOrigin: PersonalReminderCauseSeedOrigin;
    projectionKey: string;
    probe: boolean;
  }>,
): PersonalReminderRuntimeCurrentSeed {
  if (
    input.constructionOrigin.seed.causeId !== input.seed.causeId ||
    serializeCanonicalJson(input.constructionOrigin.seed) !== serializeCanonicalJson(input.seed)
  ) {
    throw new TypeError(`seedの生成元とseedが一致しません。対象: ${input.seed.causeId}`);
  }
  const draft =
    input.constructionOrigin.kind === "retained_without_draft"
      ? undefined
      : input.constructionOrigin.draft;
  if (draft != null && !seedMatchesDraft(input.seed, draft)) {
    throw new TypeError(`current seedとdraftが一致しません。対象: ${input.seed.causeId}`);
  }
  let previousCause: PersonalReminderCause | undefined;
  switch (input.constructionOrigin.kind) {
    case "new_draft":
      previousCause = undefined;
      break;
    case "normal_continuation":
    case "retained_without_draft":
      previousCause = input.constructionOrigin.previousCause;
      break;
    default:
      throw new UnreachableError(input.constructionOrigin);
  }
  return Object.freeze({
    seed: input.seed,
    item: input.item,
    origin: draft == null ? "retained_without_draft" : "current_draft",
    constructionOrigin: input.constructionOrigin,
    draft,
    draftIdentity: draft == null ? undefined : personalReminderDraftIdentity(draft),
    projectionKey: input.projectionKey,
    probe: input.probe,
    previousCause,
  });
}

/** 原因projectionからseedの生成元を取得する。 */
export function seedOriginForProjection(
  projection: PersonalReminderCauseProjection,
  seed: PersonalReminderCauseSeed,
): PersonalReminderCauseSeedOrigin {
  if (projection.draft == null) {
    assertNonNullable(
      projection.previousCause,
      `保持seedのprevious causeがありません。対象: ${seed.causeId}`,
    );
    return Object.freeze({
      kind: "retained_without_draft",
      seed,
      previousCause: projection.previousCause,
    });
  }
  if (projection.previousCause == null) {
    return Object.freeze({ kind: "new_draft", seed, draft: projection.draft });
  }
  return Object.freeze({
    kind: "normal_continuation",
    seed,
    draft: projection.draft,
    previousCause: projection.previousCause,
  });
}

/** 原因seedが正規の生成規則と一致するか検証する。 */
export function assertRuntimeSeedMatchesBuilder(
  currentSeed: PersonalReminderRuntimeCurrentSeed,
  evaluatedAt: UtcIsoDateTime,
): void {
  const origin = currentSeed.constructionOrigin;
  let projection: PersonalReminderCauseProjection;
  switch (origin.kind) {
    case "new_draft":
      projection = Object.freeze({
        key: currentSeed.projectionKey,
        draft: origin.draft,
        previousCause: undefined,
      });
      break;
    case "normal_continuation":
      projection = Object.freeze({
        key: currentSeed.projectionKey,
        draft: origin.draft,
        previousCause: origin.previousCause,
      });
      break;
    case "retained_without_draft":
      projection = Object.freeze({
        key: currentSeed.projectionKey,
        draft: undefined,
        previousCause: origin.previousCause,
      });
      break;
    default:
      throw new UnreachableError(origin);
  }
  const rebuilt = createPersonalReminderCauseProjectionSeed({
    projection,
    currentObservedAt: evaluatedAt,
    clockEventOccurredAtBySourceId: currentSeed.item.clockEventOccurredAtBySourceId,
  });
  if (serializeCanonicalJson(rebuilt) !== serializeCanonicalJson(currentSeed.seed)) {
    throw new TypeError(
      `個人催促cause seedの生成元が一致しません。対象: ${currentSeed.seed.causeId}`,
    );
  }
}

/** 原因seedの各fieldに対するAI依存入力を集める。 */
export function personalReminderCauseSeedAiDependencyInputs(
  currentSeed: PersonalReminderRuntimeCurrentSeed,
): readonly AiAnalysisDependencyInput[] {
  const seed = currentSeed.seed;
  return Object.freeze([
    seedAiDependencyInput(seed.aiDependencies.presence, currentSeed.origin),
    seedAiDependencyInput(seed.aiDependencies.responsible, currentSeed.origin),
    seedAiDependencyInput(seed.aiDependencies.action, currentSeed.origin),
    seedAiDependencyInput(seed.aiDependencies.evidence, currentSeed.origin),
  ]);
}
