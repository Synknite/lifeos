import { formatLocal, prioritySchema, resolveDatePhrase, taskStatusSchema } from '@lifeos/domain';
import { defineTool, ToolRegistry, untrustedDocument } from '@lifeos/llm';
import { z } from 'zod';
import { ValidationError } from '../errors.js';
import type { NoteService, SearchService } from '../notes.js';
import type { ReminderService } from '../reminders.js';
import type { ProjectService, TaskService } from '../tasks.js';

export interface AssistantServices {
  tasks: TaskService;
  projects: ProjectService;
  notes: NoteService;
  search: SearchService;
  reminders: ReminderService;
}

/** Per-run tool context. `userId` always comes from the session, never the model. */
export interface ToolContext {
  userId: string;
  timezone: string;
  now: Date;
  services: AssistantServices;
  pendingActionId?: string;
}

const when = z
  .string()
  .max(100)
  .describe('When, in the user\'s own words ("tomorrow 9am", "next friday") or ISO-8601. Omit if none.');

/** Resolve a model-supplied date: ISO passes through; phrases go through chrono in the user's zone. */
export function resolveWhen(
  value: string,
  ctx: Pick<ToolContext, 'now' | 'timezone'>,
): { at: string; allDay: boolean } {
  if (/^\d{4}-\d{2}-\d{2}T/.test(value) && !Number.isNaN(Date.parse(value))) {
    return { at: new Date(value).toISOString(), allDay: false };
  }
  const r = resolveDatePhrase(value, ctx.now, ctx.timezone);
  if (!r) throw new ValidationError(`Couldn't understand the date "${value}". Try something like "tomorrow at 9am".`);
  return { at: r.at, allDay: r.allDay };
}

function describeWhen(value: string | null | undefined, ctx: ToolContext): string {
  if (!value) return '';
  try {
    const r = resolveWhen(value, ctx);
    const d = new Date(r.at);
    return r.allDay
      ? new Intl.DateTimeFormat('en-US', {
          timeZone: ctx.timezone,
          weekday: 'short',
          month: 'short',
          day: 'numeric',
        }).format(d)
      : formatLocal(d, ctx.timezone);
  } catch {
    return `"${value}" (unrecognized date)`;
  }
}

const compactTask = (t: {
  id: string;
  title: string;
  status: string;
  priority: number;
  dueAt: string | null;
  tags: string[];
}) => ({
  id: t.id,
  title: t.title,
  status: t.status,
  priority: t.priority,
  dueAt: t.dueAt,
  tags: t.tags,
});

