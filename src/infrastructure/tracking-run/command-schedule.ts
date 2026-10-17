import type { UtcIsoDateTime } from "../../domain/index.js";

/** runの予定時刻を現在時刻または明示値から決める指定。 */
export type CliSchedule =
  | Readonly<{
      kind: "current_time";
    }>
  | Readonly<{
      kind: "specified";
      value: UtcIsoDateTime;
    }>;
