import { ISSUE_DETERMINISTIC_RULES_VERSION } from "./issue-state-contracts.js";
import { PULL_REQUEST_DETERMINISTIC_RULES_VERSION } from "./pull-request-state-contracts.js";

/** 1 runへ適用するIssueとPull Requestの決定規則version。 */
export const DETERMINISTIC_RULES_VERSION = `issue=${ISSUE_DETERMINISTIC_RULES_VERSION};pull-request=${PULL_REQUEST_DETERMINISTIC_RULES_VERSION}`;
