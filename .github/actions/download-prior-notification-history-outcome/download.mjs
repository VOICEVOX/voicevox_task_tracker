import { Buffer } from "node:buffer";
import { appendFile, mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import process from "node:process";
import { setTimeout } from "node:timers/promises";
import { URL } from "node:url";
import { extractFiles } from "./zip.mjs";

const phase = "notification_history";
const stageName = "tracking-stage-notification-history-pages";
const commitName = "tracking-stage-finalize-run";
const outcomeName = "notification-history-pages-deployment-record";
const filenames = [
  "notification-settlement-receipt.json",
  "run-finalization-receipt.json",
  "notification-history-pages-build.json",
  "notification-history-pages-deployment.json",
  "receipt-chain.json",
];
const pageSize = 100;
const maximumPages = 1000;
const maximumArchiveBytes = 64 * 1024 * 1024;

function requiredEnvironment(name) {
  const value = process.env[name];
  if (value == null || value.length === 0) throw new TypeError(`${name}が必要です`);
  return value;
}

async function request(url, headers) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    let response;
    try {
      response = await globalThis.fetch(url, { headers, redirect: "manual" });
    } catch (error) {
      if (attempt === 2)
        throw new Error("Actions artifact取得の通信に失敗しました", { cause: error });
      await setTimeout(1000 * (attempt + 1));
      continue;
    }
    if ((response.status === 429 || response.status >= 500) && attempt < 2) {
      await response.body?.cancel();
      await setTimeout(1000 * (attempt + 1));
      continue;
    }
    if (!response.ok && response.status !== 302) {
      throw new Error(`Actions artifact取得がHTTP ${response.status}で失敗しました`);
    }
    return response;
  }
  throw new TypeError("Actions artifact取得の再試行が完了しませんでした");
}

async function listArtifacts(apiUrl, repository, token) {
  const artifacts = [];
  const ids = new Set();
  let expectedCount;
  for (let page = 1; page <= maximumPages; page += 1) {
    const url = new URL(
      `repos/${repository}/actions/artifacts?per_page=${pageSize}&page=${page}`,
      `${apiUrl.replace(/\/$/u, "")}/`,
    );
    const response = await request(url, {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
    });
    const value = await response.json();
    if (
      value == null ||
      typeof value !== "object" ||
      !Number.isSafeInteger(value.total_count) ||
      value.total_count < 0 ||
      !Array.isArray(value.artifacts)
    ) {
      throw new TypeError("Actions artifact一覧の形式が不正です");
    }
    if (expectedCount == null) expectedCount = value.total_count;
    if (
      expectedCount !== value.total_count ||
      artifacts.length + value.artifacts.length > expectedCount
    ) {
      throw new TypeError("Actions artifact一覧の件数が一致しません");
    }
    for (const artifact of value.artifacts) {
      if (
        artifact == null ||
        typeof artifact !== "object" ||
        !Number.isSafeInteger(artifact.id) ||
        artifact.id < 1 ||
        typeof artifact.name !== "string" ||
        ids.has(artifact.id)
      ) {
        throw new TypeError("Actions artifactの識別情報が不正です");
      }
      ids.add(artifact.id);
      const relevant =
        artifact.name === stageName ||
        artifact.name === commitName ||
        artifact.name === outcomeName ||
        /^(?:tracking|sandbox)-pages-[1-9][0-9]*-[1-9][0-9]*-/u.test(artifact.name);
      if (
        relevant &&
        (!Number.isSafeInteger(artifact.workflow_run?.id) || artifact.workflow_run.id < 1)
      ) {
        throw new TypeError("Pages関連artifactのActions run IDがありません");
      }
      artifacts.push({
        id: artifact.id,
        name: artifact.name,
        workflowRunId: artifact.workflow_run?.id,
      });
    }
    if (artifacts.length === expectedCount) return artifacts;
    if (value.artifacts.length !== pageSize) {
      throw new TypeError("Actions artifact一覧のページ数が一致しません");
    }
  }
  throw new TypeError("Actions artifact一覧の全ページを確認できませんでした");
}

async function archiveBytes(apiUrl, repository, artifactId, token) {
  const url = new URL(
    `repos/${repository}/actions/artifacts/${artifactId}/zip`,
    `${apiUrl.replace(/\/$/u, "")}/`,
  );
  let response = await request(url, {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
  });
  for (let redirect = 0; response.status === 302 && redirect < 5; redirect += 1) {
    const location = response.headers.get("location");
    if (location == null) throw new TypeError("Actions artifactのdownload先がありません");
    response = await request(new URL(location, url), {});
  }
  if (response.status === 302) throw new TypeError("Actions artifactのdownload先を確定できません");
  const length = Number(response.headers.get("content-length"));
  if (Number.isFinite(length) && length > maximumArchiveBytes) {
    throw new TypeError("保存済みPages artifactが許容byte数を超えています");
  }
  const reader = response.body?.getReader();
  if (reader == null) throw new TypeError("Actions artifactのdownload結果がありません");
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return Buffer.concat(chunks);
    total += value.byteLength;
    if (total > maximumArchiveBytes) {
      await reader.cancel();
      throw new TypeError("保存済みPages artifactが許容byte数を超えています");
    }
    chunks.push(value);
  }
}

function artifactRunId(bytes) {
  const value = JSON.parse(bytes.toString("utf8"));
  if (value.kind === "deployed" || value.kind === "not_required")
    return value.receipt?.binding?.runId;
  if (value.kind === "failure") return value.runId;
  throw new TypeError("保存済み通知履歴Pages結果の種別が不正です");
}

