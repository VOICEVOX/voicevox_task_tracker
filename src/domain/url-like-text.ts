import type { Nodes } from "mdast";
import { type CompileContext, fromMarkdown, type Token } from "mdast-util-from-markdown";

import { assertNonNullable } from "../util/index.js";
import { type UrlTextPart, urlTextParts } from "./url-like-components.js";
import {
  mayHaveGitHubAuthority,
  PERCENT_ENCODED_UTF8_CHARACTER_PATTERN,
  type UrlLikeCandidate,
  urlInputProjection,
  urlInputText,
  urlLikeCandidates,
} from "./url-like-candidates.js";
import {
  appendHtmlBoundarySpan,
  decodeHtmlCharacterReference,
  HTML_CHARACTER_REFERENCE_PATTERN,
  htmlDisplayTag,
  htmlTextFields,
  isHtmlReferenceFragment,
} from "./url-like-html.js";

const NON_SCHEME_URL_LIKE_START_PATTERN =
  /(?<![A-Za-z0-9+.-])(?:mailto|javascript|data|urn|tel|blob|about):|(?<![:/])\/\/|(?<![\p{L}\p{N}_.．。｡@/:%-])(?:[\p{L}\p{N}-]+(?:[.．。｡][\p{L}\p{N}-]+)*[.．。｡][\p{L}]{2,}(?![\p{L}\p{N}_]))/iu;
const URL_LIKE_START_PATTERN = new RegExp(
  `[A-Za-z][A-Za-z0-9+.-]*:\\/\\/|${NON_SCHEME_URL_LIKE_START_PATTERN.source}`,
  "giu",
);
const URL_LIKE_TEXT_PATTERN = new RegExp(
  `(?:${URL_LIKE_START_PATTERN.source})[^\\s<>"'\\x60]*`,
  "giu",
);
const PERCENT_ENCODED_BYTE_SEQUENCE_PATTERN = /(?:%[0-9a-f]{2})+/giu;

/** 理由要約にURL形式を含めないschema制約。 */
export const NO_URL_LIKE_TEXT_PATTERN = new RegExp(
  `^(?![\\s\\S]*${URL_LIKE_TEXT_PATTERN.source})[\\s\\S]*$`,
  "iu",
);

type UrlLikeTextScan =
  | Readonly<{
      status: "valid";
      candidates: readonly string[];
      views: readonly Readonly<{ value: string; candidates: readonly UrlLikeCandidate[] }>[];
    }>
  | Readonly<{
      status: "invalid";
      reason: "invalid_encoding";
      failure: Readonly<{ candidate: string; originalCandidate: string; decodeDepth: number }>;
    }>
  | Readonly<{
      status: "invalid";
      reason:
        | "text_limit"
        | "candidate_characters_limit"
        | "candidate_count_limit"
        | "decode_depth_limit"
        | "markdown_boundary";
    }>;

type TextSpan = Readonly<{ start: number; end: number }>;
type MarkdownReferenceNode = Extract<
  Nodes,
  { type: "link" | "image" | "linkReference" | "imageReference" }
>;
type TextOrigin =
  | Readonly<{ kind: "copy"; original: TextSpan }>
  | Readonly<{
      kind: "replacement";
      original: readonly TextSpan[];
      literalPercent: boolean;
      hardBoundary: boolean;
      percentDecoded: boolean;
    }>;
type SourceTextSegment = TextSpan & TextOrigin;
type MappedText = Readonly<{
  value: string;
  segments: readonly SourceTextSegment[];
  hardBoundaries: readonly number[];
}>;
interface TextBuilder {
  chunks: string[];
  segments: SourceTextSegment[];
  hardBoundaries: number[];
  length: number;
}
type MappedTextView = Readonly<{ text: MappedText; context: "markdown" | "url" | "text" }>;
type TextView = MappedTextView & Readonly<{ decodeDepth: number }>;
type MarkdownValueNode = Extract<Nodes, { type: "link" | "image" | "definition" }>;
type MarkdownField =
  | Readonly<{ node: MarkdownValueNode; field: "url" | "title"; span: TextSpan }>
  | Readonly<{ node: Extract<Nodes, { type: "definition" }>; field: "label"; span: TextSpan }>;
type TextTransformation =
  Readonly<{ status: "unchanged" }> | Readonly<{ status: "changed"; text: MappedText }>;
type MarkdownLayout =
  | Readonly<{ status: "invalid" }>
  | Readonly<{
      status: "valid";
      text: MappedText;
      offsets: readonly number[];
      display: TextTransformation;
      fields: readonly MappedTextView[];
    }>;

