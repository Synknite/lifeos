import { type Database, schema } from '@lifeos/db';
import {
  chunkMarkdown,
  createNoteSchema,
  updateNoteSchema,
  type CreateNoteInput,
  type Note,
  type SearchHit,
} from '@lifeos/domain';
import type { EmbeddingProvider } from '@lifeos/llm';
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { z } from 'zod';
import { AuditService, type Actor } from './audit.js';
import { NotFoundError } from './errors.js';
import type { JobScheduler } from './queues.js';

const { notes, noteChunks } = schema;
type NoteRow = typeof notes.$inferSelect;

export function toNote(row: NoteRow): Note {
  return {
    id: row.id,
    kind: row.kind,
    title: row.title,
    bodyMd: row.bodyMd,
    journalDate: row.journalDate,
    tags: row.tags,
    indexed: row.indexedAt !== null && row.indexedAt >= row.updatedAt,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export class NoteService {
  private readonly audit: AuditService;

  constructor(
    private readonly db: Database,
    private readonly jobs: JobScheduler,
  ) {
    this.audit = new AuditService(db);
  }

  async list(userId: string, opts: { kind?: 'note' | 'journal'; limit?: number } = {}): Promise<Note[]> {
    const rows = await this.db
      .select()
      .from(notes)
      .where(and(eq(notes.userId, userId), isNull(notes.deletedAt), opts.kind ? eq(notes.kind, opts.kind) : undefined))
      .orderBy(desc(notes.updatedAt))
      .limit(Math.min(opts.limit ?? 100, 200));
    return rows.map(toNote);
  }

  async get(userId: string, id: string): Promise<Note> {
    return toNote(await this.getRow(userId, id));
  }

  async create(userId: string, input: CreateNoteInput, actor: Actor = 'user'): Promise<Note> {
    const data = createNoteSchema.parse(input);
    const [row] = await this.db
      .insert(notes)
      .values({
        userId,
        kind: data.kind,
        title: data.title,
        bodyMd: data.bodyMd,
        journalDate: data.journalDate ?? null,
        tags: data.tags,
      })
      .returning();
    await this.jobs.enqueueEmbed({ noteId: row!.id, userId }, row!.updatedAt.getTime());
    await this.audit.record({ userId, actor, action: 'note.create', entityType: 'note', entityId: row!.id });
    return toNote(row!);
  }

  async update(
    userId: string,
    id: string,
    input: z.input<typeof updateNoteSchema>,
    actor: Actor = 'user',
  ): Promise<Note> {
    const data = updateNoteSchema.parse(input);
    await this.getRow(userId, id);
    const [row] = await this.db
      .update(notes)
      .set({ ...data, journalDate: data.journalDate ?? undefined })
      .where(eq(notes.id, id))
      .returning();
    if (data.bodyMd !== undefined || data.title !== undefined) {
      await this.jobs.enqueueEmbed({ noteId: id, userId }, row!.updatedAt.getTime());
    }
    await this.audit.record({ userId, actor, action: 'note.update', entityType: 'note', entityId: id });
    return toNote(row!);
  }

  async remove(userId: string, id: string, actor: Actor = 'user'): Promise<void> {
    await this.getRow(userId, id);
    await this.db.transaction(async (tx) => {
      await tx.update(notes).set({ deletedAt: new Date() }).where(eq(notes.id, id));
      await tx.delete(noteChunks).where(eq(noteChunks.noteId, id));
    });
    await this.audit.record({ userId, actor, action: 'note.delete', entityType: 'note', entityId: id });
  }

  private async getRow(userId: string, id: string): Promise<NoteRow> {
    const [row] = await this.db
      .select()
      .from(notes)
      .where(and(eq(notes.id, id), eq(notes.userId, userId), isNull(notes.deletedAt)));
    if (!row) throw new NotFoundError('Note');
    return row;
  }
}

/**
 * Builds the semantic index for a note. Idempotent: chunks are keyed by
 * content hash, so re-running (retries, duplicate jobs) only embeds what
 * actually changed.
 */
export class IndexingService {
  constructor(
    private readonly db: Database,
    private readonly embeddings: EmbeddingProvider,
  ) {}

  async indexNote(noteId: string): Promise<{ embedded: number; reused: number; removed: number }> {
    const [note] = await this.db.select().from(notes).where(eq(notes.id, noteId));
    if (!note || note.deletedAt) {
      const removed = await this.db
        .delete(noteChunks)
        .where(eq(noteChunks.noteId, noteId))
        .returning({ id: noteChunks.id });
      return { embedded: 0, reused: 0, removed: removed.length };
    }

    const chunks = chunkMarkdown(note.bodyMd, note.title);
    const existing = await this.db
      .select({
        contentHash: noteChunks.contentHash,
        embedding: noteChunks.embedding,
        model: noteChunks.embeddingModel,
      })
      .from(noteChunks)
      .where(eq(noteChunks.noteId, noteId));
    const reusable = new Map(
      existing.filter((e) => e.model === this.embeddings.model).map((e) => [e.contentHash, e.embedding]),
    );

    const toEmbed = chunks.filter((c) => !reusable.has(c.contentHash));
    const vectors = toEmbed.length
      ? await this.embeddings.embed(
          toEmbed.map((c) => c.content),
          { purpose: 'embed', userId: note.userId },
        )
      : [];
    const fresh = new Map(toEmbed.map((c, i) => [c.contentHash, vectors[i]!]));

    await this.db.transaction(async (tx) => {
      await tx.delete(noteChunks).where(eq(noteChunks.noteId, noteId));
      if (chunks.length) {
        await tx.insert(noteChunks).values(
          chunks.map((c) => ({
            userId: note.userId,
            noteId,
            chunkIndex: c.index,
            content: c.content,
            contentHash: c.contentHash,
            embedding: reusable.get(c.contentHash) ?? fresh.get(c.contentHash)!,
            embeddingModel: this.embeddings.model,
          })),
        );
      }
      // Only mark indexed if the note wasn't edited while we were embedding.
      await tx
        .update(notes)
        .set({ indexedAt: sql`now()`, updatedAt: note.updatedAt })
        .where(and(eq(notes.id, noteId), eq(notes.updatedAt, note.updatedAt)));
    });
    return {
      embedded: toEmbed.length,
      reused: chunks.length - toEmbed.length,
      removed: Math.max(0, existing.length - chunks.length),
    };
  }
}

const RRF_K = 60;

/**
 * Hybrid search: Postgres full-text (exact words, names) fused with pgvector
 * similarity (meaning) via Reciprocal Rank Fusion, which needs no score
 * normalisation between the two very different rankers.
 */
export class SearchService {
  constructor(
    private readonly db: Database,
    private readonly embeddings: EmbeddingProvider,
  ) {}

  async search(userId: string, query: string, limit = 10): Promise<SearchHit[]> {
    const candidates = Math.max(limit * 3, 20);
    const [fulltext, semantic] = await Promise.all([
      this.fulltext(userId, query, candidates),
      this.semantic(userId, query, candidates).catch(() => [] as SemanticRow[]),
    ]);

    const fused = new Map<string, { score: number; matchedBy: Set<'fulltext' | 'semantic'>; snippet?: string }>();
    fulltext.forEach((r, i) => {
      const e = fused.get(r.id) ?? { score: 0, matchedBy: new Set() };
      e.score += 1 / (RRF_K + i + 1);
      e.matchedBy.add('fulltext');
      e.snippet = r.snippet;
      fused.set(r.id, e);
    });
    semantic.forEach((r, i) => {
      const e = fused.get(r.noteId) ?? { score: 0, matchedBy: new Set() };
      e.score += 1 / (RRF_K + i + 1);
      e.matchedBy.add('semantic');
      e.snippet ??= r.content.replace(/^# .*\n\n/, '').slice(0, 240);
      fused.set(r.noteId, e);
    });

    const ranked = [...fused.entries()].sort((a, b) => b[1].score - a[1].score).slice(0, limit);
    if (!ranked.length) return [];
    const rows = await this.db
      .select({ id: notes.id, title: notes.title, kind: notes.kind })
      .from(notes)
      .where(
        and(
          inArray(
            notes.id,
            ranked.map(([id]) => id),
          ),
          isNull(notes.deletedAt),
        ),
      );
    const byId = new Map(rows.map((r) => [r.id, r]));
    return ranked.flatMap(([id, e]) => {
      const n = byId.get(id);
      if (!n) return [];
      return [
        {
          noteId: id,
          title: n.title,
          kind: n.kind,
          snippet: e.snippet ?? '',
          score: Math.round(e.score * 1e4) / 1e4,
          matchedBy: [...e.matchedBy],
        },
      ];
    });
  }

  private async fulltext(userId: string, query: string, limit: number) {
    const tsq = sql`websearch_to_tsquery('english', ${query})`;
    return this.db
      .select({
        id: notes.id,
        snippet: sql<string>`ts_headline('english', ${notes.bodyMd}, ${tsq}, 'MaxWords=30, MinWords=10, StartSel=**, StopSel=**')`,
      })
      .from(notes)
      .where(and(eq(notes.userId, userId), isNull(notes.deletedAt), sql`${notes.search} @@ ${tsq}`))
      .orderBy(sql`ts_rank_cd(${notes.search}, ${tsq}) desc`)
      .limit(limit);
  }

  private async semantic(userId: string, query: string, limit: number): Promise<SemanticRow[]> {
    const [vector] = await this.embeddings.embed([query], { purpose: 'search', userId });
    const literal = JSON.stringify(vector);
    return this.db.transaction(async (tx) => {
      // HNSW filters after the index scan; iterative scans keep going until
      // enough rows match this user instead of silently returning too few.
      await tx.execute(sql`set local hnsw.iterative_scan = relaxed_order`);
      await tx.execute(sql`set local hnsw.ef_search = 100`);
      const rows = await tx
        .select({
          noteId: noteChunks.noteId,
          content: noteChunks.content,
          distance: sql<number>`${noteChunks.embedding} <=> ${literal}::vector`,
        })
        .from(noteChunks)
        .where(and(eq(noteChunks.userId, userId), eq(noteChunks.embeddingModel, this.embeddings.model)))
        .orderBy(sql`${noteChunks.embedding} <=> ${literal}::vector`)
        .limit(limit);
      // Keep the best chunk per note; drop weak matches.
      const best = new Map<string, SemanticRow>();
      for (const r of rows) if (r.distance < 0.8 && !best.has(r.noteId)) best.set(r.noteId, r);
      return [...best.values()];
    });
  }
}

interface SemanticRow {
  noteId: string;
  content: string;
  distance: number;
}
