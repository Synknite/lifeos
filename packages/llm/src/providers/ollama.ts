import { Ollama, type Message as OllamaMessage, type Tool as OllamaTool } from 'ollama';
import { z } from 'zod';
import { LlmError, withRetry } from '../errors.js';
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

/** Local models via Ollama: free, private, and lets reviewers run with no API key. */
export class OllamaProvider implements ChatProvider {
  readonly id = 'ollama' as const;
  private readonly client: Ollama;

  constructor(
    host: string,
    private readonly chatModel: string,
  ) {
    this.client = new Ollama({ host });
  }

  model(_tier: ModelTier): string {
    return this.chatModel;
  }

  async generate(req: ChatRequest, opts: CallOptions): Promise<ChatResult> {
    return this.call(opts, () =>
      this.client
        .chat({ model: this.chatModel, messages: toOllama(req), tools: toTools(req), stream: false, keep_alive: '10m' })
        .then((res) => toResult(res.message, res.prompt_eval_count, res.eval_count, this.chatModel, res.done_reason)),
    );
  }

  async *stream(req: ChatRequest, opts: CallOptions): AsyncIterable<ChatStreamEvent> {
    const abort = this.abortable(opts);
    try {
      const stream = await this.client.chat({
        model: this.chatModel,
        messages: toOllama(req),
        tools: toTools(req),
        stream: true,
        keep_alive: '10m',
      });
      abort.onAbort(() => stream.abort());
      let text = '';
      const toolCalls: OllamaMessage['tool_calls'] = [];
      let inTokens = 0;
      let outTokens = 0;
      let doneReason: string | undefined;
      for await (const chunk of stream) {
        if (chunk.message.content) {
          text += chunk.message.content;
          yield { type: 'text_delta', text: chunk.message.content };
        }
        toolCalls.push(...(chunk.message.tool_calls ?? []));
        if (chunk.done) {
          inTokens = chunk.prompt_eval_count;
          outTokens = chunk.eval_count;
          doneReason = chunk.done_reason;
        }
      }
      yield {
        type: 'done',
        result: toResult(
          { role: 'assistant', content: text, tool_calls: toolCalls },
          inTokens,
          outTokens,
          this.chatModel,
          doneReason,
        ),
      };
    } catch (err) {
      throw mapError(err);
    } finally {
      abort.dispose();
    }
  }

  async generateObject<T>(req: ChatRequest, schema: z.ZodType<T>, opts: CallOptions): Promise<ObjectResult<T>> {
    return this.call(opts, async () => {
      const res = await this.client.chat({
        model: this.chatModel,
        messages: toOllama({ ...req, tools: undefined }),
        // Ollama constrains decoding to the JSON schema.
        format: z.toJSONSchema(schema, { target: 'draft-7' }),
        stream: false,
        keep_alive: '10m',
        options: { temperature: 0 },
      });
      const parsed = schema.safeParse(safeJson(res.message.content));
      if (!parsed.success)
        throw new LlmError('Model output did not match the schema', 'invalid_output', { retryable: true });
      return {
        object: parsed.data,
        usage: usage(res.prompt_eval_count, res.eval_count),
        provider: this.id,
        model: this.chatModel,
      };
    });
  }

  private async call<T>(opts: CallOptions, fn: () => Promise<T>): Promise<T> {
    const abort = this.abortable(opts);
    try {
      return await withRetry(async () => {
        try {
          return await fn();
        } catch (err) {
          throw mapError(err);
        }
      });
    } finally {
      abort.dispose();
    }
  }

  /** The ollama client aborts all in-flight requests; wire our signal to it. */
  private abortable(opts: CallOptions) {
    const signals = [opts.signal, opts.timeoutMs ? AbortSignal.timeout(opts.timeoutMs) : undefined].filter(
      (s): s is AbortSignal => !!s,
    );
    const signal = signals.length ? AbortSignal.any(signals) : undefined;
    const handlers: (() => void)[] = [() => this.client.abort()];
    const listener = () => handlers.forEach((h) => h());
    signal?.addEventListener('abort', listener, { once: true });
    return {
      onAbort: (h: () => void) => handlers.push(h),
      dispose: () => signal?.removeEventListener('abort', listener),
    };
  }
}

