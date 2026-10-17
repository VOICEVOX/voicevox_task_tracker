import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { z } from "zod";

import type { PagesDeploymentExternalReference } from "../../application/tracking-run/receipt-schema.js";
import { receiptSchema } from "../../application/tracking-run/receipt-schema.js";
import { serializeCanonicalJsonLine } from "../../canonical-json/value.js";
import { assertNonNullable } from "../../util/index.js";
import {
  parsePriorPagesCandidate,
  priorPagesFileNames,
  type PriorPagesCandidate,
} from "./prior-pages-candidate.js";
import type { ProductionRuntimeAdapters } from "./runtime/adapters.js";
import type { SplitStagePaths } from "./split-stage-paths.js";

const artifactSchema = z.strictObject({
  id: z.number().int().positive(),
  name: z.string().min(1),
  workflowRunId: z.number().int().positive(),
});
const pageSchema = artifactSchema.extend({ runAttempt: z.number().int().positive() });
const bindingSchema = z.strictObject({
  phase: z.enum(["initial", "notification_history"]),
  trackingRunId: z.string().regex(/^tracker-run:[0-9a-f]{64}$/u),
  status: z.enum(["no_previous", "downloaded"]),
});
const candidatesSchema = bindingSchema.extend({
  stageArtifacts: z.array(artifactSchema),
  individualArtifacts: z.array(artifactSchema),
  pagesArtifacts: z.array(pageSchema),
  commitWorkflowRunIds: z.array(z.number().int().positive()),
  currentWorkflowRunId: z.number().int().positive(),
  currentRunAttempt: z.number().int().positive(),
});
const selectedSchema = bindingSchema.extend({
  stage: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("absent") }),
    z.strictObject({ kind: z.enum(["unprepared", "prepared"]), artifact: artifactSchema }),
  ]),
  individualArtifact: artifactSchema.nullable(),
  pagesArtifact: pageSchema.nullable(),
});
const outcomeBindingSchema = z.object({
  kind: z.enum(["success", "deployed", "not_required", "failure"]),
  receipt: receiptSchema.options[2].optional(),
  runId: z.string().optional(),
  checkpointDigest: z.string().optional(),
  deploymentIntentDigest: z.string().optional(),
});

type Candidates = z.output<typeof candidatesSchema>;
type Selected = z.output<typeof selectedSchema>;
type Artifact = z.output<typeof artifactSchema>;
type Candidate = Readonly<{
  stageArtifact: Artifact;
  individualArtifact: Artifact | null;
  validated: PriorPagesCandidate;
}>;

function witnessPath(
  adapters: ProductionRuntimeAdapters,
  phase: Selected["phase"],
): string | undefined {
  const prefix = phase === "initial" ? "INITIAL" : "HISTORY";
  return adapters.environment[`VOICEVOX_PRIOR_${prefix}_EVIDENCE_PATH`];
}

function assertBinding(
  witness: Selected | Candidates,
  adapters: ProductionRuntimeAdapters,
  phase: Selected["phase"],
  runId: string,
): void {
  const prefix = phase === "initial" ? "INITIAL" : "HISTORY";
  if (
    witness.phase !== phase ||
    witness.trackingRunId !== runId ||
    witness.status !== adapters.environment[`VOICEVOX_PREVIOUS_${prefix}_OUTCOME_STATUS`]
  ) {
    throw new TypeError("Pages保持artifactの取得状態とrunが一致しません");
  }
}

/** 候補の検証と選択を終えたPagesの取得証拠を読む。 */
export async function readSelectedPriorPagesWitness(
  adapters: ProductionRuntimeAdapters,
  phase: Selected["phase"],
  runId: string,
): Promise<Selected | undefined> {
  const path = witnessPath(adapters, phase);
  if (path == null) return undefined;
  const witness = selectedSchema.parse(JSON.parse(await readFile(`${path}.selected`, "utf8")));
  assertBinding(witness, adapters, phase, runId);
  return witness;
}

