import type { z } from 'zod';

/**
 * Provider-neutral conversation model. Adapters translate to and from each
 * vendor's wire format; the rest of the app only sees these types.
 */
export type MessagePart =
  | { type: 'text'; text: string }
  | { type: 'tool_call'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; toolCallId: string; content: string; isError?: boolean };

export interface Message {
  role: 'user' | 'assistant';
  parts: MessagePart[];
  /**
   * Opaque provider-native content for assistant turns. Replayed verbatim
   * when the same provider continues the conversation, which keeps Claude's
   * thinking blocks valid (history must be append-only and unmodified).
   */
  providerRaw?: { provider: ProviderId; model: string; content: unknown };
}

export type ProviderId = 'anthropic' | 'openai' | 'ollama' | 'mock';
export type ModelTier = 'smart' | 'fast';
export type Effort = 'low' | 'medium' | 'high';

/** JSON Schema object for a tool's input. */
export type JsonSchema = Record<string, unknown>;

export interface ToolSpec {
  name: string;
  description: string;
  inputSchema: JsonSchema;
}

export interface ChatRequest {
  /**
   * Stable instructions; providers that support caching cache this prefix.
   * Keep volatile data (current time, user state) out of it and put that in
   * the user message instead, so history stays append-only.
   */
  system: string;
  messages: Message[];
  tools?: ToolSpec[];
  maxTokens?: number;
}

export interface CallOptions {
  /** Feature that made the call, for usage accounting ("capture", "chat", ...). */
  purpose: string;
  userId?: string | null;
  tier?: ModelTier;
  effort?: Effort;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export const emptyUsage = (): Usage => ({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 });

export function addUsage(a: Usage, b: Usage): Usage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
  };
}

export type StopReason = 'end_turn' | 'tool_use' | 'max_tokens' | 'refusal' | 'other';

export interface ChatResult {
  message: Message;
  stopReason: StopReason;
  usage: Usage;
  provider: ProviderId;
  /** Model that actually served the response (may differ after a fallback). */
  model: string;
}

export type ChatStreamEvent = { type: 'text_delta'; text: string } | { type: 'done'; result: ChatResult };

export interface ObjectResult<T> {
  object: T;
  usage: Usage;
  provider: ProviderId;
  model: string;
}

export interface ChatProvider {
  readonly id: ProviderId;
  /** Model id for a tier, used for display and usage records. */
  model(tier: ModelTier): string;
  generate(req: ChatRequest, opts: CallOptions): Promise<ChatResult>;
  stream(req: ChatRequest, opts: CallOptions): AsyncIterable<ChatStreamEvent>;
  generateObject<T>(req: ChatRequest, schema: z.ZodType<T>, opts: CallOptions): Promise<ObjectResult<T>>;
}

export interface EmbeddingProvider {
  readonly id: ProviderId;
  readonly model: string;
  readonly dimensions: number;
  embed(texts: string[], opts: CallOptions): Promise<number[][]>;
}

/** Concatenate the text parts of a message. */
export function textOf(message: Message): string {
  return message.parts
    .filter((p): p is Extract<MessagePart, { type: 'text' }> => p.type === 'text')
    .map((p) => p.text)
    .join('');
}

export function toolCallsOf(message: Message): Extract<MessagePart, { type: 'tool_call' }>[] {
  return message.parts.filter((p): p is Extract<MessagePart, { type: 'tool_call' }> => p.type === 'tool_call');
}
