import { z } from "zod";

export const gitCommitRevisionSchema = z.string().regex(/^[0-9a-f]{40}$/u);

/** Git commitの完全なrevision。 */
export type GitCommitRevision = z.output<typeof gitCommitRevisionSchema>;
