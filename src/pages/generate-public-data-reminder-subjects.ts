import type { PersonalReminderCause } from "../domain/index.js";
import { UnreachableError } from "../util/index.js";
import type {
  PublicCurrentResponseSubjectChangesDto,
  PublicCurrentResponseSubjectDto,
  PublicPersonalReminderResponseDto,
} from "./public-dto-contracts.js";
import { compareStrings } from "./public-dto-primitives.js";

type PublicPersonalReminderResponse = PublicPersonalReminderResponseDto;

export interface PublicCurrentResponseSubjectChangesAccumulator {
  addableSubjects: Map<string, PublicCurrentResponseSubjectDto>;
  removableSubjects: Map<string, PublicCurrentResponseSubjectDto>;
  unbounded: boolean;
}

function publicCurrentResponseSubjectKey(subject: PublicCurrentResponseSubjectDto): string {
  return `${subject.kind}\u0000${subject.candidateId.toLowerCase()}`;
}

function addPublicCurrentResponseSubject(
  accumulator: PublicCurrentResponseSubjectChangesAccumulator,
  change: "addable" | "removable",
  subject: PublicCurrentResponseSubjectDto,
): void {
  const subjects =
    change === "addable" ? accumulator.addableSubjects : accumulator.removableSubjects;
  const key = publicCurrentResponseSubjectKey(subject);
  const existing = subjects.get(key);
  if (existing == null || compareStrings(subject.candidateId, existing.candidateId) < 0) {
    subjects.set(key, subject);
  }
}

/** 応答対象の変更候補を収集する。 */
export function createPublicCurrentResponseSubjectChangesAccumulator(
  changes: PublicCurrentResponseSubjectChangesDto,
): PublicCurrentResponseSubjectChangesAccumulator {
  const accumulator: PublicCurrentResponseSubjectChangesAccumulator = {
    addableSubjects: new Map(),
    removableSubjects: new Map(),
    unbounded: changes.scope === "unbounded",
  };
  if (changes.scope === "unbounded") {
    return accumulator;
  }
  for (const subject of changes.addableSubjects) {
    addPublicCurrentResponseSubject(accumulator, "addable", subject);
  }
  for (const subject of changes.removableSubjects) {
    addPublicCurrentResponseSubject(accumulator, "removable", subject);
  }
  return accumulator;
}

/** 責任者を応答対象の変更候補へ追加する。 */
export function addResponsibleCurrentResponseSubjectChanges(
  accumulator: PublicCurrentResponseSubjectChangesAccumulator,
  change: "addable" | "removable",
  responsibleValues: PersonalReminderCause["responsible"],
): void {
  for (const responsible of responsibleValues) {
    const responsibleKind = responsible.kind;
    switch (responsibleKind) {
      case "user":
      case "team":
        addPublicCurrentResponseSubject(accumulator, change, {
          kind: responsibleKind,
          candidateId: responsible.candidateId,
        });
        break;
      case "role":
        break;
      default:
        throw new UnreachableError(responsibleKind);
    }
  }
}

/** 応答対象の変更候補を公開値へ確定する。 */
export function finalizePublicCurrentResponseSubjectChanges(
  accumulator: PublicCurrentResponseSubjectChangesAccumulator,
  responses: readonly PublicPersonalReminderResponse[],
): PublicCurrentResponseSubjectChangesDto {
  if (accumulator.unbounded) {
    return {
      scope: "unbounded",
    };
  }
  const verifiedSubjectKeys = new Set<string>();
  for (const response of responses) {
    if (response.subjectMembershipUnverified) {
      continue;
    }
    for (const responsible of response.responsible) {
      if (responsible.kind === "role") {
        continue;
      }
      verifiedSubjectKeys.add(
        publicCurrentResponseSubjectKey({
          kind: responsible.kind,
          candidateId: responsible.candidateId,
        }),
      );
    }
  }
  for (const key of verifiedSubjectKeys) {
    accumulator.removableSubjects.delete(key);
  }
  const compareSubjects = (
    left: PublicCurrentResponseSubjectDto,
    right: PublicCurrentResponseSubjectDto,
  ): number =>
    compareStrings(publicCurrentResponseSubjectKey(left), publicCurrentResponseSubjectKey(right));
  return {
    scope: "bounded",
    addableSubjects: [...accumulator.addableSubjects.values()].sort(compareSubjects),
    removableSubjects: [...accumulator.removableSubjects.values()].sort(compareSubjects),
  };
}
