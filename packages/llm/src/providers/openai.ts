import OpenAI from 'openai';
import { z } from 'zod';
import { deadlineSignal, LlmError } from '../errors.js';
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
  StopReason,
  Usage,
} from '../types.js';

type ChatMessageParam = OpenAI.Chat.Completions.ChatCompletionMessageParam;
type ChatCompletion = OpenAI.Chat.Completions.ChatCompletion;

export interface OpenAIProviderOptions {
  apiKey: string;
  baseURL?: string;
  smartModel: string;
  fastModel: string;
}

/** OpenAI (or any Chat Completions-compatible endpoint via baseURL). */
export class OpenAIProvider implements ChatProvider {
  readonly id = 'openai' as const;
  private readonly client: OpenAI;

  constructor(private readonly opts: OpenAIProviderOptions) {
    this.client = new OpenAI({ apiKey: opts.apiKey, baseURL: opts.baseURL, maxRetries: 2 });
  }

  model(tier: ModelTier): string {
    return tier === 'fast' ? this.opts.fastModel : this.opts.smartModel;
  }

  async generate(req: ChatRequest, opts: CallOptions): Promise<ChatResult> {
    const model = this.model(opts.tier ?? 'smart');
    try {
      const res = await this.client.chat.completions.create(
        { model, messages: toOpenAIMessages(req), tools: toTools(req), max_completion_tokens: req.maxTokens ?? 8_000 },
        { signal: deadlineSignal(opts.signal, opts.timeoutMs) },
      );
      return toResult(res);
    } catch (err) {
      throw mapError(err);
    }
  }

  async *stream(req: ChatRequest, opts: CallOptions): AsyncIterable<ChatStreamEvent> {
    const model = this.model(opts.tier ?? 'smart');
    try {
      const stream = await this.client.chat.completions.create(
        {
          model,
          messages: toOpenAIMessages(req),
          tools: toTools(req),
          max_completion_tokens: req.maxTokens ?? 8_000,
          stream: true,
          stream_options: { include_usage: true },
        },
        { signal: deadlineSignal(opts.signal, opts.timeoutMs) },
      );
      let text = '';
      let finish: string | null = null;
      let usage: Usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
      let servedModel = model;
      const calls = new Map<number, { id: string; name: string; args: string }>();
      for await (const chunk of stream) {
        servedModel = chunk.model || servedModel;
        if (chunk.usage) usage = toUsage(chunk.usage);
        const choice = chunk.choices[0];
        if (!choice) continue;
        if (choice.delta.content) {
          text += choice.delta.content;
          yield { type: 'text_delta', text: choice.delta.content };
        }
        for (const tc of choice.delta.tool_calls ?? []) {
          const cur = calls.get(tc.index) ?? { id: '', name: '', args: '' };
          if (tc.id) cur.id = tc.id;
          if (tc.function?.name) cur.name += tc.function.name;
          if (tc.function?.arguments) cur.args += tc.function.arguments;
          calls.set(tc.index, cur);
        }
        if (choice.finish_reason) finish = choice.finish_reason;
      }
      const parts: MessagePart[] = text ? [{ type: 'text', text }] : [];
      for (const c of calls.values())
        parts.push({ type: 'tool_call', id: c.id, name: c.name, input: safeJson(c.args) });
      yield {
        type: 'done',
        result: {
          message: { role: 'assistant', parts },
          stopReason: mapStop(finish),
          usage,
          provider: this.id,
          model: servedModel,
        },
      };
    } catch (err) {
      throw mapError(err);
    }
  }

  async generateObject<T>(req: ChatRequest, schema: z.ZodType<T>, opts: CallOptions): Promise<ObjectResult<T>> {
    const model = this.model(opts.tier ?? 'fast');
    try {
      const res = await this.client.chat.completions.create(
        {
          model,
          messages: toOpenAIMessages(req),
          max_completion_tokens: req.maxTokens ?? 4_000,
          response_format: {
            type: 'json_schema',
            json_schema: { name: 'output', schema: z.toJSONSchema(schema, { target: 'draft-7' }), strict: false },
          },
        },
        { signal: deadlineSignal(opts.signal, opts.timeoutMs) },
      );
      const choice = res.choices[0];
      if (choice?.message.refusal) throw new LlmError('The model declined this request', 'refusal');
      const parsed = schema.safeParse(safeJson(choice?.message.content ?? ''));
      if (!parsed.success) throw new LlmError('Model output did not match the schema', 'invalid_output');
      return { object: parsed.data, usage: toUsage(res.usage), provider: this.id, model: res.model };
    } catch (err) {
      throw mapError(err);
    }
  }
}

export class OpenAIEmbeddings implements EmbeddingProvider {
  readonly id = 'openai' as const;
  readonly dimensions = 768;
  private readonly client: OpenAI;

  constructor(
    apiKey: string,
    readonly model: string,
    baseURL?: string,
  ) {
    this.client = new OpenAI({ apiKey, baseURL, maxRetries: 2 });
  }

