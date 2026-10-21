import { appMetrics, withSpan } from '@lifeos/observability';
import { LlmError } from '../errors.js';
import type { ParsedCall, ToolRegistry } from '../tools/registry.js';
import {
  addUsage,
  emptyUsage,
  toolCallsOf,
  type ChatProvider,
  type Effort,
  type Message,
  type MessagePart,
  type Usage,
} from '../types.js';

/** A write the model proposed, awaiting the user's decision. */
export interface ProposedAction {
  toolCallId: string;
  toolName: string;
  input: unknown;
  summary: string;
}

/** Result of a tool that already ran while the turn waits for confirmation. */
export interface SettledResult {
  toolCallId: string;
  toolName: string;
  content: string;
  isError: boolean;
}

export type AgentEvent =
  | { type: 'text_delta'; text: string }
  /** A message to append to the persisted conversation (assistant turns and tool results). */
  | { type: 'message'; message: Message }
  | { type: 'tool_call'; toolCallId: string; name: string; summary: string; risk: 'read' | 'write' }
  | { type: 'tool_result'; toolCallId: string; name: string; isError: boolean };

export type AgentOutcome =
  | { status: 'completed'; steps: number; usage: Usage }
  | { status: 'refused'; steps: number; usage: Usage }
  | { status: 'max_steps'; steps: number; usage: Usage }
  | {
      status: 'awaiting_confirmation';
      steps: number;
      usage: Usage;
      proposed: ProposedAction[];
      /** Reads (and invalid calls) from the same turn; returned with the decisions later. */
      settled: SettledResult[];
    };

export interface RunAgentOptions<Ctx> {
  provider: ChatProvider;
  tools: ToolRegistry<Ctx>;
  ctx: Ctx;
  system: string;
  /** Full conversation so far; must end with a user message (text or tool results). */
  history: Message[];
  onEvent: (event: AgentEvent) => void | Promise<void>;
  userId?: string;
  maxSteps?: number;
  /** Hard cap on tokens per run, independent of the daily budget. */
  maxRunTokens?: number;
  effort?: Effort;
  signal?: AbortSignal;
  stepTimeoutMs?: number;
}

/**
 * The agent loop: model -> tools -> model, until the model answers, a write
 * needs confirmation, or a limit is hit.
 *
 * Safety properties:
 * - Read tools run immediately and in parallel; write tools never run here.
 *   They are returned as `proposed` so the caller can persist them and ask
 *   the user. Approval happens out of band (see AgentService).
 * - Every tool_result for a turn goes back in one message, as the API expects.
 * - Model-proposed inputs are validated before anything executes.
 * - Bounded by maxSteps, a per-run token cap and an abort signal.
 */
