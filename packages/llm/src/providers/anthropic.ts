import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import type { z } from 'zod';
import { deadlineSignal, LlmError } from '../errors.js';
import type {
  CallOptions,
  ChatProvider,
  ChatRequest,
  ChatResult,
  ChatStreamEvent,
  Message,
  MessagePart,
  ModelTier,
  ObjectResult,
  StopReason,
  Usage,
} from '../types.js';

type BetaMessage = Anthropic.Beta.Messages.BetaMessage;
type BetaMessageParam = Anthropic.Beta.Messages.BetaMessageParam;
type BetaContentBlockParam = Anthropic.Beta.Messages.BetaContentBlockParam;
type BetaTool = Anthropic.Beta.Messages.BetaTool;

// Server-side refusal fallback: a declined request is re-run on Anthropic's
// recommended model for that refusal category within the same call.
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

export interface AnthropicProviderOptions {
  apiKey: string;
  smartModel: string;
  fastModel: string;
  maxRetries?: number;
  baseURL?: string;
  /** Override for tests (contract tests against recorded responses). */
  fetch?: typeof fetch;
}

export class AnthropicProvider implements ChatProvider {
  readonly id = 'anthropic' as const;
  private readonly client: Anthropic;

  constructor(private readonly opts: AnthropicProviderOptions) {
    // The SDK retries 408/409/429/5xx and connection errors with backoff and
    // honours retry-after.
    this.client = new Anthropic({
      apiKey: opts.apiKey,
      maxRetries: opts.maxRetries ?? 2,
      baseURL: opts.baseURL,
      fetch: opts.fetch,
    });
  }

  model(tier: ModelTier): string {
    return tier === 'fast' ? this.opts.fastModel : this.opts.smartModel;
  }

  async generate(req: ChatRequest, opts: CallOptions): Promise<ChatResult> {
    const model = this.model(opts.tier ?? 'smart');
    try {
      const message = await this.client.beta.messages.create(this.params(req, opts, model, false), {
        signal: deadlineSignal(opts.signal, opts.timeoutMs),
      });
      return toResult(message);
    } catch (err) {
      throw mapError(err);
    }
  }

  async *stream(req: ChatRequest, opts: CallOptions): AsyncIterable<ChatStreamEvent> {
    const model = this.model(opts.tier ?? 'smart');
    try {
      const stream = this.client.beta.messages.stream(this.params(req, opts, model, true), {
        signal: deadlineSignal(opts.signal, opts.timeoutMs),
      });
      for await (const event of stream) {
        if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
          yield { type: 'text_delta', text: event.delta.text };
        }
      }
      yield { type: 'done', result: toResult(await stream.finalMessage()) };
    } catch (err) {
      throw mapError(err);
    }
  }

  async generateObject<T>(req: ChatRequest, schema: z.ZodType<T>, opts: CallOptions): Promise<ObjectResult<T>> {
    const model = this.model(opts.tier ?? 'fast');
    try {
      const base = this.params({ ...req, tools: undefined }, opts, model, false);
      const message = await this.client.beta.messages.parse(
        {
          ...base,
          output_config: {
            ...base.output_config,
            // The helper is typed for zod's own type graph; our generic ZodType<T> is the same object.
            format: betaZodOutputFormat(schema as never),
          },
        },
        { signal: deadlineSignal(opts.signal, opts.timeoutMs) },
      );
      if (message.stop_reason === 'refusal') throw new LlmError('The model declined this request', 'refusal');
      if (message.stop_reason === 'max_tokens') throw new LlmError('Structured output was truncated', 'max_tokens');
      if (message.parsed_output == null) throw new LlmError('Model output did not match the schema', 'invalid_output');
      return {
        object: message.parsed_output,
        usage: toUsage(message.usage),
        provider: this.id,
        model: message.model,
      };
    } catch (err) {
      throw mapError(err);
    }
  }

  private params(req: ChatRequest, opts: CallOptions, model: string, streaming: boolean) {
    const tools: BetaTool[] | undefined = req.tools
      ?.slice()
      // Deterministic order keeps the cached prefix byte-identical across requests.
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.inputSchema as BetaTool['input_schema'],
        // Stream large inputs as generated; we validate every input with zod before running it.
        ...(streaming ? { eager_input_streaming: true } : {}),
      }));

    return {
      model,
      max_tokens: req.maxTokens ?? (streaming ? 32_000 : 8_000),
      // Thinking is always on for current Opus/Sonnet; effort controls depth and spend.
      output_config: { effort: opts.effort ?? (opts.tier === 'fast' ? 'low' : 'medium') },
      // tools -> system render first, so this breakpoint caches both.
      system: [{ type: 'text' as const, text: req.system, cache_control: { type: 'ephemeral' as const } }],
      messages: req.messages.map(toAnthropicMessage),
      ...(tools?.length ? { tools } : {}),
      // Haiku has no server-side fallback; sending the parameter would be pointless.
      ...(model.startsWith('claude-haiku') ? {} : { betas: [FALLBACK_BETA], fallbacks: 'default' as const }),
    };
  }
}

