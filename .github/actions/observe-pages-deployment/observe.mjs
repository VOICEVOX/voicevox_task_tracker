import { Buffer } from "node:buffer";
import { appendFile } from "node:fs/promises";
import process from "node:process";
import { setTimeout } from "node:timers/promises";
import { URL } from "node:url";
import { TextDecoder } from "node:util";

const deployActionRevision = "d6db90164ac5ed86f2b6aed7e0febac5b3c0c03e";
const pageSize = 100;
const maximumPages = 100;
const maximumLogBytes = 32 * 1024 * 1024;

function requiredEnvironment(name) {
  const value = process.env[name];
  if (value == null || value.length === 0) {
    throw new TypeError(`${name}が必要です`);
  }
  return value;
}

function apiPath(base, path) {
  return new URL(path, `${base.replace(/\/$/u, "")}/`);
}

async function request(url, token, accept, allowRedirect, retryNotFound) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    let response;
    try {
      response = await globalThis.fetch(url, {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: accept,
          "X-GitHub-Api-Version": "2022-11-28",
        },
        redirect: "manual",
      });
    } catch (error) {
      if (attempt === 2) {
        throw new Error("Pages観測のGitHub API通信に失敗しました", { cause: error });
      }
      await setTimeout(1000 * (attempt + 1));
      continue;
    }
    if (
      attempt < 2 &&
      (response.status === 429 ||
        response.status >= 500 ||
        (retryNotFound && response.status === 404))
    ) {
      await response.body?.cancel();
      await setTimeout(1000 * (attempt + 1));
      continue;
    }
    if (!response.ok && !(allowRedirect && response.status === 302)) {
      throw new Error(`Pages観測のGitHub APIがHTTP ${response.status}を返しました`);
    }
    return response;
  }
  throw new TypeError("Pages観測のGitHub API再試行が完了しませんでした");
}

async function jsonResponse(url, token, retryNotFound) {
  const response = await request(url, token, "application/vnd.github+json", false, retryNotFound);
  return response.json();
}

function parseJobPage(value) {
  if (
    value == null ||
    typeof value !== "object" ||
    !Number.isSafeInteger(value.total_count) ||
    value.total_count < 0 ||
    !Array.isArray(value.jobs)
  ) {
    throw new TypeError("Actions job一覧の形式が不正です");
  }
  for (const job of value.jobs) {
    if (
      job == null ||
      typeof job !== "object" ||
      !Number.isSafeInteger(job.id) ||
      job.id < 1 ||
      typeof job.name !== "string"
    ) {
      throw new TypeError("Actions jobの識別または完了状態が不正です");
    }
  }
  return value;
}

async function deploymentJob(apiUrl, repository, runId, runAttempt, phase, token) {
  const name = phase === "initial" ? "initial-pages-deploy" : "notification-history-pages-deploy";
  const matches = [];
  let totalCount;
  let listed = 0;
  for (let page = 1; page <= maximumPages; page += 1) {
    const url = apiPath(
      apiUrl,
      `repos/${repository}/actions/runs/${runId}/attempts/${runAttempt}/jobs?per_page=${pageSize}&page=${page}`,
    );
    const result = parseJobPage(await jsonResponse(url, token, false));
    if (totalCount == null) {
      totalCount = result.total_count;
    }
    listed += result.jobs.length;
    if (
      result.total_count !== totalCount ||
      listed > totalCount ||
      (listed < totalCount && result.jobs.length !== pageSize)
    ) {
      throw new TypeError("Actions job一覧のページ数が一致しません");
    }
    matches.push(
      ...result.jobs.filter((job) => job.name === name || job.name.endsWith(` / ${name}`)),
    );
    if (matches.length > 1) {
      throw new TypeError("Pages deploy jobが複数見つかりました");
    }
    if (listed === totalCount) {
      if (matches.length !== 1) {
        throw new TypeError("Pages deploy jobを一意に特定できません");
      }
      const job = matches[0];
      if (job.run_id != null && String(job.run_id) !== runId) {
        throw new TypeError("Pages deploy jobのrun IDが一致しません");
      }
      if (job.run_attempt != null && String(job.run_attempt) !== runAttempt) {
        throw new TypeError("Pages deploy jobのattemptが一致しません");
      }
      if (job.status !== "completed") {
        throw new TypeError("Pages deploy jobが完了していません");
      }
      if (!Array.isArray(job.steps)) {
        throw new TypeError("Pages deploy jobのstepがありません");
      }
      const steps = job.steps.filter((step) => step.name === "Pagesへdeploy");
      if (
        steps.length !== 1 ||
        steps[0].status !== "completed" ||
        steps[0].conclusion !== "success"
      ) {
        throw new TypeError("Pages deploy actionの成功をjob stepで確認できません");
      }
      return job.id;
    }
  }
  throw new TypeError("Actions job一覧の全ページを確認できませんでした");
}

