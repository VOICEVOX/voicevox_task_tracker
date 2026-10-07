import { z } from "zod";

export const initialStateCommitStepSchema = z.enum([
  "value_digests",
  "snapshot_digest",
  "history_digest",
  "ai_cache_digest",
  "personal_cache_digest",
  "ledger_digest",
  "snapshot_normalization",
  "base_state_read",
  "base_state_validation",
  "evidence_closure",
  "history",
  "cache_normalization",
  "ledger_validation",
  "cache_encoding",
  "record_materialization",
  "public_safety",
  "snapshot_encoding",
  "ledger_encoding",
  "record_encoding",
  "files_prepared",
  "candidate_transaction",
  "candidate_content",
  "candidate_snapshot",
  "candidate_public_values",
  "candidate_public_safety",
  "candidate_verified",
  "cas_completed",
  "receipt_observation",
  "receipt_observed",
]);

/** 初回commit内の固定した処理境界だけを観測する。 */
export type InitialStateCommitObserver = (
  step: z.output<typeof initialStateCommitStepSchema>,
) => void;