async function readFiles(
  root: string,
  phase: Selected["phase"],
  artifact: Artifact,
): Promise<Map<string, Uint8Array>> {
  const files = new Map<string, Uint8Array>();
  for (const filename of priorPagesFileNames(phase)) {
    try {
      files.set(filename, await readFile(join(root, String(artifact.id), filename)));
    } catch (error: unknown) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
  }
  return files;
}

function pagesArtifact(
  reference: PagesDeploymentExternalReference | undefined,
  pages: Candidates["pagesArtifacts"],
): Candidates["pagesArtifacts"][number] | undefined {
  if (reference == null) return undefined;
  let matches;
  if (reference.kind === "github_pages_actions") {
    const actions = reference.actionsArtifact;
    matches = pages.filter((page) =>
      actions.kind === "not_exposed"
        ? page.name === actions.artifactName
        : String(page.id) === actions.artifactId,
    );
  } else if (reference.kind === "recording") {
    matches = pages.filter((page) => `${page.name}:${String(page.id)}` === reference.recordingId);
  } else {
    throw new TypeError("Actionsに保存されたPages候補の公開先参照が不正です");
  }
  if (matches.length > 1)
    throw new TypeError("Pages候補のActions artifact参照が一意ではありません");
  return matches[0];
}

function selectCandidate(candidates: readonly Candidate[]): Candidate | undefined {
  let selected: Candidate | undefined;
  let initialStateKey: string | undefined;
  let contentKey: string | undefined;
  let successKey: string | undefined;
  for (const candidate of candidates) {
    const initial = candidate.validated.entries[0]?.receipt;
    if (initial?.receiptType !== "initial_state_commit") {
      throw new TypeError("Pages候補の初回state receiptがありません");
    }
    const key = serializeCanonicalJsonLine({
      binding: initial.binding,
      revision: initial.result.resultingStateRevision,
    });
    if (initialStateKey != null && initialStateKey !== key) {
      throw new TypeError("保存時点ごとのPages候補のcheckpointと初回stateが一致しません");
    }
    initialStateKey = key;
    const { content, publication } = candidate.validated;
    if (content.kind === "prepared") {
      if (contentKey != null && contentKey !== content.key) {
        throw new TypeError("保存時点ごとのPages候補のrun、revision、contentが一致しません");
      }
      contentKey = content.key;
    }
    if (publication.kind === "succeeded") {
      if (successKey != null && successKey !== publication.successKey) {
        throw new TypeError("保存済みPages候補に異なる成功結果があります");
      }
      successKey = publication.successKey;
    }
    const current = selected?.validated.publication;
    if (
      selected == null ||
      (publication.kind === "succeeded" && current?.kind !== "succeeded") ||
      (publication.kind === current?.kind &&
        (candidate.validated.entries.length > selected.validated.entries.length ||
          (candidate.validated.entries.length === selected.validated.entries.length &&
            candidate.stageArtifact.id > selected.stageArtifact.id))) ||
      (publication.kind === "no_effect" && current?.kind === "unrecorded")
    ) {
      selected = candidate;
    }
  }
  return selected;
}

function assertPagesStarts(
  witness: Candidates,
  candidates: readonly Candidate[],
  selected: Candidate | undefined,
): Candidates["pagesArtifacts"][number] | undefined {
  const publication = selected?.validated.publication;
  const page = pagesArtifact(
    publication?.kind === "succeeded" ? publication.reference : undefined,
    witness.pagesArtifacts,
  );
  const relevantRuns = new Set([
    ...witness.commitWorkflowRunIds,
    ...candidates.map((candidate) => candidate.stageArtifact.workflowRunId),
    ...witness.individualArtifacts.map((artifact) => artifact.workflowRunId),
  ]);
  for (const artifact of witness.pagesArtifacts) {
    const current =
      artifact.workflowRunId === witness.currentWorkflowRunId &&
      artifact.runAttempt === witness.currentRunAttempt;
    if (current && publication?.kind === "succeeded" && artifact.id !== page?.id) {
      throw new TypeError("今回のPages deploy開始と別の保存済み成功結果が競合しています");
    }
    if (relevantRuns.has(artifact.workflowRunId) && !current && artifact.id !== page?.id) {
      throw new TypeError("結果が不明なPages deployの開始証拠があります");
    }
  }
  return page;
}

