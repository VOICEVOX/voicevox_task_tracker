import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";

import type { ContentDigestPort } from "../../application/tracking-run/contracts/content-digest-port.js";
import { serializeCanonicalJson } from "../../canonical-json/value.js";
import {
  workflowV1AdapterSourcePaths,
  workflowV2AdapterSourcePaths,
} from "./frozen-runtime-source-layout.js";
import { hashSources } from "./publication-runtime-source-digest.js";
import { workflowActionSources } from "./workflow-action-identity.js";
import {
  readWorkflowV2Adapter,
  readWorkflowV2AdapterCurrentLegacy,
  readWorkflowV2AdapterLegacy,
} from "./workflow-v2-adapter.js";

/** V1 workflow adapterの静的identityを計算する。 */
export async function workflowAdapterIdentity(
  repositoryPath: string,
  digest: ContentDigestPort,
): Promise<ReturnType<ContentDigestPort["sha256Utf8"]>> {
  const workflowPaths = [
    ".github/workflows/_tracking-run.yml",
    ".github/workflows/daily.yml",
    ".github/workflows/resolve_discord_delivery.yml",
    ".github/workflows/run_sequential.yml",
    ".github/workflows/sequential_pages_effect.yml",
  ];
  const workflows = await Promise.all(
    workflowPaths.map((path) => readFile(resolve(repositoryPath, path), "utf8")),
  );
  const actionSources = await workflowActionSources(repositoryPath, workflows, digest);
  const scripts = (await readdir(resolve(repositoryPath, ".github/scripts")))
    .map((path) => `.github/scripts/${path}`)
    .sort();
  const adapterSources = await workflowV1AdapterSourcePaths(repositoryPath);
  const adapterSourcesDigest = await hashSources(
    repositoryPath,
    [
      ...workflowPaths,
      ...adapterSources.effectSources,
      ...scripts,
      ...adapterSources.commandSources,
    ],
    digest,
  );
  return digest.sha256Utf8(
    serializeCanonicalJson({
      effectActions: actionSources.effectActions,
      localActionFiles: actionSources.localActionFiles,
      ...(actionSources.localWorkflowFiles.length === 0
        ? {}
        : { localWorkflowFiles: actionSources.localWorkflowFiles }),
      adapterSourcesDigest,
    }),
  );
}

/** V2 Pages adapterの実stepと固定actionから静的identityを計算する。 */
export async function workflowAdapterIdentityV2(
  repositoryPath: string,
  digest: ContentDigestPort,
): Promise<ReturnType<ContentDigestPort["sha256Utf8"]>> {
  const adapterSourcesDigest = await hashSources(
    repositoryPath,
    await workflowV2AdapterSourcePaths(repositoryPath, "full"),
    digest,
  );
  return digest.sha256Utf8(
    serializeCanonicalJson({
      selection: await workflowAdapterSelectionV2(repositoryPath, repositoryPath, digest),
      adapterSourcesDigest,
    }),
  );
}

async function workflowAdapterSelectionV2(
  workflowRepositoryPath: string,
  actionRepositoryPath: string,
  digest: ContentDigestPort,
): Promise<object> {
  const pagesWorkflowSource = await readFile(
    resolve(workflowRepositoryPath, ".github/workflows/_tracking-pages.yml"),
    "utf8",
  );
  const actionSources = await workflowActionSources(
    actionRepositoryPath,
    [pagesWorkflowSource],
    digest,
  );
  const scriptSources = [pagesWorkflowSource];
  for (const file of actionSources.localActionFiles) {
    if (/\/action\.ya?ml$/u.test(file.path)) {
      scriptSources.push(await readFile(resolve(actionRepositoryPath, file.path), "utf8"));
    }
  }
  const referencedScripts = [
    ...new Set(
      scriptSources.flatMap((source) =>
        [...source.matchAll(/\.github\/scripts\/[A-Za-z0-9._/-]+/gu)].map((match) => match[0]),
      ),
    ),
  ].sort();
  return {
    adapter: await readWorkflowV2Adapter(workflowRepositoryPath),
    actionSources,
    referencedScriptsDigest: await hashSources(actionRepositoryPath, referencedScripts, digest),
  };
}

async function workflowAdapterSelectionV2CurrentLegacy(
  repositoryPath: string,
  digest: ContentDigestPort,
): Promise<object> {
  const pagesWorkflowSource = await readFile(
    resolve(repositoryPath, ".github/workflows/_tracking-pages.yml"),
    "utf8",
  );
  const actionSources = await workflowActionSources(repositoryPath, [pagesWorkflowSource], digest);
  const scriptSources = [pagesWorkflowSource];
  for (const file of actionSources.localActionFiles) {
    if (/\/action\.ya?ml$/u.test(file.path)) {
      scriptSources.push(await readFile(resolve(repositoryPath, file.path), "utf8"));
    }
  }
  const referencedScripts = [
    ...new Set(
      scriptSources.flatMap((source) =>
        [...source.matchAll(/\.github\/scripts\/[A-Za-z0-9._/-]+/gu)].map((match) => match[0]),
      ),
    ),
  ].sort();
  return {
    adapter: await readWorkflowV2AdapterCurrentLegacy(repositoryPath),
    actionSources,
    referencedScriptsDigest: await hashSources(repositoryPath, referencedScripts, digest),
  };
}

