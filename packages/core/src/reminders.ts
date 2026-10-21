import { type Database, schema } from '@lifeos/db';
import { and, desc, eq, isNull, lte, sql } from 'drizzle-orm';
import { NotFoundError, ValidationError } from './errors.js';
import type { JobScheduler } from './queues.js';

const { reminders, notifications } = schema;

export interface Reminder {
  id: string;
  taskId: string | null;
  title: string;
  remindAt: string;
  channel: 'in_app' | 'email';
  status: 'pending' | 'sent' | 'failed' | 'cancelled';
}

export interface Notification {
  id: string;
  kind: 'reminder' | 'briefing' | 'system';
  title: string;
  body: string | null;
  link: string | null;
  read: boolean;
  createdAt: string;
}

const toReminder = (r: typeof reminders.$inferSelect): Reminder => ({
  id: r.id,
  taskId: r.taskId,
  title: r.title,
  remindAt: r.remindAt.toISOString(),
  channel: r.channel,
  status: r.status,
});

/**
 * Reminders are durable in Postgres; BullMQ delayed jobs are just the fast
 * path. A sweeper re-enqueues anything overdue, so losing Redis data delays
 * a reminder by at most one sweep interval instead of dropping it.
 */
export class ReminderService {
  constructor(
    private readonly db: Database,
    private readonly jobs: JobScheduler,
  ) {}

  async create(
    userId: string,
    input: { title: string; remindAt: Date; taskId?: string | null; channel?: 'in_app' | 'email' },
  ): Promise<Reminder> {
    if (Number.isNaN(input.remindAt.getTime())) throw new ValidationError('Invalid reminder time');
    if (input.remindAt.getTime() < Date.now() - 60_000) throw new ValidationError('Reminder time is in the past');
    const [row] = await this.db
      .insert(reminders)
      .values({
        userId,
        title: input.title,
        remindAt: input.remindAt,
        taskId: input.taskId ?? null,
        channel: input.channel ?? 'in_app',
      })
      .returning();
    await this.jobs.scheduleReminder(row!.id, row!.remindAt);
    return toReminder(row!);
  }

  async listForTask(userId: string, taskId: string): Promise<Reminder[]> {
    const rows = await this.db
      .select()
      .from(reminders)
      .where(and(eq(reminders.userId, userId), eq(reminders.taskId, taskId)))
      .orderBy(reminders.remindAt);
    return rows.map(toReminder);
  }

  async cancel(userId: string, id: string): Promise<void> {
    const rows = await this.db
      .update(reminders)
      .set({ status: 'cancelled' })
      .where(and(eq(reminders.id, id), eq(reminders.userId, userId), eq(reminders.status, 'pending')))
      .returning({ id: reminders.id });
    if (!rows.length) throw new NotFoundError('Pending reminder');
    await this.jobs.cancelReminder(id);
  }

  /**
   * Claim a due reminder for delivery. The conditional UPDATE makes delivery
   * exactly-once even if the job runs twice (retry, sweeper overlap).
   * Returns null if it was already handled, cancelled, or isn't due yet.
   */
  async claimForDelivery(id: string): Promise<(Reminder & { userId: string; lagSeconds: number }) | null> {
    const [row] = await this.db
      .update(reminders)
      .set({ status: 'sent', sentAt: sql`now()`, attempts: sql`${reminders.attempts} + 1` })
      .where(
        and(
          eq(reminders.id, id),
          eq(reminders.status, 'pending'),
          lte(reminders.remindAt, sql`now() + interval '5 seconds'`),
        ),
      )
      .returning();
    if (!row) return null;
    return { ...toReminder(row), userId: row.userId, lagSeconds: (Date.now() - row.remindAt.getTime()) / 1000 };
  }

  /** Put a claimed reminder back after a delivery failure, so a retry can claim it again. */
  async releaseAfterFailure(id: string, error: string, giveUp: boolean): Promise<void> {
    await this.db
      .update(reminders)
      .set({ status: giveUp ? 'failed' : 'pending', sentAt: null, lastError: error.slice(0, 500) })
      .where(eq(reminders.id, id));
  }

  /** Pending reminders that should already have fired (input for the sweeper). */
  async overdue(graceSeconds = 30, limit = 500): Promise<{ id: string; remindAt: Date }[]> {
    return this.db
      .select({ id: reminders.id, remindAt: reminders.remindAt })
      .from(reminders)
      .where(
        and(
          eq(reminders.status, 'pending'),
          lte(reminders.remindAt, sql`now() - make_interval(secs => ${graceSeconds})`),
        ),
      )
      .orderBy(reminders.remindAt)
      .limit(limit);
  }
}

export class NotificationService {
  constructor(private readonly db: Database) {}

  async create(
    userId: string,
    n: { kind: Notification['kind']; title: string; body?: string | null; link?: string | null },
  ): Promise<Notification> {
    const [row] = await this.db
      .insert(notifications)
      .values({ userId, kind: n.kind, title: n.title, body: n.body ?? null, link: n.link ?? null })
      .returning();
    return toNotification(row!);
  }

  async list(userId: string, opts: { unreadOnly?: boolean; limit?: number } = {}): Promise<Notification[]> {
    const rows = await this.db
      .select()
      .from(notifications)
      .where(and(eq(notifications.userId, userId), opts.unreadOnly ? isNull(notifications.readAt) : undefined))
      .orderBy(desc(notifications.createdAt))
      .limit(opts.limit ?? 50);
    return rows.map(toNotification);
  }

  async markRead(userId: string, ids: string[] | 'all'): Promise<number> {
    const rows = await this.db
      .update(notifications)
      .set({ readAt: sql`now()` })
      .where(
        and(
          eq(notifications.userId, userId),
          isNull(notifications.readAt),
          ids === 'all' ? undefined : sql`${notifications.id} = any(${ids}::uuid[])`,
        ),
      )
      .returning({ id: notifications.id });
    return rows.length;
  }
}

function toNotification(r: typeof notifications.$inferSelect): Notification {
  return {
    id: r.id,
    kind: r.kind,
    title: r.title,
    body: r.body,
    link: r.link,
    read: r.readAt !== null,
    createdAt: r.createdAt.toISOString(),
  };
}
