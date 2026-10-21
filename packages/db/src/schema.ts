import { sql } from 'drizzle-orm';
import {
  boolean,
  customType,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  vector,
} from 'drizzle-orm/pg-core';
import { v7 as uuidv7 } from 'uuid';

export const EMBEDDING_DIMS = 768;

const tsvector = customType<{ data: string }>({ dataType: () => 'tsvector' });

/** UUIDv7 primary key: time-ordered, so B-tree inserts stay append-mostly. */
const id = () =>
  uuid('id')
    .primaryKey()
    .$defaultFn(() => uuidv7())
    .default(sql`gen_random_uuid()`);

// Millisecond precision so values round-trip exactly through JS Dates
// (compare-and-set on updated_at would otherwise never match).
const tstz = (name: string) => timestamp(name, { withTimezone: true, mode: 'date', precision: 3 });
const createdAt = () => tstz('created_at').notNull().defaultNow();
const updatedAt = () =>
  tstz('updated_at')
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date());

const userRef = () =>
  uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' });

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

export const users = pgTable(
  'users',
  {
    id: id(),
    email: text('email').notNull(),
    passwordHash: text('password_hash').notNull(),
    displayName: text('display_name').notNull(),
    timezone: text('timezone').notNull().default('UTC'),
    briefingEnabled: boolean('briefing_enabled').notNull().default(true),
    /** Local time of day for the daily briefing, "HH:MM". */
    briefingTime: text('briefing_time').notNull().default('07:30'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('users_email_lower_idx').on(sql`lower(${t.email})`)],
);

export const sessions = pgTable(
  'sessions',
  {
    /** sha256 of the opaque session token; the raw token only lives in the cookie. */
    id: text('id').primaryKey(),
    userId: userRef(),
    expiresAt: tstz('expires_at').notNull(),
    userAgent: text('user_agent'),
    ip: text('ip'),
    createdAt: createdAt(),
  },
  (t) => [index('sessions_user_idx').on(t.userId), index('sessions_expires_idx').on(t.expiresAt)],
);

// ---------------------------------------------------------------------------
// Planning
// ---------------------------------------------------------------------------

export const projects = pgTable(
  'projects',
  {
    id: id(),
    userId: userRef(),
    name: text('name').notNull(),
    description: text('description'),
    status: text('status', { enum: ['active', 'someday', 'done', 'archived'] })
      .notNull()
      .default('active'),
    color: text('color'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('projects_user_idx').on(t.userId, t.status)],
);

export const tasks = pgTable(
  'tasks',
  {
    id: id(),
    userId: userRef(),
    projectId: uuid('project_id').references(() => projects.id, { onDelete: 'set null' }),
    title: text('title').notNull(),
    notes: text('notes'),
    status: text('status', { enum: ['inbox', 'todo', 'doing', 'done', 'cancelled'] })
      .notNull()
      .default('todo'),
    priority: smallint('priority').notNull().default(0),
    dueAt: tstz('due_at'),
    allDay: boolean('all_day').notNull().default(false),
    tags: text('tags')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    source: text('source', { enum: ['manual', 'capture', 'chat', 'briefing'] })
      .notNull()
      .default('manual'),
    completedAt: tstz('completed_at'),
    deletedAt: tstz('deleted_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('tasks_user_status_due_idx').on(t.userId, t.status, t.dueAt),
    index('tasks_project_idx').on(t.projectId),
    index('tasks_tags_idx').using('gin', t.tags),
  ],
);

export const reminders = pgTable(
  'reminders',
  {
    id: id(),
    userId: userRef(),
    taskId: uuid('task_id').references(() => tasks.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    remindAt: tstz('remind_at').notNull(),
    channel: text('channel', { enum: ['in_app', 'email'] })
      .notNull()
      .default('in_app'),
    status: text('status', { enum: ['pending', 'sent', 'failed', 'cancelled'] })
      .notNull()
      .default('pending'),
    attempts: integer('attempts').notNull().default(0),
    sentAt: tstz('sent_at'),
    lastError: text('last_error'),
    createdAt: createdAt(),
  },
  (t) => [
    // The sweeper scans this to re-enqueue overdue reminders.
    index('reminders_pending_idx')
      .on(t.remindAt)
      .where(sql`${t.status} = 'pending'`),
    index('reminders_user_idx').on(t.userId),
  ],
);

export const notifications = pgTable(
  'notifications',
  {
    id: id(),
    userId: userRef(),
    kind: text('kind', { enum: ['reminder', 'briefing', 'system'] }).notNull(),
    title: text('title').notNull(),
    body: text('body'),
    link: text('link'),
    readAt: tstz('read_at'),
    createdAt: createdAt(),
  },
  (t) => [index('notifications_user_idx').on(t.userId, t.createdAt)],
);

// ---------------------------------------------------------------------------
// Knowledge
// ---------------------------------------------------------------------------

export const notes = pgTable(
  'notes',
  {
    id: id(),
    userId: userRef(),
    kind: text('kind', { enum: ['note', 'journal'] })
      .notNull()
      .default('note'),
    title: text('title').notNull().default(''),
    bodyMd: text('body_md').notNull(),
    journalDate: date('journal_date', { mode: 'string' }),
    tags: text('tags')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    /** Set by the worker once chunks for the current body are embedded. */
    indexedAt: tstz('indexed_at'),
    search: tsvector('search').generatedAlwaysAs(
      sql`setweight(to_tsvector('english', coalesce(title, '')), 'A') || setweight(to_tsvector('english', body_md), 'B')`,
    ),
    deletedAt: tstz('deleted_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('notes_user_idx').on(t.userId, t.updatedAt), index('notes_search_idx').using('gin', t.search)],
);

export const noteChunks = pgTable(
  'note_chunks',
  {
    id: id(),
    userId: userRef(),
    noteId: uuid('note_id')
      .notNull()
      .references(() => notes.id, { onDelete: 'cascade' }),
    chunkIndex: integer('chunk_index').notNull(),
    content: text('content').notNull(),
    contentHash: text('content_hash').notNull(),
    embedding: vector('embedding', { dimensions: EMBEDDING_DIMS }).notNull(),
    embeddingModel: text('embedding_model').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('note_chunks_note_idx').on(t.noteId, t.chunkIndex),
    index('note_chunks_user_idx').on(t.userId),
    index('note_chunks_embedding_idx').using('hnsw', t.embedding.op('vector_cosine_ops')),
  ],
);

// ---------------------------------------------------------------------------
// Assistant
// ---------------------------------------------------------------------------

export const conversations = pgTable(
  'conversations',
  {
    id: id(),
    userId: userRef(),
    title: text('title').notNull().default('New conversation'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('conversations_user_idx').on(t.userId, t.updatedAt)],
);

export const messages = pgTable(
  'messages',
  {
    id: id(),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    role: text('role', { enum: ['user', 'assistant', 'tool'] }).notNull(),
    /** Provider-neutral message parts (see @lifeos/llm `MessagePart`). */
    parts: jsonb('parts').notNull(),
    createdAt: createdAt(),
  },
  (t) => [index('messages_conversation_idx').on(t.conversationId, t.createdAt)],
);

export const agentRuns = pgTable(
  'agent_runs',
  {
    id: id(),
    userId: userRef(),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    status: text('status', { enum: ['running', 'awaiting_confirmation', 'completed', 'failed'] })
      .notNull()
      .default('running'),
    steps: integer('steps').notNull().default(0),
    error: text('error'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('agent_runs_conversation_idx').on(t.conversationId)],
);

export const pendingActions = pgTable(
  'pending_actions',
  {
    id: id(),
    userId: userRef(),
    agentRunId: uuid('agent_run_id')
      .notNull()
      .references(() => agentRuns.id, { onDelete: 'cascade' }),
    toolCallId: text('tool_call_id').notNull(),
    toolName: text('tool_name').notNull(),
    input: jsonb('input').notNull(),
    summary: text('summary').notNull(),
    status: text('status', { enum: ['pending', 'approved', 'rejected', 'executed', 'failed', 'expired'] })
      .notNull()
      .default('pending'),
    result: jsonb('result'),
    expiresAt: tstz('expires_at').notNull(),
    decidedAt: tstz('decided_at'),
    createdAt: createdAt(),
  },
  (t) => [index('pending_actions_run_idx').on(t.agentRunId), index('pending_actions_user_idx').on(t.userId, t.status)],
);

export const briefings = pgTable(
  'briefings',
  {
    id: id(),
    userId: userRef(),
    kind: text('kind', { enum: ['daily'] })
      .notNull()
      .default('daily'),
    periodStart: date('period_start', { mode: 'string' }).notNull(),
    contentMd: text('content_md').notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('briefings_period_idx').on(t.userId, t.kind, t.periodStart)],
);

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

export const llmCalls = pgTable(
  'llm_calls',
  {
    id: id(),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
    purpose: text('purpose').notNull(),
    provider: text('provider').notNull(),
    model: text('model').notNull(),
    inputTokens: integer('input_tokens').notNull().default(0),
    outputTokens: integer('output_tokens').notNull().default(0),
    cacheReadTokens: integer('cache_read_tokens').notNull().default(0),
    cacheWriteTokens: integer('cache_write_tokens').notNull().default(0),
    costUsd: numeric('cost_usd', { precision: 12, scale: 6, mode: 'number' }).notNull().default(0),
    latencyMs: integer('latency_ms').notNull(),
    status: text('status', { enum: ['ok', 'error'] }).notNull(),
    errorCode: text('error_code'),
    traceId: text('trace_id'),
    createdAt: createdAt(),
  },
  (t) => [index('llm_calls_user_idx').on(t.userId, t.createdAt)],
);

export const auditLog = pgTable(
  'audit_log',
  {
    id: id(),
    userId: userRef(),
    actor: text('actor', { enum: ['user', 'agent', 'system'] }).notNull(),
    action: text('action').notNull(),
    entityType: text('entity_type').notNull(),
    entityId: uuid('entity_id'),
    detail: jsonb('detail'),
    pendingActionId: uuid('pending_action_id').references(() => pendingActions.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
  },
  (t) => [index('audit_log_user_idx').on(t.userId, t.createdAt)],
);
