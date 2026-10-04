import { z } from "zod";

import type { ContentDigestPort } from "../../application/tracking-run/contracts/content-digest-port.js";
import {
  serializeCanonicalJson,
  serializeCanonicalJsonBounded,
} from "../../canonical-json/value.js";
import type { PublicationArtifact } from "./publication-checkpoint-schema.js";

export const MAX_CHECKPOINT_FRAME_BYTES = 32 * 1024 * 1024;
export const MAX_CHECKPOINT_TOTAL_UNCOMPRESSED_BYTES = 512 * 1024 * 1024;
const MAX_CHECKPOINT_FRAME_COUNT = 1024;

/** gzip frameを作成して上限付きで展開する境界。 */
export type CheckpointCompressionPort = Readonly<{
  compress: (value: Uint8Array) => Uint8Array;
  decompress: (value: Uint8Array, maxOutputLength: number) => Uint8Array;
}>;

type CheckpointFrameMetadata = PublicationArtifact["logical"]["frames"][number];
type FrameNode = Readonly<{ kind: "frame"; index: number }>;
type ObjectNode = Readonly<{
  kind: "object";
  fields: readonly (readonly [string, CheckpointNode])[];
}>;
type ArrayFramePart = Readonly<{ kind: "frame"; index: number; start: number; count: number }>;
type ArrayItemPart = Readonly<{ kind: "item"; index: number; node: CheckpointNode }>;
type ArrayNode = Readonly<{
  kind: "array";
  count: number;
  parts: readonly (ArrayFramePart | ArrayItemPart)[];
}>;
export type CheckpointNode = FrameNode | ObjectNode | ArrayNode;

/** 論理値を上限付きのcanonical JSON部分値とgzip frameへ分ける。 */
export function createCheckpointFrameEncoder(
  digest: ContentDigestPort,
  compression: CheckpointCompressionPort,
): Readonly<{
  encode: (value: unknown) => CheckpointNode;
  frames: readonly CheckpointFrameMetadata[];
  compressedFrames: readonly Uint8Array[];
}> {
  const frames: CheckpointFrameMetadata[] = [];
  const compressedFrames: Uint8Array[] = [];
  const encoder = new TextEncoder();
  let totalUncompressedBytes = 0;

  function appendFrame(source: string): number {
    const bytes = encoder.encode(source);
    if (bytes.length === 0 || bytes.length > MAX_CHECKPOINT_FRAME_BYTES) {
      throw new TypeError("checkpoint frameの非圧縮byte数が上限を超えています");
    }
    totalUncompressedBytes += bytes.length;
    if (
      totalUncompressedBytes > MAX_CHECKPOINT_TOTAL_UNCOMPRESSED_BYTES ||
      frames.length >= MAX_CHECKPOINT_FRAME_COUNT
    ) {
      throw new TypeError("checkpointの非圧縮byte数またはframe数が上限を超えています");
    }
    const index = frames.length;
    frames.push({
      index,
      uncompressedByteLength: bytes.length,
      contentDigest: digest.sha256Bytes(bytes),
    });
    compressedFrames.push(compression.compress(bytes));
    return index;
  }

  function encode(value: unknown): CheckpointNode {
    const source = serializeCanonicalJsonBounded(value, MAX_CHECKPOINT_FRAME_BYTES);
    if (source != null) return { kind: "frame", index: appendFrame(source) };
    if (Array.isArray(value)) {
      const parts: (ArrayFramePart | ArrayItemPart)[] = [];
      let items: string[] = [];
      let chunkBytes = 2;
      let start = 0;
      function flush(): void {
        if (items.length === 0) return;
        parts.push({
          kind: "frame",
          index: appendFrame(`[${items.join(",")}]`),
          start,
          count: items.length,
        });
        start += items.length;
        items = [];
        chunkBytes = 2;
      }
      for (const [index, item] of value.entries()) {
        const itemSource = serializeCanonicalJsonBounded(item, MAX_CHECKPOINT_FRAME_BYTES - 2);
        if (itemSource == null) {
          flush();
          parts.push({ kind: "item", index, node: encode(item) });
          start = index + 1;
          continue;
        }
        const itemBytes = encoder.encode(itemSource).length;
        if (chunkBytes + itemBytes + (items.length === 0 ? 0 : 1) > MAX_CHECKPOINT_FRAME_BYTES)
          flush();
        items.push(itemSource);
        chunkBytes += itemBytes + (items.length === 1 ? 0 : 1);
      }
      flush();
      return { kind: "array", count: value.length, parts };
    }
    if (value != null && typeof value === "object") {
      const fields: [string, CheckpointNode][] = [];
      for (const [key, child] of Object.entries(value).sort(([left], [right]) =>
        left < right ? -1 : left > right ? 1 : 0,
      )) {
        if (key === "__proto__") throw new TypeError("checkpointのobject keyが不正です");
        fields.push([key, encode(child)]);
      }
      return { kind: "object", fields };
    }
    throw new TypeError("checkpointの単一JSON値がframe上限を超えています");
  }

  return { encode, frames, compressedFrames };
}

