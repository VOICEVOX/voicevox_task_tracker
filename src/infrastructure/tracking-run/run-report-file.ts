import { serializeRunReport, type RunReport } from "../../publication/run-report.js";
import { CliOutputError } from "./errors.js";
/** run reportを指定されたwriterへ安全に出力する。 */
export async function writeRunReport(
  path: string,
  report: RunReport,
  write: (path: string, source: string) => Promise<void>,
): Promise<void> {
  try {
    await write(path, serializeRunReport(report));
  } catch (error: unknown) {
    throw new CliOutputError(path, {
      cause: error,
    });
  }
}