export class OllamaEmbeddings implements EmbeddingProvider {
  readonly id = 'ollama' as const;
  readonly dimensions = 768;
  private readonly client: Ollama;

  constructor(
    host: string,
    readonly model: string,
  ) {
    this.client = new Ollama({ host });
  }

  async embed(texts: string[], _opts: CallOptions): Promise<number[][]> {
    return withRetry(async () => {
      try {
        const res = await this.client.embed({ model: this.model, input: texts, keep_alive: '10m' });
        return res.embeddings;
      } catch (err) {
        throw mapError(err);
      }
    });
  }
}

function toOllama(req: ChatRequest): OllamaMessage[] {
  const out: OllamaMessage[] = [{ role: 'system', content: req.system }];
  for (const m of req.messages) out.push(...toOllamaMessage(m));
  return out;
}

function toOllamaMessage(m: Message): OllamaMessage[] {
  if (m.role === 'assistant') {
    return [
      {
        role: 'assistant',
        content: m.parts.flatMap((p) => (p.type === 'text' ? [p.text] : [])).join(''),
        tool_calls: m.parts.flatMap((p) =>
          p.type === 'tool_call' ? [{ function: { name: p.name, arguments: p.input as Record<string, unknown> } }] : [],
        ),
      },
    ];
  }
  const out: OllamaMessage[] = [];
  for (const p of m.parts) {
    if (p.type === 'tool_result') out.push({ role: 'tool', content: p.content });
  }
  const text = m.parts.flatMap((p) => (p.type === 'text' ? [p.text] : [])).join('\n');
  if (text) out.push({ role: 'user', content: text });
  return out;
}

function toTools(req: ChatRequest): OllamaTool[] | undefined {
  return req.tools?.map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: t.inputSchema,
    },
  }));
}

function toResult(
  msg: OllamaMessage,
  inTokens: number | undefined,
  outTokens: number | undefined,
  model: string,
  doneReason: string | undefined,
): ChatResult {
  const parts: MessagePart[] = msg.content ? [{ type: 'text', text: msg.content }] : [];
  // Ollama doesn't issue tool call ids; synthesize stable ones.
  (msg.tool_calls ?? []).forEach((tc, i) =>
    parts.push({
      type: 'tool_call',
      id: `ollama_${Date.now()}_${i}`,
      name: tc.function.name,
      input: tc.function.arguments,
    }),
  );
  const hasTools = parts.some((p) => p.type === 'tool_call');
  return {
    message: { role: 'assistant', parts },
    stopReason: hasTools ? 'tool_use' : doneReason === 'length' ? 'max_tokens' : 'end_turn',
    usage: usage(inTokens, outTokens),
    provider: 'ollama',
    model,
  };
}

const usage = (i = 0, o = 0): Usage => ({ inputTokens: i, outputTokens: o, cacheReadTokens: 0, cacheWriteTokens: 0 });

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}

function mapError(err: unknown): unknown {
  if (err instanceof LlmError) return err;
  const e = err as { name?: string; status_code?: number; cause?: { code?: string } };
  if (e?.name === 'AbortError')
    return new LlmError('Ollama request aborted', 'timeout', { cause: err, retryable: false });
  if (e?.cause?.code === 'ECONNREFUSED' || (err instanceof TypeError && /fetch failed/.test(err.message))) {
    return new LlmError('Could not reach Ollama', 'unavailable', { cause: err });
  }
  if (e?.status_code === 404)
    return new LlmError('Ollama model not found; run `ollama pull`', 'bad_request', { cause: err });
  return new LlmError((err as Error)?.message ?? 'Ollama error', 'provider_error', { cause: err });
}