async function workflowAdapterIdentityV2CurrentLegacy(
  repositoryPath: string,
  digest: ContentDigestPort,
): Promise<ReturnType<ContentDigestPort["sha256Utf8"]>> {
  const adapterSourcesDigest = await hashSources(
    repositoryPath,
    await workflowV2AdapterSourcePaths(repositoryPath, "full"),
    digest,
  );
  return digest.sha256Utf8(
    serializeCanonicalJson({
      selection: await workflowAdapterSelectionV2CurrentLegacy(repositoryPath, digest),
      adapterSourcesDigest,
    }),
  );
}

async function workflowAdapterSelectionV2NarrowLegacy(
  repositoryPath: string,
  digest: ContentDigestPort,
): Promise<object> {
  const pagesWorkflowSource = await readFile(
    resolve(repositoryPath, ".github/workflows/_tracking-pages.yml"),
    "utf8",
  );
  const actionSources = await workflowActionSources(repositoryPath, [pagesWorkflowSource], digest);
  const pageActionPaths = [
    ".github/actions/download-prior-notification-history-outcome/",
    ".github/actions/observe-pages-deployment/",
    ".github/actions/route-tracking-stage/",
  ];
  return {
    adapter: await readWorkflowV2AdapterLegacy(repositoryPath),
    actionSources: {
      effectActions: actionSources.effectActions,
      localActionFiles: actionSources.localActionFiles.filter(({ path }) =>
        pageActionPaths.some((prefix) => path.startsWith(prefix)),
      ),
      localWorkflowFiles: actionSources.localWorkflowFiles,
    },
    routeScriptDigest: await hashSources(
      repositoryPath,
      [".github/scripts/route-tracking-stage.sh"],
      digest,
    ),
  };
}

async function workflowAdapterIdentityV2NarrowLegacy(
  repositoryPath: string,
  digest: ContentDigestPort,
): Promise<ReturnType<ContentDigestPort["sha256Utf8"]>> {
  const adapterSourcesDigest = await hashSources(
    repositoryPath,
    await workflowV2AdapterSourcePaths(repositoryPath, "narrow"),
    digest,
  );
  return digest.sha256Utf8(
    serializeCanonicalJson({
      selection: await workflowAdapterSelectionV2NarrowLegacy(repositoryPath, digest),
      adapterSourcesDigest,
    }),
  );
}

async function workflowAdapterIdentityV2Legacy(
  repositoryPath: string,
  digest: ContentDigestPort,
): Promise<ReturnType<ContentDigestPort["sha256Utf8"]>> {
  const workflowSource = await readFile(
    resolve(repositoryPath, ".github/workflows/_tracking-run.yml"),
    "utf8",
  );
  const actionSources = await workflowActionSources(repositoryPath, [workflowSource], digest);
  const scripts = (await readdir(resolve(repositoryPath, ".github/scripts")))
    .map((path) => `.github/scripts/${path}`)
    .sort();
  const adapterSourcesDigest = await hashSources(
    repositoryPath,
    [...(await workflowV2AdapterSourcePaths(repositoryPath, "narrow")), ...scripts],
    digest,
  );
  return digest.sha256Utf8(
    serializeCanonicalJson({
      adapter: await readWorkflowV2AdapterLegacy(repositoryPath),
      actionSources,
      adapterSourcesDigest,
    }),
  );
}

/** 記録済みV2 identityを選択元の静的adapterと照合する。 */
export async function assertRecordedWorkflowAdapterIdentityV2(
  repositoryPath: string,
  expectedIdentity: string,
  digest: ContentDigestPort,
): Promise<void> {
  if ((await workflowAdapterIdentityV2CurrentLegacy(repositoryPath, digest)) === expectedIdentity) {
    return;
  }
  if ((await workflowAdapterIdentityV2NarrowLegacy(repositoryPath, digest)) === expectedIdentity) {
    return;
  }
  if ((await workflowAdapterIdentityV2Legacy(repositoryPath, digest)) === expectedIdentity) {
    return;
  }
  if ((await workflowAdapterIdentityV2(repositoryPath, digest)) === expectedIdentity) {
    return;
  }
  throw new TypeError("V2 Pages adapterの記録済みidentityが選択元と一致しません");
}

/** 現行YAMLとexact checkout上のactionが記録済みV2 adapterと同じか検証する。 */
export async function assertWorkflowV2AdapterCompatibility(
  currentRepositoryPath: string,
  exactRepositoryPath: string,
  expectedIdentity: string,
  digest: ContentDigestPort,
): Promise<void> {
  await assertRecordedWorkflowAdapterIdentityV2(exactRepositoryPath, expectedIdentity, digest);
  const [current, exact] = await Promise.all([
    workflowAdapterSelectionV2(currentRepositoryPath, exactRepositoryPath, digest),
    workflowAdapterSelectionV2(exactRepositoryPath, exactRepositoryPath, digest),
  ]);
  if (serializeCanonicalJson(current) !== serializeCanonicalJson(exact)) {
    throw new TypeError("現行YAMLのV2 Pages adapterが記録済みrunと一致しません");
  }
}
