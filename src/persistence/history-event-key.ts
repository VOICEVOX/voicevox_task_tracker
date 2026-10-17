type HistoryEventKeyInput =
  | Readonly<{
      kind: "responsibility_set" | "responsibility_removed" | "severity_set" | "severity_removed";
      nodeId: string;
    }>
  | Readonly<{ kind: "edge_set" | "edge_removed"; relationId: string }>
  | Readonly<{ kind: "repository_excluded"; repositoryFullName: string }>
  | Readonly<{ kind: "notification_sent"; deliveryId: string; itemNodeId: string }>;

/** 履歴eventの対象と分類から安定した識別キーを作る。 */
export function historyEventKey(event: HistoryEventKeyInput): string {
  switch (event.kind) {
    case "responsibility_set":
    case "responsibility_removed":
      return `responsibility:${event.nodeId}`;
    case "severity_set":
    case "severity_removed":
      return `severity:${event.nodeId}`;
    case "edge_set":
    case "edge_removed":
      return `edge:${event.relationId}`;
    case "repository_excluded":
      return `repository_excluded:${event.repositoryFullName}`;
    case "notification_sent":
      return `notification_sent:${event.deliveryId}:${event.itemNodeId}`;
  }
}
