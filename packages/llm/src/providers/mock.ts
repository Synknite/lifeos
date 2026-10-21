import * as chrono from 'chrono-node';
import type { z } from 'zod';
import { LlmError } from '../errors.js';
import type {
  CallOptions,
  ChatProvider,
  ChatRequest,
  ChatResult,
  ChatStreamEvent,
  EmbeddingProvider,
  Message,
  MessagePart,
  ModelTier,
  ObjectResult,
  Usage,
} from '../types.js';
import { textOf } from '../types.js';

/** One canned assistant turn for scripted tests. */
export interface ScriptedTurn {
  text?: string;
  toolCalls?: { name: string; input: unknown; id?: string }[];
}

/**
 * Deterministic provider for tests, CI and keyless demos.
 *
 * - Scripted mode: returns queued turns in order, so agent-loop tests can
 *   assert exact behaviour.
 * - Heuristic mode (default): pattern-matches common intents ("remind me to",
 *   "what's on today", "find my notes about") into real tool calls, so the
 *   whole product works end to end without any model.
 */
export class MockProvider implements ChatProvider {
  readonly id = 'mock' as const;
  private readonly script: ScriptedTurn[] | undefined;
  readonly calls: { req: ChatRequest; opts: CallOptions }[] = [];
  private seq = 0;

  constructor(opts: { script?: ScriptedTurn[] } = {}) {
    this.script = opts.script ? [...opts.script] : undefined;
  }

  model(_tier: ModelTier): string {
    return 'mock-1';
  }

  async generate(req: ChatRequest, opts: CallOptions): Promise<ChatResult> {
    this.calls.push({ req, opts });
    if (opts.signal?.aborted) throw new LlmError('Request aborted', 'timeout', { retryable: false });
    const turn = this.script ? this.nextScripted() : heuristicTurn(req, opts);
    return this.toResult(turn, req);
  }

  async *stream(req: ChatRequest, opts: CallOptions): AsyncIterable<ChatStreamEvent> {
    const result = await this.generate(req, opts);
    const text = textOf(result.message);
    // Emit word-sized deltas so streaming UIs behave like they would with a real model.
    for (const piece of text.match(/\S+\s*/g) ?? []) yield { type: 'text_delta', text: piece };
    yield { type: 'done', result };
  }

  async generateObject<T>(req: ChatRequest, schema: z.ZodType<T>, opts: CallOptions): Promise<ObjectResult<T>> {
    this.calls.push({ req, opts });
    const input = lastUserText(req.messages);
    const candidate = opts.purpose === 'capture' ? heuristicCapture(stripContext(input)) : undefined;
    const parsed = schema.safeParse(candidate);
    if (!parsed.success) throw new LlmError(`Mock provider has no heuristic for "${opts.purpose}"`, 'invalid_output');
    return {
      object: parsed.data,
      usage: fakeUsage(input, JSON.stringify(candidate)),
      provider: this.id,
      model: 'mock-1',
    };
  }

  private nextScripted(): ScriptedTurn {
    const next = this.script!.shift();
    if (!next) throw new LlmError('Mock script exhausted', 'provider_error');
    return next;
  }

  private toResult(turn: ScriptedTurn, req: ChatRequest): ChatResult {
    const parts: MessagePart[] = [];
    if (turn.text) parts.push({ type: 'text', text: turn.text });
    for (const tc of turn.toolCalls ?? []) {
      parts.push({ type: 'tool_call', id: tc.id ?? `mock_call_${++this.seq}`, name: tc.name, input: tc.input });
    }
    const message: Message = { role: 'assistant', parts };
    return {
      message,
      stopReason: turn.toolCalls?.length ? 'tool_use' : 'end_turn',
      usage: fakeUsage(JSON.stringify(req.messages), turn.text ?? ''),
      provider: 'mock',
      model: 'mock-1',
    };
  }
}