function nodeTextSpan(node: Nodes): TextSpan {
  const start = node.position?.start.offset;
  const end = node.position?.end.offset;
  assertNonNullable(start, "Markdown境界の開始位置を取得できません");
  assertNonNullable(end, "Markdown境界の終了位置を取得できません");
  return { start, end };
}

function textBuilder(): TextBuilder {
  return { chunks: [], segments: [], hardBoundaries: [], length: 0 };
}

function mappedText(builder: TextBuilder): MappedText {
  return {
    value: builder.chunks.join(""),
    segments: builder.segments,
    hardBoundaries: builder.hardBoundaries,
  };
}

function firstHardBoundary(boundaries: readonly number[], start: number): number {
  let left = 0;
  let right = boundaries.length;
  while (left < right) {
    const middle = Math.floor((left + right) / 2);
    const boundary = boundaries[middle];
    assertNonNullable(boundary, "Markdown境界の位置を取得できません");
    if (boundary < start) left = middle + 1;
    else right = middle;
  }
  return left;
}

function withHardBoundaries(text: MappedText, boundaries: readonly number[]): MappedText {
  if (boundaries.length === 0) return text;
  return {
    ...text,
    hardBoundaries: [...new Set([...text.hardBoundaries, ...boundaries])].sort(
      (left, right) => left - right,
    ),
  };
}

function appendSourceText(builder: TextBuilder, value: string, origin: TextOrigin): void {
  if (value.length === 0) return;
  if (origin.kind === "copy" && value.length !== origin.original.end - origin.original.start) {
    throw new TypeError("原文位置と文字数が一致しません");
  }
  if (origin.kind === "replacement" && origin.literalPercent && value !== "%") {
    throw new TypeError("percent復号の由来と文字が一致しません");
  }
  const start = builder.length;
  builder.chunks.push(value);
  builder.length += value.length;
  const previous = builder.segments.at(-1);
  if (
    origin.kind === "copy" &&
    previous?.kind === "copy" &&
    previous.original.end === origin.original.start
  ) {
    builder.segments[builder.segments.length - 1] = {
      ...previous,
      end: builder.length,
      original: { start: previous.original.start, end: origin.original.end },
    };
    return;
  }
  builder.segments.push({ ...origin, start, end: builder.length });
}

function firstSourceSegment(text: MappedText, start: number): number {
  let left = 0;
  let right = text.segments.length;
  while (left < right) {
    const middle = Math.floor((left + right) / 2);
    const segment = text.segments[middle];
    assertNonNullable(segment, "原文位置の対応を取得できません");
    if (start >= segment.end) left = middle + 1;
    else right = middle;
  }
  return left;
}

function slicedOrigin(segment: SourceTextSegment, start: number, end: number): TextOrigin {
  return segment.kind === "copy"
    ? {
        kind: "copy",
        original: {
          start: segment.original.start + start - segment.start,
          end: segment.original.start + end - segment.start,
        },
      }
    : {
        kind: "replacement",
        original: segment.original,
        literalPercent: segment.literalPercent,
        hardBoundary: segment.hardBoundary,
        percentDecoded: segment.percentDecoded,
      };
}

function appendTextSlice(builder: TextBuilder, text: MappedText, span: TextSpan): void {
  let covered = span.start;
  for (let index = firstSourceSegment(text, span.start); index < text.segments.length; index += 1) {
    const segment = text.segments[index];
    assertNonNullable(segment, "原文位置の対応を取得できません");
    if (segment.start >= span.end) break;
    const start = Math.max(span.start, segment.start);
    const end = Math.min(span.end, segment.end);
    const destinationStart = builder.length;
    appendSourceText(builder, text.value.slice(start, end), slicedOrigin(segment, start, end));
    for (
      let boundaryIndex = firstHardBoundary(text.hardBoundaries, start);
      boundaryIndex < text.hardBoundaries.length;
      boundaryIndex += 1
    ) {
      const boundary = text.hardBoundaries[boundaryIndex];
      assertNonNullable(boundary, "Markdown境界の位置を取得できません");
      if (boundary >= end) break;
      builder.hardBoundaries.push(destinationStart + boundary - start);
    }
    covered = end;
  }
  if (covered !== span.end) throw new TypeError("原文位置の対応に欠落があります");
}

function originalTextSpans(text: MappedText, span: TextSpan): readonly TextSpan[] {
  const originals: TextSpan[] = [];
  for (let index = firstSourceSegment(text, span.start); index < text.segments.length; index += 1) {
    const segment = text.segments[index];
    assertNonNullable(segment, "原文位置の対応を取得できません");
    if (segment.start >= span.end) break;
    const origin = slicedOrigin(
      segment,
      Math.max(span.start, segment.start),
      Math.min(span.end, segment.end),
    );
    for (const original of origin.kind === "copy" ? [origin.original] : origin.original) {
      const previous = originals.at(-1);
      if (previous != null && original.start <= previous.end) {
        if (original.start < previous.start) throw new TypeError("原文位置の順序が一致しません");
        originals[originals.length - 1] = {
          start: previous.start,
          end: Math.max(previous.end, original.end),
        };
      } else {
        originals.push(original);
      }
    }
  }
  return originals;
}

