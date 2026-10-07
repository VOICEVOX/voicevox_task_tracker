import type { PerformanceDetailObserver } from "../application/tracking-run/contracts/performance-detail-observation.js";
import { serializeCanonicalJson } from "../canonical-json/value.js";
import { nodeContentDigestPort as digest } from "../infrastructure/tracking-run/content-digest.js";
import type {
  StateBranchAdapter,
  StateBranchCommitInspection,
  StateFileReadResult,
  StatePersistenceConfiguration,
} from "./branch-adapter.js";
import {
  recordPostSaveExactReads,
  type PostSaveExactReadFootprint,
} from "./exact-state-read-footprint.js";
import {
  createStateFileValidationProofs,
  StateFileValidation,
  type StateFileValidationProofs,
} from "./state-file-validation.js";

type ValidationRun = Readonly<{
  runId: string;
  token: symbol;
  proofs: StateFileValidationProofs;
  observe: PerformanceDetailObserver | undefined;
  files: Map<string, string>;
  listings: Map<string, string>;
  commits: Map<string, string>;
}>;

const adapterRuns = new WeakMap<StateBranchAdapter, ValidationRun>();
const adapterSessions = new WeakMap<StateBranchAdapter, ExactStateValidationSession>();

/** 固定adapterに一つのrun世代と小型file証明を結合する。 */
export function beginExactStateValidationRun(
  adapter: StateBranchAdapter,
  runId: string,
  observe?: PerformanceDetailObserver,
): void {
  adapterRuns.set(adapter, {
    runId,
    token: Symbol("exactStateValidationRun"),
    proofs: createStateFileValidationProofs(),
    observe,
    files: new Map(),
    listings: new Map(),
    commits: new Map(),
  });
}

/** 同じrunの終了時にadapterの証明を破棄する。 */
export function endExactStateValidationRun(adapter: StateBranchAdapter, runId: string): void {
  if (adapterRuns.get(adapter)?.runId === runId) adapterRuns.delete(adapter);
}

function remember(values: Map<string, string>, key: string, value: string): void {
  const previous = values.get(key);
  if (previous != null && previous !== value) {
    throw new TypeError("同じexact revisionのpath、byteまたはcommit metadataが変化しました");
  }
  values.set(key, value);
}

/** CASまたはreceipt境界内でfreshな読込と検証済み値を共有する。 */
export class ExactStateValidationSession {
  public readonly adapter: StateBranchAdapter;
  public readonly originAdapter: StateBranchAdapter;
  public readonly validation: StateFileValidation;
  public readonly footprint: PostSaveExactReadFootprint;
  public readonly configurationIdentity: string;
  readonly #files = new Map<string, Map<string, StateFileReadResult>>();
  readonly #listings = new Map<string, readonly string[]>();
  readonly #commits = new Map<string, StateBranchCommitInspection>();
  #readGeneration = 0;

  /** 公開effectの後にfresh照合を開始する読込世代。 */
  public get readGeneration(): number {
    return this.#readGeneration;
  }

