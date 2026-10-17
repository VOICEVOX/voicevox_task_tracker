import { serializeCanonicalJson } from "../../../canonical-json/value.js";
import type {
  AiAnalysisDependency,
  AiAnalysisDependencyInput,
} from "../../../domain/ai-analysis-dependencies.js";
import { combineReconciledAiAnalysisDependencies } from "../../../domain/ai-analysis-dependencies.js";
import type {
  PersonalReminderCause,
  PersonalReminderCauseId,
  PersonalReminderCauseSetSubjectChanges,
  PersonalReminderSubject,
} from "../../../domain/personal-reminder-causes.js";
import { personalReminderCauseSeedSchema } from "../../../domain/personal-reminder-causes.js";
import type {
  PersonalReminderCauseDraft,
  PersonalReminderCauseProjection,
} from "../../../domain/personal-reminder-planning.js";
import {
  createPersonalReminderCauseDraft,
  createPersonalReminderCauseProjectionSeed,
  determineStructurallyEndedPersonalReminderCauses,
  enumeratePersonalReminderCauseProjections,
  personalReminderCauseAiDependenciesForDecision,
  reconcilePersonalReminderCauseSeeds,
} from "../../../domain/personal-reminder-planning.js";
import type { SourceId } from "../../../domain/source-id.js";
import type { Evidence, GitHubNodeId, GraphNodeId } from "../../../domain/types.js";
import { assertNonNullable } from "../../../util/index.js";
import {
  createCauseSemanticProjection,
  createCauseSourceEvidence,
  createGlobalItemContextIndex,
} from "./personal-reminder-runtime-semantic-projection.js";
import {
  assertRuntimeSeedMatchesBuilder,
  createRuntimeCurrentSeed,
  personalReminderCauseSeedAiDependencyInputs,
  seedOriginForProjection,
} from "./personal-reminder-runtime-seed.js";
import {
  aiAnalysisDependencyIsUnverified,
  combineCauseSetAiDependency,
  compareStrings,
  createCauseSetSubjectChanges,
  currentAiDependencyInput,
  personalReminderDraftIdentity,
  retainedAiDependencyInput,
  seedAiDependencyInput,
  seedMatchesDraft,
} from "./personal-reminder-runtime-common.js";
import { addRuntimeSource } from "./personal-reminder-runtime-source-projection.js";
import type {
  PersonalReminderCauseContinuityConflict,
  PersonalReminderCauseNewDraftIdCollision,
  PersonalReminderCauseRuntimePlan,
  PersonalReminderCauseRuntimePlanEntry,
  PersonalReminderCauseSemanticProjection,
  PersonalReminderRuntimeCauseSetSubjectChangeInput,
  PersonalReminderRuntimeContext,
  PersonalReminderRuntimeCurrentSeed,
  PersonalReminderRuntimeDraftedItem,
  PersonalReminderRuntimePlanningIndexes,
  PersonalReminderRuntimeReconciledItem,
  PersonalReminderRuntimeSource,
} from "./personal-reminder-runtime-contracts.js";
import {
  pendingResponseMembershipDependencyInputs,
  responseMembershipAssessmentRequirement,
  sameResponsibleValues,
} from "./personal-reminder-runtime-duplicate-options.js";
import {
  assertNewDraftIdCollisionPreviousCauses,
  deterministicAssessment,
  previousCauseById,
} from "./personal-reminder-runtime-options.js";
import { graphDerivedDrafts } from "./personal-reminder-runtime-graph-drafts.js";
import { negativeCandidateDependenciesForIssue } from "./personal-reminder-runtime-negative-candidates.js";
import { createPersonalReminderPlanningIndexes } from "./personal-reminder-runtime-relations.js";