export async function runAgent<Ctx>(opts: RunAgentOptions<Ctx>): Promise<AgentOutcome> {
  const maxSteps = opts.maxSteps ?? 8;
  const maxRunTokens = opts.maxRunTokens ?? 200_000;
  const history = [...opts.history];
  let usage = emptyUsage();

  return withSpan('agent.run', { 'lifeos.agent.max_steps': maxSteps }, async (span) => {
    for (let step = 1; step <= maxSteps; step++) {
      if (opts.signal?.aborted) throw new LlmError('Agent run aborted', 'timeout', { retryable: false });

      let result;
      for await (const ev of opts.provider.stream(
        // Snapshot: providers may hold the request after we append to history.
        { system: opts.system, messages: [...history], tools: opts.tools.specs() },
        {
          purpose: 'chat',
          userId: opts.userId,
          tier: 'smart',
          effort: opts.effort ?? 'medium',
          signal: opts.signal,
          timeoutMs: opts.stepTimeoutMs ?? 90_000,
        },
      )) {
        if (ev.type === 'text_delta') await opts.onEvent(ev);
        else result = ev.result;
      }
      if (!result) throw new LlmError('Model stream ended without a result', 'provider_error');
      usage = addUsage(usage, result.usage);

      const assistant = result.message;
      history.push(assistant);
      await opts.onEvent({ type: 'message', message: assistant });

      const finish = (status: 'completed' | 'refused' | 'max_steps') => {
        span.setAttributes({ 'lifeos.agent.steps': step, 'lifeos.agent.status': status });
        appMetrics.agentSteps.record(step, { status });
        return { status, steps: step, usage };
      };

      if (result.stopReason === 'refusal') return finish('refused');
      const calls = toolCallsOf(assistant);
      if (calls.length === 0) return finish('completed');
      // A tool input cut off at max_tokens may parse as a plausible partial object; never run it.
      if (result.stopReason === 'max_tokens') {
        throw new LlmError('The response was cut off before the tool call finished', 'max_tokens');
      }

      const parsed = calls.map((c) => opts.tools.parse(c, opts.ctx));
      for (const p of parsed) {
        await opts.onEvent({
          type: 'tool_call',
          toolCallId: p.id,
          name: p.ok ? p.tool.name : p.name,
          summary: p.ok ? p.summary : p.error,
          risk: p.ok ? p.tool.risk : 'read',
        });
      }

      const writes = parsed.filter((p): p is Extract<ParsedCall<Ctx>, { ok: true }> => p.ok && p.tool.risk === 'write');
      const immediate = parsed.filter((p) => !(p.ok && p.tool.risk === 'write'));
      const settled = await Promise.all(immediate.map((p) => execute(p, opts)));
      for (const s of settled) {
        await opts.onEvent({ type: 'tool_result', toolCallId: s.toolCallId, name: s.toolName, isError: s.isError });
      }

      if (writes.length > 0) {
        span.setAttributes({ 'lifeos.agent.steps': step, 'lifeos.agent.status': 'awaiting_confirmation' });
        appMetrics.agentSteps.record(step, { status: 'awaiting_confirmation' });
        return {
          status: 'awaiting_confirmation',
          steps: step,
          usage,
          settled,
          proposed: writes.map((w) => ({
            toolCallId: w.id,
            toolName: w.tool.name,
            input: w.input,
            summary: w.summary,
          })),
        };
      }

      const toolMessage = toolResultMessage(settled);
      history.push(toolMessage);
      await opts.onEvent({ type: 'message', message: toolMessage });

      if (usage.inputTokens + usage.outputTokens > maxRunTokens) {
        throw new LlmError('This conversation used too many tokens in one run', 'budget_exceeded');
      }
      if (step === maxSteps) return finish('max_steps');
    }
    return { status: 'max_steps', steps: maxSteps, usage };
  });
}

async function execute<Ctx>(p: ParsedCall<Ctx>, opts: RunAgentOptions<Ctx>): Promise<SettledResult> {
  if (!p.ok) return { toolCallId: p.id, toolName: p.name, content: p.error, isError: true };
  return runTool(p.tool, p.id, p.input, opts.ctx);
}

/** Execute one validated tool call, converting failures into error results. */
export async function runTool<Ctx>(
  tool: { name: string; handler: (input: never, ctx: Ctx) => Promise<string> },
  toolCallId: string,
  input: unknown,
  ctx: Ctx,
): Promise<SettledResult> {
  return withSpan('tool.execute', { 'lifeos.tool.name': tool.name }, async (span) => {
    try {
      const content = await tool.handler(input as never, ctx);
      return { toolCallId, toolName: tool.name, content, isError: false };
    } catch (err) {
      span.setAttribute('lifeos.tool.error', true);
      // Domain errors carry user-safe messages; anything else stays generic.
      const message = err instanceof Error && 'status' in err ? err.message : 'The tool failed unexpectedly';
      return { toolCallId, toolName: tool.name, content: message, isError: true };
    }
  });
}

/** One user message carrying every tool_result for a turn. */
export function toolResultMessage(results: SettledResult[]): Message {
  const parts: MessagePart[] = results.map((r) => ({
    type: 'tool_result',
    toolCallId: r.toolCallId,
    content: r.content,
    isError: r.isError,
  }));
  return { role: 'user', parts };
}
