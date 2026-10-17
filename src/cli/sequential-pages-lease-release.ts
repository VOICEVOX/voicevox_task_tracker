import { releaseCompletedSequentialPagesLease } from "../infrastructure/tracking-run/sequential-pages-lease-release.js";

await releaseCompletedSequentialPagesLease(
  process.cwd(),
  "artifacts/run-reports/run-sequential.json",
  process.env,
);
