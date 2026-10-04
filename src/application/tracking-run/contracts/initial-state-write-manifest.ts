import { z } from "zod";

const sha256Schema = z.string().regex(/^sha256:[0-9a-f]{64}$/u);
const statePathSchema = z
  .string()
  .regex(/^state(?:\/[A-Za-z0-9._-]+)+$/u)
  .refine((path) => path.split("/").every((segment) => segment !== "." && segment !== ".."));

const writtenFileSchema = z.discriminatedUnion("operation", [
  z.strictObject({
    path: statePathSchema,
    operation: z.literal("created"),
    afterDigest: sha256Schema,
  }),
  z.strictObject({
    path: statePathSchema,
    operation: z.literal("modified"),
    beforeDigest: sha256Schema,
    afterDigest: sha256Schema,
  }),
  z.strictObject({
    path: statePathSchema,
    operation: z.literal("unchanged"),
    beforeDigest: sha256Schema,
    afterDigest: sha256Schema,
  }),
]);

export const initialStateWriteManifestSchema = z.strictObject({
  history: z.strictObject({
    file: writtenFileSchema,
    recordDigest: sha256Schema,
  }),
  aiCache: z.array(writtenFileSchema),
  personalReminderAiCache: z.array(writtenFileSchema),
  deletions: z.array(
    z.strictObject({
      path: statePathSchema,
      beforeDigest: sha256Schema,
    }),
  ),
});

/** 初回commitの履歴、cache、削除対象を固定するmanifest。 */
export type InitialStateWriteManifest = z.output<typeof initialStateWriteManifestSchema>;
