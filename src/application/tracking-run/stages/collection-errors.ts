import { TaskTrackerError } from "../../../util/task-tracker-error.js";

/** 1 runの関係先展開上限に到達したことを表す。 */
export class CollectionRelationExpansionLimitError extends TaskTrackerError {
  public readonly limit: number;
  public readonly fetchedCount: number;
  public readonly unfetchedCount: number;

  public constructor(
    limit: number,
    fetchedCount: number,
    unfetchedCount: number,
    options: ErrorOptions,
  ) {
    super(
      `1 runの関係先展開上限に到達しました。上限: ${limit.toString()}、取得済み: ${fetchedCount.toString()}、未取得: ${unfetchedCount.toString()}`,
      options,
    );
    this.limit = limit;
    this.fetchedCount = fetchedCount;
    this.unfetchedCount = unfetchedCount;
  }
}
