import { sql } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { connectTestDb, resetDb } from '../test/helpers.js';
import { appliedMigrationCount, expectedMigrationCount } from './migrate.js';
import { noteChunks, notes, users } from './schema.js';

const handle = connectTestDb();
const { db } = handle;

afterAll(() => handle.close());
beforeEach(() => resetDb(handle));

describe('schema', () => {
  it('has applied every migration', async () => {
    expect(await appliedMigrationCount(handle.sql)).toBe(expectedMigrationCount());
  });

  it('enforces case-insensitive unique emails', async () => {
    await db.insert(users).values({ email: 'Ada@example.com', passwordHash: 'x', displayName: 'Ada' });
    await expect(
      db.insert(users).values({ email: 'ada@EXAMPLE.com', passwordHash: 'x', displayName: 'Ada 2' }),
    ).rejects.toThrow();
  });

  it('generates UUIDv7 ids and a weighted full-text vector for notes', async () => {
    const [user] = await db.insert(users).values({ email: 'a@b.c', passwordHash: 'x', displayName: 'A' }).returning();
    const [note] = await db
      .insert(notes)
      .values({ userId: user!.id, title: 'Car insurance', bodyMd: 'Renewal is due in March.' })
      .returning();
    expect(note!.id[14]).toBe('7');

    const hits = await db
      .select({ id: notes.id })
      .from(notes)
      .where(sql`${notes.search} @@ websearch_to_tsquery('english', 'insurance renewal')`);
    expect(hits).toHaveLength(1);
  });

  it('stores 768-dim embeddings and orders by cosine distance', async () => {
    const [user] = await db.insert(users).values({ email: 'v@b.c', passwordHash: 'x', displayName: 'V' }).returning();
    const [note] = await db.insert(notes).values({ userId: user!.id, bodyMd: 'vectors' }).returning();
    const vec = (hot: number) => Array.from({ length: 768 }, (_, i) => (i === hot ? 1 : 0));
    await db.insert(noteChunks).values([
      {
        userId: user!.id,
        noteId: note!.id,
        chunkIndex: 0,
        content: 'a',
        contentHash: 'a',
        embedding: vec(0),
        embeddingModel: 't',
      },
      {
        userId: user!.id,
        noteId: note!.id,
        chunkIndex: 1,
        content: 'b',
        contentHash: 'b',
        embedding: vec(1),
        embeddingModel: 't',
      },
    ]);
    const query = JSON.stringify(vec(1));
    const rows = await db
      .select({ content: noteChunks.content })
      .from(noteChunks)
      .orderBy(sql`${noteChunks.embedding} <=> ${query}::vector`)
      .limit(1);
    expect(rows[0]?.content).toBe('b');
  });
});
