import { z } from "zod";

export const manualExactCommandSchema = z.enum(["select-runtime", "resolve-discord-delivery"]);

/** 固定runtimeの選択と一送達の手動解決を指定する入力。 */
export type ManualExactCommand = z.output<typeof manualExactCommandSchema>;
