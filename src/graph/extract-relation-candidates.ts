import type { List, ListItem, Nodes, PhrasingContent } from "mdast";
import { fromMarkdown } from "mdast-util-from-markdown";

import {
  createExternalReferenceNodeId,
  type GitHubNodeId,
  type SourceId,
} from "../domain/index.js";
import { assertNonNullable, UnreachableError } from "../util/index.js";
import { RelationReferenceConflictError, type RelationReferenceMismatch } from "./errors.js";
import { normalizeRelationCandidates } from "./normalize-relation-candidates.js";
import { buildRelationCandidateId } from "./relation-candidate-id.js";
import {
  type CandidateBlocksRelation,
  type CandidateImplementsRelation,
  type CandidateParentRelation,
  type CandidateUnclassifiedRelation,
  type ChecklistRelationCandidate,
  type ClosingKeywordRelationCandidate,
  type CrossReferenceRelationCandidate,
  type ExplicitTextRelationCandidate,
  type ExtractRelationCandidatesInput,
  type ExternalRelationCandidateNode,
  type NativeRelationCandidate,
  type OrganizationRelationCandidateNode,
  type PublicGitHubRelationItem,
  type RelationCandidate,
  type RelationCandidateNode,
  type RelationTextSource,
} from "./relation-candidate-types.js";

const CANONICAL_GITHUB_ITEM_URL_PATTERN =
  /^https:\/\/github\.com\/([a-z\d](?:[a-z\d-]{0,38}))\/([a-z\d_.-]+)\/(issues|pull)\/([1-9]\d*)$/iu;
const GITHUB_ITEM_URL_IN_TEXT_PATTERN =
  /https:\/\/github\.com\/([a-z\d](?:[a-z\d-]{0,38}))\/([a-z\d_.-]+)\/(issues|pull)\/([1-9]\d*)/giu;
const GITHUB_SHORTHAND_IN_TEXT_PATTERN =
  /(?<![a-z\d_.-])(?:([a-z\d](?:[a-z\d-]{0,38}))\/([a-z\d_.-]+))?#([1-9]\d*)(?![a-z\d_])/giu;
