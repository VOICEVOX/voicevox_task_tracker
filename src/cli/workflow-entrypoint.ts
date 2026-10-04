import { runTrackerCliEntrypoint } from "./tracker-run.js";

await runTrackerCliEntrypoint(process.argv.slice(2));