function isDecodedLiteralPercent(text: MappedText, index: number): boolean {
  const segment = text.segments[firstSourceSegment(text, index)];
  assertNonNullable(segment, "percentの原文位置を取得できません");
  return segment.kind === "replacement" && segment.literalPercent;
}

function isHardUrlBoundary(text: MappedText, index: number): boolean {
  if (text.hardBoundaries[firstHardBoundary(text.hardBoundaries, index)] === index) return true;
  if (text.value.charAt(index) !== "\n") return false;
  const segment = text.segments[firstSourceSegment(text, index)];
  assertNonNullable(segment, "表示上の改行位置を取得できません");
  return segment.kind === "replacement" && segment.hardBoundary;
}

function isStructuralUrlDelimiter(text: MappedText, index: number): boolean {
  const segment = text.segments[firstSourceSegment(text, index)];
  assertNonNullable(segment, "URL構造区切りの原文位置を取得できません");
  return segment.kind === "copy" || !segment.percentDecoded;
}

function containingUrlTextPart(
  parts: readonly UrlTextPart[],
  start: number,
): UrlTextPart | undefined {
  let left = 0;
  let right = parts.length;
  while (left < right) {
    const middle = Math.floor((left + right) / 2);
    const part = parts[middle];
    assertNonNullable(part, "URL成分の位置を取得できません");
    if (part.end <= start) left = middle + 1;
    else right = middle;
  }
  const part = parts[left];
  return part != null && part.start <= start ? part : undefined;
}

function textWithoutMarkdownPrefixes(
  text: MappedText,
  span: TextSpan,
  prefixes: readonly TextSpan[],
): MappedText {
  const builder = textBuilder();
  let left = 0;
  let right = prefixes.length;
  while (left < right) {
    const middle = Math.floor((left + right) / 2);
    const prefix = prefixes[middle];
    assertNonNullable(prefix, "Markdown prefixの位置を取得できません");
    if (prefix.end <= span.start) left = middle + 1;
    else right = middle;
  }
  let start = span.start;
  for (let index = left; index < prefixes.length; index += 1) {
    const prefix = prefixes[index];
    assertNonNullable(prefix, "Markdown prefixの位置を取得できません");
    if (prefix.start >= span.end) break;
    appendTextSlice(builder, text, { start, end: Math.max(start, prefix.start) });
    start = Math.min(span.end, prefix.end);
  }
  appendTextSlice(builder, text, { start, end: span.end });
  return mappedText(builder);
}

