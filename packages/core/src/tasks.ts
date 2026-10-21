import { type Database, schema } from '@lifeos/db';
import {
  createProjectSchema,
  createTaskSchema,
  listTasksQuerySchema,
  localDayBounds,
  type Project,
  type Task,
  updateProjectSchema,
  updateTaskSchema,
  type CreateTaskInput,
  type ListTasksQuery,
  type UpdateTaskInput,
} from '@lifeos/domain';
import { and, asc, desc, eq, gte, ilike, inArray, isNull, lt, or, sql, type SQL } from 'drizzle-orm';
import type { z } from 'zod';
import { AuditService, type Actor } from './audit.js';
import { NotFoundError, ValidationError } from './errors.js';

const { tasks, projects, reminders } = schema;
type TaskRow = typeof tasks.$inferSelect;

const OPEN_STATUSES = ['inbox', 'todo', 'doing'] as const;

export function toTask(row: TaskRow): Task {
  return {
    id: row.id,
    title: row.title,
    notes: row.notes,
    status: row.status,
    priority: row.priority,
    dueAt: row.dueAt?.toISOString() ?? null,
    allDay: row.allDay,
    projectId: row.projectId,
    tags: row.tags,
    source: row.source,
    completedAt: row.completedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export class TaskService {
  private readonly audit: AuditService;

  constructor(private readonly db: Database) {
    this.audit = new AuditService(db);
  }

  async list(userId: string, timeZone: string, query: Partial<ListTasksQuery> = {}): Promise<Task[]> {
    const q = listTasksQuerySchema.parse(query);
    const { end: endOfToday } = localDayBounds(new Date(), timeZone);
    const where: SQL[] = [eq(tasks.userId, userId), isNull(tasks.deletedAt)];
    let order: SQL[] = [desc(tasks.priority), sql`${tasks.dueAt} asc nulls last`, desc(tasks.createdAt)];

    switch (q.view) {
      case 'inbox':
        where.push(eq(tasks.status, 'inbox'));
        order = [desc(tasks.createdAt)];
        break;
      case 'today':
        // Due today or overdue.
        where.push(inArray(tasks.status, OPEN_STATUSES), lt(tasks.dueAt, endOfToday));
        order = [asc(tasks.dueAt), desc(tasks.priority)];
        break;
      case 'upcoming':
        where.push(inArray(tasks.status, OPEN_STATUSES), gte(tasks.dueAt, endOfToday));
        order = [asc(tasks.dueAt)];
        break;
      case 'done':
        where.push(eq(tasks.status, 'done'));
        order = [desc(tasks.completedAt)];
        break;
      case 'all':
        where.push(inArray(tasks.status, OPEN_STATUSES));
        break;
    }
    if (q.projectId) where.push(eq(tasks.projectId, q.projectId));
    if (q.q) where.push(or(ilike(tasks.title, `%${escapeLike(q.q)}%`), ilike(tasks.notes, `%${escapeLike(q.q)}%`))!);

    const rows = await this.db
      .select()
      .from(tasks)
      .where(and(...where))
      .orderBy(...order)
      .limit(q.limit);
    return rows.map(toTask);
  }

  async get(userId: string, id: string): Promise<Task> {
    return toTask(await this.getRow(userId, id));
  }

  async create(userId: string, input: CreateTaskInput, actor: Actor = 'user'): Promise<Task> {
    const data = createTaskSchema.parse(input);
    if (data.projectId) await this.assertProject(userId, data.projectId);
    const [row] = await this.db
      .insert(tasks)
      .values({
        userId,
        title: data.title,
        notes: data.notes ?? null,
        status: data.status,
        priority: data.priority,
        dueAt: data.dueAt ? new Date(data.dueAt) : null,
        allDay: data.allDay,
        projectId: data.projectId ?? null,
        tags: data.tags,
        source: data.source,
        completedAt: data.status === 'done' ? new Date() : null,
      })
      .returning();
    await this.audit.record({ userId, actor, action: 'task.create', entityType: 'task', entityId: row!.id });
    return toTask(row!);
  }

  async update(userId: string, id: string, input: UpdateTaskInput, actor: Actor = 'user'): Promise<Task> {
    const data = updateTaskSchema.parse(input);
    const current = await this.getRow(userId, id);
    if (data.projectId) await this.assertProject(userId, data.projectId);

    const patch: Partial<typeof tasks.$inferInsert> = {};
    if (data.title !== undefined) patch.title = data.title;
    if (data.notes !== undefined) patch.notes = data.notes;
    if (data.priority !== undefined) patch.priority = data.priority;
    if (data.allDay !== undefined) patch.allDay = data.allDay;
    if (data.tags !== undefined) patch.tags = data.tags;
    if (data.projectId !== undefined) patch.projectId = data.projectId;
    if (data.dueAt !== undefined) patch.dueAt = data.dueAt ? new Date(data.dueAt) : null;
    if (data.status !== undefined && data.status !== current.status) {
      patch.status = data.status;
      patch.completedAt = data.status === 'done' ? new Date() : null;
    }

    const row = await this.db.transaction(async (tx) => {
      const [updated] = await tx.update(tasks).set(patch).where(eq(tasks.id, id)).returning();
      // Closing a task silences its outstanding reminders.
      if (patch.status === 'done' || patch.status === 'cancelled') {
        await tx
          .update(reminders)
          .set({ status: 'cancelled' })
          .where(and(eq(reminders.taskId, id), eq(reminders.status, 'pending')));
      }
      return updated!;
    });
    await this.audit.record({
      userId,
      actor,
      action: 'task.update',
      entityType: 'task',
      entityId: id,
      detail: { fields: Object.keys(patch) },
    });
    return toTask(row);
  }

  async complete(userId: string, id: string, actor: Actor = 'user'): Promise<Task> {
    return this.update(userId, id, { status: 'done' }, actor);
  }

  /** Soft delete so the audit trail keeps referring to something real. */
  async remove(userId: string, id: string, actor: Actor = 'user'): Promise<void> {
    await this.getRow(userId, id);
    await this.db.transaction(async (tx) => {
      await tx.update(tasks).set({ deletedAt: new Date() }).where(eq(tasks.id, id));
      await tx
        .update(reminders)
        .set({ status: 'cancelled' })
        .where(and(eq(reminders.taskId, id), eq(reminders.status, 'pending')));
    });
    await this.audit.record({ userId, actor, action: 'task.delete', entityType: 'task', entityId: id });
  }

  private async getRow(userId: string, id: string): Promise<TaskRow> {
    const [row] = await this.db
      .select()
      .from(tasks)
      .where(and(eq(tasks.id, id), eq(tasks.userId, userId), isNull(tasks.deletedAt)));
    if (!row) throw new NotFoundError('Task');
    return row;
  }

  private async assertProject(userId: string, projectId: string): Promise<void> {
    const [p] = await this.db
      .select({ id: projects.id })
      .from(projects)
      .where(and(eq(projects.id, projectId), eq(projects.userId, userId)));
    if (!p) throw new ValidationError('Project does not exist');
  }
}

export class ProjectService {
  constructor(private readonly db: Database) {}

  async list(userId: string): Promise<Project[]> {
    const rows = await this.db
      .select({
        project: projects,
        openTaskCount: sql<number>`count(${tasks.id})::int`,
      })
      .from(projects)
      .leftJoin(
        tasks,
        and(eq(tasks.projectId, projects.id), isNull(tasks.deletedAt), inArray(tasks.status, OPEN_STATUSES)),
      )
      .where(eq(projects.userId, userId))
      .groupBy(projects.id)
      .orderBy(asc(projects.status), asc(projects.name));
    return rows.map((r) => toProject(r.project, r.openTaskCount));
  }

  async findByName(userId: string, name: string): Promise<Project | null> {
    const [row] = await this.db
      .select()
      .from(projects)
      .where(and(eq(projects.userId, userId), sql`lower(${projects.name}) = ${name.toLowerCase()}`));
    return row ? toProject(row, 0) : null;
  }

  async create(userId: string, input: z.input<typeof createProjectSchema>): Promise<Project> {
    const data = createProjectSchema.parse(input);
    const [row] = await this.db
      .insert(projects)
      .values({ userId, ...data })
      .returning();
    return toProject(row!, 0);
  }

  async update(userId: string, id: string, input: z.input<typeof updateProjectSchema>): Promise<Project> {
    const data = updateProjectSchema.parse(input);
    const [row] = await this.db
      .update(projects)
      .set(data)
      .where(and(eq(projects.id, id), eq(projects.userId, userId)))
      .returning();
    if (!row) throw new NotFoundError('Project');
    return toProject(row, 0);
  }

  async remove(userId: string, id: string): Promise<void> {
    const rows = await this.db
      .delete(projects)
      .where(and(eq(projects.id, id), eq(projects.userId, userId)))
      .returning({ id: projects.id });
    if (rows.length === 0) throw new NotFoundError('Project');
  }
}

function toProject(row: typeof projects.$inferSelect, openTaskCount: number): Project {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    status: row.status,
    color: row.color,
    openTaskCount,
    createdAt: row.createdAt.toISOString(),
  };
}

function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}