  public constructor(
    adapter: StateBranchAdapter,
    configuration: StatePersistenceConfiguration,
    observe?: PerformanceDetailObserver,
  ) {
    this.originAdapter = exactStateValidationOrigin(adapter);
    const bound: StateBranchAdapter = Object.freeze({
      resolveHead: adapter.resolveHead.bind(adapter),
      ...(adapter.resolveRepositoryRevision == null
        ? {}
        : { resolveRepositoryRevision: adapter.resolveRepositoryRevision.bind(adapter) }),
      ...(adapter.resolveOriginUrls == null
        ? {}
        : { resolveOriginUrls: adapter.resolveOriginUrls.bind(adapter) }),
      readFile: adapter.readFile.bind(adapter),
      readFiles: adapter.readFiles.bind(adapter),
      listFiles: adapter.listFiles.bind(adapter),
      readCommit: adapter.readCommit.bind(adapter),
      commit: adapter.commit.bind(adapter),
      publish: adapter.publish.bind(adapter),
    });
    const run = adapterRuns.get(this.originAdapter);
    const configurationIdentity = serializeCanonicalJson(configuration);
    this.configurationIdentity = configurationIdentity;
    const assertActive = (): void => {
      if (
        adapterRuns.get(this.originAdapter)?.token !== run?.token ||
        serializeCanonicalJson(configuration) !== configurationIdentity
      ) {
        throw new TypeError("exact revision検証中にrun、adapterまたは設定が変化しました");
      }
    };
    this.validation = new StateFileValidation(
      run?.proofs ?? createStateFileValidationProofs(),
      observe ?? run?.observe,
    );
    const fresh: StateBranchAdapter = Object.freeze({
      ...bound,
      readFiles: async (revision, paths) => {
        assertActive();
        const files = await adapter.readFiles(revision, paths);
        if (files.size !== paths.length) throw new TypeError("exact file読込数が一致しません");
        for (const path of paths) {
          const file = files.get(path);
          if (file == null) throw new TypeError("exact file読込結果が不足しています");
          if (run != null) {
            remember(
              run.files,
              JSON.stringify([revision, path]),
              file.status === "missing"
                ? "missing"
                : `${file.bytes.length.toString()}:${digest.sha256Bytes(file.bytes)}`,
            );
          }
        }
        assertActive();
        return files;
      },
      readFile: async (revision, path) => {
        const files = await fresh.readFiles(revision, [path]);
        const file = files.get(path);
        if (file == null) throw new TypeError("exact file読込結果が不足しています");
        return file;
      },
      listFiles: async (revision, directory) => {
        assertActive();
        const paths = await adapter.listFiles(revision, directory);
        if (new Set(paths).size !== paths.length)
          throw new TypeError("exact path一覧が重複しています");
        if (run != null)
          remember(run.listings, JSON.stringify([revision, directory]), JSON.stringify(paths));
        assertActive();
        return paths;
      },
      readCommit: async (revision) => {
        assertActive();
        const commit = await adapter.readCommit(revision);
        if (commit.revision !== revision)
          throw new TypeError("exact commitのrevisionが一致しません");
        if (run != null)
          remember(run.commits, revision, digest.sha256Utf8(serializeCanonicalJson(commit)));
        assertActive();
        return commit;
      },
    });
    const recording = recordPostSaveExactReads(fresh);
    this.footprint = recording.footprint;
    const source = recording.adapter;
    this.adapter = Object.freeze({
      ...bound,
      readFile: async (revision, path) => {
        const files = await this.adapter.readFiles(revision, [path]);
        const file = files.get(path);
        if (file == null) throw new TypeError("exact file読込結果が不足しています");
        return file;
      },
      readFiles: async (revision, paths) => {
        assertActive();
        const cached = this.#files.get(revision) ?? new Map<string, StateFileReadResult>();
        this.#files.delete(revision);
        this.#files.set(revision, cached);
        const missing = paths.filter((path) => !cached.has(path));
        if (missing.length > 0) {
          const files = await source.readFiles(revision, missing);
          for (const [path, file] of files) cached.set(path, file);
        }
        while (this.#files.size > 2) {
          const oldest = this.#files.keys().next().value;
          if (oldest == null) throw new TypeError("exact treeの保持順序が不正です");
          this.#files.delete(oldest);
        }
        const result = new Map<string, StateFileReadResult>();
        for (const path of paths) {
          const file = cached.get(path);
          if (file == null) throw new TypeError("exact file読込結果が不足しています");
          result.set(path, file);
        }
        assertActive();
        return result;
      },
      listFiles: async (revision, directory) => {
        assertActive();
        const key = JSON.stringify([revision, directory]);
        const cached = this.#listings.get(key);
        if (cached != null) return cached;
        const paths = Object.freeze([...(await source.listFiles(revision, directory))]);
        this.#listings.set(key, paths);
        return paths;
      },
      readCommit: async (revision) => {
        assertActive();
        const cached = this.#commits.get(revision);
        if (cached != null) return cached;
        const commit = await source.readCommit(revision);
        this.#commits.set(revision, commit);
        return commit;
      },
      commit: async (request) => {
        assertActive();
        const commit = await adapter.commit(request);
        assertActive();
        return commit;
      },
      publish: async (request) => {
        assertActive();
        try {
          await adapter.publish(request);
          assertActive();
        } finally {
          this.#readGeneration += 1;
          this.#files.clear();
          this.#listings.clear();
          this.#commits.clear();
        }
      },
    });
    if (run != null) adapterRuns.set(this.adapter, run);
    adapterSessions.set(this.adapter, this);
  }
}

/** 同じ境界内のsessionを取り出し、境界の入口では新しく作る。 */
export function exactStateValidationSession(
  adapter: StateBranchAdapter,
  configuration: StatePersistenceConfiguration,
  observe?: PerformanceDetailObserver,
): ExactStateValidationSession {
  const existing = adapterSessions.get(adapter);
  if (
    existing != null &&
    existing.configurationIdentity !== serializeCanonicalJson(configuration)
  ) {
    throw new TypeError("exact revision検証sessionの設定が一致しません");
  }
  return existing ?? new ExactStateValidationSession(adapter, configuration, observe);
}

/** boundary内のadapterを固定したrunの生成元へ対応付ける。 */
export function exactStateValidationOrigin(adapter: StateBranchAdapter): StateBranchAdapter {
  return adapterSessions.get(adapter)?.originAdapter ?? adapter;
}
