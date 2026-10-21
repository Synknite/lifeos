import type { BaseConfig } from '@lifeos/config';
import { instrumentChat, instrumentEmbeddings, type InstrumentOptions } from './instrument.js';
import { AnthropicProvider } from './providers/anthropic.js';
import { MockEmbeddings, MockProvider } from './providers/mock.js';
import { OllamaEmbeddings, OllamaProvider } from './providers/ollama.js';
import { OpenAIEmbeddings, OpenAIProvider } from './providers/openai.js';
import type { ChatProvider, EmbeddingProvider, ProviderId } from './types.js';

export interface LlmRuntime {
  chat: ChatProvider;
  embeddings: EmbeddingProvider;
  info: LlmInfo;
}

export interface LlmInfo {
  provider: ProviderId;
  smartModel: string;
  fastModel: string;
  embeddingProvider: ProviderId;
  embeddingModel: string;
  /** True when running on the mock provider (no model configured). */
  demoMode: boolean;
}

type LlmConfig = Pick<
  BaseConfig,
  | 'LLM_PROVIDER'
  | 'EMBEDDING_PROVIDER'
  | 'ANTHROPIC_API_KEY'
  | 'ANTHROPIC_MODEL_SMART'
  | 'ANTHROPIC_MODEL_FAST'
  | 'OPENAI_API_KEY'
  | 'OPENAI_BASE_URL'
  | 'OPENAI_MODEL_SMART'
  | 'OPENAI_MODEL_FAST'
  | 'OPENAI_EMBEDDING_MODEL'
  | 'OLLAMA_BASE_URL'
  | 'OLLAMA_MODEL'
  | 'OLLAMA_EMBEDDING_MODEL'
>;

/** Is an Ollama server answering? Short timeout so startup isn't held up. */
export async function probeOllama(baseUrl: string, timeoutMs = 1_000): Promise<boolean> {
  try {
    const res = await fetch(new URL('/api/tags', baseUrl), { signal: AbortSignal.timeout(timeoutMs) });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Pick providers from configuration. `auto` prefers Anthropic, then OpenAI,
 * then a reachable Ollama, and finally the mock provider so the app always
 * starts — reviewers can run it with zero keys.
 */
export async function createLlmRuntime(
  cfg: LlmConfig,
  instrument: InstrumentOptions = {},
  probe: (url: string) => Promise<boolean> = probeOllama,
): Promise<LlmRuntime> {
  const ollamaUp =
    cfg.LLM_PROVIDER === 'auto' || cfg.EMBEDDING_PROVIDER === 'auto' ? await probe(cfg.OLLAMA_BASE_URL) : false;

  const chatId: ProviderId =
    cfg.LLM_PROVIDER !== 'auto'
      ? cfg.LLM_PROVIDER
      : cfg.ANTHROPIC_API_KEY
        ? 'anthropic'
        : cfg.OPENAI_API_KEY
          ? 'openai'
          : ollamaUp
            ? 'ollama'
            : 'mock';

  // Anthropic has no embeddings endpoint, so embeddings resolve separately.
  const embedId: ProviderId =
    cfg.EMBEDDING_PROVIDER !== 'auto'
      ? cfg.EMBEDDING_PROVIDER
      : cfg.OPENAI_API_KEY
        ? 'openai'
        : ollamaUp
          ? 'ollama'
          : 'mock';

  const chat = instrumentChat(buildChat(chatId, cfg), instrument);
  const embeddings = instrumentEmbeddings(buildEmbeddings(embedId, cfg), instrument);
  return {
    chat,
    embeddings,
    info: {
      provider: chatId,
      smartModel: chat.model('smart'),
      fastModel: chat.model('fast'),
      embeddingProvider: embedId,
      embeddingModel: embeddings.model,
      demoMode: chatId === 'mock',
    },
  };
}

function buildChat(id: ProviderId, cfg: LlmConfig): ChatProvider {
  switch (id) {
    case 'anthropic':
      if (!cfg.ANTHROPIC_API_KEY) throw new Error('LLM_PROVIDER=anthropic requires ANTHROPIC_API_KEY');
      return new AnthropicProvider({
        apiKey: cfg.ANTHROPIC_API_KEY,
        smartModel: cfg.ANTHROPIC_MODEL_SMART,
        fastModel: cfg.ANTHROPIC_MODEL_FAST,
      });
    case 'openai':
      if (!cfg.OPENAI_API_KEY) throw new Error('LLM_PROVIDER=openai requires OPENAI_API_KEY');
      return new OpenAIProvider({
        apiKey: cfg.OPENAI_API_KEY,
        baseURL: cfg.OPENAI_BASE_URL,
        smartModel: cfg.OPENAI_MODEL_SMART,
        fastModel: cfg.OPENAI_MODEL_FAST,
      });
    case 'ollama':
      return new OllamaProvider(cfg.OLLAMA_BASE_URL, cfg.OLLAMA_MODEL);
    case 'mock':
      return new MockProvider();
  }
}

function buildEmbeddings(id: ProviderId, cfg: LlmConfig): EmbeddingProvider {
  switch (id) {
    case 'openai':
      if (!cfg.OPENAI_API_KEY) throw new Error('EMBEDDING_PROVIDER=openai requires OPENAI_API_KEY');
      return new OpenAIEmbeddings(cfg.OPENAI_API_KEY, cfg.OPENAI_EMBEDDING_MODEL, cfg.OPENAI_BASE_URL);
    case 'ollama':
      return new OllamaEmbeddings(cfg.OLLAMA_BASE_URL, cfg.OLLAMA_EMBEDDING_MODEL);
    case 'anthropic':
      throw new Error('Anthropic does not offer embeddings; use EMBEDDING_PROVIDER=openai, ollama or mock');
    case 'mock':
      return new MockEmbeddings();
  }
}
