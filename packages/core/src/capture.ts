import {
  captureExtractionSchema,
  formatLocal,
  resolveDatePhrase,
  type CaptureExtraction,
  type CapturePreview,
} from '@lifeos/domain';
import { CAPTURE_SYSTEM_PROMPT, type ChatProvider } from '@lifeos/llm';
import { z } from 'zod';
import type { User } from './auth.js';
import type { NoteService } from './notes.js';
import type { ReminderService } from './reminders.js';
import type { ProjectService, TaskService } from './tasks.js';

export const commitCaptureSchema = z.object({
  kind: z.enum(['task', 'note']),
  title: z.string().trim().min(1).max(300),
  details: z.string().max(10_000).nullable(),
  dueAt: z.iso.datetime({ offset: true }).nullable(),
  allDay: z.boolean(),
  remindAt: z.iso.datetime({ offset: true }).nullable(),
  priority: z.number().int().min(0).max(3),
  tags: z.array(z.string().trim().toLowerCase().min(1).max(32)).max(10),
  projectId: z.uuid().nullable(),
});
export type CommitCaptureInput = z.infer<typeof commitCaptureSchema>;

/**
 * Quick capture: free text -> structured preview -> user edits/accepts ->
 * task or note. The model only extracts fields and verbatim date phrases;
 * dates are resolved here, deterministically, in the user's timezone.
 */
export class CaptureService {
  constructor(
    private readonly llm: ChatProvider,
    private readonly tasks: TaskService,
    private readonly projects: ProjectService,
    private readonly notes: NoteService,
    private readonly reminders: ReminderService,
  ) {}

  async preview(user: User, text: string, now = new Date()): Promise<CapturePreview> {
    const projects = await this.projects.list(user.id);
    const active = projects.filter((p) => p.status === 'active').map((p) => p.name);
    const result = await this.llm.generateObject(
      {
        system: CAPTURE_SYSTEM_PROMPT,
        messages: [
          {
            role: 'user',
            parts: [
              {
                type: 'text',
                text: [
                  '<context>',
                  `Now: ${formatLocal(now, user.timezone)} (${user.timezone})`,
                  `Projects: ${active.length ? active.join(', ') : '(none)'}`,
                  '</context>',
                  '<input>',
                  text,
                  '</input>',
                ].join('\n'),
              },
            ],
          },
        ],
        maxTokens: 2_000,
      },
      captureExtractionSchema,
      { purpose: 'capture', userId: user.id, tier: 'fast', effort: 'low', timeoutMs: 20_000 },
    );
    return this.resolve(result.object, user, now, projects, result);
  }

  private resolve(
    x: CaptureExtraction,
    user: User,
    now: Date,
    projects: { id: string; name: string }[],
    meta: { provider: string; model: string },
  ): CapturePreview {
    const due = x.duePhrase ? resolveDatePhrase(x.duePhrase, now, user.timezone) : null;
    const remind = x.remindPhrase ? resolveDatePhrase(x.remindPhrase, now, user.timezone) : null;
    const project = x.projectName
      ? projects.find((p) => p.name.toLowerCase() === x.projectName!.toLowerCase())
      : undefined;
    return {
      kind: x.kind,
      title: x.title.trim() || 'Untitled',
      details: x.details,
      dueAt: due?.at ?? null,
      allDay: due?.allDay ?? false,
      remindAt: remind?.at ?? null,
      priority: x.priority,
      tags: [...new Set(x.tags.map((t) => t.toLowerCase().replace(/[^\p{L}\p{N}_-]/gu, '')).filter(Boolean))].slice(
        0,
        5,
      ),
      projectId: project?.id ?? null,
      projectName: project?.name ?? null,
      provider: meta.provider,
      model: meta.model,
    };
  }

  async commit(user: User, input: CommitCaptureInput) {
    const data = commitCaptureSchema.parse(input);
    if (data.kind === 'note') {
      const note = await this.notes.create(user.id, {
        title: data.title,
        bodyMd: data.details ?? data.title,
        tags: data.tags,
      });
      return { kind: 'note' as const, note };
    }
    const task = await this.tasks.create(user.id, {
      title: data.title,
      notes: data.details,
      dueAt: data.dueAt,
      allDay: data.allDay,
      priority: data.priority,
      tags: data.tags,
      projectId: data.projectId,
      source: 'capture',
    });
    const reminder = data.remindAt
      ? await this.reminders.create(user.id, { title: data.title, remindAt: new Date(data.remindAt), taskId: task.id })
      : null;
    return { kind: 'task' as const, task, reminder };
  }
}
