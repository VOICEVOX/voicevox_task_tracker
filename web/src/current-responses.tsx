import {
  type PublicPersonalReminderResponseDto,
  type PublicSummaryDto,
} from "../../src/pages/public-dto.js";
import { UnreachableError, assertNonNullable } from "../../src/util/index.js";
import { ItemDetailsLink } from "./item-details.js";
import {
  currentResponseRoleLabel,
  currentResponseStatusLabel,
  currentResponseUnknownReasonLabel,
} from "./model.js";
import { SafeGitHubLink } from "./safe-link.js";
import { Pill } from "./ui.js";
import { PersonLink, type PersonNavigation } from "./waiting-on-display.js";

type CurrentResponse = PublicPersonalReminderResponseDto;

type CurrentResponsesProps = PersonNavigation &
  Readonly<{
    createItemHref: (nodeId: string) => string;
    onSelectItem: (nodeId: string) => void;
    summary: PublicSummaryDto;
    responses: readonly CurrentResponse[];
    variant: "compact" | "detail" | "nested";
  }>;

function responseTone(response: CurrentResponse): "danger" | "info" | "success" {
  switch (response.status) {
    case "actionable":
      return "success";
    case "waiting":
      return "info";
    case "unknown":
      return "danger";
    default:
      throw new UnreachableError(response);
  }
}

function ResponseResponsible({
  createPersonHref,
  onSelectPerson,
  responsible,
}: PersonNavigation &
  Readonly<{
    responsible: CurrentResponse["responsible"][number];
  }>) {
  switch (responsible.kind) {
    case "user":
      return (
        <PersonLink
          createPersonHref={createPersonHref}
          login={responsible.candidateId}
          onSelectPerson={onSelectPerson}
          showAvatar={false}
        />
      );
    case "team":
      return <span>チーム {responsible.candidateId}</span>;
    case "role":
      return <span>{currentResponseRoleLabel(responsible.role)}の役割</span>;
    default:
      throw new TypeError(`現在の対応者のkindが不正です: ${responsible.kind}`);
  }
}

function ResponseResponsibleList({
  createPersonHref,
  onSelectPerson,
  response,
}: PersonNavigation &
  Readonly<{
    response: CurrentResponse;
  }>) {
  return (
    <span class="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1">
      {response.responsible.map((responsible, index) => (
        <span
          class="inline-flex min-w-0 items-center gap-1.5"
          key={`${responsible.kind}:${responsible.candidateId}:${responsible.role}`}
        >
          {index > 0 && <span aria-hidden="true">、</span>}
          <ResponseResponsible
            createPersonHref={createPersonHref}
            onSelectPerson={onSelectPerson}
            responsible={responsible}
          />
        </span>
      ))}
    </span>
  );
}

function ResponseItemReference({
  createItemHref,
  itemNodeId,
  onSelectItem,
  summary,
}: Readonly<{
  createItemHref: (nodeId: string) => string;
  itemNodeId: string;
  onSelectItem: (nodeId: string) => void;
  summary: PublicSummaryDto;
}>) {
  const item = summary.items.find((candidate) => candidate.nodeId === itemNodeId);
  if (item != null) {
    return (
      <ItemDetailsLink
        href={createItemHref(item.nodeId)}
        nodeId={item.nodeId}
        onSelect={onSelectItem}
      >
        {item.displayReference} {item.title}
      </ItemDetailsLink>
    );
  }
  const graphNode = summary.graph.nodes.find((candidate) => candidate.nodeId === itemNodeId);
  assertNonNullable(graphNode, `現在の対応の待機先 ${itemNodeId} がsummaryにありません`);
  if (graphNode.kind !== "external_reference") {
    throw new TypeError(`現在の対応の待機先 ${itemNodeId} の表示名がありません`);
  }
  return <span>{graphNode.displayReference}</span>;
}

function CurrentResponseWaitingFor({
  createItemHref,
  onSelectItem,
  response,
  summary,
}: Readonly<{
  createItemHref: (nodeId: string) => string;
  onSelectItem: (nodeId: string) => void;
  response: Extract<CurrentResponse, Readonly<{ status: "waiting" }>>;
  summary: PublicSummaryDto;
}>) {
  return (
    <p class="m-0 text-sm text-text-secondary wrap-anywhere">
      <span class="font-bold">待機先:</span>{" "}
      <ResponseItemReference
        createItemHref={createItemHref}
        itemNodeId={response.waitingFor.itemNodeId}
        onSelectItem={onSelectItem}
        summary={summary}
      />
      <span> の{response.waitingFor.action}</span>
    </p>
  );
}

