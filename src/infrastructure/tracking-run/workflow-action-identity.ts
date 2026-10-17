import { lstat, readFile, readdir } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";

import { parseDocument } from "yaml";
import { z } from "zod";

import type { ContentDigestPort } from "../../application/tracking-run/contracts/content-digest-port.js";
import { normalizedBundlePathSchema } from "../../application/tracking-run/recovery-bootstrap.js";
import { assertNonNullable } from "../../util/assert-non-nullable.js";

const effectActionNames = [
  "actions/configure-pages",
  "actions/deploy-pages",
  "actions/upload-artifact",
  "actions/upload-pages-artifact",
];
const stepSchema = z.looseObject({ uses: z.string().optional() });
const workflowSchema = z.looseObject({
  jobs: z.record(
    z.string(),
    z.looseObject({
      uses: z.string().optional(),
      steps: z.array(stepSchema).optional(),
    }),
  ),
});
const actionSchema = z.looseObject({
  runs: z.looseObject({ steps: z.array(stepSchema).optional() }),
});

type ActionFile = Readonly<{
  path: string;
  byteLength: number;
  digest: ReturnType<ContentDigestPort["sha256Bytes"]>;
  bytes: Buffer;
}>;

function parseYaml(source: string): unknown {
  const document = parseDocument(source, {
    prettyErrors: true,
    schema: "core",
    uniqueKeys: true,
  });
  if (document.errors.length > 0) {
    throw new TypeError("workflow actionのYAMLが不正です", { cause: document.errors[0] });
  }
  return document.toJS();
}

function workflowReferences(
  source: string,
): readonly Readonly<{ kind: "workflow" | "action"; reference: string }>[] {
  const workflow = workflowSchema.parse(parseYaml(source));
  const references: Readonly<{ kind: "workflow" | "action"; reference: string }>[] = [];
  for (const job of Object.values(workflow.jobs)) {
    if (job.uses != null) {
      references.push({ kind: "workflow", reference: job.uses });
    }
    for (const step of job.steps ?? []) {
      if (step.uses != null) references.push({ kind: "action", reference: step.uses });
    }
  }
  return references;
}

function actionReferences(source: string): readonly string[] {
  const action = actionSchema.parse(parseYaml(source));
  return (action.runs.steps ?? []).flatMap((step) => (step.uses == null ? [] : [step.uses]));
}

async function checkedActionDirectory(
  repositoryPath: string,
  relativePath: string,
): Promise<string> {
  let directory = resolve(repositoryPath);
  for (const segment of relativePath.split("/")) {
    directory = join(directory, segment);
    const status = await lstat(directory);
    if (status.isSymbolicLink() || !status.isDirectory()) {
      throw new TypeError("workflowのlocal action pathは通常のdirectoryである必要があります");
    }
  }
  return directory;
}

async function actionFiles(
  repositoryPath: string,
  directory: string,
  digest: ContentDigestPort,
): Promise<readonly ActionFile[]> {
  const files: ActionFile[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      throw new TypeError("workflowのlocal action内のsymlinkは使用できません");
    }
    if (entry.isDirectory()) {
      files.push(...(await actionFiles(repositoryPath, path, digest)));
      continue;
    }
    if (!entry.isFile()) {
      throw new TypeError("workflowのlocal actionに通常file以外が含まれています");
    }
    const relativePath = relative(repositoryPath, path).split(sep).join("/");
    const bytes = await readFile(path);
    files.push({
      path: relativePath,
      byteLength: bytes.length,
      digest: digest.sha256Bytes(bytes),
      bytes,
    });
  }
  return files.sort((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
  );
}

/** workflowのaction参照とlocal actionの実fileをadapter識別用に取得する。 */
export async function workflowActionSources(
  repositoryPath: string,
  workflowSources: readonly string[],
  digest: ContentDigestPort,
): Promise<
  Readonly<{
    effectActions: readonly (readonly [string, string])[];
    localActionFiles: readonly Readonly<{ path: string; byteLength: number; digest: string }>[];
    localWorkflowFiles: readonly Readonly<{ path: string; byteLength: number; digest: string }>[];
  }>