export function buildAssistantTools(): ToolRegistry<ToolContext> {
  return new ToolRegistry<ToolContext>([
    defineTool({
      name: 'list_tasks',
      description:
        "List the user's tasks. view: today (due today or overdue), upcoming (due later), inbox (unsorted), all (every open task), done (recently completed).",
      input: z.object({
        view: z.enum(['today', 'upcoming', 'inbox', 'all', 'done']).default('today'),
        query: z.string().max(100).optional().describe('Optional text filter'),
      }),
      risk: 'read',
      summarize: (i) => `Look up ${i.view} tasks${i.query ? ` matching "${i.query}"` : ''}`,
      handler: async (i, ctx) => {
        const tasks = await ctx.services.tasks.list(ctx.userId, ctx.timezone, { view: i.view, q: i.query, limit: 50 });
        return JSON.stringify(tasks.map(compactTask));
      },
    }),

    defineTool({
      name: 'search_notes',
      description: "Search the user's notes and journal by meaning and keywords. Returns the best matching excerpts.",
      input: z.object({ query: z.string().min(1).max(200) }),
      risk: 'read',
      summarize: (i) => `Search notes for "${i.query}"`,
      handler: async (i, ctx) => {
        const hits = await ctx.services.search.search(ctx.userId, i.query, 6);
        if (!hits.length) return 'No matching notes.';
        return hits.map((h) => untrustedDocument(h.noteId, h.title || '(untitled)', h.snippet)).join('\n');
      },
    }),

    defineTool({
      name: 'get_note',
      description: 'Read the full text of one note by id (ids come from search_notes).',
      input: z.object({ id: z.uuid() }),
      risk: 'read',
      summarize: () => 'Open a note',
      handler: async (i, ctx) => {
        const note = await ctx.services.notes.get(ctx.userId, i.id);
        return untrustedDocument(note.id, note.title || '(untitled)', note.bodyMd.slice(0, 20_000));
      },
    }),

    defineTool({
      name: 'create_task',
      description: 'Create a task, optionally with a due date and a reminder.',
      input: z.object({
        title: z.string().trim().min(1).max(300),
        notes: z.string().max(5_000).optional(),
        due: when.optional(),
        remind: when.optional().describe('When to send a reminder, if the user asked for one'),
        priority: prioritySchema.optional().describe('0 none, 1 low, 2 medium, 3 high'),
        tags: z.array(z.string().max(32)).max(5).optional(),
        project: z.string().max(120).optional().describe('Existing project name'),
      }),
      risk: 'write',
      summarize: (i, ctx) =>
        [
          `Create task "${i.title}"`,
          i.due ? `due ${describeWhen(i.due, ctx)}` : '',
          i.remind ? `· remind ${describeWhen(i.remind, ctx)}` : '',
          i.priority ? `· priority ${i.priority}` : '',
          i.project ? `· in ${i.project}` : '',
        ]
          .filter(Boolean)
          .join(' '),
      handler: async (i, ctx) => {
        const due = i.due ? resolveWhen(i.due, ctx) : null;
        const project = i.project ? await ctx.services.projects.findByName(ctx.userId, i.project) : null;
        const task = await ctx.services.tasks.create(
          ctx.userId,
          {
            title: i.title,
            notes: i.notes,
            dueAt: due?.at,
            allDay: due?.allDay ?? false,
            priority: i.priority ?? 0,
            tags: (i.tags ?? []).map((t) => t.toLowerCase().replace(/[^\p{L}\p{N}_-]/gu, '')).filter(Boolean),
            projectId: project?.id,
            source: 'chat',
          },
          'agent',
        );
        if (i.remind) {
          await ctx.services.reminders.create(ctx.userId, {
            title: task.title,
            remindAt: new Date(resolveWhen(i.remind, ctx).at),
            taskId: task.id,
          });
        }
        return JSON.stringify({ ...compactTask(task), reminder: i.remind ? describeWhen(i.remind, ctx) : null });
      },
    }),

    defineTool({
      name: 'update_task',
      description: 'Change an existing task (title, due date, priority or status). Use list_tasks to find its id.',
      input: z.object({
        id: z.uuid(),
        title: z.string().trim().min(1).max(300).optional(),
        due: when.nullable().optional().describe('New due date, or null to clear it'),
        priority: prioritySchema.optional(),
        status: taskStatusSchema.optional(),
      }),
      risk: 'write',
      summarize: (i, ctx) => {
        const changes = [
          i.title && `rename to "${i.title}"`,
          i.due === null ? 'clear due date' : i.due && `due ${describeWhen(i.due, ctx)}`,
          i.priority !== undefined && `priority ${i.priority}`,
          i.status && `mark ${i.status}`,
        ].filter(Boolean);
        return `Update task: ${changes.join(', ') || 'no changes'}`;
      },
      handler: async (i, ctx) => {
        const due = i.due ? resolveWhen(i.due, ctx) : undefined;
        const task = await ctx.services.tasks.update(
          ctx.userId,
          i.id,
          {
            title: i.title,
            priority: i.priority,
            status: i.status,
            ...(i.due === null ? { dueAt: null } : due ? { dueAt: due.at, allDay: due.allDay } : {}),
          },
          'agent',
        );
        return JSON.stringify(compactTask(task));
      },
    }),

    defineTool({
      name: 'complete_task',
      description: 'Mark a task as done.',
      input: z.object({ id: z.uuid() }),
      risk: 'write',
      summarize: () => 'Mark a task as done',
      handler: async (i, ctx) =>
        JSON.stringify(compactTask(await ctx.services.tasks.complete(ctx.userId, i.id, 'agent'))),
    }),

    defineTool({
      name: 'create_note',
      description: 'Save a note (or a journal entry) for the user.',
      input: z.object({
        title: z.string().max(300).default(''),
        body: z.string().min(1).max(20_000),
        kind: z.enum(['note', 'journal']).default('note'),
      }),
      risk: 'write',
      summarize: (i) =>
        `Save ${i.kind === 'journal' ? 'journal entry' : 'note'}${i.title ? ` "${i.title}"` : ''}: ${i.body.slice(0, 80)}${i.body.length > 80 ? '…' : ''}`,
      handler: async (i, ctx) => {
        const note = await ctx.services.notes.create(
          ctx.userId,
          {
            title: i.title,
            bodyMd: i.body,
            kind: i.kind,
            journalDate: i.kind === 'journal' ? ctx.now.toISOString().slice(0, 10) : null,
          },
          'agent',
        );
        return JSON.stringify({ id: note.id, title: note.title || '(untitled)', summary: 'Note saved.' });
      },
    }),
  ]);
}
