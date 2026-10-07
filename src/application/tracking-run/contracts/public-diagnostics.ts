import { z } from "zod";

export const publicRunDiagnosticsSchema = z.array(z.string().min(1).max(1000));

/** 公開可能なrun診断文を検証する。 */
export function parsePublicRunDiagnostics(value: unknown): readonly string[] {
  return Object.freeze([...publicRunDiagnosticsSchema.parse(value)]);
}
