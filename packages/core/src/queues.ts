import { Queue, type ConnectionOptions, type JobsOptions } from 'bullmq';

/** Queue names and payloads shared by the API (producer) and worker (consumer). */
export const QUEUES = {
  embed: 'embed-note',
  reminders: 'send-reminder',
  briefings: 'daily-briefing',
  maintenance: 'maintenance',
} as const;

export interface EmbedJob {
  noteId: string;
  userId: string;
}
export interface ReminderJob {
  reminderId: string;
}
export interface BriefingJob {
  userId: string;
}
export type MaintenanceJob = { kind: 'reminder-sweep' } | { kind: 'purge-sessions' } | { kind: 'schedule-briefings' };

/** What services need from the job system; lets tests run without Redis. */
export interface JobScheduler {
  enqueueEmbed(job: EmbedJob, version: number): Promise<void>;
  scheduleReminder(reminderId: string, at: Date): Promise<void>;
  cancelReminder(reminderId: string): Promise<void>;
  enqueueBriefing(userId: string, periodStart: string): Promise<void>;
}

const defaults: JobsOptions = {
  attempts: 5,
  backoff: { type: 'exponential', delay: 2_000 },
  removeOnComplete: { age: 3_600, count: 1_000 },
  removeOnFail: { age: 7 * 86_400 },
};

// BullMQ custom job ids may not contain ':'.
export const reminderJobId = (id: string) => `reminder-${id}`;

export class BullScheduler implements JobScheduler {
  readonly embed: Queue<EmbedJob>;
  readonly reminders: Queue<ReminderJob>;
  readonly briefings: Queue<BriefingJob>;
  readonly maintenance: Queue<MaintenanceJob>;

  constructor(connection: ConnectionOptions, prefix = 'lifeos') {
    const opts = { connection, prefix, defaultJobOptions: defaults };
    this.embed = new Queue(QUEUES.embed, opts);
    this.reminders = new Queue(QUEUES.reminders, opts);
    this.briefings = new Queue(QUEUES.briefings, opts);
    this.maintenance = new Queue(QUEUES.maintenance, opts);
  }

  async enqueueEmbed(job: EmbedJob, version: number): Promise<void> {
    // One job per note version; a short delay coalesces bursts of autosaves.
    await this.embed.add('embed', job, { jobId: `embed-${job.noteId}-${version}`, delay: 1_500 });
  }

  async scheduleReminder(reminderId: string, at: Date): Promise<void> {
    await this.reminders.add(
      'remind',
      { reminderId },
      { jobId: reminderJobId(reminderId), delay: Math.max(0, at.getTime() - Date.now()) },
    );
  }

  async cancelReminder(reminderId: string): Promise<void> {
    // Delivery also re-checks the DB row, so a job that slips through is harmless.
    await this.reminders.remove(reminderJobId(reminderId)).catch(() => 0);
  }

  async enqueueBriefing(userId: string, periodStart: string): Promise<void> {
    await this.briefings.add('brief', { userId }, { jobId: `briefing-${userId}-${periodStart}` });
  }

  async close(): Promise<void> {
    await Promise.all([this.embed.close(), this.reminders.close(), this.briefings.close(), this.maintenance.close()]);
  }
}

/** In-memory scheduler for tests and single-process demos. */
export class MemoryScheduler implements JobScheduler {
  readonly embeds: EmbedJob[] = [];
  readonly reminders = new Map<string, Date>();
  readonly briefings: { userId: string; periodStart: string }[] = [];

  async enqueueEmbed(job: EmbedJob): Promise<void> {
    this.embeds.push(job);
  }
  async scheduleReminder(reminderId: string, at: Date): Promise<void> {
    this.reminders.set(reminderId, at);
  }
  async cancelReminder(reminderId: string): Promise<void> {
    this.reminders.delete(reminderId);
  }
  async enqueueBriefing(userId: string, periodStart: string): Promise<void> {
    this.briefings.push({ userId, periodStart });
  }
  clear(): void {
    this.embeds.length = 0;
    this.reminders.clear();
    this.briefings.length = 0;
  }
}
