import { z } from "zod";

import type { AiAnalysisElement } from "../domain/ai-analysis-elements.js";
import { verifiedExternalUrls } from "../domain/verified-external-reference.js";
import {
  containsDisallowedAiTextUrl,
  containsUnallowlistedGitHubRepositoryUrl,
} from "../github/private-repository-reference.js";
import type { SchemaValidCodexElementOutput } from "./element-output.js";
import type { CodexOutputValidationIssue } from "./errors.js";
import type { CodexAnalysisInput } from "./input.js";
import type { CodexSemanticValidationIssueCode } from "./semantic-validation-issues.js";

const TARGET_ORGANIZATION = "VOICEVOX";

type TextField = Readonly<{ path: string; value: string }>;
const publicRepositoryAllowlistSchema = z.array(
  z.strictObject({ owner: z.string().min(1), name: z.string().min(1) }),
);
const verifiedExternalReferencesSchema = z.array(
  z.strictObject({
    repositoryFullName: z.string().min(3),
    number: z.number().int().positive(),
    url: z.url(),
  }),
);

function createIssue(
  path: string,
  code: CodexSemanticValidationIssueCode,
  message: string,
): CodexOutputValidationIssue {
  return Object.freeze({ path, code, message });
}

function resultPath(output: SchemaValidCodexElementOutput, element: AiAnalysisElement): string {
  return Object.hasOwn(output, element) ? `/${element}` : `/lockedElements/${element}`;
}

function normalizedUrl(value: string): string | null {
  try {
    const url = new URL(value);
    url.hash = "";
    const normalized = url.toString();
    return normalized.endsWith("/") ? normalized.slice(0, -1) : normalized;
  } catch (error: unknown) {
    if (!(error instanceof TypeError)) {
      throw error;
    }
    return null;
  }
}

function organizationFromUrl(value: string): string | null {
  const normalized = normalizedUrl(value);
  if (normalized == null) {
    return null;
  }
  const url = new URL(normalized);
  if (url.protocol !== "https:" || url.hostname.toLowerCase() !== "github.com") {
    return null;
  }
  const organization = url.pathname.split("/").find((segment) => segment.length > 0);
  return organization ?? null;
}

type TextResult = Readonly<{
  evidence?: readonly Readonly<{ summary: string }>[];
  uncertainties: readonly string[];
}>;

function appendCommonTextFields(result: TextResult, path: string, fields: TextField[]): void {
  if (result.evidence != null) {
    for (const [index, evidence] of result.evidence.entries()) {
      fields.push(
        Object.freeze({
          path: `${path}/evidence/${index.toString()}/summary`,
          value: evidence.summary,
        }),
      );
    }
  }
  for (const [index, uncertainty] of result.uncertainties.entries()) {
    fields.push(
      Object.freeze({
        path: `${path}/uncertainties/${index.toString()}`,
        value: uncertainty,
      }),
    );
  }
}

