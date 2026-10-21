import type { Usage } from './types.js';

/** USD per million tokens. */
export interface ModelPrice {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

// Anthropic first-party list prices (Oct 2026). Cache writes bill at 1.25x
// input for the default 5-minute TTL. Unknown models fall back to zero so a
// missing entry under-reports instead of crashing; update when adding models.
const PRICES: Record<string, ModelPrice> = {
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
  'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  'claude-haiku-5-5': { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
  'claude-opus-4-8': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  'claude-opus-5': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  'claude-sonnet-5': { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  'text-embedding-3-small': { input: 0.02, output: 0, cacheRead: 0, cacheWrite: 0 },
};

export function priceFor(model: string): ModelPrice | undefined {
  return PRICES[model];
}

export function estimateCostUsd(model: string, usage: Usage): number {
  const p = PRICES[model];
  if (!p) return 0;
  const cost =
    (usage.inputTokens * p.input +
      usage.outputTokens * p.output +
      usage.cacheReadTokens * p.cacheRead +
      usage.cacheWriteTokens * p.cacheWrite) /
    1_000_000;
  return Math.round(cost * 1e6) / 1e6;
}
