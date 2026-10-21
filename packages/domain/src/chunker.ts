import { createHash } from 'node:crypto';

export interface Chunk {
  index: number;
  content: string;
  contentHash: string;
}

export interface ChunkOptions {
  /** Target max characters per chunk (~4 chars per token). */
  maxChars?: number;
  /** Characters of trailing context carried into the next chunk. */
  overlap?: number;
}

/**
 * Split markdown into embedding-sized chunks, preferring paragraph, then
 * sentence, then word boundaries. A title is prefixed to every chunk so each
 * embedding carries document context.
 */
export function chunkMarkdown(body: string, title = '', opts: ChunkOptions = {}): Chunk[] {
  const text = body.replace(/\r\n/g, '\n').trim();
  if (!text) return [];

  const prefix = title.trim() ? `# ${title.trim().slice(0, 200)}\n\n` : '';
  // Budget for body text so prefix + overlap + piece never exceeds maxChars.
  const maxChars = Math.max((opts.maxChars ?? 1_200) - prefix.length, 100);
  const overlap = Math.min(opts.overlap ?? 150, Math.floor(maxChars / 4));
  const SEP = '\n\n';

  const pieces = splitToFit(text, overlap > 0 ? maxChars - overlap - SEP.length : maxChars);
  const chunks: string[] = [];
  let current = '';
  for (const piece of pieces) {
    if (current && current.length + SEP.length + piece.length > maxChars) {
      chunks.push(current);
      if (overlap > 0) {
        const tail = current.slice(-overlap);
        const wordStart = tail.indexOf(' ');
        current = (wordStart >= 0 ? tail.slice(wordStart + 1) : tail) + SEP + piece;
      } else {
        current = piece;
      }
    } else {
      current = current ? current + SEP + piece : piece;
    }
  }
  if (current) chunks.push(current);

  return chunks.map((c, index) => {
    const content = prefix + c;
    return { index, content, contentHash: sha256(content) };
  });
}

function splitToFit(text: string, limit: number): string[] {
  const out: string[] = [];
  for (const para of text.split(/\n{2,}/)) {
    const p = para.trim();
    if (!p) continue;
    if (p.length <= limit) {
      out.push(p);
      continue;
    }
    // Long paragraph: fall back to sentences, then hard word wrapping.
    let buf = '';
    for (const sentence of p.split(/(?<=[.!?])\s+/)) {
      for (const part of sentence.length > limit ? wrapWords(sentence, limit) : [sentence]) {
        if (buf && buf.length + part.length + 1 > limit) {
          out.push(buf);
          buf = part;
        } else {
          buf = buf ? `${buf} ${part}` : part;
        }
      }
    }
    if (buf) out.push(buf);
  }
  return out;
}

function wrapWords(s: string, limit: number): string[] {
  const out: string[] = [];
  let line = '';
  for (const word of s.split(/\s+/)) {
    if (word.length > limit) {
      if (line) out.push(line);
      for (let i = 0; i < word.length; i += limit) out.push(word.slice(i, i + limit));
      line = '';
    } else if (line && line.length + word.length + 1 > limit) {
      out.push(line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) out.push(line);
  return out;
}

export function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}
