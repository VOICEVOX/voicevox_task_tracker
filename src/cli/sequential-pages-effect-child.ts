import { z } from "zod";

import {
  beginSequentialPagesEffectChild,
  prepareSequentialPagesEffectChild,
} from "../infrastructure/tracking-run/sequential-pages-effect-child.js";

const source = process.env["PAGES_EFFECT_PAYLOAD"];
if (source == null) {
  throw new TypeError("Pages childの固定入力がありません");
}
const value: unknown = JSON.parse(source);
const command = z.enum(["prepare", "begin"]).parse(process.env["PAGES_EFFECT_COMMAND"]);
if (command === "prepare") {
  await prepareSequentialPagesEffectChild(process.cwd(), value, process.env);
} else {
  await beginSequentialPagesEffectChild(process.cwd(), value, process.env);
}
