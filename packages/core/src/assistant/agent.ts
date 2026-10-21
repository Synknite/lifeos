import { type Database, schema } from '@lifeos/db';
import { formatLocal } from '@lifeos/domain';
import {
  ASSISTANT_SYSTEM_PROMPT,
  LlmError,
  runAgent,
  runTool,
  toolCallsOf,
  toolResultMessage,
  type AgentEvent,
  type ChatProvider,
  type Message,
  type MessagePart,
  type SettledResult,
} from '@lifeos/llm';
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { User } from '../auth.js';
import { ConflictError, NotFoundError } from '../errors.js';
import { buildAssistantTools, type AssistantServices, type ToolContext } from './tools.js';

const { conversations, messages, agentRuns, pendingActions } = schema;

export const PENDING_ACTION_TTL_MS = 24 * 3_600_000;

export const sendMessageSchema = z.object({
  conversationId: z.uuid().optional(),
  text: z.string().trim().min(1).max(8_000),
});

export const decideSchema = z.object({
  decisions: z
    .array(z.object({ actionId: z.uuid(), approve: z.boolean() }))
    .min(1)
    .max(20),
});

export interface PendingActionView {
  id: string;
  toolName: string;
  summary: string;
  input: unknown;
  status: string;
}

/** Events streamed to the browser over SSE. */
export type ChatEvent =
  | { type: 'start'; conversationId: string; runId: string }
  | Exclude<AgentEvent, { type: 'message' }>
  | { type: 'confirmation_required'; runId: string; actions: PendingActionView[] }
  | { type: 'action_result'; actionId: string; status: 'executed' | 'failed' | 'rejected' | 'expired'; summary: string }
  | { type: 'done'; status: 'completed' | 'awaiting_confirmation' | 'refused' | 'max_steps' }
  | { type: 'error'; code: string; message: string };

export type Emit = (event: ChatEvent) => void;

export interface ViewMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  toolCalls: { name: string }[];
  createdAt: string;
}

interface StoredParts {
  parts: MessagePart[];
  providerRaw?: Message['providerRaw'];
}

/**
 * Orchestrates conversations with the assistant: persistence, the agent
 * loop, and human-in-the-loop confirmation of every write.
 *
 * History is append-only: user turns carry their own <context> block and
 * assistant turns keep provider-native content, so replaying a conversation
 * always sends byte-identical earlier turns (prompt cache hits, valid
 * thinking blocks).
 */
export class AgentService {
  private readonly tools = buildAssistantTools();

  constructor(
    private readonly db: Database,
    private readonly llm: ChatProvider,
    private readonly services: AssistantServices,
    private readonly opts: { maxSteps?: number } = {},
  ) {}

  async listConversations(userId: string) {
    const rows = await this.db
      .select({ id: conversations.id, title: conversations.title, updatedAt: conversations.updatedAt })
      .from(conversations)
      .where(eq(conversations.userId, userId))
      .orderBy(desc(conversations.updatedAt))
      .limit(50);
    return rows.map((r) => ({ ...r, updatedAt: r.updatedAt.toISOString() }));
  }

  async getConversation(userId: string, id: string) {
    const conv = await this.ownConversation(userId, id);
    const rows = await this.db
      .select()
      .from(messages)
      .where(eq(messages.conversationId, id))
      .orderBy(asc(messages.createdAt), asc(messages.id));
    const view: ViewMessage[] = rows.flatMap((r) => {
      if (r.role === 'tool') return [];
      const stored = r.parts as StoredParts;
      const text = stored.parts
        .filter((p) => p.type === 'text')
        .map((p) => (p.type === 'text' ? stripContext(p.text) : ''))
        .join('');
      const toolCalls = stored.parts.flatMap((p) => (p.type === 'tool_call' ? [{ name: p.name }] : []));
      if (!text && !toolCalls.length) return [];
      return [{ id: r.id, role: r.role, text, toolCalls, createdAt: r.createdAt.toISOString() }];
    });
    const pending = await this.db
      .select()
      .from(pendingActions)
      .innerJoin(agentRuns, eq(agentRuns.id, pendingActions.agentRunId))
      .where(
        and(
          eq(agentRuns.conversationId, id),
          eq(agentRuns.status, 'awaiting_confirmation'),
          eq(pendingActions.status, 'pending'),
        ),
      );
    return {
      id: conv.id,
      title: conv.title,
      messages: view,
      pending: pending.map((p) => ({ runId: p.agent_runs.id, ...toActionView(p.pending_actions) })),
    };
  }

