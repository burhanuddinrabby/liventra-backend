import crypto from "crypto";
import { FarmStatuses } from "../modules/farm/farm.constants.js";
import { FarmModel } from "../modules/farm/farm.model.js";
import { JobLockModel } from "./jobLock.model.js";

const MINUTE_MS = 60_000;

const errorText = (error: unknown): string =>
  error instanceof Error ? `${error.name}: ${error.message}` : String(error);

/**
 * Takes the lock with one atomic upsert. It matches only when the lock is free and this
 * tick has not started anywhere yet; otherwise the upsert collides on _id (11000).
 */
const acquire = async (
  name: string,
  lockedBy: string,
  ttlMs: number,
  tick: Date,
): Promise<boolean> => {
  const now = new Date();
  try {
    await JobLockModel.findOneAndUpdate(
      { _id: name, lockedUntil: { $lte: now }, lastTickAt: { $lt: tick } },
      {
        $set: {
          lockedUntil: new Date(now.getTime() + ttlMs),
          lockedBy,
          lastTickAt: tick,
          lastRunAt: now,
        },
      },
      { upsert: true, returnDocument: "after" },
    );
    return true;
  } catch (error) {
    if ((error as { code?: number })?.code === 11000) return false;
    throw error;
  }
};

/**
 * Runs `work` once per tick across all processes. Never throws: an escaped rejection would
 * stop the server (see server.ts). `ttlMs` is the lease: it is renewed while the work runs,
 * and after a crash it decides how long the job stays locked. Ticks are whole minutes, so
 * schedules must not be finer than one minute.
 */
export const runJob = async (
  name: string,
  ttlMs: number,
  work: () => Promise<unknown>,
  tick: Date = new Date(Math.round(Date.now() / MINUTE_MS) * MINUTE_MS),
): Promise<"done" | "failed" | "skipped"> => {
  const lockedBy = crypto.randomUUID();
  try {
    if (!(await acquire(name, lockedBy, ttlMs, tick))) return "skipped";
  } catch (error) {
    console.log(`[job] ${name}: lock failed:`, errorText(error));
    return "failed";
  }

  const renewal = setInterval(() => {
    JobLockModel.updateOne(
      { _id: name, lockedBy },
      { $set: { lockedUntil: new Date(Date.now() + ttlMs) } },
    ).catch((error: unknown) =>
      console.log(`[job] ${name}: lease renewal failed:`, errorText(error)),
    );
  }, Math.max(Math.floor(ttlMs / 3), 1));
  renewal.unref();

  let result: "done" | "failed" = "done";
  let lastResult = "OK";
  try {
    await work();
  } catch (error) {
    result = "failed";
    lastResult = `Failed: ${errorText(error)}`.slice(0, 500);
    console.log(`[job] ${name}:`, lastResult);
  } finally {
    clearInterval(renewal);
  }

  try {
    //lockedBy: a run that lost its lease must not release somebody else's
    await JobLockModel.updateOne(
      { _id: name, lockedBy },
      { $set: { lockedUntil: new Date(), lockedBy: null, lastResult } },
    );
  } catch (error) {
    console.log(`[job] ${name}: release failed:`, errorText(error));
  }
  return result;
};

/**
 * Walks the Active farms in batches; one broken farm does not stop the others.
 * Throws at the end when any farm failed, so the run is recorded as failed.
 */
export const forEachActiveFarm = async (
  // eslint-disable-next-line no-unused-vars
  work: (farm: { _id: unknown; farmId: string; farmName: string }) => Promise<unknown>,
): Promise<void> => {
  let failed = 0;
  const cursor = FarmModel.find({ status: FarmStatuses.ACTIVE })
    .select("_id farmId farmName")
    .lean()
    .cursor({ batchSize: 50 });
  for await (const farm of cursor) {
    try {
      await work(farm);
    } catch (error) {
      failed += 1;
      console.log(`[job] farm ${farm.farmId}:`, errorText(error));
    }
  }
  if (failed > 0) throw new Error(`${failed} farm(s) failed`);
};