function appendRenderedText(
  builder: TextBuilder,
  text: MappedText,
  span: TextSpan,
  expected: string,
  context: "markdown" | "html",
): boolean {
  const raw = text.value.slice(span.start, span.end);
  if (raw === expected) {
    appendTextSlice(builder, text, span);
    return true;
  }
  if (context === "html" && expected === "\n" && htmlDisplayTag(raw).kind === "break") {
    appendSourceText(builder, expected, {
      kind: "replacement",
      original: originalTextSpans(text, span),
      literalPercent: false,
      hardBoundary: true,
      percentDecoded: false,
    });
    return true;
  }
  const chunkStart = builder.chunks.length;
  let start = span.start;
  const replacements =
    context === "html"
      ? HTML_CHARACTER_REFERENCE_PATTERN
      : /\\[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]|&(?:#[xX][0-9a-f]{1,6}|#[0-9]{1,7}|[A-Za-z][A-Za-z0-9]{1,31});/giu;
  for (const match of raw.matchAll(replacements)) {
    const replacementStart = span.start + match.index;
    const replacementEnd = replacementStart + match[0].length;
    appendTextSlice(builder, text, { start, end: replacementStart });
    if (match[0].startsWith("\\")) {
      appendTextSlice(builder, text, { start: replacementStart + 1, end: replacementEnd });
      start = replacementEnd;
      continue;
    }
    appendSourceText(builder, decodeHtmlCharacterReference(match[0]), {
      kind: "replacement",
      original: originalTextSpans(text, { start: replacementStart, end: replacementEnd }),
      literalPercent: false,
      hardBoundary: false,
      percentDecoded: false,
    });
    start = replacementEnd;
  }
  appendTextSlice(builder, text, { start, end: span.end });
  return builder.chunks.slice(chunkStart).join("") === expected;
}

function appendInlineCode(
  builder: TextBuilder,
  source: MappedText,
  node: Extract<Nodes, { type: "inlineCode" }>,
  prefixes: readonly TextSpan[],
): boolean {
  const text = textWithoutMarkdownPrefixes(source, nodeTextSpan(node), prefixes);
  const span = { start: 0, end: text.value.length };
  const raw = text.value;
  const fence = /^`+/u.exec(raw)?.[0];
  if (fence == null || !raw.endsWith(fence)) return false;
  const inner = { start: span.start + fence.length, end: span.end - fence.length };
  const content = textBuilder();
  appendTextSlice(content, text, inner);
  const code = mappedText(content);
  const trim = code.value.startsWith(" ") && code.value.endsWith(" ") && /[^ ]/u.test(code.value);
  const displayed = { start: trim ? 1 : 0, end: code.value.length - Number(trim) };
  if (code.value.slice(displayed.start, displayed.end) !== node.value) return false;
  appendTextSlice(builder, code, displayed);
  return true;
}

function appendInlineDisplayText(
  builder: TextBuilder,
  text: MappedText,
  nodes: readonly Nodes[],
  labels: ReadonlyMap<MarkdownReferenceNode, readonly Nodes[]>,
  prefixes: readonly TextSpan[],
  mode: "text" | "link" | "alt",
): boolean {
  type Entry =
    | Readonly<{ kind: "node"; node: Nodes; mode: "text" | "link" | "alt" }>
    | Readonly<{ kind: "verify"; chunkStart: number; expected: string }>;
  const pending: Entry[] = nodes.toReversed().map((node) => ({ kind: "node", node, mode }));
  const htmlTags: string[] = [];
  const htmlBoundaries: TextSpan[] = [];
  const chunkStart = builder.chunks.length;
  const displayStart = builder.length;
  while (pending.length > 0) {
    const entry = pending.pop();
    assertNonNullable(entry, "Markdownラベルのnodeを取得できません");
    if (entry.kind === "verify") {
      if (builder.chunks.slice(entry.chunkStart).join("") !== entry.expected) return false;
      continue;
    }
    const node = entry.node;
    if (node.type === "text") {
      const literal = textWithoutMarkdownPrefixes(text, nodeTextSpan(node), prefixes);
      if (
        !appendRenderedText(
          builder,
          literal,
          { start: 0, end: literal.value.length },
          node.value,
          "markdown",
        )
      )
        return false;
    } else if (node.type === "inlineCode") {
      if (!appendInlineCode(builder, text, node, prefixes)) return false;
    } else if (node.type === "break") {
      appendSourceText(builder, "\n", {
        kind: "replacement",
        original: originalTextSpans(text, nodeTextSpan(node)),
        literalPercent: false,
        hardBoundary: true,
        percentDecoded: false,
      });
    } else if (node.type === "image" || node.type === "imageReference") {
      if (entry.mode === "text") {
        appendSourceText(builder, " ", {
          kind: "replacement",
          original: originalTextSpans(text, nodeTextSpan(node)),
          literalPercent: false,
          hardBoundary: false,
          percentDecoded: false,
        });
        continue;
      }
      const children = labels.get(node);
      if (children == null) return false;
      assertNonNullable(node.alt, "Markdown画像のaltを取得できません");
      pending.push({ kind: "verify", chunkStart: builder.chunks.length, expected: node.alt });
      pending.push(
        ...children
          .toReversed()
          .map((child): Entry => ({ kind: "node", node: child, mode: "alt" })),
      );
    } else if (node.type === "html") {
      if (entry.mode === "alt") {
        appendTextSlice(builder, text, nodeTextSpan(node));
        continue;
      }
      const tag = htmlDisplayTag(node.value);
      if (tag.kind === "invalid") return false;
      if (tag.kind === "anchor") {
        if (entry.mode === "link") return false;
        continue;
      }
      if (tag.kind === "break") {
        if (entry.mode === "link" && !tag.labelAllowed) return false;
        appendSourceText(builder, "\n", {
          kind: "replacement",
          original: originalTextSpans(text, nodeTextSpan(node)),
          literalPercent: false,
          hardBoundary: true,
          percentDecoded: false,
        });
        continue;
      }
      if (tag.kind === "other") {
        if (entry.mode === "link") return false;
        const start = builder.length - displayStart;
        appendTextSlice(builder, text, nodeTextSpan(node));
        appendHtmlBoundarySpan(htmlBoundaries, start, builder.length - displayStart);
        continue;
      }
      if (entry.mode === "link") {
        if (tag.closing) {
          if (htmlTags.at(-1) !== tag.name) return false;
          htmlTags.pop();
        } else {
          htmlTags.push(tag.name);
        }
      }
    } else if ("children" in node) {
      const childMode =
        entry.mode !== "alt" && (node.type === "link" || node.type === "linkReference")
          ? "link"
          : entry.mode;
      pending.push(
        ...node.children
          .toReversed()
          .map((child): Entry => ({ kind: "node", node: child, mode: childMode })),
      );
    } else {
      return false;
    }
  }
  const display = builder.chunks.slice(chunkStart).join("");
  if (
    htmlBoundaries.some(
      (span) =>
        isHtmlReferenceFragment(display.charAt(span.start - 1)) &&
        isHtmlReferenceFragment(display.charAt(span.end)),
    )
  )
    return false;
  return htmlTags.length === 0;
}

function markdownBlockBoundaries(value: string, root: Nodes): readonly number[] {
  const boundaries = new Set<number>();
  const containers: Nodes[] = [root];
  while (containers.length > 0) {
    const container = containers.pop();
    assertNonNullable(container, "Markdown blockを取得できません");
    if (
      container.type !== "root" &&
      container.type !== "blockquote" &&
      container.type !== "list" &&
      container.type !== "listItem"
    )
      continue;
    for (const child of container.children) {
      const span = nodeTextSpan(child);
      if (span.end < value.length) boundaries.add(span.end);
      if (
        child.type === "code" &&
        /^[ \t]*(?:`{3,}|~{3,})/u.test(value.slice(span.start, span.end))
      ) {
        for (let index = span.start; index < span.end; index += 1) {
          if (value.charAt(index) === "\n" || value.charAt(index) === "\r") boundaries.add(index);
        }
      }
      if (child.type === "blockquote" || child.type === "list" || child.type === "listItem")
        containers.push(child);
    }
  }
  return [...boundaries].sort((left, right) => left - right);
}

