import { type PublicNotificationHistoryDto } from "../../src/pages/public-dto.js";

/** notification-history.jsonを取得する遅延loader。 */
export type PublicNotificationHistoryLoader = () => Promise<PublicNotificationHistoryDto>;

type SharedNotificationHistoryLoaderState =
  | Readonly<{
      status: "empty";
    }>
  | Readonly<{
      status: "loading";
      promise: Promise<PublicNotificationHistoryDto>;
    }>
  | Readonly<{
      status: "loaded";
      history: PublicNotificationHistoryDto;
    }>;

/** notification history DTOの取得結果をページ間で共有するloaderを作る。 */
export function createSharedNotificationHistoryLoader(
  loadNotificationHistory: PublicNotificationHistoryLoader,
): PublicNotificationHistoryLoader {
  let state: SharedNotificationHistoryLoaderState = {
    status: "empty",
  };
  return () => {
    if (state.status === "loading") {
      return state.promise;
    }
    if (state.status === "loaded") {
      return Promise.resolve(state.history);
    }

    let request: Promise<PublicNotificationHistoryDto>;
    try {
      request = loadNotificationHistory();
    } catch (error: unknown) {
      if (error instanceof Error) {
        return Promise.reject(error);
      }
      return Promise.reject(
        new Error("notification history DTOの取得開始時にError以外が投げられました", {
          cause: error,
        }),
      );
    }
    const sharedRequest = request.then(
      (history) => {
        state = {
          status: "loaded",
          history,
        };
        return history;
      },
      (error: unknown) => {
        state = {
          status: "empty",
        };
        throw error;
      },
    );
    state = {
      status: "loading",
      promise: sharedRequest,
    };
    return sharedRequest;
  };
}
