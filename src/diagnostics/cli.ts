import { constants } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import { pathToFileURL } from "node:url";

import { z } from "zod";

import { encryptDiagnosticsBundle, decryptDiagnosticsBundle } from "./encrypted-bundle.js";
import { DiagnosticsCliUsageError, DiagnosticsError } from "./errors.js";
import { DIAGNOSTICS_KEY_ENVIRONMENT_VARIABLE } from "./schema.js";

const commandSchema = z.enum(["encrypt", "decrypt"]);
const KEY_FILE_MAX_BYTES = 4 * 1024;
const optionNameSchema = z.enum([
  "--input",
  "--output",
  "--key-file",
  "--run-id",
  "--run-attempt",
  "--job",
  "--invocation-id",
]);

type DiagnosticsCliCommand = z.output<typeof commandSchema>;
type ParsedOptions = ReadonlyMap<string, string>;

function usageError(message: string): DiagnosticsCliUsageError {
  return new DiagnosticsCliUsageError(message, {});
}

function parseOptions(args: readonly string[]): ParsedOptions {
  const options = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    const nameResult = optionNameSchema.safeParse(name);
    if (!nameResult.success) {
      throw usageError(`未対応のoptionです。対象: ${name ?? ""}`);
    }
    if (value == null || value.startsWith("--") || value.length === 0) {
      throw usageError(`${nameResult.data}には値が必要です`);
    }
    if (options.has(nameResult.data)) {
      throw usageError(`${nameResult.data}は1回だけ指定してください`);
    }
    options.set(nameResult.data, value);
  }
  return options;
}

function requiredOption(options: ParsedOptions, name: string): string {
  const value = options.get(name);
  if (value == null || value.length === 0) {
    throw usageError(`${name}には値が必要です`);
  }
  return value;
}

function parsePositiveInteger(value: string, name: string): number {
  const result = z.coerce.number().int().positive().safeParse(value);
  if (!result.success) {
    throw usageError(`${name}には正の整数が必要です`);
  }
  return result.data;
}

function parseCommand(value: string | undefined): DiagnosticsCliCommand {
  const result = commandSchema.safeParse(value);
  if (!result.success) {
    throw usageError("サブコマンドはencryptまたはdecryptにしてください");
  }
  return result.data;
}

function assertNoOptions(options: ParsedOptions, names: readonly string[]): void {
  for (const name of names) {
    if (options.has(name)) {
      throw usageError(`${name}はこのサブコマンドでは使えません`);
    }
  }
}

async function readKeyFileContents(handle: FileHandle): Promise<string> {
  const buffer = Buffer.alloc(KEY_FILE_MAX_BYTES + 1);
  let offset = 0;
  while (offset < buffer.byteLength) {
    const result = await handle.read(buffer, offset, buffer.byteLength - offset, offset);
    if (result.bytesRead === 0) {
      break;
    }
    offset += result.bytesRead;
  }
  if (offset > KEY_FILE_MAX_BYTES) {
    throw new DiagnosticsCliUsageError("key-fileが大きすぎます", {});
  }
  return buffer.subarray(0, offset).toString("utf8").trim();
}

async function closeKeyFileHandleAfterFailure(handle: FileHandle, error: unknown): Promise<never> {
  try {
    await handle.close();
  } catch (closeError: unknown) {
    throw new DiagnosticsCliUsageError("key-fileを閉じられません", {
      cause: new AggregateError([error, closeError], "key-fileの主処理とcloseに失敗しました", {
        cause: error,
      }),
    });
  }
  throw error;
}

async function readKeyFile(path: string): Promise<string> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const statistics = await handle.stat();
    if (!statistics.isFile() || statistics.isSymbolicLink()) {
      throw new DiagnosticsCliUsageError("key-fileは通常ファイルにしてください", {});
    }
    if ((statistics.mode & 0o777) !== 0o600) {
      throw new DiagnosticsCliUsageError("key-fileの権限は600にしてください", {});
    }
    if (statistics.size > KEY_FILE_MAX_BYTES) {
      throw new DiagnosticsCliUsageError("key-fileが大きすぎます", {});
    }
    const contents = await readKeyFileContents(handle);
    await handle.close();
    handle = undefined;
    return contents;
  } catch (error: unknown) {
    if (handle != null) {
      return await closeKeyFileHandleAfterFailure(handle, error);
    }
    if (error instanceof DiagnosticsCliUsageError) {
      throw error;
    }
    throw new DiagnosticsCliUsageError("key-fileを読み取れません", { cause: error });
  }
}

async function executeEncrypt(
  options: ParsedOptions,
  environment: NodeJS.ProcessEnv,
): Promise<void> {
  assertNoOptions(options, ["--key-file"]);
  const keyBase64 = environment[DIAGNOSTICS_KEY_ENVIRONMENT_VARIABLE];
  if (keyBase64 == null || keyBase64.length === 0) {
    throw usageError(`${DIAGNOSTICS_KEY_ENVIRONMENT_VARIABLE}が必要です`);
  }
  await encryptDiagnosticsBundle({
    inputPath: requiredOption(options, "--input"),
    outputPath: requiredOption(options, "--output"),
    keyBase64,
    runId: requiredOption(options, "--run-id"),
    runAttempt: parsePositiveInteger(requiredOption(options, "--run-attempt"), "--run-attempt"),
    job: requiredOption(options, "--job"),
    invocationId: requiredOption(options, "--invocation-id"),
  });
}

async function executeDecrypt(options: ParsedOptions): Promise<void> {
  assertNoOptions(options, ["--run-id", "--run-attempt", "--job", "--invocation-id"]);
  const keyFile = requiredOption(options, "--key-file");
  const keyBase64 = await readKeyFile(keyFile);
  await decryptDiagnosticsBundle({
    inputPath: requiredOption(options, "--input"),
    outputPath: requiredOption(options, "--output"),
    keyBase64,
  });
}

/** diagnostics暗号化または復号CLIを実行する。 */
export async function runDiagnosticsCli(
  args: readonly string[],
  environment: NodeJS.ProcessEnv,
): Promise<number> {
  const command = parseCommand(args[0]);
  const options = parseOptions(args.slice(1));
  if (command === "encrypt") {
    await executeEncrypt(options, environment);
  } else {
    await executeDecrypt(options);
  }
  return 0;
}

function isMainModule(moduleUrl: string, executablePath: string | undefined): boolean {
  return executablePath != null && pathToFileURL(executablePath).href === moduleUrl;
}

function writeCliError(error: unknown): void {
  if (error instanceof DiagnosticsError) {
    process.stderr.write(`${error.message}\n`);
    return;
  }
  process.stderr.write("diagnostics CLIの実行に失敗しました\n");
}

if (isMainModule(import.meta.url, process.argv[1])) {
  try {
    process.exitCode = await runDiagnosticsCli(process.argv.slice(2), process.env);
  } catch (error: unknown) {
    writeCliError(error);
    process.exitCode = 1;
  }
}
