import { z } from "zod";

import {
  identifierSchema,
  publicEvidenceSchema,
  publicPersonalReminderResponsibleSchema,
  shortStringSchema,
} from "./public-dto-primitives.js";

export const publicCurrentResponseSubjectSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("user"),
    candidateId: identifierSchema,
  }),
  z.strictObject({
    kind: z.literal("team"),
    candidateId: identifierSchema,
  }),
]);
export const publicCurrentResponseSubjectChangesSchema = z.discriminatedUnion("scope", [
  z.strictObject({
    scope: z.literal("bounded"),
    addableSubjects: z.array(publicCurrentResponseSubjectSchema),
    removableSubjects: z.array(publicCurrentResponseSubjectSchema),
  }),
  z.strictObject({
    scope: z.literal("unbounded"),
  }),
]);
export const publicPersonalReminderActionSchema = z.strictObject({
  kind: z.enum(["assessment", "owner", "decision", "review", "revision", "reply", "work", "merge"]),
  summary: shortStringSchema,
});
const publicPersonalReminderUnverifiedValueSchema = z.enum([
  "status",
  "responsible",
  "action",
  "evidence",
  "waitingFor",
]);
export const publicPersonalReminderUnknownReasonSchema = z.enum([
  "input_mismatch",
  "not_evaluated",
  "failed",
  "deferred",
  "incomplete_input",
  "conflicting_evidence",
  "ambiguous_meaning",
]);
export const publicPersonalReminderResponseSchema = z.discriminatedUnion("status", [
  z.strictObject({
    causeId: identifierSchema,
    responsible: z.array(publicPersonalReminderResponsibleSchema).nonempty().max(20),
    action: publicPersonalReminderActionSchema,
    evidence: z.array(publicEvidenceSchema).nonempty(),
    unverifiedValues: z.array(publicPersonalReminderUnverifiedValueSchema).max(5),
    subjectMembershipUnverified: z.boolean(),
    status: z.literal("actionable"),
  }),
  z.strictObject({
    causeId: identifierSchema,
    responsible: z.array(publicPersonalReminderResponsibleSchema).nonempty().max(20),
    action: publicPersonalReminderActionSchema,
    evidence: z.array(publicEvidenceSchema).nonempty(),
    unverifiedValues: z.array(publicPersonalReminderUnverifiedValueSchema).max(5),
    subjectMembershipUnverified: z.boolean(),
    status: z.literal("waiting"),
    waitingFor: z.strictObject({
      itemNodeId: identifierSchema,
      action: shortStringSchema,
    }),
  }),
  z.strictObject({
    causeId: identifierSchema,
    responsible: z.array(publicPersonalReminderResponsibleSchema).nonempty().max(20),
    action: publicPersonalReminderActionSchema,
    evidence: z.array(publicEvidenceSchema).nonempty(),
    unverifiedValues: z.array(publicPersonalReminderUnverifiedValueSchema).max(5),
    subjectMembershipUnverified: z.boolean(),
    status: z.literal("unknown"),
    reason: publicPersonalReminderUnknownReasonSchema,
  }),
]);
export const publicPersonalReminderCausePlanningStatusSchema = z.enum([
  "pending",
  "completed",
  "excluded",
]);
export const repositoryFreshnessSchema = z.discriminatedUnion("status", [
  z.strictObject({
    status: z.literal("fresh"),
  }),
  z.strictObject({
    status: z.literal("stale"),
  }),
]);
