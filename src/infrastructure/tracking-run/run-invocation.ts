import type { RunExecutionPolicy, RunIdentity } from "../../application/tracking-run/request.js";
import type { RunReport } from "../../publication/run-report.js";

/** run内で共通に使う識別情報と実行方針。 */
export type RunInvocation = RunIdentity &
  Readonly<{
    executionPolicy: RunExecutionPolicy;
    commandKind: RunReport["command"];
  }>;
