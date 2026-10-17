import { Buffer } from "node:buffer";
import { crc32, inflateRawSync } from "node:zlib";

const maximumFileBytes = 8 * 1024 * 1024;

/** Actions artifactのZIPを検証してfile内容を取得する。 */
export function extractFiles(archive) {
  let end = -1;
  for (
    let offset = archive.length - 22;
    offset >= Math.max(0, archive.length - 65557);
    offset -= 1
  ) {
    if (
      archive.readUInt32LE(offset) === 0x06054b50 &&
      offset + 22 + archive.readUInt16LE(offset + 20) === archive.length
    ) {
      end = offset;
      break;
    }
  }
  if (end < 0 || archive.readUInt16LE(end + 4) !== 0 || archive.readUInt16LE(end + 6) !== 0) {
    throw new TypeError("保存済みPages artifactのZIP構造が不正です");
  }
  const count = archive.readUInt16LE(end + 10);
  const size = archive.readUInt32LE(end + 12);
  let offset = archive.readUInt32LE(end + 16);
  if (count !== archive.readUInt16LE(end + 8) || offset + size !== end) {
    throw new TypeError("保存済みPages artifactのZIP索引が不正です");
  }
  const files = new Map();
  for (let index = 0; index < count; index += 1) {
    if (offset + 46 > end || archive.readUInt32LE(offset) !== 0x02014b50) {
      throw new TypeError("保存済みPages artifactのZIP項目が不正です");
    }
    const flags = archive.readUInt16LE(offset + 8);
    const method = archive.readUInt16LE(offset + 10);
    const checksum = archive.readUInt32LE(offset + 16);
    const compressedSize = archive.readUInt32LE(offset + 20);
    const uncompressedSize = archive.readUInt32LE(offset + 24);
    const nameLength = archive.readUInt16LE(offset + 28);
    const extraLength = archive.readUInt16LE(offset + 30);
    const commentLength = archive.readUInt16LE(offset + 32);
    const localOffset = archive.readUInt32LE(offset + 42);
    const next = offset + 46 + nameLength + extraLength + commentLength;
    const name = archive.subarray(offset + 46, offset + 46 + nameLength).toString("utf8");
    if (
      next > end ||
      flags & 1 ||
      (method !== 0 && method !== 8) ||
      uncompressedSize > maximumFileBytes ||
      localOffset + 30 > offset ||
      archive.readUInt32LE(localOffset) !== 0x04034b50 ||
      archive.readUInt16LE(localOffset + 6) !== flags ||
      archive.readUInt16LE(localOffset + 8) !== method ||
      files.has(name)
    ) {
      throw new TypeError("保存済みPages artifactのZIP内容が不正です");
    }
    const localNameLength = archive.readUInt16LE(localOffset + 26);
    const localExtraLength = archive.readUInt16LE(localOffset + 28);
    const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
    if (
      !archive
        .subarray(localOffset + 30, localOffset + 30 + localNameLength)
        .equals(Buffer.from(name)) ||
      dataOffset + compressedSize > offset
    ) {
      throw new TypeError("保存済みPages artifactのZIP本文が不正です");
    }
    const compressed = archive.subarray(dataOffset, dataOffset + compressedSize);
    const bytes =
      method === 0
        ? compressed
        : inflateRawSync(compressed, { maxOutputLength: maximumFileBytes + 1 });
    if (bytes.length !== uncompressedSize || crc32(bytes) !== checksum) {
      throw new TypeError("保存済みPages artifactのZIP検査値が一致しません");
    }
    files.set(name, bytes);
    offset = next;
  }
  if (offset !== end) throw new TypeError("保存済みPages artifactのZIP索引が完結しません");
  return files;
}
