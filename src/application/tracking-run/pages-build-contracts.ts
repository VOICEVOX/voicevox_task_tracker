import { z } from "zod";

import { serializeCanonicalJson } from "../../canonical-json/value.js";
import type { ContentDigestPort } from "./contracts/content-digest-port.js";
import { pagesPublicUrlSchema } from "./receipt-schema.js";

const sha256Schema = z.string().regex(/^sha256:[0-9a-f]{64}$/u);
const revisionSchema = z.string().regex(/^[0-9a-f]{40}$/u);
const relativePathSchema = z
  .string()
  .min(1)
  .refine((path) => {
    const segments = path.split("/");
    return (
      !path.startsWith("/") &&
      !path.includes("\\") &&
      !path.includes("\0") &&
      segments.every((segment) => segment.length > 0 && segment !== "." && segment !== "..")
    );
  });

export const pagesContentManifestSchema = z.strictObject({
  schemaVersion: z.literal(1),
  files: z.array(
    z.strictObject({
      path: relativePathSchema,
      byteLength: z.number().int().nonnegative(),
      sha256: sha256Schema,
    }),
  ),
});

export const pagesDeploymentIntentSchema = z.strictObject({
  schemaVersion: z.literal(1),
  phase: z.enum(["initial", "notification_history"]),
  runId: z.string().regex(/^tracker-run:[0-9a-f]{64}$/u),
  checkpointDigest: sha256Schema,
  recordDigest: sha256Schema,
  sourceStateRevision: revisionSchema,
  snapshotDigest: sha256Schema,
  repositoryAllowlistDigest: sha256Schema,
  outputManifestDigest: sha256Schema,
  pagesContentDigest: sha256Schema,
  outputDirectory: relativePathSchema,
  expectedPageUrl: pagesPublicUrlSchema,
  deploymentIntentDigest: sha256Schema,
});

/** Pagesの実出力を相対pathとbyte列digestで固定した一覧。 */
export type PagesContentManifest = z.output<typeof pagesContentManifestSchema>;

/** Pagesのdeploy対象と正本revisionを固定した指示。 */
export type PagesDeploymentIntent = z.output<typeof pagesDeploymentIntentSchema>;

/** file一覧の重複と順序を照合して内容digestを返す。 */
export function digestPagesContentManifest(
  value: unknown,
  digest: ContentDigestPort,
): Readonly<{
  manifest: PagesContentManifest;
  outputManifestDigest: string;
  pagesContentDigest: string;
}> {
  const manifest = pagesContentManifestSchema.parse(value);
  let previousPath: string | undefined;
  for (const file of manifest.files) {
    if (previousPath != null && file.path <= previousPath) {
      throw new TypeError("Pages出力manifestのpathが重複または昇順ではありません");
    }
    previousPath = file.path;
  }
  if (manifest.files.length === 0) {
    throw new TypeError("Pages出力manifestのpathが空、重複、または昇順ではありません");
  }
  const outputManifestDigest = digest.sha256Utf8(serializeCanonicalJson(manifest));
  return Object.freeze({
    manifest,
    outputManifestDigest,
    pagesContentDigest: digest.sha256Utf8(
      serializeCanonicalJson({ schemaVersion: 1, outputManifestDigest }),
    ),
  });
}

/** Pagesの正本と出力manifestからdeploy指示を作る。 */
export function createPagesDeploymentIntent(
  value: Omit<PagesDeploymentIntent, "schemaVersion" | "deploymentIntentDigest">,
  digest: ContentDigestPort,
): PagesDeploymentIntent {
  const payload = { schemaVersion: 1, ...value };
  return parsePagesDeploymentIntent(
    { ...payload, deploymentIntentDigest: digest.sha256Utf8(serializeCanonicalJson(payload)) },
    digest,
  );
}

/** Pages deploy指示の形式とdigestを照合する。 */
export function parsePagesDeploymentIntent(
  value: unknown,
  digest: ContentDigestPort,
): PagesDeploymentIntent {
  const intent = pagesDeploymentIntentSchema.parse(value);
  const { deploymentIntentDigest, ...payload } = intent;
  if (deploymentIntentDigest !== digest.sha256Utf8(serializeCanonicalJson(payload))) {
    throw new TypeError("Pages deploy指示のdigestが一致しません");
  }
  return intent;
}
