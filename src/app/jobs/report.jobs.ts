import { ReportServices } from "../modules/report/report.services.js";
import { recoverStuckReports } from "../modules/report/report.worker.js";
import type { TJob } from "./scheduler.js";

/**
 * Report maintenance jobs (plan 8). Both are safe to run twice:
 *  - report.stuck:  fail reports left Generating for over 15 min with no live worker.
 *  - report.expiry: delete the files of Completed reports past expiry, then mark Expired.
 */
export const reportJobs: TJob[] = [
  {
    name: "report.stuck",
    schedule: "*/5 * * * *",
    ttlMs: 2 * 60_000,
    work: () => recoverStuckReports(false),
  },
  {
    name: "report.expiry",
    schedule: "0 * * * *",
    ttlMs: 5 * 60_000,
    work: () => ReportServices.expireReports(),
  },
];
