import { join } from "node:path";

import { writeCliJsonArtifact } from "../cli/index.js";
import {
  assertEndToEndPerformanceProfilePassed,
  runEndToEndPerformanceProfile,
} from "./end-to-end-profile.js";

const ARTIFACT_PATH = "artifacts/performance-profile.json";

async function main(): Promise<void> {
  const repositoryPath = process.cwd();
  const profile = await runEndToEndPerformanceProfile(repositoryPath);
  await writeCliJsonArtifact(join(repositoryPath, ARTIFACT_PATH), profile);
  process.stdout.write(
    [
      `status=${profile.status}`,
      `duration_milliseconds=${profile.measurements.durationMilliseconds.toFixed(3)}`,
      `github_api_used=${profile.measurements.githubApi.used.toString()}`,
      `github_api_limit=${profile.measurements.githubApi.limit.toString()}`,
      `github_api_used_ratio=${profile.measurements.githubApi.usedRatio.toFixed(6)}`,
      `codex_calls=${profile.measurements.codex.calls.toString()}`,
      `codex_call_limit=${profile.measurements.codex.configuredMaxCalls.toString()}`,
      `summary_gzip_bytes=${profile.measurements.webInitialSummary.gzipBytes.toString()}`,
      `summary_gzip_limit_bytes=${profile.measurements.webInitialSummary.limitBytes.toString()}`,
      `artifact=${ARTIFACT_PATH}`,
      "",
    ].join("\n"),
  );
  assertEndToEndPerformanceProfilePassed(profile);
}

await main();
