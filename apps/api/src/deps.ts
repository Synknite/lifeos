import type { ApiConfig } from '@lifeos/config';
import {
  AgentService,
  AuthService,
  BriefingService,
  CaptureService,
  DbUsageSink,
  NoteService,
  NotificationService,
  ProjectService,
  RedisTokenBudget,
  ReminderService,
  SearchService,
  TaskService,
  UsageService,
  type JobScheduler,
} from '@lifeos/core';
import type { DbHandle } from '@lifeos/db';
import { createLlmRuntime, type LlmRuntime } from '@lifeos/llm';
import type { Logger } from '@lifeos/observability';
import type { Redis } from 'ioredis';

export interface Services {
  auth: AuthService;
  tasks: TaskService;
  projects: ProjectService;
  notes: NoteService;
  search: SearchService;
  reminders: ReminderService;
  notifications: NotificationService;
  capture: CaptureService;
  agent: AgentService;
  usage: UsageService;
  briefings: BriefingService;
}

/** Everything the HTTP layer needs, injected so tests can supply their own. */
export interface AppDeps {
  config: ApiConfig;
  db: DbHandle;
  redis: Redis;
  logger: Logger;
  llm: LlmRuntime;
  jobs: JobScheduler;
  services: Services;
  /** Flipped on SIGTERM so /readyz fails and the load balancer drains us. */
  lifecycle: { shuttingDown: boolean; abort: AbortController };
}

export function createServices(db: DbHandle, config: ApiConfig, llm: LlmRuntime, jobs: JobScheduler): Services {
  const tasks = new TaskService(db.db);
  const projects = new ProjectService(db.db);
  const notes = new NoteService(db.db, jobs);
  const search = new SearchService(db.db, llm.embeddings);
  const reminders = new ReminderService(db.db, jobs);
  const notifications = new NotificationService(db.db);
  return {
    auth: new AuthService(db.db, config.SESSION_TTL_DAYS),
    tasks,
    projects,
    notes,
    search,
    reminders,
    notifications,
    capture: new CaptureService(llm.chat, tasks, projects, notes, reminders),
    agent: new AgentService(db.db, llm.chat, { tasks, projects, notes, search, reminders }),
    usage: new UsageService(db.db),
    briefings: new BriefingService(db.db, llm.chat, tasks, notifications),
  };
}

/** LLM runtime with usage persisted to Postgres and a Redis-backed daily budget. */
export async function createLlm(config: ApiConfig, db: DbHandle, redis: Redis, logger: Logger): Promise<LlmRuntime> {
  return createLlmRuntime(config, {
    sink: new DbUsageSink(db.db),
    budget: new RedisTokenBudget(redis, config.LLM_DAILY_TOKEN_BUDGET),
    onSinkError: (err) => logger.warn({ err }, 'failed to record llm usage'),
  });
}
