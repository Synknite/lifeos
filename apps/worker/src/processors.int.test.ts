import { AuthService, MemoryScheduler, ReminderService, TaskService } from '@lifeos/core';
import { schema } from '@lifeos/db';
import { connectTestDb, resetDb } from '@lifeos/db/testing';
import { createLlmRuntime, type LlmRuntime } from '@lifeos/llm';
import { createLogger } from '@lifeos/observability';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MemoryMailer } from './mailer.js';
import { createProcessors, type Processors } from './processors.js';

const handle = connectTestDb();
const db = handle.db;
let llm: LlmRuntime;
let jobs: MemoryScheduler;
let mailer: MemoryMailer;
let p: Processors;
const auth = new AuthService(db);

beforeAll(async () => {
  llm = await createLlmRuntime(
    {
      LLM_PROVIDER: 'mock',
      EMBEDDING_PROVIDER: 'mock',
      ANTHROPIC_MODEL_SMART: 'x',
      ANTHROPIC_MODEL_FAST: 'x',
      OPENAI_MODEL_SMART: 'x',
      OPENAI_MODEL_FAST: 'x',
      OPENAI_EMBEDDING_MODEL: 'x',
      OLLAMA_BASE_URL: 'http://localhost:1',
      OLLAMA_MODEL: 'x',
      OLLAMA_EMBEDDING_MODEL: 'x',
    },
    {},
    async () => false,
  );
});
afterAll(() => handle.close());
beforeEach(async () => {
  await resetDb(handle);
  jobs = new MemoryScheduler();
  mailer = new MemoryMailer();
  p = createProcessors({
    db,
    llm,
    jobs,
    mailer,
    logger: createLogger({ service: 't', level: 'silent', version: 't' }),
    appUrl: 'http://app',
  });
});

const newUser = (tz = 'UTC') =>
  auth.signup({
    email: `w${Math.random()}@example.com`,
    password: 'correct horse battery',
    displayName: 'Wren',
    timezone: tz,
  });

describe('reminders', () => {
  it('delivers a due reminder exactly once, by in-app notification and email', async () => {
    const user = await newUser();
    const reminder = await new ReminderService(db, jobs).create(user.id, {
      title: 'Stretch',
      remindAt: new Date(Date.now() + 1_000),
    });
    expect(jobs.reminders.has(reminder.id)).toBe(true);
    await db
      .update(schema.reminders)
      .set({ remindAt: sql`now() - interval '1 second'` })
      .where(eq(schema.reminders.id, reminder.id));

    const [a, b] = await Promise.all([
      p.sendReminder({ reminderId: reminder.id }, { number: 1, max: 5 }),
      p.sendReminder({ reminderId: reminder.id }, { number: 1, max: 5 }),
    ]);
    expect([a.delivered, b.delivered].sort()).toEqual([false, true]);
    expect(mailer.sent).toEqual([expect.objectContaining({ to: user.email, subject: 'Reminder: Stretch' })]);
    const notes = await db.select().from(schema.notifications).where(eq(schema.notifications.userId, user.id));
    expect(notes).toHaveLength(1);
  });

  it('does not deliver early, and the sweeper re-enqueues overdue reminders', async () => {
    const user = await newUser();
    const svc = new ReminderService(db, jobs);
    const r = await svc.create(user.id, { title: 'Later', remindAt: new Date(Date.now() + 3_600_000) });
    expect((await p.sendReminder({ reminderId: r.id }, { number: 1, max: 5 })).delivered).toBe(false);

    // Simulate a lost delayed job for a reminder that's now overdue.
    jobs.reminders.clear();
    await db
      .update(schema.reminders)
      .set({ remindAt: sql`now() - interval '5 minutes'` })
      .where(eq(schema.reminders.id, r.id));
    expect(await p.maintenance({ kind: 'reminder-sweep' })).toEqual({ requeued: 1 });
    expect(jobs.reminders.has(r.id)).toBe(true);
  });

  it('releases the claim when delivery fails so a retry can deliver', async () => {
    const user = await newUser();
    const r = await new ReminderService(db, jobs).create(user.id, { title: 'Retry me', remindAt: new Date() });
    mailer.send = async () => {
      throw new Error('smtp down');
    };
    await expect(p.sendReminder({ reminderId: r.id }, { number: 1, max: 5 })).rejects.toThrow('smtp down');
    const [row] = await db.select().from(schema.reminders).where(eq(schema.reminders.id, r.id));
    expect(row).toMatchObject({ status: 'pending', lastError: 'smtp down' });
  });

  it('completing a task cancels its reminders', async () => {
    const user = await newUser();
    const task = await new TaskService(db).create(user.id, { title: 'Pay bill' });
    const r = await new ReminderService(db, jobs).create(user.id, {
      title: 'Pay bill',
      remindAt: new Date(),
      taskId: task.id,
    });
    await new TaskService(db).complete(user.id, task.id);
    expect((await p.sendReminder({ reminderId: r.id }, { number: 1, max: 5 })).delivered).toBe(false);
  });
});

describe('daily briefing', () => {
  it('schedules users whose local briefing time has passed, once per local day', async () => {
    const early = await newUser('Pacific/Kiritimati'); // UTC+14: almost always past 00:00
    await auth.updateProfile(early.id, { briefingTime: '00:00' });
    const late = await newUser('UTC');
    await auth.updateProfile(late.id, { briefingTime: '23:59' });

    const due = await p.maintenance({ kind: 'schedule-briefings' });
    expect(jobs.briefings.map((b) => b.userId)).toContain(early.id);
    expect(jobs.briefings.map((b) => b.userId)).not.toContain(late.id);
    expect(due).toMatchObject({ enqueued: expect.any(Number) });

    await new TaskService(db).create(early.id, {
      title: 'Ship the release',
      dueAt: new Date().toISOString(),
      priority: 3,
    });
    await p.dailyBriefing({ userId: early.id });
    await p.dailyBriefing({ userId: early.id }); // idempotent
    const rows = await db.select().from(schema.briefings).where(eq(schema.briefings.userId, early.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.contentMd).toContain('Ship the release');

    jobs.clear();
    await p.maintenance({ kind: 'schedule-briefings' });
    expect(jobs.briefings.map((b) => b.userId)).not.toContain(early.id);
  });
});

describe('maintenance', () => {
  it('purges expired sessions', async () => {
    const user = await newUser();
    await auth.createSession(user.id);
    await db.update(schema.sessions).set({ expiresAt: sql`now() - interval '1 day'` });
    expect(await p.maintenance({ kind: 'purge-sessions' })).toEqual({ purged: 1 });
  });
});
