import cron from "node-cron";
import config from "../config/index.js";
import { notificationJobs } from "./notification.jobs.js";
import { runJob } from "./runJob.js";

export type TJob = {
  name: string;
  schedule: string; //five-field cron expression in APP_TIMEZONE, one minute or coarser
  ttlMs: number;
  work: () => Promise<unknown>;
};

//every job must be safe to repeat
const jobs: TJob[] = [...notificationJobs];

/** Never throws: a bad schedule or timezone must not stop the API. */
export const startJobs = (list: TJob[] = jobs): void => {
  if (!config.jobs_enabled) {
    console.log("[job] scheduler off (JOBS_ENABLED is not true)");
    return;
  }
  let started = 0;
  for (const job of list) {
    try {
      cron.schedule(
        job.schedule,
        async () => {
          await runJob(job.name, job.ttlMs, job.work);
        },
        { name: job.name, timezone: config.app_timezone },
      );
      started += 1;
    } catch (error) {
      console.log(`[job] ${job.name} could not be scheduled:`, error);
    }
  }
  console.log(`[job] scheduler on, ${started} job(s), ${config.app_timezone}`);
};