const MARKDOWN_REFERENCE_SYNTAX_PATTERN = /\[([^\]\n]+)\]\[([^\]\n]*)\]/gu;
const TASK_LIST_MARKER_PATTERN = /^\[[ xX]\](?:[ \t]|$)/u;
const CLOSING_KEYWORD_PATTERN =
  /(?:^|[\s(,:;])(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s*:?\s*$/iu;

type ParsedGitHubItemUrl = Readonly<{
  repositoryOwner: string;
  repositoryName: string;
  itemType: "issue" | "pull_request";
  number: number;
}>;

type MarkdownDefinitionIndex = ReadonlyMap<string, string>;

type MarkdownReferenceContext =
  | Readonly<{
      status: "available";
      repositoryOwner: string;
      repositoryName: string;
    }>
  | Readonly<{
      status: "unavailable";
    }>;

type MarkdownReference = Readonly<{
  repositoryOwner: string;
  repositoryName: string;
  itemType: "issue" | "pull_request" | null;
  number: number;
  syntax: "github_url" | "repository_shorthand" | "local_shorthand";
  start: number;
  end: number;
}>;

type ReferenceIndex = Readonly<{
  byAlias: ReadonlyMap<string, PublicGitHubRelationItem>;
  byNodeId: ReadonlyMap<GitHubNodeId, PublicGitHubRelationItem>;
}>;

type CandidateTemplate =
  | Omit<NativeRelationCandidate, "sourceIds">
  | Omit<ExplicitTextRelationCandidate, "sourceIds">
  | Omit<ClosingKeywordRelationCandidate, "sourceIds">
  | Omit<ChecklistRelationCandidate, "sourceIds">
  | Omit<CrossReferenceRelationCandidate, "sourceIds">;

function parseCanonicalGitHubItemUrl(value: string): ParsedGitHubItemUrl | null {
  const match = CANONICAL_GITHUB_ITEM_URL_PATTERN.exec(value);
  if (match == null) {
    return null;
  }
  const repositoryOwner = match[1];
  const repositoryName = match[2];
  const itemPath = match[3];
  const numberText = match[4];
  assertNonNullable(repositoryOwner, "GitHub URLからownerを取得できません");
  assertNonNullable(repositoryName, "GitHub URLからrepository名を取得できません");
  assertNonNullable(itemPath, "GitHub URLから項目種別を取得できません");
  assertNonNullable(numberText, "GitHub URLから項目番号を取得できません");
  const number = Number(numberText);
  if (!Number.isSafeInteger(number)) {
    return null;
  }
  return Object.freeze({
    repositoryOwner,
    repositoryName,
    itemType: itemPath === "issues" ? "issue" : "pull_request",
    number,
  });
}

function aliasKey(repositoryOwner: string, repositoryName: string, number: number): string {
  return `${repositoryOwner.toLowerCase()}/${repositoryName.toLowerCase()}#${number.toString()}`;
}

function validatePublicItem(item: PublicGitHubRelationItem): void {
  if (item.repositoryOwner.length === 0 || item.repositoryName.length === 0) {
    throw new TypeError("公開参照項目のrepository情報は空にできません");
  }
  if (
    typeof item.repositoryArchived !== "boolean" ||
    typeof item.repositoryDisabled !== "boolean"
  ) {
    throw new TypeError("公開参照項目のrepository状態はbooleanで指定してください");
  }
  if (!Number.isSafeInteger(item.number) || item.number <= 0) {
    throw new TypeError("公開参照項目の番号は正の安全な整数で指定してください");
  }
  if (item.type === "issue" && item.state === "merged") {
    throw new TypeError("Issueの状態にmergedは指定できません");
  }
  const parsedUrl = parseCanonicalGitHubItemUrl(item.url);
  if (
    parsedUrl?.repositoryOwner.toLowerCase() !== item.repositoryOwner.toLowerCase() ||
    parsedUrl.repositoryName.toLowerCase() !== item.repositoryName.toLowerCase() ||
    parsedUrl.itemType !== item.type ||
    parsedUrl.number !== item.number
  ) {
    throw new TypeError("公開参照項目のURLとmetadataが一致しません");
  }
}

function samePublicItem(left: PublicGitHubRelationItem, right: PublicGitHubRelationItem): boolean {
  return (
    left.nodeId === right.nodeId &&
    left.repositoryOwner.toLowerCase() === right.repositoryOwner.toLowerCase() &&
    left.repositoryName.toLowerCase() === right.repositoryName.toLowerCase() &&
    left.repositoryArchived === right.repositoryArchived &&
    left.repositoryDisabled === right.repositoryDisabled &&
    left.type === right.type &&
    left.number === right.number &&
    left.url === right.url &&
    left.state === right.state
  );
}

function findRelationReferenceMismatches(
  existing: PublicGitHubRelationItem,
  incoming: PublicGitHubRelationItem,
): readonly RelationReferenceMismatch[] {
  const mismatches: RelationReferenceMismatch[] = [];
  if (existing.nodeId !== incoming.nodeId) {
    mismatches.push({ field: "nodeId" });
  }
  if (existing.repositoryOwner.toLowerCase() !== incoming.repositoryOwner.toLowerCase()) {
    mismatches.push({ field: "repositoryOwner" });
  }
  if (existing.repositoryName.toLowerCase() !== incoming.repositoryName.toLowerCase()) {
    mismatches.push({ field: "repositoryName" });
  }
  if (existing.repositoryArchived !== incoming.repositoryArchived) {
    mismatches.push({
      field: "repositoryArchived",
      existingValue: existing.repositoryArchived,
      incomingValue: incoming.repositoryArchived,
    });
  }
  if (existing.repositoryDisabled !== incoming.repositoryDisabled) {
    mismatches.push({
      field: "repositoryDisabled",
      existingValue: existing.repositoryDisabled,
      incomingValue: incoming.repositoryDisabled,
    });
  }
  if (existing.type !== incoming.type) {
    mismatches.push({
      field: "type",
      existingValue: existing.type,
      incomingValue: incoming.type,
    });
  }
  if (existing.number !== incoming.number) {
    mismatches.push({ field: "number" });
  }
  if (existing.url !== incoming.url) {
    mismatches.push({ field: "url" });
  }
  if (existing.state !== incoming.state) {
    mismatches.push({
      field: "state",
      existingValue: existing.state,
      incomingValue: incoming.state,
    });
  }
  return Object.freeze(mismatches);
}

function createReferenceIndex(input: ExtractRelationCandidatesInput): ReferenceIndex {
  const byAlias = new Map<string, PublicGitHubRelationItem>();
  const byNodeId = new Map<GitHubNodeId, PublicGitHubRelationItem>();
  const embeddedItems = [
    ...input.item.nativeDependencies.map((source) => source.relatedItem),
    ...input.item.nativeHierarchy.map((source) => source.relatedItem),
    ...input.item.nativeClosingIssues.map((source) => source.relatedItem),
    ...input.item.crossReferences.map((source) => source.sourceItem),
  ];
  const items = [input.item, ...input.knownItems, ...embeddedItems];

  for (const item of items) {
    validatePublicItem(item);
    const existingByNodeId = byNodeId.get(item.nodeId);
    if (existingByNodeId != null && !samePublicItem(existingByNodeId, item)) {
      throw new RelationReferenceConflictError(
        "node_id",
        findRelationReferenceMismatches(existingByNodeId, item),
      );
    }
    const key = aliasKey(item.repositoryOwner, item.repositoryName, item.number);
    const existingByAlias = byAlias.get(key);
    if (existingByAlias != null && existingByAlias.nodeId !== item.nodeId) {
      throw new RelationReferenceConflictError(
        "repository_number",
        findRelationReferenceMismatches(existingByAlias, item),
      );
    }
    byNodeId.set(item.nodeId, item);
    byAlias.set(key, item);
  }

  return Object.freeze({
    byAlias,
    byNodeId,
  });
}

function createOrganizationNode(item: PublicGitHubRelationItem): OrganizationRelationCandidateNode {
  return Object.freeze({
    scope: "organization",
    kind: item.type,
    nodeId: item.nodeId,
    repositoryOwner: item.repositoryOwner,
    repositoryName: item.repositoryName,
    number: item.number,
    url: item.url,
    state: item.state,
  });
}

function createExternalNode(item: PublicGitHubRelationItem): ExternalRelationCandidateNode {
  return Object.freeze({
    scope: "external_public",
    kind: "external_reference",
    nodeId: createExternalReferenceNodeId(`external:github:${item.nodeId}`),
    githubNodeId: item.nodeId,
    githubItemType: item.type,
    repositoryOwner: item.repositoryOwner,
    repositoryName: item.repositoryName,
    number: item.number,
    url: item.url,
    state: item.state,
  });
}

function resolveCandidateNode(
  item: PublicGitHubRelationItem,
  organization: string,
): RelationCandidateNode | null {
  if (item.repositoryArchived || item.repositoryDisabled) {
    return null;
  }
  if (item.repositoryOwner.toLowerCase() === organization.toLowerCase()) {
    return createOrganizationNode(item);
  }
  return createExternalNode(item);
}

function createCurrentNode(
  input: ExtractRelationCandidatesInput,
): OrganizationRelationCandidateNode {
  if (input.organization.length === 0) {
    throw new TypeError("対象Organizationは空にできません");
  }
  if (input.item.repositoryOwner.toLowerCase() !== input.organization.toLowerCase()) {
    throw new TypeError("抽出対象項目は対象Organization内でなければなりません");
  }
  if (input.item.repositoryArchived || input.item.repositoryDisabled) {
    throw new TypeError("抽出対象項目は非archiveかつ有効なrepositoryに置いてください");
  }
  return createOrganizationNode(input.item);
}

function resolveReferenceItem(
  reference: MarkdownReference,
  index: ReferenceIndex,
  organization: string,
): RelationCandidateNode | null {
  const item = index.byAlias.get(
    aliasKey(reference.repositoryOwner, reference.repositoryName, reference.number),
  );
  if (item == null || (reference.itemType != null && item.type !== reference.itemType)) {
    return null;
  }
  return resolveCandidateNode(item, organization);
}

function resolveNodeId(
  nodeId: GitHubNodeId,
  index: ReferenceIndex,
  organization: string,
): RelationCandidateNode | null {
  const item = index.byNodeId.get(nodeId);
  return item == null ? null : resolveCandidateNode(item, organization);
}

function childNodes(node: Nodes): readonly Nodes[] {
  switch (node.type) {
    case "root":
    case "blockquote":
    case "footnoteDefinition":
    case "list":
    case "listItem":
    case "paragraph":
    case "heading":
    case "link":
    case "linkReference":
    case "emphasis":
    case "strong":
    case "delete":
    case "table":
    case "tableRow":
    case "tableCell":
      return node.children;
    case "break":
    case "code":
    case "definition":
    case "footnoteReference":
    case "html":
    case "image":
    case "imageReference":
    case "inlineCode":
    case "text":
    case "thematicBreak":
    case "yaml":
      return Object.freeze([]);
  }
}

function collectDefinitionIndex(root: Nodes): MarkdownDefinitionIndex {
  const definitions = new Map<string, string>();

  function visit(node: Nodes): void {
    if (node.type === "definition" && !definitions.has(node.identifier)) {
      definitions.set(node.identifier, node.url);
      return;
    }
    for (const child of childNodes(node)) {
      visit(child);
    }
  }

  visit(root);
  return definitions;
}

function renderPhrasingNode(node: PhrasingContent, definitions: MarkdownDefinitionIndex): string {
  switch (node.type) {
    case "text":
      return node.value;
    case "break":
      return "\n";
    case "link":
      return ` ${node.url} `;
    case "linkReference": {
      const url = definitions.get(node.identifier);
      return url == null
        ? node.children.map((child) => renderPhrasingNode(child, definitions)).join("")
        : ` ${url} `;
    }
    case "delete":
    case "emphasis":
    case "strong":
      return node.children.map((child) => renderPhrasingNode(child, definitions)).join("");
    case "footnoteReference":
    case "html":
    case "image":
    case "imageReference":
    case "inlineCode":
      return "";
    default:
      throw new UnreachableError(node);
  }
}

function renderPhrasingChildren(
  children: readonly PhrasingContent[],
  definitions: MarkdownDefinitionIndex,
): string {
  return children.map((child) => renderPhrasingNode(child, definitions)).join("");
}

function isTaskListItem(item: ListItem, definitions: MarkdownDefinitionIndex): boolean {
  if (typeof item.checked === "boolean") {
    return true;
  }
  const firstParagraph = item.children.find((child) => child.type === "paragraph");
  if (firstParagraph == null) {
    return false;
  }
  return TASK_LIST_MARKER_PATTERN.test(
    renderPhrasingChildren(firstParagraph.children, definitions),
  );
}

function isReferenceBoundary(value: string, end: number): boolean {
  if (end === value.length) {
    return true;
  }
  const next = value[end];
  assertNonNullable(next, "参照の直後の文字を取得できません");
  if (/\s/u.test(next)) {
    return true;
  }
  if (next === ".") {
    const afterPeriod = value[end + 1];
    return afterPeriod == null || !/[a-z\d_]/iu.test(afterPeriod);
  }
  return /[,;:!'"）)\]】}>、。！？]/u.test(next);
}

function findMarkdownReferences(
  value: string,
  currentItem: MarkdownReferenceContext,
): readonly MarkdownReference[] {
  const references: MarkdownReference[] = [];

  for (const match of value.matchAll(GITHUB_ITEM_URL_IN_TEXT_PATTERN)) {
    const url = match[0];
    const repositoryOwner = match[1];
    const repositoryName = match[2];
    const itemPath = match[3];
    const numberText = match[4];
    assertNonNullable(repositoryOwner, "GitHub URL参照からownerを取得できません");
    assertNonNullable(repositoryName, "GitHub URL参照からrepository名を取得できません");
    assertNonNullable(itemPath, "GitHub URL参照から項目種別を取得できません");
    assertNonNullable(numberText, "GitHub URL参照から項目番号を取得できません");
    const end = match.index + url.length;
    const number = Number(numberText);
    if (!Number.isSafeInteger(number) || !isReferenceBoundary(value, end)) {
      continue;
    }
    references.push(
      Object.freeze({
        repositoryOwner,
        repositoryName,
        itemType: itemPath.toLowerCase() === "issues" ? "issue" : "pull_request",
        number,
        syntax: "github_url",
        start: match.index,
        end,
      }),
    );
  }

  for (const match of value.matchAll(GITHUB_SHORTHAND_IN_TEXT_PATTERN)) {
    const fullReference = match[0];
    const specifiedOwner = match[1];
    const specifiedRepository = match[2];
    const numberText = match[3];
    assertNonNullable(numberText, "GitHub短縮参照から項目番号を取得できません");
    if ((specifiedOwner == null) !== (specifiedRepository == null)) {
      throw new TypeError("GitHub短縮参照のownerとrepositoryの有無が一致しません");
    }
    const end = match.index + fullReference.length;
    const number = Number(numberText);
    if (!Number.isSafeInteger(number) || !isReferenceBoundary(value, end)) {
      continue;
    }
    let repositoryOwner: string;
    let repositoryName: string;
    if (specifiedOwner == null) {
      if (currentItem.status === "unavailable") {
        continue;
      }
      repositoryOwner = currentItem.repositoryOwner;
      repositoryName = currentItem.repositoryName;
    } else {
      assertNonNullable(specifiedRepository, "GitHub短縮参照からrepository名を取得できません");
      repositoryOwner = specifiedOwner;
      repositoryName = specifiedRepository;
    }
    references.push(
      Object.freeze({
        repositoryOwner,
        repositoryName,
        itemType: null,
        number,
        syntax:
          specifiedOwner == null && specifiedRepository == null
            ? "local_shorthand"
            : "repository_shorthand",
        start: match.index,
        end,
      }),
    );
  }

  return Object.freeze(
    references.sort((left, right) => {
      const startComparison = left.start - right.start;
      return startComparison !== 0 ? startComparison : right.end - left.end;
    }),
  );
}

export type RelationTextReference = Readonly<{
  repositoryOwner: string;
  repositoryName: string;
  itemType: "issue" | "pull_request" | null;
  number: number;
}>;

export type RelationTextParseResult =
  | Readonly<{
      status: "available";
      references: readonly RelationTextReference[];
    }>
  | Readonly<{
      status: "unknown";
      reason: "markdown_reference_definition";
    }>;

function hasUnknownMarkdownReferenceDefinition(
  node: Nodes,
  definitions: MarkdownDefinitionIndex,
): boolean {
  if (node.type === "linkReference" && !definitions.has(node.identifier)) {
    return true;
  }
  return childNodes(node).some((child) =>
    hasUnknownMarkdownReferenceDefinition(child, definitions),
  );
}

function normalizeMarkdownReferenceIdentifier(value: string): string {
  return value.trim().replace(/\s+/gu, " ").toLowerCase();
}

function hasUnknownMarkdownReferenceSyntax(
  value: string,
  definitions: MarkdownDefinitionIndex,
): boolean {
  for (const match of value.matchAll(MARKDOWN_REFERENCE_SYNTAX_PATTERN)) {
    const label = match[1];
    const identifier = match[2];
    assertNonNullable(label, "Markdown参照のlabelを取得できません");
    assertNonNullable(identifier, "Markdown参照のidentifierを取得できません");
    const referenceIdentifier = identifier.length === 0 ? label : identifier;
    const resolvedIdentifier = normalizeMarkdownReferenceIdentifier(referenceIdentifier);
    if (!definitions.has(resolvedIdentifier)) {
      return true;
    }
  }
  return false;
}

/** Markdownから時系列再構築に使える明示参照だけを抽出する。 */
export function parseRelationTextReferences(value: string): RelationTextParseResult {
  const tree = fromMarkdown(value);
  const definitions = collectDefinitionIndex(tree);
  if (hasUnknownMarkdownReferenceDefinition(tree, definitions)) {
    return Object.freeze({
      status: "unknown",
      reason: "markdown_reference_definition",
    });
  }
  const references: MarkdownReference[] = [];
  const unknownReferenceValues: string[] = [];
  visitMarkdownProse(tree, definitions, false, (renderedValue) => {
    if (hasUnknownMarkdownReferenceSyntax(renderedValue, definitions)) {
      unknownReferenceValues.push(renderedValue);
      return;
    }
    references.push(...findMarkdownReferences(renderedValue, { status: "unavailable" }));
  });
  if (unknownReferenceValues.length > 0) {
    return Object.freeze({
      status: "unknown",
      reason: "markdown_reference_definition",
    });
  }
  return Object.freeze({
    status: "available",
    references: Object.freeze(
      references
        .filter(
          (reference) =>
            reference.syntax === "github_url" || reference.syntax === "repository_shorthand",
        )
        .map(({ repositoryOwner, repositoryName, itemType, number }) =>
          Object.freeze({ repositoryOwner, repositoryName, itemType, number }),
        ),
    ),
  });
}

function isClosingReference(value: string, reference: MarkdownReference): boolean {
  const prefixStart = Math.max(0, reference.start - 64);
  return CLOSING_KEYWORD_PATTERN.test(value.slice(prefixStart, reference.start));
}

function replaceCandidateSourceIds(
  template: CandidateTemplate,
  sourceIds: readonly [SourceId, ...SourceId[]],
): RelationCandidate {
  switch (template.provenance) {
    case "native":
      return Object.freeze({ ...template, sourceIds });
    case "explicit_text":
      return Object.freeze({ ...template, sourceIds });
    case "closing_keyword":
      return Object.freeze({ ...template, sourceIds });
    case "checklist":
      return Object.freeze({ ...template, sourceIds });
    case "cross_reference":
      return Object.freeze({ ...template, sourceIds });
  }
}

class CandidateAccumulator {
  readonly #candidates: RelationCandidate[] = [];

  public add(template: CandidateTemplate, sourceId: SourceId): void {
    this.#candidates.push(replaceCandidateSourceIds(template, Object.freeze([sourceId])));
  }

  public values(): readonly RelationCandidate[] {
    return normalizeRelationCandidates(this.#candidates);
  }
}

function createNativeCandidate(
  relation: CandidateBlocksRelation | CandidateParentRelation | CandidateImplementsRelation,
): Omit<NativeRelationCandidate, "sourceIds"> {
  return Object.freeze({
    id: buildRelationCandidateId("native", relation),
    authority: "authoritative",
    provenance: "native",
    relation,
  });
}

function createExplicitTextCandidate(
  relation: CandidateUnclassifiedRelation,
): Omit<ExplicitTextRelationCandidate, "sourceIds"> {
  return Object.freeze({
    id: buildRelationCandidateId("explicit_text", relation),
    authority: "inferred",
    provenance: "explicit_text",
    relation,
  });
}

function createClosingKeywordCandidate(
  relation: CandidateImplementsRelation,
): Omit<ClosingKeywordRelationCandidate, "sourceIds"> {
  return Object.freeze({
    id: buildRelationCandidateId("closing_keyword", relation),
    authority: "inferred",
    provenance: "closing_keyword",
    relation,
  });
}

function createChecklistCandidate(
  relation: CandidateParentRelation,
): Omit<ChecklistRelationCandidate, "sourceIds"> {
  return Object.freeze({
    id: buildRelationCandidateId("checklist", relation),
    authority: "inferred",
    provenance: "checklist",
    relation,
  });
}

function createCrossReferenceCandidate(
  relation: CandidateUnclassifiedRelation | CandidateImplementsRelation,
): Omit<CrossReferenceRelationCandidate, "sourceIds"> {
  return Object.freeze({
    id: buildRelationCandidateId("cross_reference", relation),
    authority: "inferred",
    provenance: "cross_reference",
    relation,
  });
}

function isSameNode(left: RelationCandidateNode, right: RelationCandidateNode): boolean {
  return left.nodeId === right.nodeId;
}

function addNativeCandidates(
  input: ExtractRelationCandidatesInput,
  currentNode: OrganizationRelationCandidateNode,
  index: ReferenceIndex,
  candidates: CandidateAccumulator,
): void {
  for (const source of input.item.nativeDependencies) {
    const relatedNode = resolveNodeId(source.relatedItem.nodeId, index, input.organization);
    if (relatedNode == null || isSameNode(currentNode, relatedNode)) {
      continue;
    }
    const relation = Object.freeze(
      source.direction === "blocked_by"
        ? {
            type: "blocks",
            blocker: relatedNode,
            blocked: currentNode,
          }
        : {
            type: "blocks",
            blocker: currentNode,
            blocked: relatedNode,
          },
    ) satisfies CandidateBlocksRelation;
    candidates.add(createNativeCandidate(relation), source.sourceId);
  }

  for (const source of input.item.nativeHierarchy) {
    const relatedNode = resolveNodeId(source.relatedItem.nodeId, index, input.organization);
    if (relatedNode == null || isSameNode(currentNode, relatedNode)) {
      continue;
    }
    const relation = Object.freeze(
      source.relationship === "parent"
        ? {
            type: "parent_of",
            parent: relatedNode,
            subtask: currentNode,
          }
        : {
            type: "parent_of",
            parent: currentNode,
            subtask: relatedNode,
          },
    ) satisfies CandidateParentRelation;
    candidates.add(createNativeCandidate(relation), source.sourceId);
  }

  if (input.item.type !== "pull_request" && input.item.nativeClosingIssues.length > 0) {
    throw new TypeError("Issueにnative closing対象は指定できません");
  }
  for (const source of input.item.nativeClosingIssues) {
    const relatedNode = resolveNodeId(source.relatedItem.nodeId, index, input.organization);
    if (relatedNode == null || isSameNode(currentNode, relatedNode)) {
      continue;
    }
    const relation = Object.freeze({
      type: "implements",
      implementation: currentNode,
      target: relatedNode,
    }) satisfies CandidateImplementsRelation;
    candidates.add(createNativeCandidate(relation), source.sourceId);
  }
}

function addCrossReferenceCandidates(
  input: ExtractRelationCandidatesInput,
  currentNode: OrganizationRelationCandidateNode,
  index: ReferenceIndex,
  candidates: CandidateAccumulator,
): void {
  for (const source of input.item.crossReferences) {
    const sourceNode = resolveNodeId(source.sourceItem.nodeId, index, input.organization);
    if (sourceNode == null || isSameNode(currentNode, sourceNode)) {
      continue;
    }
    if (source.willCloseTarget) {
      const relation = Object.freeze({
        type: "implements",
        implementation: sourceNode,
        target: currentNode,
      }) satisfies CandidateImplementsRelation;
      candidates.add(createNativeCandidate(relation), source.sourceId);
      continue;
    }
    const relation = Object.freeze({
      type: "unclassified",
      referencing: sourceNode,
      referenced: currentNode,
    }) satisfies CandidateUnclassifiedRelation;
    candidates.add(createCrossReferenceCandidate(relation), source.sourceId);
  }
}

function visitMarkdownProse(
  node: Nodes,
  definitions: MarkdownDefinitionIndex,
  skipTaskListItems: boolean,
  consume: (value: string) => void,
): void {
  switch (node.type) {
    case "paragraph":
    case "heading":
    case "tableCell":
      consume(renderPhrasingChildren(node.children, definitions));
      return;
    case "listItem": {
      const skipDirectContent = skipTaskListItems && isTaskListItem(node, definitions);
      for (const child of node.children) {
        if (child.type === "list" || !skipDirectContent) {
          visitMarkdownProse(child, definitions, skipTaskListItems, consume);
        }
      }
      return;
    }
    case "code":
    case "definition":
    case "html":
    case "inlineCode":
    case "yaml":
      return;
    default:
      for (const child of childNodes(node)) {
        visitMarkdownProse(child, definitions, skipTaskListItems, consume);
      }
  }
}

function addTextCandidates(
  input: ExtractRelationCandidatesInput,
  currentNode: OrganizationRelationCandidateNode,
  index: ReferenceIndex,
  candidates: CandidateAccumulator,
  source: RelationTextSource,
  skipTaskListItems: boolean,
): void {
  const tree = fromMarkdown(source.markdown);
  const definitions = collectDefinitionIndex(tree);
  visitMarkdownProse(tree, definitions, skipTaskListItems, (value) => {
    for (const reference of findMarkdownReferences(value, {
      status: "available",
      repositoryOwner: input.item.repositoryOwner,
      repositoryName: input.item.repositoryName,
    })) {
      const referencedNode = resolveReferenceItem(reference, index, input.organization);
      if (referencedNode == null || isSameNode(currentNode, referencedNode)) {
        continue;
      }
      if (isClosingReference(value, reference)) {
        const relation = Object.freeze({
          type: "implements",
          implementation: currentNode,
          target: referencedNode,
        }) satisfies CandidateImplementsRelation;
        candidates.add(createClosingKeywordCandidate(relation), source.sourceId);
        continue;
      }
      const relation = Object.freeze({
        type: "unclassified",
        referencing: currentNode,
        referenced: referencedNode,
      }) satisfies CandidateUnclassifiedRelation;
      candidates.add(createExplicitTextCandidate(relation), source.sourceId);
    }
  });
}

function collectDirectChecklistReferences(
  item: ListItem,
  definitions: MarkdownDefinitionIndex,
  input: ExtractRelationCandidatesInput,
  index: ReferenceIndex,
): readonly RelationCandidateNode[] {
  const nodesById = new Map<string, RelationCandidateNode>();

  function visit(node: Nodes): void {
    switch (node.type) {
      case "list":
        return;
      case "paragraph":
      case "heading":
      case "tableCell": {
        const value = renderPhrasingChildren(node.children, definitions);
        for (const reference of findMarkdownReferences(value, {
          status: "available",
          repositoryOwner: input.item.repositoryOwner,
          repositoryName: input.item.repositoryName,
        })) {
          const resolvedNode = resolveReferenceItem(reference, index, input.organization);
          if (resolvedNode != null) {
            nodesById.set(resolvedNode.nodeId, resolvedNode);
          }
        }
        return;
      }
      case "code":
      case "definition":
      case "html":
      case "inlineCode":
      case "yaml":
        return;
      default:
        for (const child of childNodes(node)) {
          visit(child);
        }
    }
  }

  for (const child of item.children) {
    visit(child);
  }
  return Object.freeze(
    [...nodesById.values()].sort((left, right) => left.nodeId.localeCompare(right.nodeId)),
  );
}

function addChecklistCandidates(
  input: ExtractRelationCandidatesInput,
  currentNode: OrganizationRelationCandidateNode,
  index: ReferenceIndex,
  candidates: CandidateAccumulator,
): void {
  const tree = fromMarkdown(input.item.body.markdown);
  const definitions = collectDefinitionIndex(tree);

  function visitNestedLists(node: Nodes, parent: RelationCandidateNode): void {
    if (node.type === "list") {
      visitList(node, parent);
      return;
    }
    for (const child of childNodes(node)) {
      visitNestedLists(child, parent);
    }
  }

  function visitList(list: List, parent: RelationCandidateNode): void {
    for (const item of list.children) {
      let nestedParent = parent;
      if (isTaskListItem(item, definitions)) {
        const referencedNodes = collectDirectChecklistReferences(item, definitions, input, index);
        const distinctReferencedNodes = referencedNodes.filter(
          (referencedNode) => !isSameNode(parent, referencedNode),
        );
        for (const referencedNode of distinctReferencedNodes) {
          const relation = Object.freeze({
            type: "parent_of",
            parent,
            subtask: referencedNode,
          }) satisfies CandidateParentRelation;
          candidates.add(createChecklistCandidate(relation), input.item.body.sourceId);
        }
        if (distinctReferencedNodes.length === 1) {
          const onlyReferencedNode = distinctReferencedNodes[0];
          assertNonNullable(onlyReferencedNode, "checklistの参照先を取得できません");
          nestedParent = onlyReferencedNode;
        }
      }
      for (const child of item.children) {
        visitNestedLists(child, nestedParent);
      }
    }
  }

  for (const child of tree.children) {
    visitNestedLists(child, currentNode);
  }
}

/** 公開GitHub項目の各sourceから決定論的な関係候補を抽出する。 */
export function extractRelationCandidates(
  input: ExtractRelationCandidatesInput,
): readonly RelationCandidate[] {
  const currentNode = createCurrentNode(input);
  const index = createReferenceIndex(input);
  const candidates = new CandidateAccumulator();

  addNativeCandidates(input, currentNode, index, candidates);
  addCrossReferenceCandidates(input, currentNode, index, candidates);
  if (input.item.type === "issue") {
    addChecklistCandidates(input, currentNode, index, candidates);
  }
  addTextCandidates(
    input,
    currentNode,
    index,
    candidates,
    input.item.body,
    input.item.type === "issue",
  );
  for (const comment of input.item.comments) {
    addTextCandidates(input, currentNode, index, candidates, comment, false);
  }

  return candidates.values();
}