const frameNodeSchema = z.strictObject({
  kind: z.literal("frame"),
  index: z.number().int().nonnegative(),
});
const objectNodeSchema = z.strictObject({
  kind: z.literal("object"),
  fields: z.array(z.tuple([z.string(), z.unknown()])),
});
const arrayNodeSchema = z.strictObject({
  kind: z.literal("array"),
  count: z.number().int().nonnegative(),
  parts: z.array(
    z.union([
      z.strictObject({
        kind: z.literal("frame"),
        index: z.number().int().nonnegative(),
        start: z.number().int().nonnegative(),
        count: z.number().int().positive(),
      }),
      z.strictObject({
        kind: z.literal("item"),
        index: z.number().int().nonnegative(),
        node: z.unknown(),
      }),
    ]),
  ),
});

/** frame順序、件数、canonical値を検証して論理値を復元する。 */
export function decodeCheckpointFrames(
  roots: readonly unknown[],
  metadata: readonly CheckpointFrameMetadata[],
  compressedFrames: readonly Uint8Array[],
  digest: ContentDigestPort,
  compression: CheckpointCompressionPort,
): readonly unknown[] {
  let nextFrame = 0;
  let totalUncompressedBytes = 0;
  const decoder = new TextDecoder("utf-8", { fatal: true });

  function frame(index: number): unknown {
    if (index !== nextFrame) throw new TypeError("checkpoint frameの順序または参照数が不正です");
    const expected = metadata[index];
    const compressed = compressedFrames[index];
    if (expected == null || compressed == null || expected.index !== index) {
      throw new TypeError("checkpoint frameの一覧が一致しません");
    }
    const bytes = compression.decompress(compressed, expected.uncompressedByteLength);
    totalUncompressedBytes += bytes.length;
    if (
      bytes.length !== expected.uncompressedByteLength ||
      bytes.length > MAX_CHECKPOINT_FRAME_BYTES ||
      totalUncompressedBytes > MAX_CHECKPOINT_TOTAL_UNCOMPRESSED_BYTES ||
      digest.sha256Bytes(bytes) !== expected.contentDigest
    ) {
      throw new TypeError("checkpoint frameのbyte数またはdigestが一致しません");
    }
    const source = decoder.decode(bytes);
    const value: unknown = JSON.parse(source);
    if (source !== serializeCanonicalJson(value)) {
      throw new TypeError("checkpoint frameがcanonical JSONではありません");
    }
    nextFrame++;
    return value;
  }

  function decode(nodeValue: unknown): unknown {
    if (typeof nodeValue !== "object" || nodeValue == null || !("kind" in nodeValue)) {
      throw new TypeError("checkpointのframe参照が不正です");
    }
    if (nodeValue.kind === "frame") return frame(frameNodeSchema.parse(nodeValue).index);
    if (nodeValue.kind === "object") {
      const node = objectNodeSchema.parse(nodeValue);
      const value: Record<string, unknown> = {};
      let previousKey: string | undefined;
      for (const [key, child] of node.fields) {
        if (key === "__proto__" || (previousKey != null && key <= previousKey)) {
          throw new TypeError("checkpointのobject keyまたは順序が不正です");
        }
        value[key] = decode(child);
        previousKey = key;
      }
      return value;
    }
    const node = arrayNodeSchema.parse(nodeValue);
    const value: unknown[] = [];
    for (const part of node.parts) {
      if (part.kind === "frame") {
        if (part.start !== value.length) throw new TypeError("checkpoint配列の開始位置が不正です");
        const chunk = frame(part.index);
        if (!Array.isArray(chunk) || chunk.length !== part.count) {
          throw new TypeError("checkpoint配列frameの件数が一致しません");
        }
        for (const item of z.array(z.unknown()).parse(chunk)) value.push(item);
      } else {
        if (part.index !== value.length) throw new TypeError("checkpoint配列の要素順序が不正です");
        value.push(decode(part.node));
      }
    }
    if (value.length !== node.count) throw new TypeError("checkpoint配列の件数が一致しません");
    return value;
  }

  const values = roots.map(decode);
  if (nextFrame !== metadata.length || nextFrame !== compressedFrames.length) {
    throw new TypeError("checkpointに余剰frameがあります");
  }
  return values;
}
