import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { AnthropicProvider } from './providers/anthropic.js';
import type { Message } from './types.js';

/**
 * Contract tests: assert the exact request we send to the Messages API and
 * how we map its responses, using a stubbed fetch (no network, no key).
 */
function stub(responseBody: object, status = 200) {
  const requests: { url: string; headers: Headers; body: Record<string, unknown> }[] = [];
  const fetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
    requests.push({
      url: input instanceof Request ? input.url : input.toString(),
      headers: new Headers(init?.headers),
      body: JSON.parse(init?.body as string) as Record<string, unknown>,
    });
    return new Response(JSON.stringify(responseBody), { status, headers: { 'content-type': 'application/json' } });
  };
  const provider = new AnthropicProvider({
    apiKey: 'sk-test',
    smartModel: 'claude-opus-5-5',
    fastModel: 'claude-opus-5-5',
    maxRetries: 0,
    fetch: fetchImpl,
  });
  return { provider, requests };
}

const message = (content: object[], stop_reason = 'end_turn') => ({
  id: 'msg_1',
  type: 'message',
  role: 'assistant',
  model: 'claude-opus-5-5',
  content,
  stop_reason,
  stop_sequence: null,
  usage: { input_tokens: 120, output_tokens: 30, cache_read_input_tokens: 100, cache_creation_input_tokens: 0 },
});

describe('AnthropicProvider', () => {
  it('sends cached system prompt, sorted tools, effort and default fallbacks', async () => {
    const { provider, requests } = stub(message([{ type: 'text', text: 'Hi' }]));
    const res = await provider.generate(
      {
        system: 'You are LifeOS',
        messages: [{ role: 'user', parts: [{ type: 'text', text: 'hello' }] }],
        tools: [
          { name: 'zeta', description: 'z', inputSchema: { type: 'object', properties: {} } },
          { name: 'alpha', description: 'a', inputSchema: { type: 'object', properties: {} } },
        ],
      },
      { purpose: 'chat', effort: 'low' },
    );

    const { body, headers, url } = requests[0]!;
    expect(url).toContain('/v1/messages');
    expect(headers.get('anthropic-beta')).toContain('server-side-fallback-2026-07-01');
    expect(body).toMatchObject({
      model: 'claude-opus-5-5',
      fallbacks: 'default',
      output_config: { effort: 'low' },
      system: [{ type: 'text', text: 'You are LifeOS', cache_control: { type: 'ephemeral' } }],
    });
    expect((body.tools as { name: string }[]).map((t) => t.name)).toEqual(['alpha', 'zeta']);
    expect(body).not.toHaveProperty('thinking');
    expect(res).toMatchObject({
      stopReason: 'end_turn',
      usage: { inputTokens: 120, outputTokens: 30, cacheReadTokens: 100 },
      message: { parts: [{ type: 'text', text: 'Hi' }] },
    });
  });

  it('maps tool_use blocks and replays raw assistant content (thinking blocks) unchanged', async () => {
    const raw = [
      { type: 'thinking', thinking: '', signature: 'sig' },
      { type: 'tool_use', id: 'toolu_1', name: 'list_tasks', input: { view: 'today' } },
    ];
    const first = stub(message(raw, 'tool_use'));
    const res = await first.provider.generate(
      { system: 's', messages: [{ role: 'user', parts: [{ type: 'text', text: "what's today" }] }] },
      { purpose: 'chat' },
    );
    expect(res.stopReason).toBe('tool_use');
    expect(res.message.parts).toEqual([
      { type: 'tool_call', id: 'toolu_1', name: 'list_tasks', input: { view: 'today' } },
    ]);

    const second = stub(message([{ type: 'text', text: 'Done' }]));
    const history: Message[] = [
      { role: 'user', parts: [{ type: 'text', text: "what's today" }] },
      res.message,
      { role: 'user', parts: [{ type: 'tool_result', toolCallId: 'toolu_1', content: '[]' }] },
    ];
    await second.provider.generate({ system: 's', messages: history }, { purpose: 'chat' });
    const sent = second.requests[0]!.body.messages as { role: string; content: unknown }[];
    expect(sent[1]).toEqual({ role: 'assistant', content: raw });
    expect(sent[2]).toEqual({
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: '[]', is_error: false }],
    });
  });

  it('surfaces refusals as a stop reason', async () => {
    const { provider } = stub(message([], 'refusal'));
    const res = await provider.generate(
      { system: 's', messages: [{ role: 'user', parts: [{ type: 'text', text: 'x' }] }] },
      { purpose: 'chat' },
    );
    expect(res.stopReason).toBe('refusal');
  });

  it('parses structured output against a zod schema', async () => {
    const { provider, requests } = stub(message([{ type: 'text', text: '{"title":"Renew passport","priority":3}' }]));
    const schema = z.object({ title: z.string(), priority: z.number() });
    const res = await provider.generateObject(
      { system: 's', messages: [{ role: 'user', parts: [{ type: 'text', text: 'renew passport asap' }] }] },
      schema,
      { purpose: 'capture', tier: 'fast' },
    );
    expect(res.object).toEqual({ title: 'Renew passport', priority: 3 });
    expect(requests[0]!.body).toMatchObject({ output_config: { effort: 'low', format: { type: 'json_schema' } } });
  });

  it('normalizes rate limits into retryable LlmErrors', async () => {
    const { provider } = stub({ type: 'error', error: { type: 'rate_limit_error', message: 'slow down' } }, 429);
    await expect(
      provider.generate(
        { system: 's', messages: [{ role: 'user', parts: [{ type: 'text', text: 'x' }] }] },
        { purpose: 'chat' },
      ),
    ).rejects.toMatchObject({ code: 'rate_limited', retryable: true });
  });
});
