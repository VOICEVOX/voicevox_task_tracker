import {
  calculateStaleness,
  StalenessTimestampRangeError,
  type CalculateStalenessInput,
  type GitHubNodeId,
  type StalenessResult,
} from "../domain/index.js";
import { StalenessReductionError } from "./errors.js";

/** 項目の停滞時間を計算し、時刻範囲違反だけを項目識別付きへ変換する。 */
export function calculateStalenessForItem(
  itemNodeId: GitHubNodeId,
  input: CalculateStalenessInput,
): StalenessResult {
  try {
    return calculateStaleness(input);
  } catch (error: unknown) {
    if (!(error instanceof StalenessTimestampRangeError)) {
      throw error;
    }
    throw new StalenessReductionError(itemNodeId, { cause: error });
  }
}
