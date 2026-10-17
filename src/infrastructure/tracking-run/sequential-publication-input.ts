import type { PublicationPlannedRun } from "../../publication/publication-plan-contracts.js";
import type { RunMetrics } from "../../publication/run-report.js";
import type { RunInvocation } from "./run-invocation.js";
import type { RuntimeConfiguration, RuntimeState } from "./runtime/contracts.js";
/** 直列runでcheckpointへ固定する公開前の入力。 */
export type SequentialPublicationInput = Readonly<{
  invocation: RunInvocation;
  configuration: RuntimeConfiguration;
  state: RuntimeState;
  planned: PublicationPlannedRun;
  metrics: RunMetrics;
  status: "success" | "fallback";
  diagnostics: readonly string[];
}>;

/** 結合済みcheckpoint以降の公開段階が使う小さい入力。 */
export type PostCheckpointPublicationContext = Pick<
  SequentialPublicationInput,
  "invocation" | "configuration"
>;
