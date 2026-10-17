import { fromMarkdown } from "mdast-util-from-markdown";

import { assertNonNullable } from "../util/index.js";

/** 原文位置を保持して復号するHTML文字参照のpattern。 */
export const HTML_CHARACTER_REFERENCE_PATTERN =
  /&(?:#[xX][0-9a-f]{1,6}|#[0-9]{1,7}|[A-Za-z][A-Za-z0-9]{1,31});/giu;

type HtmlTag =
  | Readonly<{ kind: "other" }>
  | Readonly<{ kind: "invalid" }>
  | Readonly<{ kind: "close"; name: string }>
  | Readonly<{
      kind: "open";
      name: string;
      attributes: readonly Readonly<{
        name: string;
        span: Readonly<{ start: number; end: number }>;
        value: string;
      }>[];
    }>;

type HtmlTextPart = Readonly<{ span: Readonly<{ start: number; end: number }>; value: string }>;
type HtmlTextField = Readonly<{ context: "url" | "text"; parts: readonly HtmlTextPart[] }>;

/** HTML文字参照をMarkdownのparserと同じ規則で復号する。 */
export function decodeHtmlCharacterReference(value: string): string {
  const paragraph = fromMarkdown(value).children[0];
  assertNonNullable(paragraph, "文字参照の表示値を取得できません");
  if (paragraph.type !== "paragraph" || paragraph.children.length !== 1) {
    throw new TypeError("文字参照の表示値を解釈できません");
  }
  const child = paragraph.children[0];
  assertNonNullable(child, "文字参照の表示値を取得できません");
  if (child.type !== "text") throw new TypeError("文字参照の表示値を解釈できません");
  return child.value;
}

function decodedHtmlValue(
  value: string,
  context: "attribute" | "text",
): Readonly<{ status: "valid"; value: string }> | Readonly<{ status: "invalid" }> {
  const completeReference = /^&(?:#[xX][0-9a-f]{1,6}|#[0-9]{1,7}|[A-Za-z][A-Za-z0-9]{1,31});$/iu;
  const optionalSemicolonReference =
    /^&(?:AElig|AMP|Aacute|Acirc|Agrave|Aring|Atilde|Auml|COPY|Ccedil|ETH|Eacute|Ecirc|Egrave|Euml|GT|Iacute|Icirc|Igrave|Iuml|LT|Ntilde|Oacute|Ocirc|Ograve|Oslash|Otilde|Ouml|QUOT|REG|THORN|Uacute|Ucirc|Ugrave|Uuml|Yacute|aacute|acirc|acute|aelig|agrave|amp|aring|atilde|auml|brvbar|ccedil|cedil|cent|copy|curren|deg|divide|eacute|ecirc|egrave|eth|euml|frac12|frac14|frac34|gt|iacute|icirc|iexcl|igrave|iquest|iuml|laquo|lt|macr|micro|middot|nbsp|not|ntilde|oacute|ocirc|ograve|ordf|ordm|oslash|otilde|ouml|para|plusmn|pound|quot|raquo|reg|sect|shy|sup1|sup2|sup3|szlig|thorn|times|uacute|ucirc|ugrave|uml|uuml|yacute|yen|yuml)/u;
  for (const match of value.matchAll(/&(?:#[^&;\t\r\n "'<>]*;?|[A-Za-z][A-Za-z0-9]*;?)/gu)) {
    const reference = match[0];
    if (reference.startsWith("&#")) {
      if (!completeReference.test(reference)) return { status: "invalid" };
    } else if (reference.endsWith(";") && decodeHtmlCharacterReference(reference) !== reference) {
      continue;
    } else {
      const prefix = optionalSemicolonReference.exec(reference)?.[0];
      if (
        prefix != null &&
        (context === "text" || !/[A-Za-z0-9=]/u.test(value.charAt(match.index + prefix.length)))
      ) {
        return { status: "invalid" };
      }
    }
  }
  return {
    status: "valid",
    value: value.replaceAll(HTML_CHARACTER_REFERENCE_PATTERN, decodeHtmlCharacterReference),
  };
}

function decodedHtmlTagAttributes(
  name: string,
  attributes: Extract<HtmlTag, { kind: "open" }>["attributes"],
): Extract<HtmlTag, { kind: "open" | "invalid" }> {
  const interpreted: Extract<HtmlTag, { kind: "open" }>["attributes"][number][] = [];
  for (const attribute of attributes) {
    const decoded = decodedHtmlValue(attribute.value, "attribute");
    if (decoded.status === "invalid") return { kind: "invalid" };
    interpreted.push({ ...attribute, value: decoded.value });
  }
  return { kind: "open", name, attributes: interpreted };
}

/** 完全なHTML tagから属性値と原文範囲を取得する。 */
function htmlTag(value: string): HtmlTag {
  const tagName = /^<\/?(a|br|p|h[1-6])(?=[ \t\r\n/>])/iu.exec(value)?.[1]?.toLowerCase();
  if (tagName == null) return { kind: "other" };
  if (value.startsWith("</")) {
    return /^<\/[A-Za-z0-9]+[ \t\r\n]*>$/u.test(value)
      ? { kind: "close", name: tagName }
      : { kind: "invalid" };
  }
  const spacing = /[ \t\r\n]+/uy;
  const attribute =
    /([A-Za-z_:][A-Za-z0-9_.:-]*)(?:[ \t\r\n]*=[ \t\r\n]*(?:"([^"]*)"|'([^']*)'|([^ \t\r\n"'=<>`]+)))?/duy;
  const attributes: Extract<HtmlTag, { kind: "open" }>["attributes"][number][] = [];
  let index = tagName.length + 1;
  while (index < value.length) {
    spacing.lastIndex = index;
    const space = spacing.exec(value);
    if (space != null) index = spacing.lastIndex;
    if (
      (value.charAt(index) === ">" && index + 1 === value.length) ||
      (value.charAt(index) === "/" && value.charAt(index + 1) === ">" && index + 2 === value.length)
    ) {
      return decodedHtmlTagAttributes(tagName, attributes);
    }
    if (space == null) return { kind: "invalid" };
    attribute.lastIndex = index;
    const matched = attribute.exec(value);
    if (matched == null) return { kind: "invalid" };
    const name = matched[1];
    assertNonNullable(name, "HTML属性名を取得できません");
    const span = matched.indices?.[2] ?? matched.indices?.[3] ?? matched.indices?.[4];
    if (span != null) {
      attributes.push({
        name: name.toLowerCase(),
        span: { start: span[0], end: span[1] },
        value: value.slice(span[0], span[1]),
      });
    }
    index = attribute.lastIndex;
  }
  return { kind: "invalid" };
}

/** 表示textのHTML境界として扱うtagの種別を取得する。 */
export function htmlDisplayTag(
  value: string,
):
  | Readonly<{ kind: "other" }>
  | Readonly<{ kind: "invalid" }>
  | Readonly<{ kind: "anchor" }>
  | Readonly<{ kind: "break"; labelAllowed: boolean }>
  | Readonly<{ kind: "decoration"; name: string; closing: boolean }> {
  const html = htmlTag(value);
  if (html.kind === "invalid") return { kind: "invalid" };
  if (html.kind !== "other") {
    return html.name === "a"
      ? { kind: "anchor" }
      : { kind: "break", labelAllowed: /^<(?:br\s*\/?|\/?p)>$/iu.test(value) };
  }
  const tag = /^<(\/?)(code|kbd|samp|span|strong|em|b|i|s|del|sub|sup|mark)>$/iu.exec(value);
  if (tag == null) return { kind: "other" };
  const name = tag[2];
  assertNonNullable(name, "MarkdownラベルのHTML tagを取得できません");
  return { kind: "decoration", name: name.toLowerCase(), closing: tag[1] === "/" };
}

function htmlTagEnd(value: string, start: number): number | "invalid" {
  if (value.startsWith("<!--", start) || value.startsWith("<![CDATA[", start)) {
    const terminator = value.startsWith("<!--", start) ? "-->" : "]]>";
    const end = value.indexOf(terminator, start + 1);
    return end < 0 ? "invalid" : end + terminator.length;
  }
  let quote: "unquoted" | '"' | "'" = "unquoted";
  for (let index = start + 1; index < value.length; index += 1) {
    const character = value.charAt(index);
    if (quote !== "unquoted") {
      if (character === quote) quote = "unquoted";
    } else if (character === '"' || character === "'") {
      quote = character;
    } else if (character === ">") {
      return index + 1;
    } else if (character === "<") {
      return "invalid";
    }
  }
  return "invalid";
}

/** HTML blockとinline tagから属性値と表示textの原文範囲を取得する。 */
export function htmlTextFields(
  value: string,
):
  | Readonly<{ status: "invalid" }>
  | Readonly<{ status: "valid"; fields: readonly HtmlTextField[] }> {
  const fields: HtmlTextField[] = [];
  const display: HtmlTextPart[] = [];
  const boundaries: Readonly<{ start: number; end: number }>[] = [];
  let displayLength = 0;
  function appendText(start: number, end: number): boolean {
    if (start === end) return true;
    const decoded = decodedHtmlValue(value.slice(start, end), "text");
    if (decoded.status === "invalid") return false;
    display.push({ span: { start, end }, value: decoded.value });
    displayLength += decoded.value.length;
    return true;
  }
  let start = 0;
  for (const match of value.matchAll(/<(?=\/?[A-Za-z]|!|\?)/gu)) {
    if (match.index < start) continue;
    if (!appendText(start, match.index)) return { status: "invalid" };
    const end = htmlTagEnd(value, match.index);
    if (end === "invalid") return { status: "invalid" };
    const raw = value.slice(match.index, end);
    const html = htmlTag(raw);
    if (html.kind === "invalid") return { status: "invalid" };
    if (html.kind === "open") {
      for (const attribute of html.attributes) {
        fields.push({
          context: attribute.name === "href" ? "url" : "text",
          parts: [
            {
              span: {
                start: match.index + attribute.span.start,
                end: match.index + attribute.span.end,
              },
              value: attribute.value,
            },
          ],
        });
      }
    }
    const tag = htmlDisplayTag(raw);
    if (tag.kind === "invalid") return { status: "invalid" };
    if (tag.kind === "break" || tag.kind === "other") {
      const displayed = tag.kind === "break" ? "\n" : raw;
      display.push({ span: { start: match.index, end }, value: displayed });
      if (tag.kind === "other")
        appendHtmlBoundarySpan(boundaries, displayLength, displayLength + displayed.length);
      displayLength += displayed.length;
    }
    start = end;
  }
  if (!appendText(start, value.length)) return { status: "invalid" };
  const displayed = display.map((part) => part.value).join("");
  if (
    boundaries.some(
      (span) =>
        isHtmlReferenceFragment(displayed.charAt(span.start - 1)) &&
        isHtmlReferenceFragment(displayed.charAt(span.end)),
    )
  )
    return { status: "invalid" };
  if (displayed.length > 0 && displayed !== value) fields.push({ context: "text", parts: display });
  return { status: "valid", fields };
}

/** 連続するHTMLの表示範囲を一つの境界へまとめる。 */
export function appendHtmlBoundarySpan(
  boundaries: Readonly<{ start: number; end: number }>[],
  start: number,
  end: number,
): void {
  const previous = boundaries.at(-1);
  if (previous?.end === start) {
    boundaries[boundaries.length - 1] = { start: previous.start, end };
  } else {
    boundaries.push({ start, end });
  }
}

/** HTMLの前後で参照断片を連結し得る文字か判定する。 */
export function isHtmlReferenceFragment(character: string): boolean {
  return (
    /[A-Za-z0-9_.:/%+-]/u.test(character.normalize("NFKC")) ||
    /[\p{Mark}\p{Format}]/u.test(character)
  );
}
