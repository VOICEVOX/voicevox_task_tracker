/** 排他実行器が新規実行か重複排除かを示す結果。 */
export type CoordinatedRunResult<Result> = Readonly<{
  execution: "executed" | "deduplicated";
  value: Result;
}>;

/** 同一process内のrunを直列化し、完了済みの同一runを再利用する。 */
export class RunCoordinator<Result> {
  readonly #completed = new Map<string, Result>();
  readonly #inFlight = new Map<string, Promise<Result>>();
  readonly #isCacheable: (result: Result) => boolean;
  #tail: Promise<void> = Promise.resolve();

  public constructor(isCacheable: (result: Result) => boolean) {
    this.#isCacheable = isCacheable;
  }

  /** run IDごとに重複を除きながら全runを直列実行する。 */
  public async runExclusive(
    runId: string,
    operation: () => Promise<Result>,
  ): Promise<CoordinatedRunResult<Result>> {
    if (runId.length === 0) {
      throw new TypeError("run IDは空にできません");
    }
    const completed = this.#completed.get(runId);
    if (completed != null) {
      return Object.freeze({
        execution: "deduplicated",
        value: completed,
      });
    }
    const active = this.#inFlight.get(runId);
    if (active != null) {
      return Object.freeze({
        execution: "deduplicated",
        value: await active,
      });
    }

    const execution = this.#tail.then(operation);
    this.#tail = execution.then(
      () => undefined,
      () => undefined,
    );
    this.#inFlight.set(runId, execution);
    void execution.then(
      (result) => {
        this.#inFlight.delete(runId);
        if (this.#isCacheable(result)) {
          this.#completed.set(runId, result);
        }
      },
      () => {
        this.#inFlight.delete(runId);
      },
    );
    return Object.freeze({
      execution: "executed",
      value: await execution,
    });
  }
}