function markdownLayout(text: MappedText): MarkdownLayout {
  const value = text.value;
  const offsets = new Set<number>();
  const labels = new Map<MarkdownReferenceNode, readonly Nodes[]>();
  const sourceFields: MarkdownField[] = [];
  const sourcePrefixes: TextSpan[] = [];
  if (
    !value.includes("[") &&
    !value.includes("<") &&
    !value.includes("&") &&
    !value.includes("\\") &&
    !value.includes("*") &&
    !value.includes("_") &&
    !value.includes("`") &&
    !value.includes("\n") &&
    !value.includes("\r")
  ) {
    return { status: "valid", text, offsets: [], display: { status: "unchanged" }, fields: [] };
  }
  function tokenBoundaries(token: Token): void {
    offsets.add(token.start.offset);
    offsets.add(token.end.offset);
  }
  function prefixSpan(token: Token): void {
    sourcePrefixes.push({ start: token.start.offset, end: token.end.offset });
  }
  function bufferBoundaries(this: CompileContext, token: Token): void {
    tokenBoundaries(token);
    const node = this.stack.at(-1);
    assertNonNullable(node, "Markdown fieldのnodeを取得できません");
    if (node.type !== "link" && node.type !== "image" && node.type !== "definition") {
      throw new TypeError("Markdown fieldのnode種別を解釈できません");
    }
    const span = { start: token.start.offset, end: token.end.offset };
    if (token.type === "definitionLabelString") {
      if (node.type !== "definition") throw new TypeError("Markdown definitionを取得できません");
      sourceFields.push({ node, field: "label", span });
    } else if (
      token.type === "resourceDestinationString" ||
      token.type === "definitionDestinationString"
    ) {
      sourceFields.push({ node, field: "url", span });
    } else if (token.type === "resourceTitleString" || token.type === "definitionTitleString") {
      sourceFields.push({ node, field: "title", span });
    } else {
      throw new TypeError("Markdown fieldのtoken種別を解釈できません");
    }
    this.buffer();
  }
  function labelBoundaries(this: CompileContext, token: Token): void {
    tokenBoundaries(token);
    const node = this.stack.at(-2);
    assertNonNullable(node, "Markdownラベルのnodeを取得できません");
    if (node.type !== "link" && node.type !== "image") {
      throw new TypeError("Markdownラベルのnode種別を解釈できません");
    }
    const fragment = this.stack.at(-1);
    assertNonNullable(fragment, "Markdownラベルのfragmentを取得できません");
    if (!("children" in fragment)) throw new TypeError("Markdownラベルのfragmentを解釈できません");
    labels.set(node, fragment.children);
  }
  const displayedNodes: Extract<Nodes, { type: "paragraph" | "heading" }>[] = [];
  const images: Extract<MarkdownReferenceNode, { type: "image" | "imageReference" }>[] = [];
  const htmlNodes: Extract<Nodes, { type: "html" }>[] = [];
  const root = fromMarkdown(value, {
    mdastExtensions: [
      {
        enter: {
          linePrefix: prefixSpan,
          lineSuffix: prefixSpan,
          blockQuotePrefix: prefixSpan,
          listItemPrefix: prefixSpan,
          listItemIndent: prefixSpan,
          labelText: labelBoundaries,
          resourceDestinationString: bufferBoundaries,
          resourceTitleString: bufferBoundaries,
          definitionDestinationString: bufferBoundaries,
          definitionLabelString: bufferBoundaries,
          definitionTitleString: bufferBoundaries,
        },
      },
    ],
  });
  text = withHardBoundaries(text, markdownBlockBoundaries(value, root));
  const pending: Nodes[] = [root];
  while (pending.length > 0) {
    const node = pending.pop();
    assertNonNullable(node, "Markdown境界のnodeを取得できません");
    if (
      node.type === "link" ||
      node.type === "image" ||
      node.type === "linkReference" ||
      node.type === "imageReference" ||
      node.type === "definition"
    ) {
      const span = nodeTextSpan(node);
      offsets.add(span.start);
      offsets.add(span.end);
    }
    if (node.type === "paragraph" || node.type === "heading") {
      displayedNodes.push(node);
    }
    if (node.type === "image" || node.type === "imageReference") images.push(node);
    if (node.type === "html") htmlNodes.push(node);
    if ("children" in node) pending.push(...node.children);
  }
  const prefixes: TextSpan[] = [];
  for (const prefix of sourcePrefixes.sort((left, right) => left.start - right.start)) {
    const previous = prefixes.at(-1);
    if (previous != null && prefix.start <= previous.end) {
      prefixes[prefixes.length - 1] = {
        start: previous.start,
        end: Math.max(previous.end, prefix.end),
      };
    } else {
      prefixes.push(prefix);
    }
  }
  const labelNodes: Nodes[] = [
    ...[...labels.values()].flat(),
    ...displayedNodes.flatMap((node) => node.children),
  ];
  while (labelNodes.length > 0) {
    const node = labelNodes.pop();
    assertNonNullable(node, "Markdownラベルの境界を取得できません");
    const span = nodeTextSpan(node);
    offsets.add(span.start);
    offsets.add(span.end);
    if ("children" in node) labelNodes.push(...node.children);
  }
  const fields: MappedTextView[] = [];
  for (const field of sourceFields) {
    const expected = field.field === "label" ? field.node.label : field.node[field.field];
    assertNonNullable(expected, "Markdown fieldの表示値を取得できません");
    const builder = textBuilder();
    const literal = textWithoutMarkdownPrefixes(text, field.span, prefixes);
    if (
      !appendRenderedText(
        builder,
        literal,
        { start: 0, end: literal.value.length },
        expected,
        "markdown",
      )
    )
      return { status: "invalid" };
    fields.push({ text: mappedText(builder), context: field.field === "url" ? "url" : "text" });
  }
  for (const node of htmlNodes) {
    const literal = textWithoutMarkdownPrefixes(text, nodeTextSpan(node), prefixes);
    if (literal.value !== node.value) return { status: "invalid" };
    const html = htmlTextFields(literal.value);
    if (html.status === "invalid") return { status: "invalid" };
    for (const field of html.fields) {
      const builder = textBuilder();
      if (
        !field.parts.every((part) =>
          appendRenderedText(builder, literal, part.span, part.value, "html"),
        )
      )
        return { status: "invalid" };
      fields.push({ text: mappedText(builder), context: field.context });
    }
  }
  for (const image of images) {
    const children = labels.get(image);
    if (children == null) return { status: "invalid" };
    const builder = textBuilder();
    if (!appendInlineDisplayText(builder, text, children, labels, prefixes, "alt"))
      return { status: "invalid" };
    const alt = mappedText(builder);
    if (alt.value !== image.alt) return { status: "invalid" };
    fields.push({ text: alt, context: "text" });
  }
  const boundaries = [...offsets].sort((left, right) => left - right);
  if (displayedNodes.length === 0)
    return { status: "valid", text, offsets: boundaries, display: { status: "unchanged" }, fields };
  const display = textBuilder();
  let start = 0;
  for (const node of displayedNodes.sort(
    (left, right) => nodeTextSpan(left).start - nodeTextSpan(right).start,
  )) {
    const span = nodeTextSpan(node);
    if (span.start < start) {
      if (span.end <= start) continue;
      return { status: "invalid" };
    }
    appendTextSlice(display, text, { start, end: span.start });
    if (!appendInlineDisplayText(display, text, node.children, labels, prefixes, "text"))
      return { status: "invalid" };
    start = span.end;
  }
  appendTextSlice(display, text, { start, end: value.length });
  const result = mappedText(display);
  return {
    status: "valid",
    text,
    offsets: boundaries,
    display: result.value === value ? { status: "unchanged" } : { status: "changed", text: result },
    fields,
  };
}

