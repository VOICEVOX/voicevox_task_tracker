import { z } from "zod";

const nonEmptyStringSchema = z.string().min(1).max(1000);
const sha256Schema = z.string().regex(/^sha256:[0-9a-f]{64}$/u);

export const runtimeToolchainIdentitySchema = z.strictObject({
  nodeVersion: nonEmptyStringSchema,
  packageManager: z.literal("pnpm"),
  packageManagerVersion: nonEmptyStringSchema,
  platform: nonEmptyStringSchema,
  architecture: nonEmptyStringSchema,
  buildCommandId: nonEmptyStringSchema,
  buildConfigDigest: sha256Schema,
});

/** 実際にbuildした環境と入力の識別情報。 */
export type RuntimeToolchainIdentity = z.output<typeof runtimeToolchainIdentitySchema>;

export const runtimeIdentitySchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("workflow_bundle"),
    codeRevision: nonEmptyStringSchema,
    bundleSha256: sha256Schema,
    lockfileSha256: sha256Schema,
    toolchain: runtimeToolchainIdentitySchema,
  }),
  z.strictObject({
    kind: z.literal("source_process"),
    codeRevision: nonEmptyStringSchema,
    runtimeManifestSha256: sha256Schema,
    lockfileSha256: sha256Schema,
    toolchain: runtimeToolchainIdentitySchema,
  }),
]);

/** 実行byte列とbuild環境を照合するruntimeの識別情報。 */
export type RuntimeIdentity = z.output<typeof runtimeIdentitySchema>;