function chainHasDeployment(bytes) {
  if (bytes == null) return false;
  const value = JSON.parse(bytes.toString("utf8"));
  return (
    value.entries?.some(
      (entry) => entry.receipt?.receiptType === "pages_deployment" && entry.receipt.phase === phase,
    ) === true
  );
}

async function main() {
  const apiUrl = requiredEnvironment("GITHUB_API_URL");
  const repository = requiredEnvironment("GITHUB_REPOSITORY");
  const token = requiredEnvironment("ACTIONS_READ_TOKEN");
  const trackingRunId = requiredEnvironment("PRIOR_TRACKING_RUN_ID");
  const currentRunId = requiredEnvironment("GITHUB_RUN_ID");
  const currentAttempt = requiredEnvironment("GITHUB_RUN_ATTEMPT");
  const outputPath = resolve(requiredEnvironment("PRIOR_OUTCOME_PATH"));
  const githubOutput = requiredEnvironment("GITHUB_OUTPUT");
  const githubEnvironment = requiredEnvironment("GITHUB_ENV");
  const match = /^tracker-run:([0-9a-f]{64})$/u.exec(trackingRunId);
  if (
    match == null ||
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository) ||
    !/^[1-9][0-9]*$/u.test(currentRunId) ||
    !/^[1-9][0-9]*$/u.test(currentAttempt)
  ) {
    throw new TypeError("Actions runまたはtracking runの指定が不正です");
  }
  const suffix = match[1];
  const root = resolve(dirname(outputPath), phase);
  const artifacts = await listArtifacts(apiUrl, repository, token);
  const pages = artifacts.filter((artifact) =>
    /^(?:tracking|sandbox)-pages-[1-9][0-9]*-[1-9][0-9]*-notification-history$/u.test(
      artifact.name,
    ),
  );
  const stageCandidates = [];
  const commitRuns = new Set();
  for (const artifact of artifacts.filter(
    (candidate) => candidate.name === stageName || candidate.name === commitName,
  )) {
    const zip = extractFiles(await archiveBytes(apiUrl, repository, artifact.id, token));
    const selected = new Map();
    for (const filename of filenames) {
      const bytes = zip.get(`${suffix}/${filename}`);
      if (bytes != null) selected.set(filename, bytes);
    }
    if (artifact.name === commitName) {
      if (zip.has(`${suffix}/run-finalization-receipt.json`))
        commitRuns.add(artifact.workflowRunId);
    } else if (selected.size > 0) {
      stageCandidates.push({ artifact, files: selected });
    }
  }
  const outcomeCandidates = [];
  for (const artifact of artifacts.filter((candidate) => candidate.name === outcomeName)) {
    const zip = extractFiles(await archiveBytes(apiUrl, repository, artifact.id, token));
    if (zip.size !== 1 || !zip.has("notification-history-pages-deployment.json")) {
      throw new TypeError("保存済み通知履歴Pages個別artifactの内容が不正です");
    }
    const bytes = zip.get("notification-history-pages-deployment.json");
    if (artifactRunId(bytes) === trackingRunId) outcomeCandidates.push({ artifact, bytes });
  }
  const pageArtifacts = pages.map((artifact) => {
    const match =
      /^(?:tracking|sandbox)-pages-([1-9][0-9]*)-([1-9][0-9]*)-notification-history$/u.exec(
        artifact.name,
      );
    if (match == null || Number(match[1]) !== artifact.workflowRunId) {
      throw new TypeError("通知履歴Pages artifact名とActions runが一致しません");
    }
    return { ...artifact, runAttempt: Number(match[2]) };
  });
  for (const candidate of stageCandidates) {
    const directory = resolve(root, String(candidate.artifact.id));
    await mkdir(directory, { recursive: true });
    for (const [filename, bytes] of candidate.files) {
      await writeFile(resolve(directory, filename), bytes);
    }
  }
  for (const candidate of outcomeCandidates) {
    const directory = resolve(root, String(candidate.artifact.id));
    await mkdir(directory, { recursive: true });
    await writeFile(
      resolve(directory, "notification-history-pages-deployment.json"),
      candidate.bytes,
    );
  }
  const status =
    outcomeCandidates.length > 0 ||
    stageCandidates.some(
      (candidate) =>
        candidate.files.has("notification-history-pages-deployment.json") ||
        chainHasDeployment(candidate.files.get("receipt-chain.json")),
    )
      ? "downloaded"
      : "no_previous";
  await mkdir(dirname(outputPath), { recursive: true });
  await rm(`${outputPath}.selected`, { force: true });
  await writeFile(
    outputPath,
    JSON.stringify({
      phase,
      trackingRunId,
      status,
      stageArtifacts: stageCandidates.map((candidate) => candidate.artifact),
      individualArtifacts: outcomeCandidates.map((candidate) => candidate.artifact),
      pagesArtifacts: pageArtifacts,
      commitWorkflowRunIds: [...commitRuns],
      currentWorkflowRunId: Number(currentRunId),
      currentRunAttempt: Number(currentAttempt),
    }),
  );
  await appendFile(githubOutput, `status=${status}\n`);
  await appendFile(githubEnvironment, `VOICEVOX_PREVIOUS_HISTORY_OUTCOME_STATUS=${status}\n`);
  await appendFile(githubEnvironment, `VOICEVOX_PRIOR_HISTORY_EVIDENCE_PATH=${outputPath}\n`);
}

await main();
