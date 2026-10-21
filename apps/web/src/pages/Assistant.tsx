import { useQuery, useQueryClient } from '@tanstack/react-query';
import { clsx } from 'clsx';
import { Check, Loader2, MessageSquarePlus, Send, ShieldCheck, Trash2, Wrench, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Markdown } from '../components/Tasks';
import { api, type PendingActionView } from '../lib/api';
import { streamSse, type ChatEvent } from '../lib/sse';

interface UiMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  tools: { name: string; summary: string; status: 'running' | 'done' | 'error' }[];
}

interface PendingSet {
  runId: string;
  actions: (PendingActionView & { decision?: boolean; result?: string })[];
}

const SUGGESTIONS = [
  "What's on my plate today?",
  'Remind me to call mom tomorrow at 6pm',
  'Find my notes about insurance',
  'Plan my week',
];

export function AssistantPage() {
  const qc = useQueryClient();
  const conversations = useQuery({ queryKey: ['conversations'], queryFn: api.conversations });
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [messages, setMessages] = useState<UiMessage[]>([]);
  const [pending, setPending] = useState<PendingSet | null>(null);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const bottom = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // Block body: newer browsers return a Promise from scrollIntoView, which React would treat as a cleanup.
    void bottom.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, [messages, pending]);

  const open = async (id: string | null) => {
    setConversationId(id);
    setPending(null);
    setError(null);
    if (!id) return setMessages([]);
    const conv = await api.conversation(id);
    setMessages(
      conv.messages.map((m) => ({
        id: m.id,
        role: m.role,
        text: m.text,
        tools: m.toolCalls.map((t) => ({ name: t.name, summary: t.name, status: 'done' as const })),
      })),
    );
    const first = conv.pending[0];
    if (first) setPending({ runId: first.runId, actions: conv.pending });
  };

  /** Apply streamed events to the last assistant bubble. */
  const handle = (e: ChatEvent) => {
    const patchLast = (fn: (m: UiMessage) => UiMessage) =>
      setMessages((ms) => {
        const last = ms.at(-1);
        if (last?.role !== 'assistant')
          return [...ms, fn({ id: crypto.randomUUID(), role: 'assistant', text: '', tools: [] })];
        return [...ms.slice(0, -1), fn(last)];
      });
    switch (e.type) {
      case 'start':
        setConversationId(e.conversationId);
        break;
      case 'text_delta':
        patchLast((m) => ({ ...m, text: m.text + e.text }));
        break;
      case 'tool_call':
        if (e.risk === 'read')
          patchLast((m) => ({ ...m, tools: [...m.tools, { name: e.name, summary: e.summary, status: 'running' }] }));
        break;
      case 'tool_result':
        patchLast((m) => ({
          ...m,
          tools: m.tools.map((t) =>
            t.name === e.name && t.status === 'running' ? { ...t, status: e.isError ? 'error' : 'done' } : t,
          ),
        }));
        break;
      case 'confirmation_required':
        setPending({ runId: e.runId, actions: e.actions });
        break;
      case 'action_result':
        setPending((p) =>
          p
            ? {
                ...p,
                actions: p.actions.map((a) =>
                  a.id === e.actionId ? { ...a, status: e.status, result: e.summary } : a,
                ),
              }
            : p,
        );
        break;
      case 'error':
        setError(e.message);
        break;
      case 'done':
        break;
    }
  };

  const finish = async () => {
    setBusy(false);
    await qc.invalidateQueries();
  };

  const send = async (text: string) => {
    if (!text.trim() || busy) return;
    setBusy(true);
    setError(null);
    setPending(null);
    setInput('');
    setMessages((ms) => [...ms, { id: crypto.randomUUID(), role: 'user', text, tools: [] }]);
    try {
      await streamSse('/assistant/chat', { text, conversationId: conversationId ?? undefined }, handle);
    } catch {
      setError('Connection lost. Please try again.');
    }
    await finish();
  };

  const decide = async (approveAll: boolean | Map<string, boolean>) => {
    if (!pending) return;
    const decisions = pending.actions
      .filter((a) => a.status === 'pending')
      .map((a) => ({
        actionId: a.id,
        approve: typeof approveAll === 'boolean' ? approveAll : (approveAll.get(a.id) ?? false),
      }));
    setBusy(true);
    setError(null);
    await streamSse(`/assistant/runs/${pending.runId}/decisions`, { decisions }, handle);
    await finish();
  };

  return (
    <div className="grid h-[calc(100vh-7rem)] gap-4 md:grid-cols-[13rem_1fr]">
      <aside className="hidden flex-col gap-1 overflow-y-auto md:flex">
        <button
          className="btn-ghost justify-start border border-dashed border-slate-300 dark:border-slate-700"
          onClick={() => void open(null)}
        >
          <MessageSquarePlus size={16} /> New chat
        </button>
        {conversations.data?.map((c) => (
          <div key={c.id} className="group flex items-center">
            <button
              onClick={() => void open(c.id)}
              className={clsx(
                'flex-1 truncate rounded-lg px-2.5 py-1.5 text-left text-sm',
                c.id === conversationId
                  ? 'bg-brand-50 dark:bg-brand-600/15'
                  : 'hover:bg-slate-100 dark:hover:bg-slate-800',
              )}
            >
              {c.title}
            </button>
            <button
              aria-label="Delete conversation"
              className="btn-ghost px-1 opacity-0 group-hover:opacity-100"
              onClick={() =>
                void api
                  .deleteConversation(c.id)
                  .then(() => (c.id === conversationId ? open(null) : null))
                  .then(() => conversations.refetch())
              }
            >
              <Trash2 size={13} />
            </button>
          </div>
        ))}
      </aside>

      <section className="card flex min-h-0 flex-col">
        <div className="flex-1 space-y-4 overflow-y-auto p-4">
          {messages.length === 0 && (
            <div className="grid h-full place-items-center text-center">
              <div className="space-y-4">
                <p className="text-sm text-slate-500">Ask about your tasks and notes, or tell me what to remember.</p>
                <div className="flex flex-wrap justify-center gap-2">
                  {SUGGESTIONS.map((s) => (
                    <button
                      key={s}
                      className="btn-ghost border border-slate-200 text-xs dark:border-slate-700"
                      onClick={() => void send(s)}
                    >
                      {s}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          )}
          {messages.map((m) => (
            <div key={m.id} className={clsx('flex', m.role === 'user' ? 'justify-end' : 'justify-start')}>
              <div
                className={clsx(
                  'max-w-[85%] rounded-2xl px-4 py-2.5',
                  m.role === 'user' ? 'bg-brand-600 text-white' : 'bg-slate-100 dark:bg-slate-800',
                )}
              >
                {m.tools.length > 0 && (
                  <div className="mb-1.5 flex flex-wrap gap-1">
                    {m.tools.map((t, i) => (
                      <span
                        key={i}
                        className="flex items-center gap-1 rounded-full bg-white/70 px-2 py-0.5 text-[11px] text-slate-600 dark:bg-slate-900/60 dark:text-slate-300"
                      >
                        {t.status === 'running' ? <Loader2 size={10} className="animate-spin" /> : <Wrench size={10} />}
                        {t.summary}
                      </span>
                    ))}
                  </div>
                )}
                {m.role === 'assistant' ? (
                  <Markdown>{m.text || (busy ? '…' : '')}</Markdown>
                ) : (
                  <p className="text-sm whitespace-pre-wrap">{m.text}</p>
                )}
              </div>
            </div>
          ))}

          {pending && <ConfirmCard pending={pending} busy={busy} onDecide={(d) => void decide(d)} />}
          {error && <p className="text-center text-sm text-rose-600">{error}</p>}
          <div ref={bottom} />
        </div>

        <form
          className="flex gap-2 border-t border-slate-200 p-3 dark:border-slate-800"
          onSubmit={(e) => {
            e.preventDefault();
            void send(input);
          }}
        >
          <input
            className="input"
            placeholder="Message LifeOS…"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            disabled={busy}
            aria-label="Message"
          />
          <button className="btn-primary px-3" disabled={busy || !input.trim()} aria-label="Send">
            {busy ? <Loader2 size={16} className="animate-spin" /> : <Send size={16} />}
          </button>
        </form>
      </section>
    </div>
  );
}

/** Every change the assistant wants to make is shown here first. Nothing runs until approved. */
function ConfirmCard({
  pending,
  busy,
  onDecide,
}: {
  pending: PendingSet;
  busy: boolean;
  onDecide: (d: boolean | Map<string, boolean>) => void;
}) {
  const open = pending.actions.filter((a) => a.status === 'pending');
  const [choices, setChoices] = useState(() => new Map(open.map((a) => [a.id, true])));
  return (
    <div
      className="mx-auto max-w-lg rounded-xl border border-brand-200 bg-brand-50/60 p-4 dark:border-brand-700/50 dark:bg-brand-600/10"
      role="dialog"
      aria-label="Confirm actions"
    >
      <div className="mb-2 flex items-center gap-2 text-sm font-medium">
        <ShieldCheck size={16} className="text-brand-600" />
        {open.length ? 'Review before I make changes' : 'Changes'}
      </div>
      <ul className="space-y-1.5">
        {pending.actions.map((a) => (
          <li key={a.id} className="flex items-start gap-2 text-sm">
            {a.status === 'pending' ? (
              <input
                type="checkbox"
                className="mt-1 accent-brand-600"
                checked={choices.get(a.id) ?? false}
                onChange={(e) => setChoices(new Map(choices).set(a.id, e.target.checked))}
                aria-label={a.summary}
              />
            ) : a.status === 'executed' ? (
              <Check size={15} className="mt-0.5 text-emerald-600" />
            ) : (
              <X size={15} className="mt-0.5 text-slate-400" />
            )}
            <span className={clsx(a.status !== 'pending' && a.status !== 'executed' && 'text-slate-400 line-through')}>
              {a.summary}
            </span>
          </li>
        ))}
      </ul>
      {open.length > 0 && (
        <div className="mt-3 flex justify-end gap-2">
          <button className="btn-ghost" disabled={busy} onClick={() => onDecide(false)}>
            Decline
          </button>
          <button className="btn-primary" disabled={busy} onClick={() => onDecide(open.length === 1 ? true : choices)}>
            {busy ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />} Approve
            {open.length > 1 ? ' selected' : ''}
          </button>
        </div>
      )}
    </div>
  );
}
