import { z } from "zod";
import { freezeJsonValue } from "../util/freeze-json-value.js";
import type { PerformanceDetailObserver } from "../application/tracking-run/contracts/performance-detail-observation.js";

import { canonicalJsonPieces } from "../canonical-json/value.js";
import { nodeContentDigestPort as digest } from "../infrastructure/tracking-run/content-digest.js";
import {
  decodeDurablePublicationRecord,
  type DurablePublicationRecord,
} from "../publication/durable-record-schema.js";
import { StateFormatError } from "./errors.js";
import { parseStateHistoryRecords } from "./history.js";
import type { StateHistoryRecord } from "./history-contracts.js";
import {
  parseStateSnapshot as parseSnapshotV21,
  serializeStateSnapshot as serializeSnapshotV21,
  type StateSnapshot as SnapshotV21,
} from "./snapshot-v21.js";
import {
  assertNoPendingPersonalReminderClock,
  parseStateSnapshot as parseSnapshotV22,
  serializeStateSnapshot as serializeSnapshotV22,
  type StateSnapshot as SnapshotV22,
} from "./snapshot-v22.js";
import { createStateSnapshot, type StateSnapshot } from "./snapshot-v23.js";

/** 検証済みsnapshotと保存時のcanonical digest。 */
export type VerifiedStateSnapshotFile = Readonly<{
  snapshot: SnapshotV21 | SnapshotV22 | StateSnapshot;
  digest: string;
}>;

const fileProofsBrand: unique symbol = Symbol("stateFileValidationProofs");

/** 検証済みbyteのschema、canonical、semantic保証だけを保持する。 */
export type StateFileValidationProofs = Readonly<{ [fileProofsBrand]: true }>;

const proofDigests = new WeakMap<StateFileValidationProofs, Map<string, string>>();

/** 未検証byteを含まないfile証明の保管先を作る。 */
export function createStateFileValidationProofs(): StateFileValidationProofs {
  const proofs = Object.freeze({ [fileProofsBrand]: true } satisfies StateFileValidationProofs);
  proofDigests.set(proofs, new Map());
  return proofs;
}

/** 検証済み値のcanonical表現を全文展開せず保存文字列と比較する。 */
export function canonicalStateSourceEquals(source: string, values: Iterable<unknown>): boolean {
  let offset = 0;
  for (const value of values) {
    for (const piece of canonicalJsonPieces(value)) {
      if (!source.startsWith(piece, offset)) return false;
      offset += piece.length;
    }
    if (source[offset] !== "\n") return false;
    offset += 1;
  }
  return offset === source.length;
}

function source(bytes: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
}

function fingerprint(bytes: Uint8Array): string {
  return `${bytes.length.toString()}:${digest.sha256Bytes(bytes)}`;
}

function retainValue<Value>(values: Map<string, Value>, key: string, value: Value): void {
  values.delete(key);
  values.set(key, value);
  if (values.size > 2) {
    const oldest = values.keys().next().value;
    if (oldest == null) throw new TypeError("検証済みfileの保持順序が不正です");
    values.delete(oldest);
  }
}

/** 一つの境界で検証済み値を共有し、各種類の値を二つまで保持する。 */
export class StateFileValidation {
  readonly #proofs: Map<string, string>;
  readonly #observe: PerformanceDetailObserver | undefined;
  readonly #snapshots = new Map<string, VerifiedStateSnapshotFile>();
  readonly #records = new Map<string, DurablePublicationRecord>();
  readonly #histories = new Map<string, readonly StateHistoryRecord[]>();

  public constructor(proofs: StateFileValidationProofs, observe?: PerformanceDetailObserver) {
    this.#observe = observe;
    const digests = proofDigests.get(proofs);
    if (digests == null) throw new TypeError("file検証証明の生成元が不正です");
    this.#proofs = digests;
  }

