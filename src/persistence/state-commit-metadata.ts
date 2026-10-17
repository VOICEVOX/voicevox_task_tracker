import { createHash } from "node:crypto";

import { z } from "zod";

import { serializeCanonicalJson } from "../canonical-json/value.js";
import { SANDBOX_ENVIRONMENT_MANIFEST_PATH } from "./sandbox-environment-path.js";
import {
  type StateBranchHead,
  type StateFileReadResult,
  type StateFileUpdate,
} from "./branch-adapter-contracts.js";
import { assertValidStatePath } from "./state-path.js";

const sha256Schema = z.string().regex(/^sha256:[0-9a-f]{64}$/u);
const operationIdSchema = z.string().regex(/^operation:v1:[0-9a-f]{64}$/u);
const runIdSchema = z.string().regex(/^tracker-run:[0-9a-f]{64}$/u);
const pathSchema = z.string().min(1);
const createdEntrySchema = z.strictObject({
  path: pathSchema,
  kind: z.literal("created"),
  afterDigest: sha256Schema,
});
const modifiedEntrySchema = z.strictObject({
  path: pathSchema,
  kind: z.literal("modified"),
  beforeDigest: sha256Schema,
  afterDigest: sha256Schema,
});
const deletedEntrySchema = z.strictObject({
  path: pathSchema,
  kind: z.literal("deleted"),
  beforeDigest: sha256Schema,
});
const entrySchema = z.discriminatedUnion("kind", [
  createdEntrySchema,
  modifiedEntrySchema,
  deletedEntrySchema,
]);
const manifestSchema = z.strictObject({
  schemaVersion: z.literal(1),
  entries: z.array(entrySchema),
});
const metadataSchema = z.strictObject({
  schemaVersion: z.literal(1),
  commitScope: z.enum([
    "tracking_run",
    "operations_alert",
    "manual_resolution",
    "sandbox_manifest",
    "production_pages_effect",
  ]),
  operationId: operationIdSchema,
  runId: runIdSchema.optional(),
  changedPathManifestVersion: z.literal(1),
  changedPathManifestDigest: sha256Schema,
});

export const STATE_COMMIT_METADATA_SCHEMA_VERSION_V1 = 1;
export const STATE_CHANGED_PATH_MANIFEST_SCHEMA_VERSION_V1 = 1;
export const MAX_STATE_COMMIT_MESSAGE_BYTES = 16_384;
export const STATE_COMMIT_TRAILER_KEYS_V1 = Object.freeze({
  schemaVersion: "State-Metadata-Version",
  commitScope: "State-Commit-Scope",
  operationId: "State-Operation-Id",
  runId: "State-Run-Id",
  manifestVersion: "State-Changed-Path-Manifest-Version",
  manifestDigest: "State-Changed-Path-Manifest-Digest",
});

/** state commitの変更pathとbyte digest一覧。 */
export type StateChangedPathManifest = z.output<typeof manifestSchema>;
/** state commitへ記録するV1 metadata。 */
export type StateCommitMetadataV1 = z.output<typeof metadataSchema>;
/** state commitの効果範囲。 */
export type StateCommitScope = StateCommitMetadataV1["commitScope"];

/** 追跡stateを変更しないcommit scopeか判定する。 */
export function isOrthogonalStateCommitScope(scope: StateCommitScope): boolean {
  return scope === "operations_alert" || scope === "sandbox_manifest";
}
/** commitのscopeと公開識別子。 */
export type StateCommitIdentity = Readonly<{
  commitScope: StateCommitScope;
  operationId: string;
  runId?: string;
}>;

/** state commitの論理識別子を公開可能な入力から作る。 */
export function createStateCommitOperationId(value: unknown): string {
  const digest = digestBytes(new TextEncoder().encode(serializeCanonicalJson(value)));
  return `operation:v1:${digest.slice("sha256:".length)}`;
}

/** 同じ親とstate変更からcommitの公開識別子を作る。 */
export function createStateCommitIdentity(
  commitScope: StateCommitIdentity["commitScope"],
  runId: string | undefined,
  parent: StateBranchHead,
  message: string,
  updates: readonly StateFileUpdate[],
  deletions: readonly string[],
): StateCommitIdentity {
  const operationId = createStateCommitOperationId({
    commitScope,
    runId: runId ?? null,
    parent,
    message,
    updates: updates.map((update) => ({ path: update.path, digest: digestBytes(update.bytes) })),
    deletions,
  });
  return Object.freeze({ commitScope, operationId, ...(runId == null ? {} : { runId }) });
}

