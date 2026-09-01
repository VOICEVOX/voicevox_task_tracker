import { execFile } from "node:child_process";
import { test } from "node:test";

function importInFreshProcess(moduleUrl: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    execFile(
      process.execPath,
      ["--input-type=module", "--eval", `await import(${JSON.stringify(moduleUrl)})`],
      (error) => {
        if (error != null) {
          reject(new Error("entry moduleのimportに失敗しました", { cause: error }));
          return;
        }
        resolve();
      },
    );
  });
}

void test("CodexとCLIのentry moduleを単独でimportできる", async () => {
  const moduleUrls = [
    new URL("./index.js", import.meta.url).href,
    new URL("./adapter.js", import.meta.url).href,
    new URL("../cli/composition-root.js", import.meta.url).href,
  ];
  for (const moduleUrl of moduleUrls) {
    await importInFreshProcess(moduleUrl);
  }
});