  /** fresh byteを照合し、保存時のschemaでsnapshotを検証する。 */
  public snapshot(bytes: Uint8Array): VerifiedStateSnapshotFile {
    const key = fingerprint(bytes);
    const cached = this.#snapshots.get(key);
    if (cached != null) {
      this.#observe?.({ step: "state_snapshot_proof_reused", count: 1, bytes: bytes.length });
      return cached;
    }
    const text = source(bytes);
    const provenDigest = this.#proofs.get(`snapshot:${key}`);
    if (provenDigest != null) {
      this.#observe?.({ step: "state_snapshot_proof_reused", count: 1, bytes: bytes.length });
      const parse: (text: string) => StateSnapshot = JSON.parse;
      const snapshot = parse(text);
      freezeJsonValue(snapshot);
      const value = Object.freeze({ snapshot, digest: provenDigest });
      retainValue(this.#snapshots, key, value);
      return value;
    }
    this.#observe?.({ step: "state_snapshot_full_validation", count: 1, bytes: bytes.length });
    const raw: unknown = JSON.parse(text);
    const version = z.object({ schemaVersion: z.string() }).parse(raw).schemaVersion;
    if (version === "21" || version === "22") {
      const snapshot = version === "21" ? parseSnapshotV21(text) : parseSnapshotV22(text);
      const canonical =
        snapshot.schemaVersion === "21"
          ? serializeSnapshotV21(snapshot)
          : serializeSnapshotV22(snapshot);
      if (canonical !== text) {
        throw new StateFormatError("snapshot", {
          cause: new TypeError("旧snapshotがcanonical JSONではありません"),
        });
      }
      return Object.freeze({ snapshot, digest: digest.sha256Utf8(canonical.slice(0, -1)) });
    }
    if (version !== "23") {
      throw new StateFormatError("snapshot", {
        cause: new TypeError("snapshotのschemaVersionは未対応です"),
      });
    }
    const snapshot = createStateSnapshot(raw);
    assertNoPendingPersonalReminderClock(snapshot);
    if (!canonicalStateSourceEquals(text, [snapshot])) {
      throw new StateFormatError("snapshot", {
        cause: new TypeError("snapshotがcanonical JSONではありません"),
      });
    }
    const snapshotDigest = digest.sha256Bytes(bytes.subarray(0, bytes.length - 1));
    freezeJsonValue(snapshot);
    this.#proofs.set(`snapshot:${key}`, snapshotDigest);
    const value = Object.freeze({ snapshot, digest: snapshotDigest });
    retainValue(this.#snapshots, key, value);
    return value;
  }

  /** fresh byteからcanonical recordを完全検証または同じ値へ復元する。 */
  public record(bytes: Uint8Array): DurablePublicationRecord {
    const key = fingerprint(bytes);
    const cached = this.#records.get(key);
    if (cached != null) {
      this.#observe?.({ step: "state_record_proof_reused", count: 1, bytes: bytes.length });
      return cached;
    }
    let record: DurablePublicationRecord;
    if (this.#proofs.get(`record:${key}`) != null) {
      this.#observe?.({ step: "state_record_proof_reused", count: 1, bytes: bytes.length });
      const parse: (text: string) => DurablePublicationRecord = JSON.parse;
      record = parse(source(bytes));
    } else {
      this.#observe?.({ step: "state_record_full_validation", count: 1, bytes: bytes.length });
      record = decodeDurablePublicationRecord(bytes, digest);
      if (canonicalStateSourceEquals(source(bytes), [record])) {
        this.#proofs.set(`record:${key}`, record.recordDigest);
      }
    }
    freezeJsonValue(record);
    retainValue(this.#records, key, record);
    return record;
  }

  /** fresh byteからcanonical履歴を検証または同じ現行recordへ復元する。 */
  public history(bytes: Uint8Array): readonly StateHistoryRecord[] {
    const key = fingerprint(bytes);
    const cached = this.#histories.get(key);
    if (cached != null) {
      this.#observe?.({ step: "state_history_proof_reused", count: 1, bytes: bytes.length });
      return cached;
    }
    const text = source(bytes);
    let records: readonly StateHistoryRecord[];
    if (this.#proofs.get(`history:${key}`) != null) {
      this.#observe?.({ step: "state_history_proof_reused", count: 1, bytes: bytes.length });
      const parse: (text: string) => StateHistoryRecord = JSON.parse;
      records = text.length === 0 ? [] : text.slice(0, -1).split("\n").map(parse);
    } else {
      this.#observe?.({ step: "state_history_full_validation", count: 1, bytes: bytes.length });
      records = parseStateHistoryRecords(text);
      if (!canonicalStateSourceEquals(text, records)) {
        throw new TypeError("履歴fileがcanonical JSON Linesではありません");
      }
      this.#proofs.set(`history:${key}`, digest.sha256Bytes(bytes));
    }
    freezeJsonValue(records);
    retainValue(this.#histories, key, records);
    return records;
  }
}
