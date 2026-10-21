import { z } from 'zod';

export const TASK_STATUSES = ['inbox', 'todo', 'doing', 'done', 'cancelled'] as const;
export const taskStatusSchema = z.enum(TASK_STATUSES);
export type TaskStatus = z.infer<typeof taskStatusSchema>;

export const TASK_SOURCES = ['manual', 'capture', 'chat', 'briefing'] as const;
export const taskSourceSchema = z.enum(TASK_SOURCES);

/** 0 = none, 1 = low, 2 = medium, 3 = high. */
export const prioritySchema = z.number().int().min(0).max(3);

const tag = z
  .string()
  .trim()
  .toLowerCase()
  .min(1)
  .max(32)
  .regex(/^[\p{L}\p{N}_-]+$/u, 'tags may contain letters, numbers, _ and -');

export const taskSchema = z.object({
  id: z.uuid(),
  title: z.string(),
  notes: z.string().nullable(),
  status: taskStatusSchema,
  priority: prioritySchema,
  dueAt: z.iso.datetime({ offset: true }).nullable(),
  allDay: z.boolean(),
  projectId: z.uuid().nullable(),
  tags: z.array(z.string()),
  source: taskSourceSchema,
  completedAt: z.iso.datetime({ offset: true }).nullable(),
  createdAt: z.iso.datetime({ offset: true }),
  updatedAt: z.iso.datetime({ offset: true }),
});
export type Task = z.infer<typeof taskSchema>;

export const createTaskSchema = z.object({
  title: z.string().trim().min(1).max(300),
  notes: z.string().max(10_000).nullish(),
  status: taskStatusSchema.default('todo'),
  priority: prioritySchema.default(0),
  dueAt: z.iso.datetime({ offset: true }).nullish(),
  allDay: z.boolean().default(false),
  projectId: z.uuid().nullish(),
  tags: z.array(tag).max(10).default([]),
  source: taskSourceSchema.default('manual'),
});
export type CreateTaskInput = z.input<typeof createTaskSchema>;

export const updateTaskSchema = createTaskSchema.omit({ source: true }).partial();
export type UpdateTaskInput = z.input<typeof updateTaskSchema>;

export const listTasksQuerySchema = z.object({
  view: z.enum(['inbox', 'today', 'upcoming', 'all', 'done']).default('all'),
  projectId: z.uuid().optional(),
  q: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});
export type ListTasksQuery = z.infer<typeof listTasksQuerySchema>;

export const PROJECT_STATUSES = ['active', 'someday', 'done', 'archived'] as const;

export const projectSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  description: z.string().nullable(),
  status: z.enum(PROJECT_STATUSES),
  color: z.string().nullable(),
  openTaskCount: z.number().int(),
  createdAt: z.iso.datetime({ offset: true }),
});
export type Project = z.infer<typeof projectSchema>;

export const createProjectSchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().max(2_000).nullish(),
  status: z.enum(PROJECT_STATUSES).default('active'),
  color: z
    .string()
    .regex(/^#[0-9a-f]{6}$/i)
    .nullish(),
});
export const updateProjectSchema = createProjectSchema.partial();