function collectTextFields(
  output: SchemaValidCodexElementOutput,
  input: CodexAnalysisInput,
): readonly TextField[] {
  const fields: TextField[] = [];
  const nextAction = output.nextAction ?? input.lockedElements.nextAction;
  if (nextAction != null) {
    const path = resultPath(output, "nextAction");
    fields.push(Object.freeze({ path: `${path}/value`, value: nextAction.value }));
    appendCommonTextFields(nextAction, path, fields);
  }
  const waitingOn = output.waitingOn ?? input.lockedElements.waitingOn;
  if (waitingOn != null) {
    const path = resultPath(output, "waitingOn");
    for (const [index, candidate] of waitingOn.value.entries()) {
      fields.push(
        Object.freeze({
          path: `${path}/value/${index.toString()}/reasonSummary`,
          value: candidate.reasonSummary,
        }),
      );
    }
    appendCommonTextFields(waitingOn, path, fields);
  }
  const relations = output.relations ?? input.lockedElements.relations;
  if (relations != null) {
    const path = resultPath(output, "relations");
    for (const [index, candidate] of relations.value.entries()) {
      fields.push(
        Object.freeze({
          path: `${path}/value/${index.toString()}/reasonSummary`,
          value: candidate.reasonSummary,
        }),
      );
    }
    appendCommonTextFields(relations, path, fields);
  }
  const progress = output.progress ?? input.lockedElements.progress;
  if (progress != null) {
    const path = resultPath(output, "progress");
    fields.push(
      Object.freeze({
        path: `${path}/value/reasonSummary`,
        value: progress.value.reasonSummary,
      }),
    );
    appendCommonTextFields(progress, path, fields);
  }
  const importance = output.importance ?? input.lockedElements.importance;
  if (importance != null) {
    const path = resultPath(output, "importance");
    fields.push(
      Object.freeze({ path: `${path}/value/rationale`, value: importance.value.rationale }),
    );
    appendCommonTextFields(importance, path, fields);
  }
  const deadline = output.deadline ?? input.lockedElements.deadline;
  if (deadline != null) {
    const path = resultPath(output, "deadline");
    fields.push(
      Object.freeze({ path: `${path}/value/rationale`, value: deadline.value.rationale }),
    );
    appendCommonTextFields(deadline, path, fields);
  }
  const notification = output.notification ?? input.lockedElements.notification;
  if (notification != null) {
    const path = resultPath(output, "notification");
    fields.push(
      Object.freeze({
        path: `${path}/value/reasonSummary`,
        value: notification.value.reasonSummary,
      }),
    );
    appendCommonTextFields(notification, path, fields);
  }
  const status = output.status ?? input.lockedElements.status;
  if (status != null) {
    appendCommonTextFields(status, resultPath(output, "status"), fields);
  }
  const selfCommitment = output.selfCommitment ?? input.lockedElements.selfCommitment;
  if (selfCommitment != null) {
    const path = resultPath(output, "selfCommitment");
    for (const [index, commitment] of selfCommitment.value.entries()) {
      fields.push(
        Object.freeze({
          path: `${path}/value/${index.toString()}/summary`,
          value: commitment.summary,
        }),
      );
    }
    appendCommonTextFields(selfCommitment, path, fields);
  }
  return Object.freeze(fields);
}

/** Codex出力の自然言語URLを公開集合と入力候補で検証する。 */
export function validateCodexOutputUrls(
  output: SchemaValidCodexElementOutput,
  input: CodexAnalysisInput,
  issues: CodexOutputValidationIssue[],
): void {
  const publicRepositoryAllowlist = publicRepositoryAllowlistSchema.parse(
    input.deterministicSignals["publicRepositoryAllowlist"],
  );
  const verifiedExternalReferences = verifiedExternalReferencesSchema.parse(
    input.deterministicSignals["verifiedExternalReferences"],
  );
  if (verifiedExternalUrls(verifiedExternalReferences) == null) {
    throw new TypeError("Codex入力の検証済み外部参照URLが不正です");
  }
  if (organizationFromUrl(input.item.url)?.toLowerCase() !== TARGET_ORGANIZATION.toLowerCase()) {
    throw new TypeError("Codex入力の対象項目がVOICEVOX Organization内ではありません");
  }
  if (output.item.url !== input.item.url) {
    issues.push(
      createIssue(
        "/item/url",
        "item_url_mismatch",
        "Codex出力の項目URLが入力の対象項目と一致しません",
      ),
    );
  }

  for (const field of collectTextFields(output, input)) {
    if (
      containsUnallowlistedGitHubRepositoryUrl(
        [field.value],
        publicRepositoryAllowlist,
        verifiedExternalReferences,
      )
    ) {
      issues.push(
        createIssue(
          field.path,
          "url_not_allowed",
          "GitHubリポジトリURLは収集済みの公開リポジトリを指してください",
        ),
      );
      continue;
    }
    if (
      containsDisallowedAiTextUrl(
        field.value,
        publicRepositoryAllowlist,
        verifiedExternalReferences,
      )
    ) {
      issues.push(
        createIssue(
          field.path,
          "url_not_allowed",
          "URLはHTTPSの許可済みGitHubリポジトリか外部候補を指してください",
        ),
      );
    }
  }
}
