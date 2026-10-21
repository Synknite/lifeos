import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { runAgent, type AgentEvent } from './agent/loop.js';
import { LlmError } from './errors.js';
import { instrumentChat, type UsageRecord } from './instrument.js';
import { estimateCostUsd } from './pricing.js';
import { heuristicCapture, hashEmbed, MockProvider } from './providers/mock.js';
import { createLlmRuntime } from './router.js';
import { defineTool, ToolRegistry } from './tools/registry.js';
import type { Message } from './types.js';

interface Ctx {
  log: string[];
}

function registry() {
  return new ToolRegistry<Ctx>([
    defineTool({
      name: 'list_tasks',
      description: 'List tasks',
      input: z.object({ view: z.enum(['today', 'all']).default('all') }),
      risk: 'read',
      summarize: (i) => `List ${i.view} tasks`,
      handler: async (i, ctx) => {
        ctx.log.push(`list:${i.view}`);
        return JSON.stringify([{ title: 'Pay rent' }]);
      },
    }),
    defineTool({
      name: 'search_notes',
      description: 'Search notes',
      input: z.object({ query: z.string() }),
      risk: 'read',
      summarize: (i) => `Search "${i.query}"`,
      handler: async (i, ctx) => {
        ctx.log.push(`search:${i.query}`);
        return '[]';
      },
    }),
    defineTool({
      name: 'create_task',
      description: 'Create a task',
      input: z.object({ title: z.string().min(1) }),
      risk: 'write',
      summarize: (i) => `Create task "${i.title}"`,
      handler: async (i, ctx) => {
        ctx.log.push(`create:${i.title}`);
        return 'created';
      },
    }),
  ]);
}

const userMsg = (text: string): Message => ({ role: 'user', parts: [{ type: 'text', text }] });

async function run(provider: MockProvider, history: Message[] = [userMsg('hi')], maxSteps?: number) {
  const ctx: Ctx = { log: [] };
  const events: AgentEvent[] = [];
  const outcome = await runAgent({
    provider,
    tools: registry(),
    ctx,
    system: 'sys',
    history,
    maxSteps,
    onEvent: (e) => {
      events.push(e);
    },
  });
  return { outcome, ctx, events, messages: events.flatMap((e) => (e.type === 'message' ? [e.message] : [])) };
}

describe('runAgent', () => {
  it('completes when the model answers without tools', async () => {
    const { outcome, messages } = await run(new MockProvider({ script: [{ text: 'Hello!' }] }));
    expect(outcome).toMatchObject({ status: 'completed', steps: 1 });
    expect(messages).toHaveLength(1);
  });

  it('runs read tools in parallel and returns all results in one message', async () => {
    const provider = new MockProvider({
      script: [
        {
          toolCalls: [
            { name: 'list_tasks', input: { view: 'today' } },
            { name: 'search_notes', input: { query: 'rent' } },
          ],
        },
        { text: 'You need to pay rent.' },
      ],
    });
    const { outcome, ctx, messages } = await run(provider);
    expect(outcome.status).toBe('completed');
    expect(ctx.log.sort()).toEqual(['list:today', 'search:rent']);
    const toolMsg = messages[1]!;
    expect(toolMsg.role).toBe('user');
    expect(toolMsg.parts.filter((p) => p.type === 'tool_result')).toHaveLength(2);
    // The second model call saw the tool results.
    expect(provider.calls[1]!.req.messages.at(-1)).toEqual(toolMsg);
  });

  it('never executes write tools; proposes them for confirmation alongside settled reads', async () => {
    const provider = new MockProvider({
      script: [
        {
          toolCalls: [
            { name: 'create_task', input: { title: 'Call mom' }, id: 'w1' },
            { name: 'list_tasks', input: {}, id: 'r1' },
          ],
        },
      ],
    });
    const { outcome, ctx } = await run(provider);
    expect(ctx.log).toEqual(['list:all']);
    expect(outcome).toMatchObject({
      status: 'awaiting_confirmation',
      proposed: [{ toolCallId: 'w1', toolName: 'create_task', summary: 'Create task "Call mom"' }],
      settled: [{ toolCallId: 'r1', isError: false }],
    });
  });

  it('turns unknown tools and invalid inputs into error results the model can correct', async () => {
    const provider = new MockProvider({
      script: [
        {
          toolCalls: [
            { name: 'delete_everything', input: {} },
            { name: 'create_task', input: { title: '' } },
          ],
        },
        { text: 'Sorry about that.' },
      ],
    });
    const { outcome, ctx, messages } = await run(provider);
    expect(outcome.status).toBe('completed');
    expect(ctx.log).toEqual([]);
    const results = messages[1]!.parts;
    expect(results.every((p) => p.type === 'tool_result' && p.isError)).toBe(true);
    expect(JSON.stringify(results)).toContain('Unknown tool');
  });

  it('stops at maxSteps', async () => {
    const loop = Array.from({ length: 5 }, () => ({ toolCalls: [{ name: 'list_tasks', input: {} }] }));
    const { outcome } = await run(new MockProvider({ script: loop }), undefined, 3);
    expect(outcome).toMatchObject({ status: 'max_steps', steps: 3 });
  });

  it('respects an aborted signal', async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(
      runAgent({
        provider: new MockProvider({ script: [{ text: 'x' }] }),
        tools: registry(),
        ctx: { log: [] },
        system: 's',
        history: [userMsg('hi')],
        onEvent: () => {},
        signal: ac.signal,
      }),
    ).rejects.toBeInstanceOf(LlmError);
  });
});