  async deleteConversation(userId: string, id: string): Promise<void> {
    await this.ownConversation(userId, id);
    await this.db.delete(conversations).where(eq(conversations.id, id));
  }

  /** Handle a new user message: persist it, run the agent, stream events. */
  async send(user: User, input: z.input<typeof sendMessageSchema>, emit: Emit, signal?: AbortSignal) {
    const { conversationId: requested, text } = sendMessageSchema.parse(input);
    const conversationId = requested
      ? (await this.ownConversation(user.id, requested)).id
      : await this.createConversation(user.id, text);

    // A new message while actions await confirmation means the user moved on:
    // decline them so every tool call in history still gets a result.
    const [waiting] = await this.db
      .select()
      .from(agentRuns)
      .where(
        and(
          eq(agentRuns.conversationId, conversationId),
          inArray(agentRuns.status, ['awaiting_confirmation', 'running']),
        ),
      );
    if (waiting?.status === 'running' && waiting.updatedAt.getTime() > Date.now() - 120_000) {
      throw new ConflictError('The assistant is still working on the previous message');
    }
    if (waiting) await this.closeAbandonedRun(conversationId, waiting.id);
    await this.repairHistory(conversationId);

    const now = new Date();
    const userMessage: Message = {
      role: 'user',
      parts: [
        {
          type: 'text',
          text: `<context>\nNow: ${formatLocal(now, user.timezone)} (${user.timezone})\nUser: ${user.displayName}\n</context>\n\n${text}`,
        },
      ],
    };
    await this.appendMessage(conversationId, userMessage);
    const [run] = await this.db.insert(agentRuns).values({ userId: user.id, conversationId }).returning();
    emit({ type: 'start', conversationId, runId: run!.id });
    await this.drive(user, conversationId, run!.id, 0, emit, signal, now);
    return { conversationId, runId: run!.id };
  }

  /**
   * Apply the user's decisions on proposed actions, then resume the run.
   * The run's status flip is a compare-and-set, so two concurrent approvals
   * (double click, two tabs) can never execute an action twice.
   */
  async decide(user: User, runId: string, input: z.input<typeof decideSchema>, emit: Emit, signal?: AbortSignal) {
    const { decisions } = decideSchema.parse(input);
    const [run] = await this.db
      .update(agentRuns)
      .set({ status: 'running' })
      .where(and(eq(agentRuns.id, runId), eq(agentRuns.userId, user.id), eq(agentRuns.status, 'awaiting_confirmation')))
      .returning();
    if (!run) {
      const [exists] = await this.db
        .select({ id: agentRuns.id })
        .from(agentRuns)
        .where(and(eq(agentRuns.id, runId), eq(agentRuns.userId, user.id)));
      if (!exists) throw new NotFoundError('Run');
      throw new ConflictError('These actions were already handled');
    }
    emit({ type: 'start', conversationId: run.conversationId, runId });

    const rows = await this.db.select().from(pendingActions).where(eq(pendingActions.agentRunId, runId));
    const approve = new Map(decisions.map((d) => [d.actionId, d.approve]));
    const ctx = this.toolContext(user, new Date());
    const results: SettledResult[] = [];

    for (const row of rows) {
      if (row.status === 'executed') {
        // A read that already ran while the turn waited.
        const r = row.result as { content: string; isError: boolean };
        results.push({ toolCallId: row.toolCallId, toolName: row.toolName, content: r.content, isError: r.isError });
        continue;
      }
      if (row.status !== 'pending') continue;

      let status: 'executed' | 'failed' | 'rejected' | 'expired';
      let settled: SettledResult;
      if (row.expiresAt < new Date()) {
        status = 'expired';
        settled = {
          toolCallId: row.toolCallId,
          toolName: row.toolName,
          content: 'The confirmation expired; nothing was changed.',
          isError: true,
        };
      } else if (approve.get(row.id) === true) {
        const tool = this.tools.get(row.toolName);
        settled = tool
          ? await runTool(tool, row.toolCallId, row.input, { ...ctx, pendingActionId: row.id })
          : { toolCallId: row.toolCallId, toolName: row.toolName, content: 'Tool no longer exists', isError: true };
        status = settled.isError ? 'failed' : 'executed';
      } else {
        status = 'rejected';
        settled = {
          toolCallId: row.toolCallId,
          toolName: row.toolName,
          content: 'The user declined this action. Nothing was changed.',
          isError: true,
        };
      }
      await this.db
        .update(pendingActions)
        .set({ status, decidedAt: sql`now()`, result: { content: settled.content, isError: settled.isError } })
        .where(eq(pendingActions.id, row.id));
      results.push(settled);
      emit({
        type: 'action_result',
        actionId: row.id,
        status,
        summary: status === 'executed' ? row.summary : settled.content,
      });
    }

    await this.appendMessage(
      run.conversationId,
      this.orderedResults(await this.loadHistory(run.conversationId), results),
    );
    await this.drive(user, run.conversationId, runId, run.steps, emit, signal, new Date());
    return { conversationId: run.conversationId, runId };
  }

