import { describe, expect, it } from 'vitest';
import { chunkMarkdown } from './chunker.js';

describe('chunkMarkdown', () => {
  it('returns nothing for empty input', () => {
    expect(chunkMarkdown('   ')).toEqual([]);
  });

  it('keeps short notes as a single chunk with the title prefix', () => {
    const [chunk, ...rest] = chunkMarkdown('Call the insurer about the car.', 'Insurance');
    expect(rest).toHaveLength(0);
    expect(chunk?.content).toBe('# Insurance\n\nCall the insurer about the car.');
    expect(chunk?.contentHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('splits long text within the size limit and preserves every word', () => {
    const para = Array.from({ length: 40 }, (_, i) => `Sentence number ${i} talks about planning.`).join(' ');
    const body = [para, para, para].join('\n\n');
    const chunks = chunkMarkdown(body, '', { maxChars: 400, overlap: 50 });
    expect(chunks.length).toBeGreaterThan(3);
    for (const c of chunks) expect(c.content.length).toBeLessThanOrEqual(400);
    const joined = chunks.map((c) => c.content).join(' ');
    expect(joined).toContain('Sentence number 39');
    expect(chunks.map((c) => c.index)).toEqual(chunks.map((_, i) => i));
  });

  it('hard-wraps a single enormous word', () => {
    const chunks = chunkMarkdown('x'.repeat(2_000), '', { maxChars: 500, overlap: 0 });
    expect(chunks.every((c) => c.content.length <= 500)).toBe(true);
  });
});
