import { type PublicDetailsDto } from "../../src/pages/public-dto.js";

/** details.jsonを検証して返す遅延loader。 */
export type PublicDetailsLoader = () => Promise<PublicDetailsDto>;

type SharedDetailsLoaderState =
  | Readonly<{
      status: "empty";
    }>
  | Readonly<{
      status: "loading";
      promise: Promise<PublicDetailsDto>;
    }>
  | Readonly<{
      status: "loaded";
      details: PublicDetailsDto;
    }>;

/** details DTOの取得結果をページ間で共有するローダーを作る。 */
export function createSharedDetailsLoader(loadDetails: PublicDetailsLoader): PublicDetailsLoader {
  let state: SharedDetailsLoaderState = {
    status: "empty",
  };
  return () => {
    if (state.status === "loading") {
      return state.promise;
    }
    if (state.status === "loaded") {
      return Promise.resolve(state.details);
    }

    let request: Promise<PublicDetailsDto>;
    try {
      request = loadDetails();
    } catch (error: unknown) {
      if (error instanceof Error) {
        return Promise.reject(error);
      }
      return Promise.reject(
        new Error("details DTOの取得開始時にError以外が投げられました", {
          cause: error,
        }),
      );
    }
    const sharedRequest = request.then(
      (details) => {
        state = {
          status: "loaded",
          details,
        };
        return details;
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