  async embed(texts: string[], opts: CallOptions): Promise<number[][]> {
    try {
      // text-embedding-3 models support shortening to our fixed column size.
      const res = await this.client.embeddings.create(
        { model: this.model, input: texts, dimensions: this.dimensions },
        { signal: deadlineSignal(opts.signal, opts.timeoutMs) },
      );
      return res.data.sort((a, b) => a.index - b.index).map((d) => d.embedding);
    } catch (err) {
      throw mapError(err);
    }
  }
}

function toOpenAIMessages(req: ChatRequest): ChatMessageParam[] {
  const out: ChatMessageParam[] = [{ role: 'system', content: req.system }];
  for (const m of req.messages) out.push(...toOpenAIMessage(m));
  return out;
}

function toOpenAIMessage(m: Message): ChatMessageParam[] {
  if (m.role === 'assistant') {
    const text = m.parts.flatMap((p) => (p.type === 'text' ? [p.text] : [])).join('');
    const toolCalls = m.parts.flatMap((p) =>
      p.type === 'tool_call'
        ? [{ id: p.id, type: 'function' as const, function: { name: p.name, arguments: JSON.stringify(p.input) } }]
        : [],
    );
    return [{ role: 'assistant', content: text || null, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) }];
  }
  // Tool results become separate `tool` messages; text stays a user message.
  const out: ChatMessageParam[] = [];
  for (const p of m.parts) {
    if (p.type === 'tool_result') out.push({ role: 'tool', tool_call_id: p.toolCallId, content: p.content });
  }
  const text = m.parts.flatMap((p) => (p.type === 'text' ? [p.text] : [])).join('\n');
  if (text) out.push({ role: 'user', content: text });
  return out;
}

function toTools(req: ChatRequest): OpenAI.Chat.Completions.ChatCompletionTool[] | undefined {
  if (!req.tools?.length) return undefined;
  return req.tools.map((t) => ({
    type: 'function' as const,
    function: { name: t.name, description: t.description, parameters: t.inputSchema },
  }));
}

function toResult(res: ChatCompletion): ChatResult {
  const choice = res.choices[0];
  if (choice?.message.refusal) {
    return {
      message: { role: 'assistant', parts: [{ type: 'text', text: choice.message.refusal }] },
      stopReason: 'refusal',
      usage: toUsage(res.usage),
      provider: 'openai',
      model: res.model,
    };
  }
  const parts: MessagePart[] = [];
  if (choice?.message.content) parts.push({ type: 'text', text: choice.message.content });
  for (const tc of choice?.message.tool_calls ?? []) {
    if (tc.type === 'function') {
      parts.push({ type: 'tool_call', id: tc.id, name: tc.function.name, input: safeJson(tc.function.arguments) });
    }
  }
  return {
    message: { role: 'assistant', parts },
    stopReason: mapStop(choice?.finish_reason ?? null),
    usage: toUsage(res.usage),
    provider: 'openai',
    model: res.model,
  };
}

function mapStop(reason: string | null): StopReason {
  switch (reason) {
    case 'stop':
      return 'end_turn';
    case 'tool_calls':
      return 'tool_use';
    case 'length':
      return 'max_tokens';
    case 'content_filter':
      return 'refusal';
    default:
      return 'other';
  }
}

function toUsage(u: OpenAI.Completions.CompletionUsage | null | undefined): Usage {
  const cached = u?.prompt_tokens_details?.cached_tokens ?? 0;
  return {
    inputTokens: (u?.prompt_tokens ?? 0) - cached,
    outputTokens: u?.completion_tokens ?? 0,
    cacheReadTokens: cached,
    cacheWriteTokens: 0,
  };
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return {};
  }
}

function mapError(err: unknown): unknown {
  if (err instanceof LlmError) return err;
  if (err instanceof OpenAI.APIConnectionTimeoutError)
    return new LlmError('OpenAI request timed out', 'timeout', { cause: err });
  if (err instanceof OpenAI.APIUserAbortError)
    return new LlmError('Request aborted', 'timeout', { cause: err, retryable: false });
  if (err instanceof OpenAI.APIConnectionError)
    return new LlmError('Could not reach OpenAI', 'unavailable', { cause: err });
  if (err instanceof OpenAI.RateLimitError)
    return new LlmError('OpenAI rate limit reached', 'rate_limited', { cause: err });
  if (err instanceof OpenAI.AuthenticationError)
    return new LlmError('OpenAI credentials were rejected', 'auth', { cause: err });
  if (err instanceof OpenAI.BadRequestError) return new LlmError(err.message, 'bad_request', { cause: err });
  if (err instanceof OpenAI.InternalServerError)
    return new LlmError('OpenAI is unavailable', 'unavailable', { cause: err });
  if (err instanceof OpenAI.APIError) return new LlmError(err.message, 'provider_error', { cause: err });
  return err;
}