function percentDecodedText(text: MappedText): TextTransformation {
  const builder = textBuilder();
  const projection = urlInputProjection(text.value, (index) => isHardUrlBoundary(text, index));
  let start = 0;
  for (const match of projection.value.matchAll(PERCENT_ENCODED_UTF8_CHARACTER_PATTERN)) {
    const matchedStart =
      projection.sourceIndices == null ? match.index : projection.sourceIndices[match.index];
    const matchedLast =
      projection.sourceIndices == null
        ? match.index + match[0].length - 1
        : projection.sourceIndices[match.index + match[0].length - 1];
    assertNonNullable(matchedStart, "復号対象の開始位置を取得できません");
    assertNonNullable(matchedLast, "復号対象の終了位置を取得できません");
    const end = matchedLast + 1;
    appendTextSlice(builder, text, { start, end: matchedStart });
    const character = decodeURIComponent(match[0]);
    appendSourceText(builder, character, {
      kind: "replacement",
      original: originalTextSpans(text, { start: matchedStart, end }),
      literalPercent: character === "%",
      hardBoundary: false,
      percentDecoded: true,
    });
    start = end;
  }
  if (start === 0) return { status: "unchanged" };
  appendTextSlice(builder, text, { start, end: text.value.length });
  return { status: "changed", text: mappedText(builder) };
}

