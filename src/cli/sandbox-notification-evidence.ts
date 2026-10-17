import { z } from "zod";
import { runSandboxNotificationEvidence } from "../infrastructure/tracking-run/sandbox-notification-evidence.js";
const command = z.enum(["pending", "target", "resolved", "completed"]).parse(process.argv[2]);
await runSandboxNotificationEvidence(command);
