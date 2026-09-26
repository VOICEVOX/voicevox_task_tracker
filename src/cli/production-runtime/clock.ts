import { createUtcIsoDateTime, type UtcIsoDateTime } from "../../domain/index.js";
import type { ProductionRuntimeAdapters } from "./adapters.js";

export function currentRuntimeTime(
  adapters: Pick<ProductionRuntimeAdapters, "now">,
): UtcIsoDateTime {
  const now = adapters.now();
  if (!Number.isFinite(now.getTime())) {
    throw new TypeError("production runtimeのnowは有効な日時を返してください");
  }
  return createUtcIsoDateTime(now.toISOString());
}
