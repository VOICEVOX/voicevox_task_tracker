/** branchが未作成か特定revisionを指すかを表す。 */
export type StateBranchHead =
  | Readonly<{
      status: "missing";
    }>
  | Readonly<{
      status: "present";
      revision: string;
    }>;

/** state branch内のファイル読み取り結果。 */
export type StateFileReadResult =
  | Readonly<{
      status: "missing";
    }>
  | Readonly<{
      status: "present";
      bytes: Uint8Array;
    }>;

/** 一つのcommitで置き換えるstateファイル。 */
export type StateFileUpdate = Readonly<{
  path: string;
  bytes: Uint8Array;
}>;