> {
  const effectActions = new Map<string, string>();
  const localActions = new Map<string, readonly ActionFile[]>();
  const localWorkflows = new Map<
    string,
    Readonly<{ path: string; byteLength: number; digest: string }>
  >();
  const visitingActions = new Set<string>();
  const visitingWorkflows = new Set<string>();

  async function visitAction(reference: string): Promise<void> {
    if (reference.startsWith("./")) {
      const relativePath = normalizedBundlePathSchema.parse(reference.slice(2));
      if (visitingActions.has(relativePath)) {
        throw new TypeError("workflowのlocal action参照が循環しています");
      }
      if (localActions.has(relativePath)) return;
      visitingActions.add(relativePath);
      const directory = await checkedActionDirectory(repositoryPath, relativePath);
      const files = await actionFiles(repositoryPath, directory, digest);
      const metadata = files.filter(
        (file) =>
          file.path === `${relativePath}/action.yml` || file.path === `${relativePath}/action.yaml`,
      );
      if (metadata.length !== 1) {
        throw new TypeError("workflowのlocal action定義は1つ必要です");
      }
      const definition = metadata[0];
      assertNonNullable(definition, "workflowのlocal action定義を取得できません");
      for (const nested of actionReferences(definition.bytes.toString("utf8"))) {
        await visitAction(nested);
      }
      visitingActions.delete(relativePath);
      localActions.set(relativePath, files);
      return;
    }
    const match = /^([A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+)@([0-9a-f]{40})$/u.exec(reference);
    if (match == null) {
      throw new TypeError("workflowの外部actionは完全なcommit SHAで固定してください");
    }
    const actionPath = match[1];
    const revision = match[2];
    assertNonNullable(actionPath, "workflowの外部action名を取得できません");
    assertNonNullable(revision, "workflowの外部action revisionを取得できません");
    const action = normalizedBundlePathSchema.parse(actionPath);
    if (effectActionNames.includes(action)) {
      const previous = effectActions.get(action);
      if (previous != null && previous !== revision) {
        throw new TypeError("workflow効果actionに異なるcommit SHAが混在しています");
      }
      effectActions.set(action, revision);
    }
  }

  async function visitWorkflow(reference: string): Promise<void> {
    if (!reference.startsWith("./")) {
      await visitAction(reference);
      return;
    }
    const relativePath = normalizedBundlePathSchema.parse(reference.slice(2));
    if (visitingWorkflows.has(relativePath)) {
      throw new TypeError("workflowの再利用参照が循環しています");
    }
    if (localWorkflows.has(relativePath)) return;
    if (!/^\.github\/workflows\/[^/]+\.ya?ml$/u.test(relativePath)) {
      throw new TypeError("再利用workflowは.github/workflows内のYAMLを指定してください");
    }
    const segments = relativePath.split("/");
    let path = resolve(repositoryPath);
    for (const segment of segments.slice(0, -1)) {
      path = join(path, segment);
      const status = await lstat(path);
      if (status.isSymbolicLink() || !status.isDirectory()) {
        throw new TypeError("再利用workflowの親pathは通常のdirectoryである必要があります");
      }
    }
    const filename = segments.at(-1);
    assertNonNullable(filename, "再利用workflowのfile名がありません");
    path = join(path, filename);
    const status = await lstat(path);
    if (status.isSymbolicLink() || !status.isFile()) {
      throw new TypeError("再利用workflowは通常のYAML fileである必要があります");
    }
    visitingWorkflows.add(relativePath);
    const bytes = await readFile(path);
    for (const nested of workflowReferences(bytes.toString("utf8"))) {
      if (nested.kind === "workflow") {
        await visitWorkflow(nested.reference);
      } else {
        await visitAction(nested.reference);
      }
    }
    visitingWorkflows.delete(relativePath);
    localWorkflows.set(relativePath, {
      path: relativePath,
      byteLength: bytes.length,
      digest: digest.sha256Bytes(bytes),
    });
  }

  for (const source of workflowSources) {
    for (const reference of workflowReferences(source)) {
      if (reference.kind === "workflow") {
        await visitWorkflow(reference.reference);
      } else {
        await visitAction(reference.reference);
      }
    }
  }
  if (effectActionNames.some((name) => !effectActions.has(name))) {
    throw new TypeError("workflowに必須の効果actionがありません");
  }
  return {
    effectActions: [...effectActions].sort(([left], [right]) =>
      left < right ? -1 : left > right ? 1 : 0,
    ),
    localActionFiles: [...localActions.values()]
      .flatMap((files) =>
        files.map(({ path, byteLength, digest: fileDigest }) => ({
          path,
          byteLength,
          digest: fileDigest,
        })),
      )
      .sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0)),
    localWorkflowFiles: [...localWorkflows.values()].sort((left, right) =>
      left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
    ),
  };
}