async function jobLog(apiUrl, repository, jobId, token) {
  let url = apiPath(apiUrl, `repos/${repository}/actions/jobs/${jobId}/logs`);
  let response = await request(url, token, "application/vnd.github+json", true, true);
  for (let redirect = 0; response.status === 302 && redirect < 5; redirect += 1) {
    const location = response.headers.get("location");
    if (location == null) {
      throw new TypeError("Actions jobログのdownload先がありません");
    }
    url = new URL(location, url);
    response = await globalThis.fetch(url, { redirect: "manual" });
    if (!response.ok && response.status !== 302) {
      throw new Error(`Actions jobログの取得がHTTP ${response.status}で失敗しました`);
    }
  }
  if (response.status === 302) {
    throw new TypeError("Actions jobログのdownload先を確定できません");
  }
  const reader = response.body?.getReader();
  if (reader == null) {
    throw new TypeError("Actions jobログがありません");
  }
  const chunks = [];
  let byteLength = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
    }
    byteLength += value.byteLength;
    if (byteLength > maximumLogBytes) {
      await reader.cancel();
      throw new TypeError("Actions jobログが許容byte数を超えています");
    }
    chunks.push(value);
  }
}

function deploymentIdFromLog(log, buildVersion) {
  const marker = `##[group]Run actions/deploy-pages@${deployActionRevision}`;
  const lines = log.split(/\r?\n/u);
  const markerIndexes = lines.flatMap((line, index) => (line.includes(marker) ? [index] : []));
  if (markerIndexes.length !== 1) {
    throw new TypeError("固定deploy-pages actionのログ区間を一意に特定できません");
  }
  const start = markerIndexes[0];
  const entries = [];
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.includes("##[group]Run ")) {
      break;
    }
    const match = new RegExp(
      `Created deployment for ${buildVersion}, ID: ([A-Za-z0-9-]+)(?:\\s|$)`,
      "u",
    ).exec(line);
    if (match != null) {
      entries.push(match[1]);
    }
  }
  if (entries.length !== 1 || entries[0] === buildVersion) {
    throw new TypeError("固定deploy-pages actionの実deployment IDを一意に特定できません");
  }
  return entries[0];
}

async function confirmDeployment(apiUrl, repository, deploymentId, pageUrl, token) {
  const response = await jsonResponse(
    apiPath(apiUrl, `repos/${repository}/pages/deployments/${encodeURIComponent(deploymentId)}`),
    token,
    true,
  );
  if (
    response == null ||
    typeof response !== "object" ||
    response.status !== "succeed" ||
    (response.id != null && String(response.id) !== deploymentId) ||
    (response.page_url != null && response.page_url !== pageUrl)
  ) {
    throw new TypeError("Pages APIのdeployment IDまたは成功結果がactionと一致しません");
  }
}

async function main() {
  const apiUrl = requiredEnvironment("GITHUB_API_URL");
  const repository = requiredEnvironment("GITHUB_REPOSITORY");
  const runId = requiredEnvironment("PAGES_OBSERVATION_RUN_ID");
  const runAttempt = requiredEnvironment("PAGES_OBSERVATION_RUN_ATTEMPT");
  const phase = requiredEnvironment("PAGES_OBSERVATION_PHASE");
  const buildVersion = requiredEnvironment("PAGES_OBSERVATION_BUILD_VERSION");
  const pageUrl = requiredEnvironment("PAGES_OBSERVATION_PAGE_URL");
  const token = requiredEnvironment("PAGES_OBSERVATION_TOKEN");
  const githubOutput = requiredEnvironment("GITHUB_OUTPUT");
  if (
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository) ||
    !/^[1-9][0-9]*$/u.test(runId) ||
    !/^[1-9][0-9]*$/u.test(runAttempt) ||
    !/^[0-9a-f]{40}$/u.test(buildVersion) ||
    (phase !== "initial" && phase !== "notification_history") ||
    new URL(pageUrl).protocol !== "https:"
  ) {
    throw new TypeError("Pages観測のrun識別またはURLが不正です");
  }
  const jobId = await deploymentJob(apiUrl, repository, runId, runAttempt, phase, token);
  const deploymentId = deploymentIdFromLog(
    await jobLog(apiUrl, repository, jobId, token),
    buildVersion,
  );
  await confirmDeployment(apiUrl, repository, deploymentId, pageUrl, token);
  await appendFile(githubOutput, `deployment_id=${deploymentId}\n`);
  process.stdout.write("Pages deploymentの実IDと成功結果を確認しました\n");
}

await main();