function CurrentResponseEvidence({ response }: Readonly<{ response: CurrentResponse }>) {
  return (
    <div class="current-response-evidence grid gap-1">
      <strong class="text-xs text-text-muted">根拠</strong>
      <ul class="m-0 grid list-disc gap-1 pl-5 text-sm text-text-secondary">
        {response.evidence.map((evidence, index) => (
          <li key={`${evidence.sourceUrl}:${index.toString()}`}>
            <span>{evidence.summary}</span>{" "}
            <SafeGitHubLink href={evidence.sourceUrl} variant="inline">
              GitHub上の根拠
            </SafeGitHubLink>
          </li>
        ))}
      </ul>
    </div>
  );
}

function CurrentResponseRow({
  createItemHref,
  createPersonHref,
  onSelectItem,
  onSelectPerson,
  response,
  summary,
  variant,
}: Omit<CurrentResponsesProps, "item" | "responses"> & Readonly<{ response: CurrentResponse }>) {
  const status = (
    <Pill className="current-response-status" tone={responseTone(response)}>
      {currentResponseStatusLabel(response.status)}
    </Pill>
  );
  const responsible = (
    <ResponseResponsibleList
      createPersonHref={createPersonHref}
      onSelectPerson={onSelectPerson}
      response={response}
    />
  );
  const details = (
    <>
      {response.status === "waiting" && (
        <CurrentResponseWaitingFor
          createItemHref={createItemHref}
          onSelectItem={onSelectItem}
          response={response}
          summary={summary}
        />
      )}
      {response.status === "unknown" && (
        <p class="m-0 text-sm text-state-danger-text wrap-anywhere">
          判定理由: {currentResponseUnknownReasonLabel(response.reason)}
        </p>
      )}
      {variant === "detail" && <CurrentResponseEvidence response={response} />}
    </>
  );

  if (variant === "compact") {
    return (
      <li class="current-response-compact-item grid min-w-0 gap-0.5">
        <div class="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          {status}
          <strong class="min-w-0 wrap-anywhere">{responsible}</strong>
        </div>
        <p class="m-0 text-sm text-text-primary wrap-anywhere">{response.action.summary}</p>
        {details}
      </li>
    );
  }

  return (
    <li class="current-response-item min-w-0 border-l-2 border-border-default pl-3">
      <div class="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
        {status}
        <strong class="min-w-0 wrap-anywhere">{responsible}</strong>
      </div>
      <p class="mt-1 mb-0 text-lg font-bold text-text-primary wrap-anywhere">
        {response.action.summary}
      </p>
      <div class="mt-2 grid min-w-0 gap-2">{details}</div>
    </li>
  );
}

/** currentResponsesから現在の対応者、行動、根拠を表示する。 */
export function CurrentResponses({
  createItemHref,
  createPersonHref,
  onSelectItem,
  onSelectPerson,
  summary,
  responses,
  variant,
}: CurrentResponsesProps) {
  const list =
    responses.length === 0 ? (
      <p class="m-0 text-sm text-text-muted">現在の対応はありません。</p>
    ) : (
      <ul class="current-responses-list m-0 grid list-none gap-3 p-0">
        {responses.map((response) => (
          <CurrentResponseRow
            key={response.causeId}
            createItemHref={createItemHref}
            createPersonHref={createPersonHref}
            onSelectItem={onSelectItem}
            onSelectPerson={onSelectPerson}
            response={response}
            summary={summary}
            variant={variant}
          />
        ))}
      </ul>
    );

  if (variant === "detail") {
    return (
      <section
        aria-labelledby="current-responses-heading"
        class="current-responses-detail grid min-w-0 gap-3 border-t border-border-subtle pt-5 lg:col-span-2"
      >
        <h4
          id="current-responses-heading"
          class="m-0 font-display text-base leading-snug font-semibold"
        >
          現在の対応
        </h4>
        {list}
      </section>
    );
  }
  if (variant === "nested") {
    return <div class="current-responses-nested min-w-0">{list}</div>;
  }
  return <div class="current-responses-compact min-w-0">{list}</div>;
}