  // -------------------------------------------------------------------------

  /** Run the agent loop on the stored history and persist everything it produces. */
  private async drive(
    user: User,
    conversationId: string,
    runId: string,
    priorSteps: number,
    emit: Emit,
    signal: AbortSignal | undefined,
    now: Date,
  ) {
    const history = await this.loadHistory(conversationId);
    try {
      const outcome = await runAgent({
        provider: this.llm,
        tools: this.tools,
        ctx: this.toolContext(user, now),
        system: ASSISTANT_SYSTEM_PROMPT,
        history,
        userId: user.id,
        maxSteps: this.opts.maxSteps ?? 8,
        signal,
        onEvent: async (ev) => {
          if (ev.type === 'message') await this.appendMessage(conversationId, ev.message);
          else emit(ev);
        },
      });
      const steps = priorSteps + outcome.steps;

      if (outcome.status === 'awaiting_confirmation') {
        const expiresAt = new Date(Date.now() + PENDING_ACTION_TTL_MS);
        const inserted = await this.db
          .insert(pendingActions)
          .values([
            ...outcome.proposed.map((p) => ({
              userId: user.id,
              agentRunId: runId,
              toolCallId: p.toolCallId,
              toolName: p.toolName,
              input: p.input,
              summary: p.summary,
              expiresAt,
            })),
            ...outcome.settled.map((s) => ({
              userId: user.id,
              agentRunId: runId,
              toolCallId: s.toolCallId,
              toolName: s.toolName,
              input: {},
              summary: 'read',
              status: 'executed' as const,
              result: { content: s.content, isError: s.isError },
              expiresAt,
            })),
          ])
          .returning();
        await this.db.update(agentRuns).set({ status: 'awaiting_confirmation', steps }).where(eq(agentRuns.id, runId));
        emit({
          type: 'confirmation_required',
          runId,
          actions: inserted.filter((r) => r.status === 'pending').map(toActionView),
        });
        emit({ type: 'done', status: 'awaiting_confirmation' });
        return;
      }

      await this.db.update(agentRuns).set({ status: 'completed', steps }).where(eq(agentRuns.id, runId));
      if (outcome.status === 'refused') {
        emit({ type: 'text_delta', text: "\n\nI can't help with that request." });
      } else if (outcome.status === 'max_steps') {
        emit({ type: 'text_delta', text: '\n\nI stopped after several steps. Ask me to continue if you need more.' });
      }
      emit({ type: 'done', status: outcome.status });
    } catch (err) {
      const message =
        err instanceof LlmError
          ? friendlyLlmError(err)
          : 'Something went wrong while talking to the assistant. Please try again.';
      await this.db
        .update(agentRuns)
        .set({ status: 'failed', error: err instanceof Error ? err.message.slice(0, 500) : 'unknown' })
        .where(eq(agentRuns.id, runId));
      await this.repairHistory(conversationId);
      emit({ type: 'error', code: err instanceof LlmError ? err.code : 'internal', message });
      if (!(err instanceof LlmError)) throw err;
    } finally {
      await this.db.update(conversations).set({ updatedAt: new Date() }).where(eq(conversations.id, conversationId));
    }
  }

  private toolContext(user: User, now: Date): ToolContext {
    return { userId: user.id, timezone: user.timezone, now, services: this.services };
  }

  private async createConversation(userId: string, text: string): Promise<string> {
    const title = text.replace(/\s+/g, ' ').slice(0, 60) + (text.length > 60 ? '…' : '');
    const [row] = await this.db.insert(conversations).values({ userId, title }).returning({ id: conversations.id });
    return row!.id;
  }

