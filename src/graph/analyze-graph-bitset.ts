import { assertNonNullable } from "../util/index.js";

/** 指定したbitを有効にする。 */
export function setBit(bitset: Uint32Array, index: number): void {
  const wordIndex = Math.floor(index / 32);
  const word = bitset[wordIndex];
  assertNonNullable(word, `bitsetのword ${wordIndex.toString()}がありません`);
  bitset[wordIndex] = word | (1 << (index % 32));
}

/** 二つのbitsetの和集合を結合先へ反映する。 */
export function unionBitsets(target: Uint32Array, source: Uint32Array): void {
  if (target.length !== source.length) {
    throw new TypeError("結合するbitsetの長さが一致しません");
  }
  for (let wordIndex = 0; wordIndex < target.length; wordIndex += 1) {
    const targetWord = target[wordIndex];
    const sourceWord = source[wordIndex];
    assertNonNullable(targetWord, `結合先bitsetのword ${wordIndex.toString()}がありません`);
    assertNonNullable(sourceWord, `結合元bitsetのword ${wordIndex.toString()}がありません`);
    target[wordIndex] = targetWord | sourceWord;
  }
}

function popcountWord(value: number): number {
  let current = value >>> 0;
  current -= (current >>> 1) & 0x55555555;
  current = (current & 0x33333333) + ((current >>> 2) & 0x33333333);
  return (((current + (current >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
}

/** 有効なbitの個数を数える。 */
export function popcount(bitset: Uint32Array): number {
  let count = 0;
  for (const word of bitset) {
    count += popcountWord(word);
  }
  return count;
}

/** 自分以外の同一repository nodeへ到達できるか判定する。 */
export function containsOtherRepositoryNode(
  reachableNodes: Uint32Array,
  repositoryMembers: Uint32Array,
  ownNodeIndex: number,
): boolean {
  if (reachableNodes.length !== repositoryMembers.length) {
    throw new TypeError("到達nodeとリポジトリ所属nodeのbitset長が一致しません");
  }
  const ownWordIndex = Math.floor(ownNodeIndex / 32);
  const ownBit = 1 << (ownNodeIndex % 32);
  for (let wordIndex = 0; wordIndex < reachableNodes.length; wordIndex += 1) {
    const reachableWord = reachableNodes[wordIndex];
    const repositoryWord = repositoryMembers[wordIndex];
    assertNonNullable(reachableWord, `到達node bitsetのword ${wordIndex.toString()}がありません`);
    assertNonNullable(
      repositoryWord,
      `リポジトリ所属bitsetのword ${wordIndex.toString()}がありません`,
    );
    const intersection =
      wordIndex === ownWordIndex
        ? (reachableWord & repositoryWord & ~ownBit) >>> 0
        : (reachableWord & repositoryWord) >>> 0;
    if (intersection !== 0) {
      return true;
    }
  }
  return false;
}