async function selectPhase(
  adapters: ProductionRuntimeAdapters,
  paths: SplitStagePaths,
  runId: string,
  phase: Selected["phase"],
): Promise<void> {
  const path = witnessPath(adapters, phase);
  if (path == null) return;
  const witness = candidatesSchema.parse(JSON.parse(await readFile(path, "utf8")));
  assertBinding(witness, adapters, phase, runId);
  try {
    const selected = selectedSchema.parse(JSON.parse(await readFile(`${path}.selected`, "utf8")));
    assertBinding(selected, adapters, phase, runId);
    return;
  } catch (error: unknown) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  const root = join(dirname(path), phase);
  const candidates: Candidate[] = [];
  const stageName =
    phase === "initial"
      ? "tracking-stage-initial-pages"
      : "tracking-stage-notification-history-pages";
  for (const artifact of witness.stageArtifacts) {
    if (artifact.name !== stageName) throw new TypeError("Pages候補の段階名が一致しません");
    const files = await readFiles(root, phase, artifact);
    candidates.push({
      stageArtifact: artifact,
      individualArtifact: null,
      validated: parsePriorPagesCandidate(files, phase, runId),
    });
  }
  const outcomeName =
    phase === "initial"
      ? "initial-pages-deployment.json"
      : "notification-history-pages-deployment.json";
  for (const artifact of witness.individualArtifacts) {
    const expectedName =
      phase === "initial"
        ? "initial-pages-deployment-record"
        : "notification-history-pages-deployment-record";
    if (artifact.name !== expectedName)
      throw new TypeError("Pages個別結果のartifact名が一致しません");
    const bytes = await readFile(join(root, String(artifact.id), outcomeName));
    const outcome = outcomeBindingSchema.parse(
      JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
    );
    const stage = candidates.find((candidate) => {
      const content = candidate.validated.content;
      if (content.kind !== "prepared") return false;
      if (outcome.receipt != null)
        return content.buildReceipt.receiptDigest === outcome.receipt.previousReceiptDigest;
      const binding = content.buildReceipt.binding;
      return (
        binding.bindingKind === "checkpoint" &&
        binding.runId === outcome.runId &&
        binding.checkpointDigest === outcome.checkpointDigest &&
        content.buildReceipt.logicalTarget === outcome.deploymentIntentDigest
      );
    });
    assertNonNullable(stage, "Pages個別結果の元buildとchainを復元できません");
    const files = new Map(stage.validated.files);
    files.set(outcomeName, bytes);
    candidates.push({
      stageArtifact: stage.stageArtifact,
      individualArtifact: artifact,
      validated: parsePriorPagesCandidate(files, phase, runId),
    });
  }
  const selected = selectCandidate(candidates);
  const page = assertPagesStarts(witness, candidates, selected);
  const status = candidates.some(
    (candidate) => candidate.validated.publication.kind !== "unrecorded",
  )
    ? "downloaded"
    : "no_previous";
  if (status !== witness.status) throw new TypeError("Pages候補の取得状態と検証結果が一致しません");
  if (selected != null) {
    await mkdir(paths.root, { recursive: true });
    for (const [filename, bytes] of selected.validated.files)
      await writeFile(join(paths.root, filename), bytes);
  }
  await writeFile(
    `${path}.selected`,
    serializeCanonicalJsonLine(
      selectedSchema.parse({
        phase,
        trackingRunId: runId,
        status,
        stage:
          selected == null
            ? { kind: "absent" }
            : { kind: selected.validated.content.kind, artifact: selected.stageArtifact },
        individualArtifact: selected?.individualArtifact ?? null,
        pagesArtifact: page ?? null,
      }),
    ),
  );
}

/** 全保持候補を検証し、同一contentの成功を未実行結果より優先して復元する。 */
export async function selectPriorPagesArtifacts(
  adapters: ProductionRuntimeAdapters,
  paths: SplitStagePaths,
  runId: string,
): Promise<void> {
  await selectPhase(adapters, paths, runId, "initial");
  await selectPhase(adapters, paths, runId, "notification_history");
}