  private async ownConversation(userId: string, id: string) {
    const [row] = await this.db
      .select()
      .from(conversations)
      .where(and(eq(conversations.id, id), eq(conversations.userId, userId)));
    if (!row) throw new NotFoundError('Conversation');
    return row;
  }

  private async appendMessage(conversationId: string, m: Message): Promise<void> {
    const isToolResults = m.role === 'user' && m.parts.every((p) => p.type === 'tool_result');
    const stored: StoredParts = { parts: m.parts, ...(m.providerRaw ? { providerRaw: m.providerRaw } : {}) };
    await this.db.insert(messages).values({ conversationId, role: isToolResults ? 'tool' : m.role, parts: stored });
  }

  private async loadHistory(conversationId: string): Promise<Message[]> {
    const rows = await this.db
      .select()
      .from(messages)
      .where(eq(messages.conversationId, conversationId))
      .orderBy(asc(messages.createdAt), asc(messages.id));
    return rows.map((r) => {
      const stored = r.parts as StoredParts;
      return {
        role: r.role === 'assistant' ? 'assistant' : 'user',
        parts: stored.parts,
        ...(stored.providerRaw ? { providerRaw: stored.providerRaw } : {}),
      };
    });
  }

  /** Tool results must follow the order of the calls in the assistant turn. */
  private orderedResults(history: Message[], results: SettledResult[]): Message {
    const last = [...history].reverse().find((m) => m.role === 'assistant');
    const order = new Map((last ? toolCallsOf(last) : []).map((c, i) => [c.id, i]));
    return toolResultMessage(
      [...results].sort((a, b) => (order.get(a.toolCallId) ?? 0) - (order.get(b.toolCallId) ?? 0)),
    );
  }

  /** Decline whatever an abandoned run left pending and record the results. */
  private async closeAbandonedRun(conversationId: string, runId: string): Promise<void> {
    const rows = await this.db.select().from(pendingActions).where(eq(pendingActions.agentRunId, runId));
    const results: SettledResult[] = rows.map((r) =>
      r.status === 'executed'
        ? { toolCallId: r.toolCallId, toolName: r.toolName, ...(r.result as { content: string; isError: boolean }) }
        : {
            toolCallId: r.toolCallId,
            toolName: r.toolName,
            content: 'The user moved on without approving this. Nothing was changed.',
            isError: true,
          },
    );
    await this.db
      .update(pendingActions)
      .set({ status: 'rejected', decidedAt: sql`now()` })
      .where(and(eq(pendingActions.agentRunId, runId), eq(pendingActions.status, 'pending')));
    if (results.length)
      await this.appendMessage(conversationId, this.orderedResults(await this.loadHistory(conversationId), results));
    await this.db.update(agentRuns).set({ status: 'failed', error: 'abandoned' }).where(eq(agentRuns.id, runId));
  }

  /**
   * If a crash left an assistant tool call without results, append error
   * results so the conversation is valid to send again.
   */
  private async repairHistory(conversationId: string): Promise<void> {
    const history = await this.loadHistory(conversationId);
    const last = history.at(-1);
    if (last?.role !== 'assistant') return;
    const calls = toolCallsOf(last);
    if (!calls.length) return;
    await this.appendMessage(
      conversationId,
      toolResultMessage(
        calls.map((c) => ({
          toolCallId: c.id,
          toolName: c.name,
          content: 'Interrupted before this ran. Nothing was changed.',
          isError: true,
        })),
      ),
    );
  }
}

function toActionView(r: typeof pendingActions.$inferSelect): PendingActionView {
  return { id: r.id, toolName: r.toolName, summary: r.summary, input: r.input, status: r.status };
}

function stripContext(text: string): string {
  return text.replace(/^<context>[\s\S]*?<\/context>\s*/, '');
}

function friendlyLlmError(err: LlmError): string {
  switch (err.code) {
    case 'rate_limited':
      return 'The AI provider is busy right now. Please try again in a moment.';
    case 'budget_exceeded':
      return err.message;
    case 'timeout':
      return 'The assistant took too long to respond. Please try again.';
    case 'auth':
      return 'The AI provider rejected our credentials. Check the API key configuration.';
    case 'refusal':
      return "I can't help with that request.";
    default:
      return 'The assistant ran into a problem. Please try again.';
  }
}