function digestBytes(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

/** canonical JSONのSHA-256を計算する。 */
export function digestStateManifest(manifest: StateChangedPathManifest): string {
  return digestBytes(new TextEncoder().encode(serializeCanonicalJson(manifest)));
}

/** 親treeと候補treeの同じpathから変更manifestを作る。 */
export function createStateChangedPathManifest(
  before: ReadonlyMap<string, StateFileReadResult>,
  after: ReadonlyMap<string, StateFileReadResult>,
): StateChangedPathManifest {
  const paths = [...new Set([...before.keys(), ...after.keys()])].sort();
  const entries: StateChangedPathManifest["entries"][number][] = [];
  for (const path of paths) {
    assertValidStatePath(path);
    const oldFile = before.get(path);
    const newFile = after.get(path);
    if (oldFile == null || newFile == null) {
      throw new TypeError("変更manifestの親treeまたは候補treeが不足しています");
    }
    if (oldFile.status === "missing" && newFile.status === "missing") {
      continue;
    }
    if (oldFile.status === "missing") {
      if (newFile.status === "missing") {
        throw new TypeError("変更manifestのfile状態が不正です");
      }
      entries.push({ path, kind: "created", afterDigest: digestBytes(newFile.bytes) });
      continue;
    }
    if (newFile.status === "missing") {
      entries.push({ path, kind: "deleted", beforeDigest: digestBytes(oldFile.bytes) });
      continue;
    }
    const beforeDigest = digestBytes(oldFile.bytes);
    const afterDigest = digestBytes(newFile.bytes);
    if (beforeDigest !== afterDigest) {
      entries.push({ path, kind: "modified", beforeDigest, afterDigest });
    }
  }
  return manifestSchema.parse({ schemaVersion: 1, entries });
}

/** identityとmanifestからcommit metadataを作る。 */
export function createStateCommitMetadata(
  identity: StateCommitIdentity,
  manifest: StateChangedPathManifest,
): StateCommitMetadataV1 {
  if (manifest.entries.length === 0) {
    throw new TypeError("変更のないstate commitは作成できません");
  }
  const metadata = metadataSchema.parse({
    schemaVersion: 1,
    ...identity,
    changedPathManifestVersion: 1,
    changedPathManifestDigest: digestStateManifest(manifest),
  });
  if (metadata.commitScope === "operations_alert") {
    if (manifest.entries.some((entry) => entry.path !== "state/operations-alert-ledger-v1.json")) {
      throw new TypeError("運用障害通知commitに直交しないpathがあります");
    }
  }
  if (
    metadata.commitScope === "sandbox_manifest" &&
    (metadata.runId != null ||
      manifest.entries.length !== 1 ||
      manifest.entries[0]?.path !== SANDBOX_ENVIRONMENT_MANIFEST_PATH ||
      manifest.entries[0].kind !== "modified")
  ) {
    throw new TypeError("sandbox manifest commitの変更範囲が不正です");
  }
  if (
    metadata.commitScope === "production_pages_effect" &&
    (metadata.runId != null ||
      manifest.entries.length !== 1 ||
      manifest.entries[0]?.path !== "state/production-pages-effect-lease-v1.json")
  ) {
    throw new TypeError("production Pages lease commitの変更範囲が不正です");
  }
  return metadata;
}

/** V1 metadataを機械parseできるGit trailerへ変換する。 */
export function serializeStateCommitTrailers(metadata: StateCommitMetadataV1): string {
  const value = metadataSchema.parse(metadata);
  const keys = STATE_COMMIT_TRAILER_KEYS_V1;
  return [
    `${keys.schemaVersion}: 1`,
    `${keys.commitScope}: ${value.commitScope}`,
    `${keys.operationId}: ${value.operationId}`,
    ...(value.runId == null ? [] : [`${keys.runId}: ${value.runId}`]),
    `${keys.manifestVersion}: 1`,
    `${keys.manifestDigest}: ${value.changedPathManifestDigest}`,
  ].join("\n");
}

/** 有界なGit commit message末尾からV1 metadataを読む。 */
export function readStateCommitMetadataBootstrap(message: string): StateCommitMetadataV1 {
  if (new TextEncoder().encode(message).length > MAX_STATE_COMMIT_MESSAGE_BYTES) {
    throw new TypeError("state commit messageが上限を超えています");
  }
  const keys = STATE_COMMIT_TRAILER_KEYS_V1;
  const entries = new Map<string, string>();
  const recognizedKeys = new Set<string>(Object.values(keys));
  const trailerBlock = message.trimEnd().split("\n\n").at(-1);
  for (const line of trailerBlock?.split("\n") ?? []) {
    const match = /^([A-Za-z][A-Za-z-]+): (.+)$/u.exec(line);
    if (match?.[1] == null || match[2] == null) {
      continue;
    }
    if (recognizedKeys.has(match[1])) {
      if (entries.has(match[1])) {
        throw new TypeError("state commit trailerが重複しています");
      }
      entries.set(match[1], match[2]);
    }
  }
  return metadataSchema.parse({
    schemaVersion: Number(entries.get(keys.schemaVersion)),
    commitScope: entries.get(keys.commitScope),
    operationId: entries.get(keys.operationId),
    ...(entries.has(keys.runId) ? { runId: entries.get(keys.runId) } : {}),
    changedPathManifestVersion: Number(entries.get(keys.manifestVersion)),
    changedPathManifestDigest: entries.get(keys.manifestDigest),
  });
}

/** Git commit message末尾のV1 trailerを読む。 */
export function parseStateCommitTrailers(message: string): StateCommitMetadataV1 {
  return readStateCommitMetadataBootstrap(message);
}
