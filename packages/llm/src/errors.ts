export type LlmErrorCode =
  | 'rate_limited'
  | 'timeout'
  | 'refusal'
  | 'max_tokens'
  | 'invalid_output'
  | 'unavailable'
  | 'bad_request'
  | 'auth'
  | 'budget_exceeded'
  | 'provider_error';

/** Normalized LLM failure, so callers never branch on vendor error classes. */
export class LlmError extends Error {
  constructor(
    message: string,
    readonly code: LlmErrorCode,
    readonly options: { retryable?: boolean; cause?: unknown } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = 'LlmError';
  }

  get retryable(): boolean {
    return this.options.retryable ?? ['rate_limited', 'timeout', 'unavailable'].includes(this.code);
  }
}

/** Combine an optional caller signal with a timeout. */
export function deadlineSignal(
  signal: AbortSignal | undefined,
  timeoutMs: number | undefined,
): AbortSignal | undefined {
  const signals = [signal, timeoutMs ? AbortSignal.timeout(timeoutMs) : undefined].filter(
    (s): s is AbortSignal => s !== undefined,
  );
  if (signals.length === 0) return undefined;
  return signals.length === 1 ? signals[0] : AbortSignal.any(signals);
}

export function isAbortError(err: unknown): boolean {
  return err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError');
}

/**
 * Retry with exponential backoff and full jitter, for providers without SDK
 * retries (Ollama). Never used around a stream that has emitted output.
 */
export async function withRetry<T>(fn: () => Promise<T>, attempts = 3, baseMs = 300): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const retryable = err instanceof LlmError ? err.retryable : !isAbortError(err);
      if (!retryable || i === attempts - 1) throw err;
      await new Promise((r) => setTimeout(r, Math.random() * baseMs * 2 ** i));
    }
  }
  throw lastErr;
}
