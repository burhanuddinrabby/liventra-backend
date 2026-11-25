import { model, Schema } from "mongoose";

type TJobLock = {
  _id: string; //job name
  lockedUntil: Date;
  lockedBy: string | null;
  lastTickAt: Date; //the scheduled tick that last started; a tick never starts twice
  lastRunAt: Date;
  lastResult?: string;
};

//technical collection: one row per job, shared by every backend process
const jobLockSchema = new Schema<TJobLock>(
  {
    _id: { type: String, required: true },
    lockedUntil: { type: Date, required: true },
    lockedBy: { type: String, default: null },
    lastTickAt: { type: Date, required: true },
    lastRunAt: { type: Date, required: true },
    lastResult: { type: String },
  },
  { versionKey: false },
);

export const JobLockModel = model<TJobLock>("JobLock", jobLockSchema);
