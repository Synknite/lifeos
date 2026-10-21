import { z } from 'zod';

/**
 * What the LLM extracts from a quick-capture string. Dates stay as verbatim
 * phrases; `resolveDatePhrase` turns them into instants deterministically.
 */
export const captureExtractionSchema = z.object({
  kind: z.enum(['task', 'note']).describe('task = something to do; note = information to remember'),
  title: z.string().describe('Short imperative title for tasks, or a short title for notes'),
  details: z.string().nullable().describe('Any extra detail from the input that is not in the title, else null'),
  duePhrase: z
    .string()
    .nullable()
    .describe('The exact words from the input describing when it is due, e.g. "next friday at 3pm", else null'),
  remindPhrase: z
    .string()
    .nullable()
    .describe('The exact words describing when to remind, if the user asked for a reminder, else null'),
  priority: z.number().int().min(0).max(3).describe('0 none, 1 low, 2 medium, 3 high/urgent'),
  tags: z.array(z.string()).max(5).describe('Up to 5 lowercase single-word tags'),
  projectName: z.string().nullable().describe('Name of an existing project this belongs to, else null'),
});
export type CaptureExtraction = z.infer<typeof captureExtractionSchema>;

export const captureRequestSchema = z.object({
  text: z.string().trim().min(1).max(2_000),
});

export const capturePreviewSchema = z.object({
  kind: z.enum(['task', 'note']),
  title: z.string(),
  details: z.string().nullable(),
  dueAt: z.string().nullable(),
  allDay: z.boolean(),
  remindAt: z.string().nullable(),
  priority: z.number().int(),
  tags: z.array(z.string()),
  projectId: z.uuid().nullable(),
  projectName: z.string().nullable(),
  provider: z.string(),
  model: z.string(),
});
export type CapturePreview = z.infer<typeof capturePreviewSchema>;
