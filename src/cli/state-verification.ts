import { resolve } from "node:path";

import type { loadConfig } from "../config/index.js";
import { type StatePersistenceConfiguration } from "../persistence/branch-adapter.js";

import type { VerifyStateCliCommand } from "../infrastructure/tracking-run/command-input.js";
import type { StateVerificationResult } from "../infrastructure/tracking-run/state-verification.js";
import { formatStateVerificationResult } from "../infrastructure/tracking-run/state-verification.js";

/** 永続state検証が利用する読み込みと標準出力境界。 */
export type StateVerificationDependencies = Readonly<{
  repositoryPath: string;
  loadConfig: typeof loadConfig;
  verifyStateDirectory: (
    stateDirectory: string,
    timezone: string,
    configuration: StatePersistenceConfiguration,
    stateRevision: string,
  ) => Promise<StateVerificationResult>;
  writeStandardOutput: (source: string) => Promise<void>;
}>;

/** verify-stateサブコマンドを実行する。 */
export class StateVerificationRunner {
  readonly #dependencies: StateVerificationDependencies;

  public constructor(dependencies: StateVerificationDependencies) {
    this.#dependencies = dependencies;
  }

  /** 指定した永続stateを検証し、件数とschema versionを出力する。 */
  public async run(command: VerifyStateCliCommand): Promise<void> {
    const config = await this.#dependencies.loadConfig(
      resolve(this.#dependencies.repositoryPath, command.configPath),
    );
    const result = await this.#dependencies.verifyStateDirectory(
      command.stateDirectory,
      config.staleness.timezone,
      config.state,
      command.stateRevision,
    );
    await this.#dependencies.writeStandardOutput(`${formatStateVerificationResult(result)}\n`);
  }
}
