import { z } from 'zod';

export const NOTE_KINDS = ['note', 'journal'] as const;

export const noteSchema = z.object({
  id: z.uuid(),
  kind: z.enum(NOTE_KINDS),
  title: z.string(),
  bodyMd: z.string(),
  journalDate: z.iso.date().nullable(),
  tags: z.array(z.string()),
  indexed: z.boolean(),
  createdAt: z.iso.datetime({ offset: true }),
  updatedAt: z.iso.datetime({ offset: true }),
});
export type Note = z.infer<typeof noteSchema>;

export const createNoteSchema = z.object({
  kind: z.enum(NOTE_KINDS).default('note'),
  title: z.string().trim().max(300).default(''),
  bodyMd: z.string().max(100_000),
  journalDate: z.iso.date().nullish(),
  tags: z.array(z.string().trim().toLowerCase().min(1).max(32)).max(10).default([]),
});
export type CreateNoteInput = z.input<typeof createNoteSchema>;
export const updateNoteSchema = createNoteSchema.partial();

export const searchQuerySchema = z.object({
  q: z.string().trim().min(1).max(500),
  limit: z.coerce.number().int().min(1).max(50).default(10),
});

export const searchHitSchema = z.object({
  noteId: z.uuid(),
  title: z.string(),
  kind: z.enum(NOTE_KINDS),
  snippet: z.string(),
  score: z.number(),
  matchedBy: z.array(z.enum(['fulltext', 'semantic'])),
});
export type SearchHit = z.infer<typeof searchHitSchema>;