/** Feature-hashed bag-of-words vectors: deterministic, and similar text scores higher. */
export class MockEmbeddings implements EmbeddingProvider {
  readonly id = 'mock' as const;
  readonly model = 'mock-hash-768';
  readonly dimensions = 768;

  async embed(texts: string[], _opts: CallOptions): Promise<number[][]> {
    return texts.map((t) => hashEmbed(t, this.dimensions));
  }
}

export function hashEmbed(text: string, dims = 768): number[] {
  const v = new Array<number>(dims).fill(0);
  const words = text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  for (const w of words) {
    if (STOPWORDS.has(w)) continue;
    const stem = w.length > 4 ? w.replace(/(ing|ed|es|s)$/, '') : w;
    const h = fnv1a(stem);
    v[h % dims]! += h & 1 ? 1 : -1;
  }
  const norm = Math.hypot(...v) || 1;
  return v.map((x) => x / norm);
}

function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

const STOPWORDS = new Set(
  'a an the and or but of to in on at for with about is are was were be been my me i you it this that what did do does how when where which who'.split(
    ' ',
  ),
);

// ---------------------------------------------------------------------------
// Heuristics
// ---------------------------------------------------------------------------

function heuristicTurn(req: ChatRequest, opts: CallOptions): ScriptedTurn {
  const last = req.messages.at(-1);
  const toolNames = new Set(req.tools?.map((t) => t.name) ?? []);

  // After tools ran, summarise their results instead of calling more tools.
  const results = last?.parts.filter((p) => p.type === 'tool_result') ?? [];
  if (results.length) {
    const lines = results.map((r) =>
      r.type === 'tool_result' ? (r.isError ? `That didn't work: ${r.content}` : summarizeToolResult(r.content)) : '',
    );
    return { text: lines.join('\n\n') };
  }

  const text = stripContext(lastUserText(req.messages));
  if (opts.purpose === 'briefing') return { text: templateBriefing(text) };

  const lower = text.toLowerCase();
  const has = (name: string) => toolNames.has(name);

  const remind = /^(?:please\s+)?(?:remind me to|remind me|add (?:a )?task(?: to)?|todo:?|i need to|add)\s+(.+)$/i.exec(
    text,
  );
  if (remind && has('create_task')) {
    const capture = heuristicCapture(remind[1]!);
    return {
      text: 'I can add that for you.',
      toolCalls: [
        {
          name: 'create_task',
          input: {
            title: capture.title,
            ...(capture.duePhrase ? { due: capture.duePhrase } : {}),
            ...(capture.duePhrase && /remind/i.test(text) ? { remind: capture.duePhrase } : {}),
            ...(capture.priority ? { priority: capture.priority } : {}),
            ...(capture.tags.length ? { tags: capture.tags } : {}),
          },
        },
      ],
    };
  }

  const note = /^(?:note|remember that|remember|jot down)[:\s]+(.+)$/i.exec(text);
  if (note && has('create_note')) {
    return {
      text: 'Saving that as a note.',
      toolCalls: [{ name: 'create_note', input: { title: '', body: note[1] } }],
    };
  }

  const search =
    /(?:find|search|look up|what did i (?:write|note|say)|notes?) (?:my )?(?:notes? )?(?:about|on|for|regarding)\s+(.+?)[?.!]*$/i.exec(
      text,
    );
  if (search && has('search_notes')) {
    return { toolCalls: [{ name: 'search_notes', input: { query: search[1] } }] };
  }

  if (/\b(today|my day|agenda|due|overdue|what'?s on)\b/.test(lower) && has('list_tasks')) {
    return { toolCalls: [{ name: 'list_tasks', input: { view: 'today' } }] };
  }
  if (/\b(tasks|to-?dos?|inbox|upcoming)\b/.test(lower) && has('list_tasks')) {
    const view = /inbox/.test(lower) ? 'inbox' : /upcoming|week|later/.test(lower) ? 'upcoming' : 'all';
    return { toolCalls: [{ name: 'list_tasks', input: { view } }] };
  }

  return {
    text:
      "I'm running in demo mode without a language model, so I understand a few phrasings: " +
      '"remind me to … tomorrow at 9", "note: …", "find my notes about …", and "what\'s on today?". ' +
      'Set ANTHROPIC_API_KEY (or OPENAI_API_KEY / run Ollama) for full conversations.',
  };
}

function summarizeToolResult(content: string): string {
  try {
    const data = JSON.parse(content) as unknown;
    if (Array.isArray(data)) {
      if (data.length === 0) return 'Nothing found.';
      return data
        .slice(0, 10)
        .map(
          (d: { title?: string; snippet?: string; dueAt?: string | null }) =>
            `- ${d.title || '(untitled)'}${d.dueAt ? ` (due ${d.dueAt.slice(0, 10)})` : ''}${d.snippet ? `: ${d.snippet}` : ''}`,
        )
        .join('\n');
    }
    const obj = data as { title?: string; summary?: string; status?: string };
    if (obj.summary) return obj.summary;
    if (obj.title) return `Done: "${obj.title}".`;
  } catch {
    // fall through
  }
  return content.slice(0, 500);
}

function templateBriefing(input: string): string {
  const items = input.split('\n').filter((l) => l.trim().startsWith('- '));
  if (!items.length) return 'Good morning! Your slate is clear today. A good day to plan ahead.';
  return ['Good morning! Here is what needs your attention today:', '', ...items.slice(0, 12)].join('\n');
}

export function heuristicCapture(raw: string) {
  let text = raw.trim();
  const tags = [...text.matchAll(/#([\p{L}\p{N}_-]+)/gu)].map((m) => m[1]!.toLowerCase()).slice(0, 5);
  text = text.replace(/#[\p{L}\p{N}_-]+/gu, '');

  let priority = 0;
  if (/\b(urgent|asap|high prio(?:rity)?|important)\b|!!/i.test(text)) priority = 3;
  else if (/\b(medium prio(?:rity)?)\b/i.test(text)) priority = 2;
  else if (/\b(low prio(?:rity)?|someday|whenever)\b/i.test(text)) priority = 1;
  text = text.replace(
    /,?\s*\b(urgent|asap|high prio(?:rity)?|medium prio(?:rity)?|low prio(?:rity)?|important)\b|!!/gi,
    '',
  );

  const isNote = /^(note|idea|remember that|fyi)[:\s]/i.test(text);
  const wantsReminder = /\bremind me\b/i.test(text);
  text = text.replace(/^(note|idea|remember that|fyi)[:\s]+|^(please\s+)?remind me( to)?\s+/i, '');

  const date = isNote ? undefined : chrono.parse(text, new Date(), { forwardDate: true })[0];
  const duePhrase = date?.text ?? null;
  if (date) text = text.slice(0, date.index) + text.slice(date.index + date.text.length);

  const title = text
    .replace(/\s{2,}/g, ' ')
    .replace(/^[\s,.;:-]+|[\s,.;:-]+$/g, '')
    .replace(/\s+(by|on|at|due)$/i, '');
  return {
    kind: isNote ? ('note' as const) : ('task' as const),
    title: title ? title[0]!.toUpperCase() + title.slice(1) : raw.trim(),
    details: null,
    duePhrase,
    remindPhrase: wantsReminder ? duePhrase : null,
    priority,
    tags,
    projectName: null,
  };
}

function lastUserText(messages: Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role === 'user' && m.parts.some((p) => p.type === 'text')) return textOf(m);
  }
  return '';
}

/** Drop the `<context>` block the app prepends to user turns. */
function stripContext(text: string): string {
  return text
    .replace(/<context>[\s\S]*?<\/context>\s*/g, '')
    .replace(/<\/?input>/g, '')
    .trim();
}

function fakeUsage(input: string, output: string): Usage {
  return {
    inputTokens: Math.ceil(input.length / 4),
    outputTokens: Math.ceil(output.length / 4),
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  };
}
