import { SANDBOX_ENVIRONMENT_MANIFEST_PATH } from "./sandbox-environment-path.js";
export { SANDBOX_ENVIRONMENT_MANIFEST_PATH } from "./sandbox-environment-path.js";
import { z } from "zod";

import { RUN_TRANSACTION_MARKER_STATE_PATH_V1 } from "../application/tracking-run/contracts/recovery-paths.js";
import { parseRunTransactionMarker } from "../application/tracking-run/run-transaction-marker.js";
import { serializeCanonicalJson } from "../canonical-json/value.js";
import type { StateBranchAdapter, StateBranchCommitInspection } from "./branch-adapter.js";

const revision = z.string().regex(/^[0-9a-f]{40}$|^[0-9a-f]{64}$/u);
const environmentId = z.string().regex(/^env-[1-9][0-9]*-[1-9][0-9]*$/u);
const digest = z.string().regex(/^sha256:[0-9a-f]{64}$/u);
const runId = z.string().regex(/^tracker-run:[0-9a-f]{64}$/u);
const sourceRef = z.string().min(1);
const base = {
  environmentId,
  sourceRepository: z.literal("Hiroshiba/voicevox_task_tracker"),
  sourceRef,
  seedRevision: revision,
};
const legacy = z.strictObject({ schemaVersion: z.literal(1), ...base });
const owner = z.strictObject({
  actionsRunId: z.string().regex(/^[1-9][0-9]*$/u),
  actionsRunAttempt: z.number().int().positive(),
  codeRevision: revision,
});
const creation = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("create") }),
  z.strictObject({ kind: z.literal("legacy") }),
  z.strictObject({
    kind: z.literal("reset"),
    sourceEnvironmentId: environmentId,
    sourceHeadRevision: revision,
  }),
]);
const preparation = z.strictObject({
  status: z.literal("preparing"),
  owner,
  creation,
});
const ready = z.strictObject({
  status: z.literal("ready"),
  owner,
  creation,
  completion: z.strictObject({
    actionsRunId: z.string().regex(/^[1-9][0-9]*$/u),
    actionsRunAttempt: z.number().int().positive(),
    finalStateRevision: revision,
    trackingRunId: runId,
    resultDigest: digest,
    coverage: z.discriminatedUnion("kind", [
      z.strictObject({ kind: z.literal("verified"), digest }),
      z.strictObject({ kind: z.literal("not_required") }),
    ]),
  }),
});
const current = z.union([
  z.strictObject({ schemaVersion: z.literal(2), ...base, lifecycle: preparation }),
  z.strictObject({ schemaVersion: z.literal(2), ...base, lifecycle: ready }),
]);

/** sandbox環境の現行manifest。 */
export type SandboxEnvironmentManifest = z.output<typeof current>;

/** 旧manifestをreadyとして読み、現行manifestを検証する。 */
export function parseSandboxEnvironmentManifest(
  source: string,
):
  | SandboxEnvironmentManifest
  | Readonly<z.output<typeof legacy> & { lifecycle: { status: "ready" } }> {
  const value: unknown = JSON.parse(source);
  const previous = legacy.safeParse(value);
  if (previous.success) {
    if (`${serializeCanonicalJson(previous.data)}\n` !== source) {
      throw new TypeError("旧sandbox environment manifestがcanonical JSONではありません");
    }
    return { ...previous.data, lifecycle: { status: "ready" } };
  }
  const manifest = current.parse(value);
  if (`${serializeCanonicalJson(manifest)}\n` !== source) {
    throw new TypeError("sandbox environment manifestがcanonical JSONではありません");
  }
  return manifest;
}

/** manifestだけのcommitでpreparingからreadyへ遷移したことを検証する。 */
export async function assertSandboxManifestCommit(
  adapter: StateBranchAdapter,
  commit: StateBranchCommitInspection,
): Promise<void> {
  if (
    commit.metadata.commitScope !== "sandbox_manifest" ||
    commit.metadata.runId != null ||
    commit.parent.status !== "present" ||
    commit.changedPathManifest.entries.length !== 1 ||
    commit.changedPathManifest.entries[0]?.path !== SANDBOX_ENVIRONMENT_MANIFEST_PATH ||
    commit.changedPathManifest.entries[0].kind !== "modified"
  ) {
    throw new TypeError("sandbox manifest commitの範囲が不正です");
  }
  const [beforeFile, afterFile] = await Promise.all([
    adapter.readFile(commit.parent.revision, SANDBOX_ENVIRONMENT_MANIFEST_PATH),
    adapter.readFile(commit.revision, SANDBOX_ENVIRONMENT_MANIFEST_PATH),
  ]);
  if (beforeFile.status !== "present" || afterFile.status !== "present") {
    throw new TypeError("sandbox manifest commitの前後にmanifestがありません");
  }
  const decode = (bytes: Uint8Array): string =>
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const before = parseSandboxEnvironmentManifest(decode(beforeFile.bytes));
  const after = parseSandboxEnvironmentManifest(decode(afterFile.bytes));
  if (after.schemaVersion !== 2 || after.lifecycle.status !== "ready") {
    throw new TypeError("sandbox manifest commitの版が不正です");
  }
  if (
    after.lifecycle.completion.finalStateRevision !== commit.parent.revision ||
    before.environmentId !== after.environmentId ||
    before.sourceRef !== after.sourceRef ||
    before.seedRevision !== after.seedRevision ||
    (before.schemaVersion === 2
      ? before.lifecycle.status !== "preparing" ||
        serializeCanonicalJson(before.lifecycle.owner) !==
          serializeCanonicalJson(after.lifecycle.owner) ||
        serializeCanonicalJson(before.lifecycle.creation) !==
          serializeCanonicalJson(after.lifecycle.creation)
      : after.lifecycle.creation.kind !== "legacy")
  ) {
    throw new TypeError("sandbox manifestのready遷移が不正です");
  }
  const markerFile = await adapter.readFile(
    commit.parent.revision,
    RUN_TRANSACTION_MARKER_STATE_PATH_V1,
  );
  if (markerFile.status !== "present") {
    throw new TypeError("sandbox manifest昇格元にrun markerがありません");
  }
  const marker = parseRunTransactionMarker(JSON.parse(decode(markerFile.bytes)));
  if (
    marker.phase !== "run_finalized" ||
    marker.runId !== after.lifecycle.completion.trackingRunId
  ) {
    throw new TypeError("sandbox manifestの完了runがmarkerと一致しません");
  }
}
