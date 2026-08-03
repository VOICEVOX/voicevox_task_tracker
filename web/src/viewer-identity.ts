import { z } from "zod";

export const VIEWER_IDENTITY_STORAGE_KEY = "voicevox-task-tracker.viewer";

const viewerIdentitySchema = z.strictObject({
  login: z
    .string()
    .min(1)
    .max(39)
    .regex(/^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$/u),
  teamIds: z.array(z.string().min(1).max(512).regex(/^\S+$/u)),
});

export type ViewerIdentity = Readonly<{
  login: string;
  teamIds: readonly string[];
}>;

export type ViewerIdentityState =
  | Readonly<{
      status: "available";
      identity: ViewerIdentity | undefined;
    }>
  | Readonly<{
      status: "unavailable";
    }>;

export type ViewerIdentityStore = Readonly<{
  clear: () => ViewerIdentityState;
  read: () => ViewerIdentityState;
  save: (identity: ViewerIdentity) => ViewerIdentityState;
}>;

/** loginが記憶した閲覧者のものかを大文字小文字を区別せず判定する。 */
export function isViewerLogin(login: string, viewerLogin: string | undefined): boolean {
  return viewerLogin?.toLowerCase() === login.toLowerCase();
}

type StorageAccessResult<Value> =
  | Readonly<{
      status: "available";
      value: Value;
    }>
  | Readonly<{
      status: "unavailable";
    }>;

function unavailableState(): ViewerIdentityState {
  return {
    status: "unavailable",
  };
}

function unavailableStore(): ViewerIdentityStore {
  return {
    clear: unavailableState,
    read: unavailableState,
    save: unavailableState,
  };
}

/** localStorageを使う閲覧者情報ストアを作る。 */
export function createViewerIdentityStore(): ViewerIdentityStore {
  let storage: Storage;
  try {
    storage = window.localStorage;
  } catch (error: unknown) {
    console.warn(
      "localStorageへアクセスできないため、閲覧者情報の記憶機能を無効にしました。",
      error,
    );
    return unavailableStore();
  }

  let available = true;

  function access<Value>(operation: (target: Storage) => Value): StorageAccessResult<Value> {
    if (!available) {
      return {
        status: "unavailable",
      };
    }
    try {
      return {
        status: "available",
        value: operation(storage),
      };
    } catch (error: unknown) {
      available = false;
      console.warn(
        "localStorageへアクセスできないため、閲覧者情報の記憶機能を無効にしました。",
        error,
      );
      return {
        status: "unavailable",
      };
    }
  }

  function discardInvalidValue(error: unknown): ViewerIdentityState {
    console.warn("保存されていた閲覧者情報が不正なため破棄しました。", error);
    const result = access((target) => {
      target.removeItem(VIEWER_IDENTITY_STORAGE_KEY);
    });
    return result.status === "available"
      ? {
          status: "available",
          identity: undefined,
        }
      : unavailableState();
  }

  function read(): ViewerIdentityState {
    const result = access((target) => target.getItem(VIEWER_IDENTITY_STORAGE_KEY));
    if (result.status === "unavailable") {
      return unavailableState();
    }
    if (result.value == null) {
      return {
        status: "available",
        identity: undefined,
      };
    }

    const parseJson: (source: string) => unknown = JSON.parse;
    let parsedValue: unknown;
    try {
      parsedValue = parseJson(result.value);
    } catch (error: unknown) {
      return discardInvalidValue(error);
    }
    const parsedIdentity = viewerIdentitySchema.safeParse(parsedValue);
    if (!parsedIdentity.success) {
      return discardInvalidValue(parsedIdentity.error);
    }
    return {
      status: "available",
      identity: parsedIdentity.data,
    };
  }

  function save(identity: ViewerIdentity): ViewerIdentityState {
    const validatedIdentity = viewerIdentitySchema.parse(identity);
    const result = access((target) => {
      target.setItem(VIEWER_IDENTITY_STORAGE_KEY, JSON.stringify(validatedIdentity));
    });
    return result.status === "available"
      ? {
          status: "available",
          identity: validatedIdentity,
        }
      : unavailableState();
  }

  function clear(): ViewerIdentityState {
    const result = access((target) => {
      target.removeItem(VIEWER_IDENTITY_STORAGE_KEY);
    });
    return result.status === "available"
      ? {
          status: "available",
          identity: undefined,
        }
      : unavailableState();
  }

  return {
    clear,
    read,
    save,
  };
}
