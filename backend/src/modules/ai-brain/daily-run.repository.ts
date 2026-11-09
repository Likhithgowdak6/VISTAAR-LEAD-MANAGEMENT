/**
 * "Has this daily job already run today?", answered by the database rather than by memory.
 *
 * WHY THIS EXISTS. `daily-scheduler.ts` guarded re-firing with `let lastFiredDateKey` - an
 * in-process variable, persisted nowhere - so the guarantee lasted exactly as long as the
 * process. Restarting the backend any time after DIGEST_HOUR left `lastFiredDateKey` null while
 * `hasReachedLocalTime` was still true, and every daily job fired a second time: the owner
 * received a second digest, a second morning read and a second booking countdown the same
 * evening. Nothing in the data prevented it.
 *
 * THE INSERT IS THE CLAIM. A unique index on (organizationId, job, dateKey) makes the second
 * one fail, whichever process makes it - which is the same mechanism every other runner in this
 * codebase already uses for its own unit of work (`claimNextOutboundMessage`, `claimAutoGreet`,
 * `claimDueReminder` and the rest). The daily jobs were the only ones without one, because
 * `digest` and `booking-countdown` notify the owner once per day rather than iterating
 * claimable rows.
 *
 * SHARED WITH THE PYTHON SERVICE. `crm-api/app/daily_jobs.py` writes the same collection with
 * the same index, so whichever service is scheduling a job, only one run happens per local day.
 *
 * `organizationId` IS NULL FOR THESE JOBS. `createDailyScheduler` is organization-agnostic - it
 * calls `service.sendDigest({})` and the service decides who to notify - so the claim is global
 * per (job, dateKey). The field stays so a job that becomes per-organization later needs no
 * schema change.
 */
import mongoose, { type Model, type Types } from 'mongoose';

export interface DailyJobRunDocument {
  _id: Types.ObjectId;
  organizationId: Types.ObjectId | null;
  job: string;
  /** Local calendar day in the business timezone, `YYYY-MM-DD`. */
  dateKey: string;
  claimedAt: Date;
  /** Which service claimed it, so an operator can tell during the migration. */
  claimedBy: string;
}

const dailyJobRunSchema = new mongoose.Schema<DailyJobRunDocument>(
  {
    organizationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Organization',
      default: null,
    },

    job: {
      type: String,
      required: true,
      trim: true,
    },

    dateKey: {
      type: String,
      required: true,
      match: /^\d{4}-\d{2}-\d{2}$/,
    },

    claimedAt: {
      type: Date,
      required: true,
      default: () => new Date(),
    },

    claimedBy: {
      type: String,
      default: 'wam-backend',
    },
  },
  { collection: 'dailyjobruns' },
);

// The guarantee. Without this index two concurrent inserts both succeed and both jobs run.
dailyJobRunSchema.index(
  { organizationId: 1, job: 1, dateKey: 1 },
  { unique: true, name: 'uniq_daily_job_run' },
);

export const DailyJobRun: Model<DailyJobRunDocument> =
  (mongoose.models.DailyJobRun as Model<DailyJobRunDocument> | undefined) ??
  mongoose.model<DailyJobRunDocument>('DailyJobRun', dailyJobRunSchema);

export interface ClaimDailyRunParams {
  job: string;
  dateKey: string;
  organizationId?: Types.ObjectId | null;
  claimedBy?: string;
}

/** True when this caller won the right to run `job` for `dateKey`. */
export const claimDailyRun = async ({
  job,
  dateKey,
  organizationId = null,
  claimedBy = 'wam-backend',
}: ClaimDailyRunParams): Promise<boolean> => {
  try {
    await DailyJobRun.create({ organizationId, job, dateKey, claimedAt: new Date(), claimedBy });

    return true;
  } catch (error: unknown) {
    // 11000 is the duplicate-key code, and it is the ONLY error that means "somebody else has
    // it". Anything else - a connection failure, a validation error - is rethrown, because
    // swallowing it would silently skip the job for the day and look identical to success.
    if ((error as { code?: unknown })?.code === 11000) {
      return false;
    }

    throw error;
  }
};