function sameSourceSegments(
  left: readonly SourceTextSegment[],
  right: readonly SourceTextSegment[],
): boolean {
  if (left.length !== right.length) return false;
  return left.every((segment, index) => {
    const other = right[index];
    assertNonNullable(other, "原文位置の照合対象を取得できません");
    if (segment.start !== other.start || segment.end !== other.end) return false;
    if (segment.kind === "copy" && other.kind === "copy") {
      return (
        segment.original.start === other.original.start &&
        segment.original.end === other.original.end
      );
    }
    if (segment.kind !== "replacement" || other.kind !== "replacement") return false;
    return (
      segment.literalPercent === other.literalPercent &&
      segment.hardBoundary === other.hardBoundary &&
      segment.percentDecoded === other.percentDecoded &&
      segment.original.length === other.original.length &&
      segment.original.every((span, originalIndex) => {
        const otherSpan = other.original[originalIndex];
        assertNonNullable(otherSpan, "原文位置の照合対象を取得できません");
        return span.start === otherSpan.start && span.end === otherSpan.end;
      })
    );
  });
}

/** URLの全開始位置と有界な復号段階を検査し、GitHub候補の曖昧な符号化を拒否する。 */
export function scanUrlLikeText(value: string): UrlLikeTextScan {
  const candidates = new Set<string>();
  const views: { value: string; candidates: UrlLikeCandidate[] }[] = [];
  const pending: TextView[] = [];
  const seen = new Map<string, Map<string, readonly MappedText[]>>();
  let textCharacters = 0;
  let candidateCharacters = 0;
  let candidateCount = 0;
  function enqueue(view: TextView): boolean {
    const key = `${view.context}:${String(view.decodeDepth)}`;
    const texts = seen.get(key) ?? new Map<string, readonly MappedText[]>();
    const origins = texts.get(view.text.value) ?? [];
    if (
      origins.some(
        (origin) =>
          sameSourceSegments(origin.segments, view.text.segments) &&
          origin.hardBoundaries.length === view.text.hardBoundaries.length &&
          origin.hardBoundaries.every(
            (boundary, index) => boundary === view.text.hardBoundaries[index],
          ),
      )
    )
      return true;
    textCharacters += view.text.value.length;
    if (textCharacters > 1_000_000) return false;
    texts.set(view.text.value, [...origins, view.text]);
    seen.set(key, texts);
    pending.push(view);
    return true;
  }
  const source = textBuilder();
  appendSourceText(source, value, { kind: "copy", original: { start: 0, end: value.length } });
  if (!enqueue({ text: mappedText(source), context: "markdown", decodeDepth: 0 }))
    return Object.freeze({ status: "invalid", reason: "text_limit" });
  for (const view of pending) {
    const layout: MarkdownLayout =
      view.context === "markdown"
        ? markdownLayout(view.text)
        : {
            status: "valid",
            text: view.text,
            offsets: [],
            display: { status: "unchanged" },
            fields: [],
          };
    if (layout.status === "invalid")
      return Object.freeze({ status: "invalid", reason: "markdown_boundary" });
    const text = layout.text;
    const viewCandidates: UrlLikeCandidate[] = [];
    const enclosingCandidates: {
      candidate: UrlLikeCandidate;
      parts: readonly UrlTextPart[];
    }[] = [];
    for (const extracted of urlLikeCandidates(
      text.value,
      layout.offsets,
      view.context === "url",
      (index) => isHardUrlBoundary(text, index),
    )) {
      candidateCount += 1;
      if (candidateCount > 4096)
        return Object.freeze({ status: "invalid", reason: "candidate_count_limit" });
      while (enclosingCandidates.at(-1) != null) {
        const enclosing = enclosingCandidates.at(-1);
        assertNonNullable(enclosing, "入れ子のURL候補を取得できません");
        if (enclosing.candidate.end > extracted.start) break;
        enclosingCandidates.pop();
      }
      let end = extracted.end;
      for (let index = enclosingCandidates.length - 1; index >= 0; index -= 1) {
        const enclosing = enclosingCandidates[index];
        assertNonNullable(enclosing, "入れ子のURL候補を取得できません");
        const part = containingUrlTextPart(enclosing.parts, extracted.start);
        if (part != null) {
          end = Math.min(end, part.end);
          break;
        }
      }
      const candidate =
        end === extracted.end
          ? extracted
          : {
              value: extracted.value.slice(0, end - extracted.start),
              start: extracted.start,
              end,
            };
      candidateCharacters += candidate.value.length;
      if (candidateCharacters > 1_000_000)
        return Object.freeze({ status: "invalid", reason: "candidate_characters_limit" });
      if (mayHaveGitHubAuthority(candidate.value)) {
        const projection = urlInputProjection(candidate.value, () => false);
        const originals = originalTextSpans(text, candidate).map((span) =>
          value.slice(span.start, span.end),
        );
        for (const original of originals) {
          try {
            decodeURIComponent(urlInputText(original));
          } catch (error: unknown) {
            if (!(error instanceof URIError)) throw error;
            return Object.freeze({
              status: "invalid",
              reason: "invalid_encoding",
              failure: Object.freeze({
                candidate: candidate.value,
                originalCandidate: original,
                decodeDepth: view.decodeDepth,
              }),
            });
          }
        }
        const originalCandidate = originals.join("");
        for (const match of projection.value.matchAll(/%(?![0-9a-f]{2})/giu)) {
          const sourceIndex =
            projection.sourceIndices == null ? match.index : projection.sourceIndices[match.index];
          assertNonNullable(sourceIndex, "percentの原文位置を取得できません");
          if (!isDecodedLiteralPercent(text, candidate.start + sourceIndex)) {
            return Object.freeze({
              status: "invalid",
              reason: "invalid_encoding",
              failure: Object.freeze({
                candidate: candidate.value,
                originalCandidate,
                decodeDepth: view.decodeDepth,
              }),
            });
          }
        }
        try {
          for (const match of projection.value.matchAll(PERCENT_ENCODED_BYTE_SEQUENCE_PATTERN))
            decodeURIComponent(match[0]);
        } catch (error: unknown) {
          if (!(error instanceof URIError)) throw error;
          return Object.freeze({
            status: "invalid",
            reason: "invalid_encoding",
            failure: Object.freeze({
              candidate: candidate.value,
              originalCandidate,
              decodeDepth: view.decodeDepth,
            }),
          });
        }
      }
      candidates.add(candidate.value);
      viewCandidates.push(candidate);
      enclosingCandidates.push({
        candidate,
        parts: urlTextParts(candidate, (index) => isStructuralUrlDelimiter(text, index)),
      });
    }
    views.push({ value: text.value, candidates: viewCandidates });
    const decoded = percentDecodedText(text);
    if (decoded.status === "changed") {
      if (view.decodeDepth === 4)
        return Object.freeze({ status: "invalid", reason: "decode_depth_limit" });
      if (
        !enqueue({ text: decoded.text, context: view.context, decodeDepth: view.decodeDepth + 1 })
      )
        return Object.freeze({ status: "invalid", reason: "text_limit" });
    }
    if (
      layout.display.status === "changed" &&
      !enqueue({ text: layout.display.text, context: "text", decodeDepth: view.decodeDepth })
    )
      return Object.freeze({ status: "invalid", reason: "text_limit" });
    for (const field of layout.fields) {
      if (!enqueue({ ...field, decodeDepth: view.decodeDepth }))
        return Object.freeze({ status: "invalid", reason: "text_limit" });
    }
  }
  return Object.freeze({
    status: "valid",
    candidates: Object.freeze([...candidates]),
    views: Object.freeze(views),
  });
}

/** 自然文にURL形式の候補または解釈不能な符号化があるか判定する。 */
export function containsUrlLikeText(value: string): boolean {
  const scan = scanUrlLikeText(value);
  return scan.status === "invalid" || scan.candidates.length > 0;
}
