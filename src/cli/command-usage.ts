/** CLIで表示する簡潔な使用方法を返す。 */
export function formatCliUsage(): string {
  return [
    "使用方法:",
    "  voicevox-task-tracker run-sequential [--config PATH] [--mode none|linked|all-open] [--notification-action send|hold|acknowledge-current] [--repository VOICEVOX/REPO] [--scheduled-for ISO] [--report PATH]",
    "  voicevox-task-tracker run-stage --stage analyze [--config PATH] [--mode none|linked|all-open] [--notification-action send|hold|acknowledge-current] [--repository VOICEVOX/REPO] [--sandbox-context PATH] [--scheduled-for ISO]",
    "  voicevox-task-tracker run-stage --stage STAGE --run-id ID [--config PATH] [--run-attempt NUMBER] [--manual-resolution-receipt PATH]",
    "  voicevox-task-tracker route-stage --state-ref REF --effect-target production|sandbox|recording [--run-id ID] [--config PATH]",
    "  voicevox-task-tracker runtime-recovery-v2 --operation inspect|execute_stage|record_pages --state-ref REF --run-id ID [--stage STAGE] [--phase initial|notification_history --observation PATH] [--run-attempt NUMBER] [--bundle-root PATH] [--config PATH]",
    "  voicevox-task-tracker daily [--config PATH] [--notification-action send|hold|acknowledge-current] [--scheduled-for ISO] [--report PATH]",
    "  voicevox-task-tracker dry-run [--config PATH] [--artifact PATH] [--report PATH]",
    "  voicevox-task-tracker backfill [--mode none|linked|all-open] [--notification-action send|hold|acknowledge-current] [--repository VOICEVOX/REPO]",
    "  voicevox-task-tracker collect-analyze [--mode none|linked|all-open] [--notification-action send|hold|acknowledge-current] [--sandbox-context PATH] [--scheduled-for ISO] [--artifact PATH]",
    "  voicevox-task-tracker resolve-discord-delivery --run-id ID --checkpoint-digest DIGEST --delivery-id ID --attempt-id ID --notification-key KEY --resolution retry|acknowledge [--receipt PATH]",
    "  voicevox-task-tracker notify-operations --workflow-run-id ID --workflow-run-attempt NUMBER --workflow-kind daily|manual --occurred-at ISO --failed-job JOB [--failure-directory PATH] [--output-failure-directory PATH] [--previous-failures-directory PATH] [--previous-receipts-directory PATH]",
    "  voicevox-task-tracker report-workflow --run-id ID --run-attempt NUMBER --effect-target production|sandbox|recording --actions-jobs PATH [--tracking-run-id ID] [--completion-directory PATH] [--failure-directory PATH]",
    "  voicevox-task-tracker verify-state --state-directory PATH --state-revision SHA [--config PATH]",
    "  voicevox-task-tracker verify-checkpoint [--artifact PATH] [--config PATH]",
    "  voicevox-task-tracker verify-runtime-recovery --input PATH [--bundle-root PATH]",
    "  voicevox-task-tracker inspect-run-state [--config PATH] [--state-ref REF] [--run-id ID --state-revision SHA]",
    "  voicevox-task-tracker verify-receipt-chain --input PATH",
    "  voicevox-task-tracker report-failure --input PATH --output PATH",
  ].join("\n");
}