/** fresh itemのcause候補をgraphと前回causeへreconcileする。 */
export function planPersonalReminderCauses(
  context: PersonalReminderRuntimeContext,
): PersonalReminderCauseRuntimePlan {
  const entries: PersonalReminderCauseRuntimePlanEntry[] = [];
  const preservedCauses: PersonalReminderCause[] = [];
  const preservedEvidenceByNodeId = new Map<GitHubNodeId, readonly Evidence[]>();
  const continuityConflicts: PersonalReminderCauseContinuityConflict[] = [];
  const endedCauseIds = new Set<PersonalReminderCauseId>();
  const pendingCauseIds = new Set<PersonalReminderCauseId>();
  const incompleteInputNodeIds = new Set<GitHubNodeId>();
  const unrecordedDependencyNodeIds = new Set<GitHubNodeId>();
  const causeSetAiDependencyInputsByNodeId = new Map<GitHubNodeId, AiAnalysisDependencyInput[]>();
  const causeSetSubjectChangeInputsByNodeId = new Map<
    GitHubNodeId,
    PersonalReminderRuntimeCauseSetSubjectChangeInput
  >();
  const reconciledItems: PersonalReminderRuntimeReconciledItem[] = [];
  const newDraftIdCollisionsByNodeId = new Map<
    GitHubNodeId,
    PersonalReminderCauseNewDraftIdCollision
  >();
  const globalSourcesById = new Map<SourceId, PersonalReminderRuntimeSource>();
  const globalItemContextsByNodeId = createGlobalItemContextIndex(context);
  for (const item of context.items) {
    for (const source of item.sources) {
      addRuntimeSource(globalSourcesById, source);
    }
  }
  const globalCausalSourcesByNodeId = new Map<GraphNodeId, PersonalReminderRuntimeSource[]>();
  for (const source of globalSourcesById.values()) {
    if (!source.causalPush) {
      continue;
    }
    const sources = globalCausalSourcesByNodeId.get(source.source.itemNodeId);
    if (sources == null) {
      globalCausalSourcesByNodeId.set(source.source.itemNodeId, [source]);
    } else {
      sources.push(source);
    }
  }
  const globalSources = globalSourcesById;
  const draftedItems: PersonalReminderRuntimeDraftedItem[] = [];
  for (const item of context.items) {
    const previous = item.previous;
    if (item.stale) {
      for (const cause of previous.causes) {
        preservedCauses.push(cause);
      }
      const evidence = context.state.previousEvidenceByNodeId.get(item.item.nodeId);
      if (evidence != null) {
        preservedEvidenceByNodeId.set(item.item.nodeId, evidence);
      }
      continue;
    }
    const localDrafts: PersonalReminderCauseDraft[] = [];
    for (const responsibility of item.responsibilities) {
      const draft = createPersonalReminderCauseDraft(
        item.item,
        item.localDecision,
        responsibility,
        item.aiAnalysisApplications,
      );
      if ("status" in draft) {
        continue;
      }
      localDrafts.push(draft);
    }
    const graphDraftProjection = graphDerivedDrafts(context, item, localDrafts);
    const negativeCandidateDependencies = negativeCandidateDependenciesForIssue(
      context,
      item,
      localDrafts,
      graphDraftProjection.drafts,
    );
    const drafts = [...localDrafts, ...graphDraftProjection.drafts];
    draftedItems.push(
      Object.freeze({
        item,
        drafts: Object.freeze(drafts),
        negativeCandidateDependencies,
      }),
    );
  }
  const draftedItemsByNodeId = new Map(
    draftedItems.map((draftedItem) => [draftedItem.item.item.nodeId, draftedItem]),
  );

  const projectionsByNodeId = new Map<GitHubNodeId, readonly PersonalReminderCauseProjection[]>();
  for (const draftedItem of draftedItems) {
    const projections = enumeratePersonalReminderCauseProjections({
      item: draftedItem.item.item,
      drafts: draftedItem.drafts,
      previous: draftedItem.item.previous,
    });
    projectionsByNodeId.set(draftedItem.item.item.nodeId, projections);
  }

  const initialStructuralEndedByNodeId = new Map<
    GitHubNodeId,
    readonly PersonalReminderCauseId[]
  >();
  for (const draftedItem of draftedItems) {
    const structurallyEnded = determineStructurallyEndedPersonalReminderCauses({
      item: draftedItem.item.item,
      previous: draftedItem.item.previous,
      currentDrafts: draftedItem.drafts,
      successorDrafts: draftedItem.drafts,
      currentDecisionStatus: draftedItem.item.localDecision.status,
      complete: draftedItem.item.completeness.status === "complete",
      currentReviewRequestTargets: draftedItem.item.currentReviewRequestTargets,
      executionSurfaceStates: draftedItem.item.executionSurfaceStates,
    });
    initialStructuralEndedByNodeId.set(
      draftedItem.item.item.nodeId,
      Object.freeze(structurallyEnded),
    );
  }

  const confirmedEndedByNodeId = new Map<GitHubNodeId, Set<PersonalReminderCauseId>>(
    [...initialStructuralEndedByNodeId].map(([nodeId, causeIds]) => [nodeId, new Set(causeIds)]),
  );
  const deferredStructuralEndNodeIds = new Set<GitHubNodeId>();
  let stableSemanticProjectionsByCauseId = new Map<
    PersonalReminderCauseId,
    PersonalReminderCauseSemanticProjection
  >();
  let stablePlanningIndexes: PersonalReminderRuntimePlanningIndexes | undefined;
  let stableContinuityConflicts: readonly PersonalReminderCauseContinuityConflict[] = [];
  let stableReconciledItems: PersonalReminderRuntimeReconciledItem[] = [];
  const initialEndedCauseCount = [...confirmedEndedByNodeId.values()].reduce(
    (count, causeIds) => count + causeIds.size,
    0,
  );
  const maximumRounds = initialEndedCauseCount + 1;
  for (let round = 1; round <= maximumRounds; round += 1) {
    const roundReconciledItems: PersonalReminderRuntimeReconciledItem[] = [];
    const roundContinuityConflicts: PersonalReminderCauseContinuityConflict[] = [];
    const provisionalConflictNodeIds = new Set<GitHubNodeId>();
    for (const draftedItem of draftedItems) {
      const item = draftedItem.item;
      const previous = item.previous;
      const confirmedEnded = confirmedEndedByNodeId.get(item.item.nodeId) ?? new Set();
      const storedCollision = newDraftIdCollisionsByNodeId.get(item.item.nodeId);
      let reconciliation: ReturnType<typeof reconcilePersonalReminderCauseSeeds>;
      if (storedCollision != null) {
        assertNewDraftIdCollisionPreviousCauses(item, storedCollision);
        reconciliation = storedCollision;
      } else {
        reconciliation = reconcilePersonalReminderCauseSeeds({
          item: item.item,
          drafts: draftedItem.drafts,
          previous,
          currentObservedAt: context.evaluatedAt,
          clockEventOccurredAtBySourceId: item.clockEventOccurredAtBySourceId,
          confirmedEndedCauseIds: confirmedEnded,
        });
        if (
          reconciliation.status === "continuity_conflict" &&
          reconciliation.reason === "new_draft_id_collision"
        ) {
          assertNewDraftIdCollisionPreviousCauses(item, reconciliation);
          newDraftIdCollisionsByNodeId.set(item.item.nodeId, reconciliation);
        }
      }
      if (reconciliation.status === "continuity_conflict") {
        provisionalConflictNodeIds.add(item.item.nodeId);
        roundContinuityConflicts.push(
          Object.freeze({
            itemNodeId: reconciliation.itemNodeId,
            previousCauseIds: reconciliation.previousCauseIds,
          }),
        );
        continue;
      }
      for (const endedCauseId of reconciliation.endedCauseIds) {
        if (!confirmedEnded.has(endedCauseId)) {
          throw new TypeError(`reconcileのended cause IDが終了集合外です。対象: ${endedCauseId}`);
        }
      }
      roundReconciledItems.push(
        Object.freeze({
          item,
          previousById: previousCauseById(previous),
          reconciliation,
        }),
      );
    }
    const removedByConflict = new Set<PersonalReminderCauseId>();
    for (const nodeId of provisionalConflictNodeIds) {
      const causeIds = confirmedEndedByNodeId.get(nodeId);
      if (causeIds == null) {
        continue;
      }
      for (const causeId of causeIds) {
        removedByConflict.add(causeId);
      }
      causeIds.clear();
      deferredStructuralEndNodeIds.add(nodeId);
    }
    if (removedByConflict.size !== 0) {
      if (round >= maximumRounds) {
        throw new RangeError("個人催促causeの構造終了確認roundが上限を超えました");
      }
      continue;
    }

    const roundCurrentSeeds: PersonalReminderRuntimeCurrentSeed[] = [];
    for (const reconciled of roundReconciledItems) {
      const draftedItem = draftedItemsByNodeId.get(reconciled.item.item.nodeId);
      assertNonNullable(
        draftedItem,
        `個人催促原因draftの項目がありません。対象: ${reconciled.item.item.nodeId}`,
      );
      const seedOriginsByCauseId = new Map(
        reconciled.reconciliation.seedOrigins.map((origin) => [origin.seed.causeId, origin]),
      );
      for (const seed of reconciled.reconciliation.seeds) {
        const constructionOrigin = seedOriginsByCauseId.get(seed.causeId);
        assertNonNullable(
          constructionOrigin,
          `個人催促cause seedの生成元がありません。対象: ${seed.causeId}`,
        );
        const matchingDrafts =
          constructionOrigin.kind === "retained_without_draft"
            ? []
            : draftedItem.drafts.filter((draft) => seedMatchesDraft(seed, draft));
        if (matchingDrafts.length > 1) {
          throw new TypeError(`current seedに対応するdraftが重複しています。対象: ${seed.causeId}`);
        }
        const currentSeed = createRuntimeCurrentSeed({
          item: reconciled.item,
          seed,
          constructionOrigin,
          projectionKey: `${seed.causeId}:member`,
          probe: false,
        });
        assertRuntimeSeedMatchesBuilder(currentSeed, context.evaluatedAt);
        roundCurrentSeeds.push(currentSeed);
      }
    }
    roundCurrentSeeds.sort((left, right) => compareStrings(left.seed.causeId, right.seed.causeId));
    const roundPlanningIndexes = createPersonalReminderPlanningIndexes(context, roundCurrentSeeds);
    const roundSemanticProjectionsByCauseId = new Map<
      PersonalReminderCauseId,
      PersonalReminderCauseSemanticProjection
    >();
    const completeDraftIdentitiesByNodeId = new Map<GitHubNodeId, Set<string>>();
    let hasIncompleteRoundInput = false;
    for (const reconciled of roundReconciledItems) {
      const draftedItem = draftedItems.find(
        (value) => value.item.item.nodeId === reconciled.item.item.nodeId,
      );
      assertNonNullable(
        draftedItem,
        `個人催促原因draftの項目がありません。対象: ${reconciled.item.item.nodeId}`,
      );
      const itemSeeds = roundCurrentSeeds.filter(
        (currentSeed) => currentSeed.item.item.nodeId === reconciled.item.item.nodeId,
      );
      for (const currentSeed of itemSeeds) {
        const semanticProjection = createCauseSemanticProjection({
          context,
          item: reconciled.item,
          globalSourcesById: globalSources,
          globalCausalSourcesByNodeId,
          globalItemContextsByNodeId,
          seed: currentSeed.seed,
          currentSeed,
          currentSeeds: roundCurrentSeeds,
          planningIndexes: roundPlanningIndexes,
        });
        if (roundSemanticProjectionsByCauseId.has(currentSeed.seed.causeId)) {
          throw new TypeError(
            `current seedのsemantic projectionが重複しています。対象: ${currentSeed.seed.causeId}`,
          );
        }
        roundSemanticProjectionsByCauseId.set(currentSeed.seed.causeId, semanticProjection);
        if (
          currentSeed.draftIdentity != null &&
          semanticProjection.semanticInput.completeness.status === "complete"
        ) {
          const completeDraftIdentities =
            completeDraftIdentitiesByNodeId.get(currentSeed.item.item.nodeId) ?? new Set();
          completeDraftIdentities.add(currentSeed.draftIdentity);
          completeDraftIdentitiesByNodeId.set(
            currentSeed.item.item.nodeId,
            completeDraftIdentities,
          );
        }
        if (semanticProjection.semanticInput.completeness.status === "incomplete") {
          hasIncompleteRoundInput = true;
        }
      }
      if (reconciled.reconciliation.seeds.length === 0 && draftedItem.drafts.length !== 0) {
        throw new TypeError(
          `個人催促原因draftがseedへ投影されていません。対象: ${reconciled.item.item.nodeId}`,
        );
      }
    }
    if (hasIncompleteRoundInput) {
      for (const value of roundReconciledItems) {
        if (
          roundCurrentSeeds.some(
            (currentSeed) =>
              currentSeed.item.item.nodeId === value.item.item.nodeId &&
              roundSemanticProjectionsByCauseId.get(currentSeed.seed.causeId)?.semanticInput
                .completeness.status === "incomplete",
          )
        ) {
          incompleteInputNodeIds.add(value.item.item.nodeId);
        }
      }
    }

    const invalidEndedCauseIds = new Set<PersonalReminderCauseId>();
    for (const draftedItem of draftedItems) {
      const itemNodeId = draftedItem.item.item.nodeId;
      const endedCauseIdsForItem = confirmedEndedByNodeId.get(itemNodeId) ?? new Set();
      if (endedCauseIdsForItem.size === 0) {
        continue;
      }
      const itemReconciled = roundReconciledItems.find(
        (value) => value.item.item.nodeId === itemNodeId,
      );
      if (itemReconciled == null) {
        continue;
      }
      const verifiedSuccessorDrafts = draftedItem.drafts.filter((draft) => {
        const identity = personalReminderDraftIdentity(draft);
        return (completeDraftIdentitiesByNodeId.get(itemNodeId) ?? new Set()).has(identity);
      });
      const projections = projectionsByNodeId.get(itemNodeId);
      assertNonNullable(projections, `個人催促原因の投影候補がありません。対象: ${itemNodeId}`);
      for (const causeId of endedCauseIdsForItem) {
        const matchingProjections: readonly PersonalReminderCauseProjection[] = projections.filter(
          (projection) => projection.previousCause?.causeId === causeId,
        );
        const previousCauseForProbe = draftedItem.item.previous.causes.find(
          (cause) => cause.causeId === causeId,
        );
        assertNonNullable(
          previousCauseForProbe,
          `終了probeのprevious causeがありません。対象: ${causeId}`,
        );
        const matchedDraftIdentities = new Set(
          matchingProjections.flatMap((projection) =>
            projection.draft == null ? [] : [personalReminderDraftIdentity(projection.draft)],
          ),
        );
        const continuationProbeProjections = draftedItem.drafts
          .filter(
            (draft) =>
              draft.action.kind === previousCauseForProbe.action.kind &&
              sameResponsibleValues(draft.responsible, previousCauseForProbe.responsible) &&
              !matchedDraftIdentities.has(personalReminderDraftIdentity(draft)),
          )
          .map((draft) =>
            Object.freeze({
              key: `ended:${causeId}:${personalReminderDraftIdentity(draft)}`,
              draft,
              previousCause: previousCauseForProbe,
            }),
          );
        const probeProjections: readonly PersonalReminderCauseProjection[] = [
          ...matchingProjections,
          ...continuationProbeProjections,
          ...(matchingProjections.length === 0 && continuationProbeProjections.length === 0
            ? [
                Object.freeze({
                  key: `ended:${causeId}`,
                  draft: undefined,
                  previousCause: previousCauseForProbe,
                }),
              ]
            : []),
        ];
        let causeHasIncompleteProbe = false;
        const draftIdentities = new Set<string>();
        for (const projection of probeProjections) {
          const probeSeed = createPersonalReminderCauseProjectionSeed({
            projection,
            currentObservedAt: context.evaluatedAt,
            clockEventOccurredAtBySourceId: draftedItem.item.clockEventOccurredAtBySourceId,
          });
          const probeCurrentSeed = createRuntimeCurrentSeed({
            item: draftedItem.item,
            seed: probeSeed,
            constructionOrigin: seedOriginForProjection(projection, probeSeed),
            projectionKey: projection.key,
            probe: true,
          });
          assertRuntimeSeedMatchesBuilder(probeCurrentSeed, context.evaluatedAt);
          const probeSemanticProjection = createCauseSemanticProjection({
            context,
            item: draftedItem.item,
            globalSourcesById: globalSources,
            globalCausalSourcesByNodeId,
            globalItemContextsByNodeId,
            seed: probeCurrentSeed.seed,
            currentSeed: probeCurrentSeed,
            currentSeeds: roundCurrentSeeds,
            planningIndexes: roundPlanningIndexes,
          });
          if (probeSemanticProjection.semanticInput.completeness.status === "incomplete") {
            causeHasIncompleteProbe = true;
          }
          if (projection.draft != null) {
            draftIdentities.add(personalReminderDraftIdentity(projection.draft));
          }
        }
        const missingDraftIdentity = [...draftIdentities].some(
          (identity) =>
            !(completeDraftIdentitiesByNodeId.get(itemNodeId) ?? new Set()).has(identity),
        );
        const structurallyEnded = determineStructurallyEndedPersonalReminderCauses({
          item: draftedItem.item.item,
          previous: Object.freeze({
            observedAt: draftedItem.item.previous.observedAt,
            causes: Object.freeze(
              draftedItem.item.previous.causes.filter((cause) => cause.causeId === causeId),
            ),
          }),
          currentDrafts: draftedItem.drafts,
          successorDrafts: verifiedSuccessorDrafts,
          currentDecisionStatus: draftedItem.item.localDecision.status,
          complete: draftedItem.item.completeness.status === "complete",
          currentReviewRequestTargets: draftedItem.item.currentReviewRequestTargets,
          executionSurfaceStates: draftedItem.item.executionSurfaceStates,
        });
        if (
          causeHasIncompleteProbe ||
          missingDraftIdentity ||
          !structurallyEnded.includes(causeId)
        ) {
          invalidEndedCauseIds.add(causeId);
          if (
            causeHasIncompleteProbe ||
            missingDraftIdentity ||
            incompleteInputNodeIds.has(itemNodeId)
          ) {
            deferredStructuralEndNodeIds.add(itemNodeId);
            incompleteInputNodeIds.add(itemNodeId);
          }
        }
      }
    }
    if (invalidEndedCauseIds.size !== 0) {
      let removed = false;
      for (const [nodeId, causeIds] of confirmedEndedByNodeId) {
        for (const causeId of invalidEndedCauseIds) {
          if (causeIds.delete(causeId)) {
            removed = true;
          }
        }
        if (causeIds.size === 0) {
          confirmedEndedByNodeId.set(nodeId, causeIds);
        }
      }
      if (!removed) {
        throw new TypeError("構造終了causeを終了集合へ再追加できません");
      }
      if (round >= maximumRounds) {
        throw new RangeError("個人催促causeの構造終了確認roundが上限を超えました");
      }
      continue;
    }

    stableReconciledItems = roundReconciledItems;
    stablePlanningIndexes = roundPlanningIndexes;
    stableSemanticProjectionsByCauseId = roundSemanticProjectionsByCauseId;
    stableContinuityConflicts = Object.freeze(roundContinuityConflicts);
    break;
  }
  if (stablePlanningIndexes == null) {
    throw new RangeError("個人催促causeの構造終了確認roundが上限を超えました");
  }

  const planningIndexes = stablePlanningIndexes;
  assertNonNullable(planningIndexes, "個人催促causeの安定round planning indexがありません");
  reconciledItems.push(...stableReconciledItems);
  continuityConflicts.push(...stableContinuityConflicts);
  for (const reconciled of stableReconciledItems) {
    for (const causeId of reconciled.reconciliation.endedCauseIds) {
      endedCauseIds.add(causeId);
    }
  }
  for (const reconciled of reconciledItems) {
    const draftedItem = draftedItems.find(
      (value) => value.item.item.nodeId === reconciled.item.item.nodeId,
    );
    assertNonNullable(
      draftedItem,
      `個人催促原因draftの項目がありません。対象: ${reconciled.item.item.nodeId}`,
    );
    const causeSetDependencies = draftedItem.negativeCandidateDependencies.flatMap(
      (candidate) => candidate.inputs,
    );
    const presenceInputs: AiAnalysisDependencyInput[] = [];
    const negativeCandidateSubjects = draftedItem.negativeCandidateDependencies.map((candidate) =>
      Object.freeze({
        subject: candidate.subject,
        dependency: combineReconciledAiAnalysisDependencies(
          candidate.inputs,
          context.aiDependencyContext,
        ),
      }),
    );
    const negativeCandidateSubjectCount = negativeCandidateSubjects.filter(
      (candidate) => candidate.dependency.status !== "not_dependent",
    ).length;
    const addableSubjects = negativeCandidateSubjects
      .filter((candidate) => aiAnalysisDependencyIsUnverified(candidate.dependency))
      .map((candidate) => candidate.subject);
    const removableSubjects: PersonalReminderSubject[] = [];
    let subjectChangesUnbounded = false;
    for (const seed of reconciled.reconciliation.seeds) {
      const previousCause = reconciled.previousById.get(seed.causeId);
      const presenceInput = reconciled.reconciliation.retainedWithoutDraftCauseIds.includes(
        seed.causeId,
      )
        ? (() => {
            assertNonNullable(
              previousCause,
              `保持した前回causeがありません。対象: ${seed.causeId}`,
            );
            return retainedAiDependencyInput(previousCause.aiDependencies.presence);
          })()
        : currentAiDependencyInput(seed.aiDependencies.presence);
      causeSetDependencies.push(presenceInput);
      presenceInputs.push(presenceInput);
      const presenceDependency = combineReconciledAiAnalysisDependencies(
        [presenceInput],
        context.aiDependencyContext,
      );
      if (!aiAnalysisDependencyIsUnverified(presenceDependency)) {
        continue;
      }
      for (const responsible of seed.responsible) {
        if (responsible.kind === "role") {
          continue;
        }
        removableSubjects.push(
          Object.freeze({
            kind: responsible.kind,
            candidateId: responsible.candidateId,
          }),
        );
      }
    }
    if (reconciled.reconciliation.seeds.length === 0) {
      const fallbackPresenceDependency = personalReminderCauseAiDependenciesForDecision(
        reconciled.item.item.nodeId,
        reconciled.item.localDecision,
        reconciled.item.aiAnalysisApplications,
      ).presence;
      const fallbackPresenceInput = currentAiDependencyInput(fallbackPresenceDependency);
      causeSetDependencies.push(fallbackPresenceInput);
      presenceInputs.push(fallbackPresenceInput);
      if (aiAnalysisDependencyIsUnverified(fallbackPresenceDependency)) {
        subjectChangesUnbounded = true;
      }
    }
    causeSetAiDependencyInputsByNodeId.set(reconciled.item.item.nodeId, causeSetDependencies);
    causeSetSubjectChangeInputsByNodeId.set(
      reconciled.item.item.nodeId,
      Object.freeze({
        addableSubjects: Object.freeze(addableSubjects),
        removableSubjects: Object.freeze(removableSubjects),
        presenceInputs: Object.freeze(presenceInputs),
        negativeCandidateSubjectCount,
        unbounded: subjectChangesUnbounded,
      }),
    );
  }

  for (const reconciled of reconciledItems) {
    const item = reconciled.item;
    for (const seed of reconciled.reconciliation.seeds) {
      const currentSeed = planningIndexes.currentSeedByCauseId.get(seed.causeId);
      assertNonNullable(currentSeed, `current seedがありません。対象: ${seed.causeId}`);
      const semanticProjection = stableSemanticProjectionsByCauseId.get(seed.causeId);
      assertNonNullable(
        semanticProjection,
        `安定roundのsemantic projectionがありません。対象: ${seed.causeId}`,
      );
      if (semanticProjection.currentSeed !== currentSeed) {
        throw new TypeError(`安定roundのcurrent seedが一致しません。対象: ${seed.causeId}`);
      }
      const {
        relationEdges,
        pendingRelations,
        waitingProjection,
        duplicateProjection,
        activityProjection,
        semanticInput,
      } = semanticProjection;
      if (
        serializeCanonicalJson([
          seed.causeId,
          seed.itemNodeId,
          seed.reasonCode,
          seed.responsible,
          seed.responsibility,
          seed.action,
        ]) !==
        serializeCanonicalJson([
          semanticInput.cause.causeId,
          semanticInput.cause.itemNodeId,
          semanticInput.cause.reasonCode,
          semanticInput.cause.responsible,
          semanticInput.cause.responsibility,
          semanticInput.cause.action,
        ])
      ) {
        throw new TypeError(
          `個人催促cause seedとsemantic inputが一致しません。対象: ${seed.causeId}`,
        );
      }
      const relationDependencies = relationEdges.map((relation) =>
        currentAiDependencyInput(relation.aiDependency),
      );
      const pendingRelationDependencies = pendingRelations.flatMap((relation) => {
        const candidate = context.graph.candidateRelations.find(
          (value) => value.candidateId === relation.candidateId,
        );
        assertNonNullable(
          candidate,
          `pending relation candidateがありません。対象: ${relation.candidateId}`,
        );
        return [currentAiDependencyInput(candidate.aiDependency)];
      });
      const waitingOptionDependencies = waitingProjection.options.flatMap((option) => {
        const dependency = waitingProjection.aiDependencyInputsByOptionId.get(option.optionId);
        assertNonNullable(
          dependency,
          `waiting optionのAI依存がありません。対象: ${option.optionId}`,
        );
        return dependency;
      });
      const duplicateOptionDependencies = duplicateProjection.options.flatMap((option) => {
        const dependency = duplicateProjection.aiDependencyInputsByCanonicalCauseId.get(
          option.canonicalCauseId,
        );
        assertNonNullable(
          dependency,
          `duplicate optionのAI依存がありません。対象: ${option.canonicalCauseId}`,
        );
        return dependency;
      });
      const pendingMembershipInputs = pendingResponseMembershipDependencyInputs(
        context,
        currentSeed,
        planningIndexes,
      );
      const semanticDependencies = [
        ...relationDependencies,
        ...pendingRelationDependencies,
        ...waitingOptionDependencies,
        ...duplicateOptionDependencies,
      ];
      const membershipAssessmentRequirement = responseMembershipAssessmentRequirement(
        seed,
        duplicateProjection.options,
      );
      const responseMembershipAiDependency = combineReconciledAiAnalysisDependencies(
        [
          currentSeed.origin === "retained_without_draft"
            ? retainedAiDependencyInput(seed.aiDependencies.responseMembership)
            : currentAiDependencyInput(Object.freeze({ status: "not_dependent" })),
          ...(membershipAssessmentRequirement.status === "required"
            ? [
                seedAiDependencyInput(seed.aiDependencies.action, currentSeed.origin),
                seedAiDependencyInput(seed.aiDependencies.evidence, currentSeed.origin),
              ]
            : []),
          ...duplicateOptionDependencies,
          ...pendingMembershipInputs,
        ],
        context.aiDependencyContext,
      );
      const seedWithResponseMembershipDependency = personalReminderCauseSeedSchema.parse({
        ...seed,
        aiDependencies: {
          ...seed.aiDependencies,
          responseMembership: responseMembershipAiDependency,
        },
      });
      const currentInputAiDependency = combineReconciledAiAnalysisDependencies(
        [...personalReminderCauseSeedAiDependencyInputs(currentSeed), ...semanticDependencies],
        context.aiDependencyContext,
      );
      if (
        [
          ...Object.values(seed.aiDependencies),
          responseMembershipAiDependency,
          currentInputAiDependency,
        ].some(
          (dependency) =>
            dependency.status === "unknown" && dependency.reasons.includes("not_recorded"),
        )
      ) {
        unrecordedDependencyNodeIds.add(seed.itemNodeId);
      }
      if (semanticInput.completeness.status === "incomplete") {
        incompleteInputNodeIds.add(item.item.nodeId);
      }
      const sourceEvidence = createCauseSourceEvidence(
        item,
        globalSourcesById,
        semanticInput,
        context.currentEvidenceBySourceId,
        context.state.previousEvidenceBySourceId,
        seed,
      );
      if (pendingRelations.length !== 0) {
        pendingCauseIds.add(seed.causeId);
      }
      entries.push(
        Object.freeze({
          seed: seedWithResponseMembershipDependency,
          responseMembershipAssessmentRequirement: membershipAssessmentRequirement,
          semanticInput,
          deterministicAssessment: deterministicAssessment(
            item,
            seed,
            semanticInput,
            currentSeed.origin,
          ),
          previousCause: currentSeed.previousCause,
          sourceEvidence,
          activity: activityProjection.activity,
          repositoryFullName: item.repositoryFullName,
          currentLabels: item.currentLabels,
          currentInputAiDependency,
        }),
      );
    }
  }
  const causeSetAiDependencyByNodeId = new Map<GitHubNodeId, AiAnalysisDependency>();
  const causeSetSubjectChangesByNodeId = new Map<
    GitHubNodeId,
    PersonalReminderCauseSetSubjectChanges
  >();
  for (const [nodeId, dependencies] of causeSetAiDependencyInputsByNodeId) {
    const subjectChangeInput = causeSetSubjectChangeInputsByNodeId.get(nodeId);
    assertNonNullable(
      subjectChangeInput,
      `個人催促cause集合の主体変化入力がありません。対象: ${nodeId}`,
    );
    const dependency = combineCauseSetAiDependency(
      dependencies,
      subjectChangeInput.presenceInputs,
      context.aiDependencyContext,
    );
    if (dependency.status === "unknown" && dependency.reasons.includes("not_recorded")) {
      unrecordedDependencyNodeIds.add(nodeId);
    }
    causeSetAiDependencyByNodeId.set(nodeId, dependency);
    causeSetSubjectChangesByNodeId.set(
      nodeId,
      createCauseSetSubjectChanges(dependency, subjectChangeInput, context.aiDependencyContext),
    );
  }
  const entryCauseIds = new Set(entries.map((entry) => entry.seed.causeId));
  const stableCauseIds = new Set(planningIndexes.currentSeedByCauseId.keys());
  if (
    entryCauseIds.size !== stableCauseIds.size ||
    [...entryCauseIds].some((causeId) => !stableCauseIds.has(causeId))
  ) {
    throw new TypeError("final entryのcause ID集合が安定roundと一致しません");
  }
  for (const causeId of endedCauseIds) {
    if (entryCauseIds.has(causeId)) {
      throw new TypeError(`終了causeがfinal entryへ残っています。対象: ${causeId}`);
    }
  }
  for (const cause of preservedCauses) {
    if (entryCauseIds.has(cause.causeId)) {
      throw new TypeError(`保持causeがfinal entryと重複しています。対象: ${cause.causeId}`);
    }
  }
  const conflictNodeIds = new Set(continuityConflicts.map((conflict) => conflict.itemNodeId));
  const applicableItemNodeIds = context.items
    .map((item) => item.item.nodeId)
    .filter((nodeId) => !conflictNodeIds.has(nodeId))
    .sort(compareStrings);
  for (let index = 1; index < applicableItemNodeIds.length; index += 1) {
    const nodeId = applicableItemNodeIds[index];
    assertNonNullable(nodeId, "個人催促planの適用項目IDがありません");
    if (nodeId === applicableItemNodeIds[index - 1]) {
      throw new TypeError(`個人催促planの適用項目IDが重複しています。対象: ${nodeId}`);
    }
  }
  return Object.freeze({
    entries: Object.freeze(
      entries.sort((left, right) => compareStrings(left.seed.causeId, right.seed.causeId)),
    ),
    applicableItemNodeIds: Object.freeze(applicableItemNodeIds),
    preservedCauses: Object.freeze(preservedCauses),
    preservedEvidenceByNodeId,
    continuityConflicts: Object.freeze(
      continuityConflicts.sort((left, right) => compareStrings(left.itemNodeId, right.itemNodeId)),
    ),
    endedCauseIds: Object.freeze([...endedCauseIds].sort(compareStrings)),
    pendingCauseIds: Object.freeze([...pendingCauseIds].sort(compareStrings)),
    incompleteInputNodeIds: new Set([...incompleteInputNodeIds].sort(compareStrings)),
    deferredStructuralEndNodeIds: new Set([...deferredStructuralEndNodeIds].sort(compareStrings)),
    unrecordedDependencyNodeIds,
    causeSetAiDependencyByNodeId,
    causeSetSubjectChangesByNodeId,
  });
}