function toAnthropicMessage(m: Message): BetaMessageParam {
  // Replay Claude's own content untouched (thinking blocks, fallback markers),
  // which the API requires for thinking to stay valid across tool turns.
  if (m.role === 'assistant' && m.providerRaw?.provider === 'anthropic') {
    return { role: 'assistant', content: m.providerRaw.content as BetaContentBlockParam[] };
  }
  const content: BetaContentBlockParam[] = m.parts.map((p): BetaContentBlockParam => {
    switch (p.type) {
      case 'text':
        return { type: 'text', text: p.text };
      case 'tool_call':
        return { type: 'tool_use', id: p.id, name: p.name, input: p.input as Record<string, unknown> };
      case 'tool_result':
        return { type: 'tool_result', tool_use_id: p.toolCallId, content: p.content, is_error: p.isError ?? false };
    }
  });
  return { role: m.role, content };
}

function toResult(message: BetaMessage): ChatResult {
  const parts: MessagePart[] = [];
  for (const block of message.content) {
    if (block.type === 'text') parts.push({ type: 'text', text: block.text });
    else if (block.type === 'tool_use')
      parts.push({ type: 'tool_call', id: block.id, name: block.name, input: block.input });
  }
  return {
    message: {
      role: 'assistant',
      parts,
      providerRaw: { provider: 'anthropic', model: message.model, content: message.content },
    },
    stopReason: mapStop(message.stop_reason),
    usage: toUsage(message.usage),
    provider: 'anthropic',
    model: message.model,
  };
}

function mapStop(reason: BetaMessage['stop_reason']): StopReason {
  switch (reason) {
    case 'end_turn':
    case 'stop_sequence':
      return 'end_turn';
    case 'tool_use':
      return 'tool_use';
    case 'max_tokens':
      return 'max_tokens';
    case 'refusal':
      return 'refusal';
    default:
      return 'other';
  }
}

function toUsage(u: BetaMessage['usage']): Usage {
  return {
    inputTokens: u.input_tokens,
    outputTokens: u.output_tokens,
    cacheReadTokens: u.cache_read_input_tokens ?? 0,
    cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
  };
}

function mapError(err: unknown): unknown {
  if (err instanceof LlmError) return err;
  // Most specific first: timeouts subclass connection errors.
  if (err instanceof Anthropic.APIConnectionTimeoutError)
    return new LlmError('Anthropic request timed out', 'timeout', { cause: err });
  if (err instanceof Anthropic.APIUserAbortError)
    return new LlmError('Request aborted', 'timeout', { cause: err, retryable: false });
  if (err instanceof Anthropic.APIConnectionError)
    return new LlmError('Could not reach Anthropic', 'unavailable', { cause: err });
  if (err instanceof Anthropic.RateLimitError)
    return new LlmError('Anthropic rate limit reached', 'rate_limited', { cause: err });
  if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
    return new LlmError('Anthropic credentials were rejected', 'auth', { cause: err });
  }
  if (err instanceof Anthropic.BadRequestError) return new LlmError(err.message, 'bad_request', { cause: err });
  if (err instanceof Anthropic.InternalServerError)
    return new LlmError('Anthropic is unavailable', 'unavailable', { cause: err });
  if (err instanceof Anthropic.APIError) return new LlmError(err.message, 'provider_error', { cause: err });
  if (err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError')) {
    return new LlmError('LLM request timed out', 'timeout', { cause: err });
  }
  return err;
}
