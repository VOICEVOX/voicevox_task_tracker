import { CliUsageError } from "../infrastructure/tracking-run/errors.js";
import { assertNonNullable } from "../util/index.js";

/** 重複optionも検出するCLI option集合。 */
export type ParsedOptions = ReadonlyMap<string, readonly string[]>;

/** CLI入力不正を使用方法の例外にする。 */
export function usageError(message: string, cause?: unknown): CliUsageError {
  return new CliUsageError(message, cause == null ? {} : { cause });
}

/** 許可されたoptionだけを値付きで読み取る。 */
export function parseOptions(
  args: readonly string[],
  allowedOptions: ReadonlySet<string>,
): ParsedOptions {
  const values = new Map<string, string[]>();
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    assertNonNullable(name, "CLI option名を取得できませんでした");
    if (!name.startsWith("--") || !allowedOptions.has(name)) {
      throw usageError(`未対応のoptionです。対象: ${name}`);
    }
    if (value == null || value.startsWith("--")) {
      throw usageError(`${name}には値が必要です`);
    }
    const existing = values.get(name) ?? [];
    values.set(name, [...existing, value]);
  }
  return values;
}

/** 一度だけ指定されたoptionまたは既定値を得る。 */
export function singleOption(options: ParsedOptions, name: string, fallback: string): string {
  const values = options.get(name);
  if (values == null) {
    return fallback;
  }
  if (values.length !== 1) {
    throw usageError(`${name}は1回だけ指定してください`);
  }
  const value = values[0];
  assertNonNullable(value, `${name}の値を取得できませんでした`);
  if (value.length === 0) {
    throw usageError(`${name}に空文字は指定できません`);
  }
  return value;
}

/** 一度だけ指定されたoptionを得る。 */
export function optionalSingleOption(options: ParsedOptions, name: string): string | undefined {
  const values = options.get(name);
  if (values == null) {
    return undefined;
  }
  if (values.length !== 1) {
    throw usageError(`${name}は1回だけ指定してください`);
  }
  const value = values[0];
  assertNonNullable(value, `${name}の値を取得できませんでした`);
  if (value.length === 0) {
    throw usageError(`${name}に空文字は指定できません`);
  }
  return value;
}
