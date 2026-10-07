import { createHash } from "node:crypto";

import { z } from "zod";

import { GitHubPublicBoundaryViolationError } from "../../github/errors.js";
import type { PrivateRepositoryReferenceFinding } from "../../github/private-repository-reference.js";

const fieldKindSchema = z.enum([
  "items",
  "details",
  "observedItems",
  "repositories",
  "comments",
  "timelineEvents",
  "body",
  "bodyText",
  "title",
  "description",
  "url",
  "htmlUrl",
  "id",
  "repositoryId",
  "owner",
  "name",
]);
const hashSchema = z.string().regex(/^[0-9a-f]{64}$/u);
const encodingStateSchema = z.enum(["valid", "invalid_percent_escape", "invalid_utf8"]);
const diagnosticBaseSchema = z.strictObject({
  path: z.array(
    z.discriminatedUnion("kind", [
      z.strictObject({ kind: z.literal("array_index"), index: z.number().int().nonnegative() }),
      z.strictObject({ kind: z.literal("field"), field: fieldKindSchema }),
      z.strictObject({ kind: z.literal("property"), keyHash: hashSchema }),
    ]),
  ),
  valueHash: hashSchema,
});
const diagnosticSchema = z.discriminatedUnion("reason", [
  diagnosticBaseSchema.extend({
    reason: z.enum([
      "private_repository_id",
      "private_repository_url",
      "private_repository_name",
      "scanner_text_limit",
      "scanner_candidate_characters_limit",
      "scanner_candidate_count_limit",
      "scanner_decode_depth_limit",
      "scanner_markdown_boundary",
    ]),
  }),
  diagnosticBaseSchema.extend({
    reason: z.literal("scanner_invalid_encoding"),
    encoding: z
      .strictObject({
        candidateHash: hashSchema,
        originalCandidateHash: hashSchema,
        decodeDepth: z.number().int().nonnegative().max(4),
        originalEncoding: encodingStateSchema,
        failedEncoding: encodingStateSchema,
        originalContainsEncodedPercent: z.boolean(),
      })
      .refine(
        (encoding) => encoding.originalEncoding !== "valid" || encoding.failedEncoding !== "valid",
        { message: "符号化の停止診断には原文または候補の不正な状態が必要です" },
      ),
  }),
]);
type PublicBoundaryDiagnostic = z.output<typeof diagnosticSchema>;

const diagnostics = new WeakMap<Error, PublicBoundaryDiagnostic>();

function hash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function percentEncodingState(value: string): z.output<typeof encodingStateSchema> {
  try {
    decodeURIComponent(value);
    return "valid";
  } catch (error: unknown) {
    if (!(error instanceof URIError)) throw error;
    return /%(?![0-9a-f]{2})/iu.test(value) ? "invalid_percent_escape" : "invalid_utf8";
  }
}

/** 原文を保持せず暗号化診断用の停止理由を公開境界エラーに結び付ける。 */
export function createPublicBoundaryDiagnosticError(
  finding: PrivateRepositoryReferenceFinding,
): GitHubPublicBoundaryViolationError {
  const path = finding.path.map((segment) => {
    if (typeof segment === "number") {
      return { kind: "array_index" as const, index: segment };
    }
    const field = fieldKindSchema.safeParse(segment);
    return field.success
      ? { kind: "field" as const, field: field.data }
      : { kind: "property" as const, keyHash: hash(segment) };
  });
  const diagnostic = diagnosticSchema.parse({
    reason: finding.reason,
    path,
    valueHash: hash(finding.value),
    ...(finding.reason === "scanner_invalid_encoding"
      ? {
          encoding: {
            candidateHash: hash(finding.scanFailure.candidate),
            originalCandidateHash: hash(finding.scanFailure.originalCandidate),
            decodeDepth: finding.scanFailure.decodeDepth,
            originalEncoding: percentEncodingState(finding.scanFailure.originalCandidate),
            failedEncoding: percentEncodingState(finding.scanFailure.candidate),
            originalContainsEncodedPercent: /%25/iu.test(finding.scanFailure.originalCandidate),
          },
        }
      : {}),
  });
  const error = new GitHubPublicBoundaryViolationError(1);
  diagnostics.set(error, diagnostic);
  return error;
}

/** 原因連鎖にある公開境界の停止理由を暗号化対象の詳細情報へ取り出す。 */
export function publicBoundaryDiagnosticDetails(
  error: unknown,
): Readonly<{ publicBoundary?: readonly PublicBoundaryDiagnostic[] }> {
  const pending: unknown[] = [error];
  const visited = new Set<Error>();
  const found: PublicBoundaryDiagnostic[] = [];
  while (pending.length > 0) {
    const current = pending.pop();
    if (!(current instanceof Error) || visited.has(current)) {
      continue;
    }
    visited.add(current);
    const diagnostic = diagnostics.get(current);
    if (diagnostic != null) {
      found.push(diagnostic);
    }
    pending.push(current.cause);
    if (current instanceof AggregateError) {
      const errors: readonly unknown[] = current.errors;
      pending.push(...errors);
    }
  }
  return found.length === 0 ? {} : { publicBoundary: found };
}
