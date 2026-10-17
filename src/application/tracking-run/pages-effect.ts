import type { PagesDeploymentIntent } from "./pages-build-contracts.js";

/** Pages actionまたは直列portから観測した一回の公開操作。 */
export type PagesEffectObservation<Result> =
  | Readonly<{ kind: "skipped" }>
  | Readonly<{ kind: "deployed"; result: Result }>
  | Readonly<{ kind: "no_effect"; cause: unknown }>
  | Readonly<{ kind: "ambiguous"; cause: unknown }>;

/** 外部Pages操作を開始していないことが確定した失敗。 */
export class PagesEffectNotStartedError extends Error {}

/** Pagesの生成結果から公開直前検証とeffect receiptを進めるport。 */
export type PagesEffectPort<
  Build,
  Preflight extends Readonly<{
    kind: "ready" | "observed" | "not_required" | "superseded";
  }>,
  Result,
  Recorded,
  Published,
> = Readonly<{
  preflight: (build: Build) => Promise<Preflight>;
  intent: (build: Build) => PagesDeploymentIntent;
  deploy: (intent: PagesDeploymentIntent) => Promise<PagesEffectObservation<Result>>;
  record: (
    build: Build,
    preflight: Preflight,
    observation: PagesEffectObservation<Result>,
  ) => Promise<Recorded>;
  requirePublished: (
    recorded: Recorded,
    observation: PagesEffectObservation<Result>,
  ) => Published | Promise<Published>;
}>;

/** 正本と全fileを確認してから一度だけPages effectを試みる。 */
export async function publishPagesWithEffect<
  Build,
  Preflight extends Readonly<{
    kind: "ready" | "observed" | "not_required" | "superseded";
  }>,
  Result,
  Recorded,
  Published,
>(
  build: Build,
  port: PagesEffectPort<Build, Preflight, Result, Recorded, Published>,
): Promise<Published> {
  let preflight: Preflight;
  try {
    preflight = await port.preflight(build);
  } catch (cause: unknown) {
    throw new PagesEffectNotStartedError("Pages公開前の検証に失敗しました", { cause });
  }
  let observation: PagesEffectObservation<Result> = { kind: "skipped" };
  if (preflight.kind === "ready") {
    let intent: PagesDeploymentIntent;
    try {
      intent = port.intent(build);
    } catch (cause: unknown) {
      throw new PagesEffectNotStartedError("Pages公開指示を作れません", { cause });
    }
    try {
      observation = await port.deploy(intent);
    } catch (cause: unknown) {
      observation = { kind: "ambiguous", cause };
    }
  }
  const recorded = await port.record(build, preflight, observation);
  return port.requirePublished(recorded, observation);
}
