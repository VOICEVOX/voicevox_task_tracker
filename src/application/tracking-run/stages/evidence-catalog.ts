import { serializeCanonicalJson } from "../../../canonical-json/value.js";
import { parseSourceId } from "../../../domain/source-id.js";
import type { Evidence } from "../../../domain/types.js";
import { isProductionSourceIdKind } from "../../../github/production-source-id.js";
import type {
  CurrentSourceFact,
  EvidenceAnnotation,
  EvidenceCatalogSnapshot,
  EvidenceRoleAssignment,
  EvidenceUseScope,
  HistoricalEvidenceRecord,
  ItemSourceKind,
  SharedSourceKind,
} from "../contracts/evidence-catalog.js";

const sourceScopeByKind = {
  github_actor: "shared",
  github_user: "shared",
  github_team: "shared",
  github_item: "shared",
  github_issue_comment: "item",
  github_commit: "shared",
  github_pull_request_commit: "item",
  github_timeline_event: "item",
  github_label: "shared",
  github_inbound_cross_reference: "item",
  github_pull_request_review: "item",
  github_pull_request_review_comment: "item",
  github_pull_request_review_thread: "item",
  github_review_request: "item",
  github_native_closing_issue: "item",
  github_native_dependency: "item",
  github_native_hierarchy: "item",
  github_check_run: "shared",
  github_commit_status: "shared",
  github_status_check_rollup: "shared",
  github_auto_merge_request: "item",
  github_merge_queue_entry: "item",
  github_item_detail: "item",
  github_item_body: "item",
} satisfies Readonly<Record<SharedSourceKind, "shared"> & Record<ItemSourceKind, "item">>;

function compareStrings(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function sortCanonical<Value>(values: Iterable<Value>): readonly Value[] {
  return Object.freeze(
    [...values].sort((left, right) =>
      compareStrings(serializeCanonicalJson(left), serializeCanonicalJson(right)),
    ),
  );
}

function canonicalEvidence(evidence: Evidence): Evidence {
  parseSourceId(evidence.sourceId);
  return Object.freeze({
    sourceId: evidence.sourceId,
    supports: evidence.supports,
    summary: evidence.summary,
  });
}

function assertSourceFact(fact: CurrentSourceFact): void {
  const parts = parseSourceId(fact.sourceId);
  if (!isProductionSourceIdKind(parts.kind) || parts.kind !== fact.sourceKind) {
    throw new TypeError(`収集source IDの種別がrecordと一致しません。対象: ${fact.sourceId}`);
  }
  if (sourceScopeByKind[fact.sourceKind] !== fact.scope) {
    throw new TypeError(`収集sourceの所有範囲が種別と一致しません。対象: ${fact.sourceId}`);
  }
}

function assertCompatibleSourceFacts(left: CurrentSourceFact, right: CurrentSourceFact): void {
  if (left.sourceKind !== right.sourceKind || left.scope !== right.scope) {
    throw new TypeError(
      `同じsource IDの種別または所有範囲が衝突しています。対象: ${left.sourceId}`,
    );
  }
  if (left.scope === "item" && right.scope === "item" && left.itemNodeId !== right.itemNodeId) {
    throw new TypeError(`同じsource IDの所有項目が衝突しています。対象: ${left.sourceId}`);
  }
  const rightFields = new Map(Object.entries(right.immutable));
  for (const [key, value] of Object.entries(left.immutable)) {
    if (
      rightFields.has(key) &&
      serializeCanonicalJson(value) !== serializeCanonicalJson(rightFields.get(key))
    ) {
      throw new TypeError(`同じsource IDの不変fieldが衝突しています。対象: ${left.sourceId}`);
    }
  }
}

/** 現行sourceと履歴根拠を登録し、完全一致だけを併合する。 */
export class EvidenceCatalog {
  private readonly currentSourcesById = new Map<string, Map<string, CurrentSourceFact>>();
  private readonly historicalRecordsByIdentity = new Map<string, HistoricalEvidenceRecord>();
  private readonly annotationsByIdentity = new Map<string, EvidenceAnnotation>();
  private readonly rolesByScope = new Map<
    string,
    Readonly<{
      sourceId: EvidenceRoleAssignment["sourceId"];
      scope: EvidenceUseScope;
      roles: Set<EvidenceRoleAssignment["roles"][number]>;
    }>
  >();
  private readonly evidenceByIdentity = new Map<string, Evidence>();

  /** 今回の収集recordから確認したsource事実を登録する。 */
  public registerCurrentSource(fact: CurrentSourceFact): void {
    assertSourceFact(fact);
    const known =
      this.currentSourcesById.get(fact.sourceId) ?? new Map<string, CurrentSourceFact>();
    for (const previous of known.values()) {
      assertCompatibleSourceFacts(previous, fact);
    }
    known.set(serializeCanonicalJson(fact), fact);
    this.currentSourcesById.set(fact.sourceId, known);
  }

  /** 履歴根拠の三字段と保存位置をそのまま登録する。 */
  public registerHistoricalEvidence(record: HistoricalEvidenceRecord): void {
    const evidence = canonicalEvidence(record.evidence);
    const preserved = Object.freeze({
      status: "historical",
      location: record.location,
      evidence,
    } satisfies HistoricalEvidenceRecord);
    this.historicalRecordsByIdentity.set(serializeCanonicalJson(preserved), preserved);
    this.evidenceByIdentity.set(serializeCanonicalJson(evidence), evidence);
  }

  /** 利用範囲ごとに根拠の文章を登録する。 */
  public addAnnotation(annotation: EvidenceAnnotation): void {
    const evidence = canonicalEvidence(annotation.evidence);
    const preserved = Object.freeze({ scope: annotation.scope, evidence });
    this.annotationsByIdentity.set(serializeCanonicalJson(preserved), preserved);
    this.evidenceByIdentity.set(serializeCanonicalJson(evidence), evidence);
  }

  /** source IDと利用範囲をキーに役割を集合併合する。 */
  public addRole(
    sourceId: EvidenceRoleAssignment["sourceId"],
    scope: EvidenceUseScope,
    role: EvidenceRoleAssignment["roles"][number],
  ): void {
    parseSourceId(sourceId);
    const key = serializeCanonicalJson([sourceId, scope]);
    const existing = this.rolesByScope.get(key);
    if (existing == null) {
      this.rolesByScope.set(key, { sourceId, scope, roles: new Set([role]) });
      return;
    }
    existing.roles.add(role);
  }

  /** 登録済みの事実と用途別根拠を決定論的順序で返す。 */
  public snapshot(): EvidenceCatalogSnapshot {
    return Object.freeze({
      currentSources: sortCanonical(
        [...this.currentSourcesById.values()].flatMap((values) => [...values.values()]),
      ),
      historicalRecords: sortCanonical(this.historicalRecordsByIdentity.values()),
      annotations: sortCanonical(this.annotationsByIdentity.values()),
      roles: sortCanonical(
        [...this.rolesByScope.values()].map(({ sourceId, scope, roles }) =>
          Object.freeze({ sourceId, scope, roles: Object.freeze([...roles].sort(compareStrings)) }),
        ),
      ),
      evidence: sortCanonical(this.evidenceByIdentity.values()),
    });
  }
}
