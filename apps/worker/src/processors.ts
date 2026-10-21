import {
  AuthService,
  BriefingService,
  IndexingService,
  NotificationService,
  ReminderService,
  TaskService,
  type BriefingJob,
  type EmbedJob,
  type JobScheduler,
  type MaintenanceJob,
  type ReminderJob,
} from '@lifeos/core';
import type { Database } from '@lifeos/db';
import type { LlmRuntime } from '@lifeos/llm';
import { appMetrics, type Logger } from '@lifeos/observability';
import type { Mailer } from './mailer.js';

export interface ProcessorDeps {
  db: Database;
  llm: LlmRuntime;
  jobs: JobScheduler;
  mailer: Mailer;
  logger: Logger;
  appUrl: string;
}

/**
 * Job handlers, kept free of BullMQ types so they can be unit/integration
 * tested by calling them directly. Every handler is idempotent: jobs may be
 * retried or delivered twice.
 */
export function createProcessors(deps: ProcessorDeps) {
  const indexing = new IndexingService(deps.db, deps.llm.embeddings);
  const jobs = deps.jobs;
  const reminders = new ReminderService(deps.db, jobs);
  const notifications = new NotificationService(deps.db);
  const tasks = new TaskService(deps.db);
  const auth = new AuthService(deps.db);
  const briefings = new BriefingService(deps.db, deps.llm.chat, tasks, notifications);

  return {
    async embedNote(job: EmbedJob) {
      const res = await indexing.indexNote(job.noteId);
      deps.logger.debug({ noteId: job.noteId, ...res }, 'note indexed');
      return res;
    },

    /** Deliver one reminder exactly once; failures put it back for retry. */
    async sendReminder(job: ReminderJob, attempt: { number: number; max: number }) {
      const claimed = await reminders.claimForDelivery(job.reminderId);
      if (!claimed) return { delivered: false };
      try {
        await notifications.create(claimed.userId, {
          kind: 'reminder',
          title: claimed.title,
          body: 'Reminder',
          link: claimed.taskId ? `/tasks/${claimed.taskId}` : null,
        });
        const user = await auth.getUser(claimed.userId);
        if (user) {
          await deps.mailer.send({
            to: user.email,
            subject: `Reminder: ${claimed.title}`,
            text: `Hi ${user.displayName},\n\nThis is your reminder: ${claimed.title}\n\nOpen LifeOS: ${deps.appUrl}/today\n`,
          });
        }
        appMetrics.reminderLag.record(Math.max(0, claimed.lagSeconds), { channel: claimed.channel });
        return { delivered: true, lagSeconds: claimed.lagSeconds };
      } catch (err) {
        await reminders.releaseAfterFailure(job.reminderId, (err as Error).message, attempt.number >= attempt.max);
        throw err;
      }
    },

    async dailyBriefing(job: BriefingJob) {
      const user = await auth.getUser(job.userId);
      if (!user?.briefingEnabled) return { skipped: true };
      const briefing = await briefings.generate(user, new Date(), { notify: true });
      return { briefingId: briefing.id };
    },

    async maintenance(job: MaintenanceJob) {
      switch (job.kind) {
        case 'reminder-sweep': {
          // Safety net for lost delayed jobs (e.g. Redis restarted without persistence).
          const overdue = await reminders.overdue();
          for (const r of overdue) await jobs.scheduleReminder(r.id, r.remindAt);
          if (overdue.length) deps.logger.warn({ count: overdue.length }, 're-enqueued overdue reminders');
          return { requeued: overdue.length };
        }
        case 'schedule-briefings': {
          const due = await briefings.dueUsers();
          for (const u of due) await jobs.enqueueBriefing(u.id, u.periodStart);
          return { enqueued: due.length };
        }
        case 'purge-sessions':
          return { purged: await auth.purgeExpiredSessions() };
      }
    },
  };
}

export type Processors = ReturnType<typeof createProcessors>;
