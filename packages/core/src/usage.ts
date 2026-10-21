import { type Database, schema } from '@lifeos/db';
import { LlmError, type TokenBudget, type UsageRecord, type UsageSink } from '@lifeos/llm';
import { and, desc, eq, gte, sql } from 'drizzle-orm';

const { llmCalls } = schema;

/** Persists every LLM call so cost and latency are queryable per user and feature. */
export class DbUsageSink implements UsageSink {
  constructor(private readonly db: Database) {}

  async record(r: UsageRecord): Promise<void> {
    await this.db.insert(llmCalls).values({
      userId: r.userId,
      purpose: r.purpose,
      provider: r.provider,
      model: r.model,
      inputTokens: r.usage.inputTokens,
      outputTokens: r.usage.outputTokens,
      cacheReadTokens: r.usage.cacheReadTokens,
      cacheWriteTokens: r.usage.cacheWriteTokens,
      costUsd: r.costUsd,
      latencyMs: r.latencyMs,
      status: r.status,
      errorCode: r.errorCode,
      traceId: r.traceId,
    });
  }
}

/** Minimal Redis surface, so core doesn't depend on a specific client. */
export interface CounterStore {
  get(key: string): Promise<string | null>;
  incrby(key: string, n: number): Promise<number>;
  expire(key: string, seconds: number): Promise<number>;
}

/** Daily per-user token cap: protects the bill from runaway loops and abuse. */
export class RedisTokenBudget implements TokenBudget {
  constructor(
    private readonly store: CounterStore,
    private readonly dailyLimit: number,
  ) {}

  private key(userId: string) {
    return `lifeos:budget:${userId}:${new Date().toISOString().slice(0, 10)}`;
  }

  async used(userId: string): Promise<number> {
    return Number((await this.store.get(this.key(userId))) ?? 0);
  }

  async assertAvailable(userId: string): Promise<void> {
    if ((await this.used(userId)) >= this.dailyLimit) {
      throw new LlmError("You've reached today's AI usage limit. It resets at midnight UTC.", 'budget_exceeded');
    }
  }

  async consume(userId: string, tokens: number): Promise<void> {
    if (tokens <= 0) return;
    const key = this.key(userId);
    await this.store.incrby(key, tokens);
    await this.store.expire(key, 2 * 86_400);
  }
}

export interface UsageSummary {
  days: number;
  totals: {
    calls: number;
    inputTokens: number;
    outputTokens: number;
    costUsd: number;
    errorRate: number;
    p95LatencyMs: number;
  };
  byPurpose: { purpose: string; model: string; calls: number; tokens: number; costUsd: number; avgLatencyMs: number }[];
  daily: { date: string; costUsd: number; tokens: number }[];
  recent: { purpose: string; model: string; status: string; latencyMs: number; costUsd: number; createdAt: string }[];
}

export class UsageService {
  constructor(private readonly db: Database) {}

  async summary(userId: string, days = 30): Promise<UsageSummary> {
    const since = new Date(Date.now() - days * 86_400_000);
    const where = and(eq(llmCalls.userId, userId), gte(llmCalls.createdAt, since));

    const [totals] = await this.db
      .select({
        calls: sql<number>`count(*)::int`,
        inputTokens: sql<number>`coalesce(sum(${llmCalls.inputTokens} + ${llmCalls.cacheReadTokens} + ${llmCalls.cacheWriteTokens}), 0)::int`,
        outputTokens: sql<number>`coalesce(sum(${llmCalls.outputTokens}), 0)::int`,
        costUsd: sql<number>`coalesce(sum(${llmCalls.costUsd}), 0)::float8`,
        errorRate: sql<number>`coalesce(avg(case when ${llmCalls.status} = 'error' then 1.0 else 0 end), 0)::float8`,
        p95LatencyMs: sql<number>`coalesce(percentile_cont(0.95) within group (order by ${llmCalls.latencyMs}), 0)::int`,
      })
      .from(llmCalls)
      .where(where);

    const byPurpose = await this.db
      .select({
        purpose: llmCalls.purpose,
        model: llmCalls.model,
        calls: sql<number>`count(*)::int`,
        tokens: sql<number>`sum(${llmCalls.inputTokens} + ${llmCalls.outputTokens} + ${llmCalls.cacheReadTokens})::int`,
        costUsd: sql<number>`sum(${llmCalls.costUsd})::float8`,
        avgLatencyMs: sql<number>`avg(${llmCalls.latencyMs})::int`,
      })
      .from(llmCalls)
      .where(where)
      .groupBy(llmCalls.purpose, llmCalls.model)
      .orderBy(desc(sql`sum(${llmCalls.costUsd})`));

    const daily = await this.db
      .select({
        date: sql<string>`to_char(date_trunc('day', ${llmCalls.createdAt}), 'YYYY-MM-DD')`,
        costUsd: sql<number>`sum(${llmCalls.costUsd})::float8`,
        tokens: sql<number>`sum(${llmCalls.inputTokens} + ${llmCalls.outputTokens} + ${llmCalls.cacheReadTokens})::int`,
      })
      .from(llmCalls)
      .where(where)
      .groupBy(sql`1`)
      .orderBy(sql`1`);

    const recent = await this.db
      .select({
        purpose: llmCalls.purpose,
        model: llmCalls.model,
        status: llmCalls.status,
        latencyMs: llmCalls.latencyMs,
        costUsd: llmCalls.costUsd,
        createdAt: llmCalls.createdAt,
      })
      .from(llmCalls)
      .where(where)
      .orderBy(desc(llmCalls.createdAt))
      .limit(20);

    return {
      days,
      totals: totals!,
      byPurpose,
      daily,
      recent: recent.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() })),
    };
  }
}