describe('MockProvider heuristics', () => {
  it('maps "remind me to …" to a create_task call with the verbatim date phrase', async () => {
    const tools = registry().specs();
    const res = await new MockProvider().generate(
      { system: '', messages: [userMsg('remind me to call mom tomorrow at 9am')], tools },
      { purpose: 'chat' },
    );
    expect(res.stopReason).toBe('tool_use');
    expect(res.message.parts[1]).toMatchObject({
      type: 'tool_call',
      name: 'create_task',
      input: { title: 'Call mom', due: 'tomorrow at 9am' },
    });
  });

  it('extracts capture fields', () => {
    expect(heuristicCapture('Renew passport next month, high prio #travel')).toMatchObject({
      kind: 'task',
      title: 'Renew passport',
      duePhrase: 'next month',
      priority: 3,
      tags: ['travel'],
    });
    expect(heuristicCapture('note: the wifi password is on the router')).toMatchObject({ kind: 'note' });
  });

  it('produces similar embeddings for overlapping text', () => {
    const cos = (a: number[], b: number[]) => a.reduce((s, x, i) => s + x * b[i]!, 0);
    const car = hashEmbed('car insurance renewal in march');
    expect(cos(car, hashEmbed('when is my car insurance renewal'))).toBeGreaterThan(
      cos(car, hashEmbed('grocery list: eggs, milk')),
    );
  });
});

describe('ToolRegistry', () => {
  it('emits sorted JSON schemas without $schema', () => {
    const specs = registry().specs();
    expect(specs.map((s) => s.name)).toEqual(['create_task', 'list_tasks', 'search_notes']);
    expect(specs[0]!.inputSchema).toMatchObject({ type: 'object', properties: { title: { type: 'string' } } });
    expect(specs[0]!.inputSchema).not.toHaveProperty('$schema');
  });
});

describe('instrumentChat', () => {
  it('records usage, cost and errors', async () => {
    const records: UsageRecord[] = [];
    const sink = { record: async (r: UsageRecord) => void records.push(r) };
    const budget = { assertAvailable: vi.fn(async () => {}), consume: vi.fn(async () => {}) };
    const chat = instrumentChat(new MockProvider({ script: [{ text: 'ok' }] }), { sink, budget });
    await chat.generate({ system: '', messages: [userMsg('hello')] }, { purpose: 'test', userId: 'u1' });
    await expect(chat.generate({ system: '', messages: [userMsg('x')] }, { purpose: 'test' })).rejects.toThrow();
    expect(records.map((r) => r.status)).toEqual(['ok', 'error']);
    expect(records[0]).toMatchObject({ provider: 'mock', purpose: 'test', userId: 'u1' });
    expect(budget.assertAvailable).toHaveBeenCalledWith('u1');
    expect(budget.consume).toHaveBeenCalledTimes(1);
  });

  it('blocks calls when the budget is exhausted', async () => {
    const chat = instrumentChat(new MockProvider({ script: [{ text: 'ok' }] }), {
      budget: {
        assertAvailable: async () => {
          throw new LlmError('Daily limit reached', 'budget_exceeded');
        },
        consume: async () => {},
      },
    });
    await expect(
      chat.generate({ system: '', messages: [userMsg('x')] }, { purpose: 't', userId: 'u' }),
    ).rejects.toMatchObject({ code: 'budget_exceeded' });
  });
});

describe('pricing', () => {
  it('prices Claude Opus 5.5 per million tokens', () => {
    expect(
      estimateCostUsd('claude-opus-5-5', {
        inputTokens: 1_000_000,
        outputTokens: 100_000,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      }),
    ).toBe(6);
    expect(
      estimateCostUsd('unknown', { inputTokens: 5, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 }),
    ).toBe(0);
  });
});

describe('createLlmRuntime', () => {
  const base = {
    LLM_PROVIDER: 'auto',
    EMBEDDING_PROVIDER: 'auto',
    ANTHROPIC_MODEL_SMART: 'claude-opus-5-5',
    ANTHROPIC_MODEL_FAST: 'claude-opus-5-5',
    OPENAI_MODEL_SMART: 'gpt-x',
    OPENAI_MODEL_FAST: 'gpt-x-mini',
    OPENAI_EMBEDDING_MODEL: 'text-embedding-3-small',
    OLLAMA_BASE_URL: 'http://localhost:11434',
    OLLAMA_MODEL: 'qwen3:4b',
    OLLAMA_EMBEDDING_MODEL: 'nomic-embed-text',
  } as const;

  it('falls back to mock (demo mode) with no keys and no Ollama', async () => {
    const rt = await createLlmRuntime(base, {}, async () => false);
    expect(rt.info).toMatchObject({ provider: 'mock', embeddingProvider: 'mock', demoMode: true });
  });

  it('prefers Anthropic for chat and Ollama for embeddings when both are available', async () => {
    const rt = await createLlmRuntime({ ...base, ANTHROPIC_API_KEY: 'sk-test' }, {}, async () => true);
    expect(rt.info).toMatchObject({
      provider: 'anthropic',
      smartModel: 'claude-opus-5-5',
      embeddingProvider: 'ollama',
      demoMode: false,
    });
  });

  it('fails fast when an explicit provider lacks credentials', async () => {
    await expect(createLlmRuntime({ ...base, LLM_PROVIDER: 'anthropic' }, {}, async () => false)).rejects.toThrow(
      /ANTHROPIC_API_KEY/,
    );
  });
});
