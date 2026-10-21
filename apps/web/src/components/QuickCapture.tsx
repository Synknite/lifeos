import { useMutation, useQueryClient } from '@tanstack/react-query';
import { CornerDownLeft, Loader2, Plus, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { api, type CapturePreview } from '../lib/api';
import { fromLocalInput, toLocalInput } from '../lib/hooks';

/**
 * Natural-language quick capture (⌘K / Ctrl+K). Type anything, get a
 * structured preview from the model, adjust it, save.
 */
export function QuickCapture() {
  const qc = useQueryClient();
  const [text, setText] = useState('');
  const [preview, setPreview] = useState<CapturePreview | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        inputRef.current?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const analyze = useMutation({ mutationFn: api.capturePreview, onSuccess: setPreview });
  const save = useMutation({
    mutationFn: (p: CapturePreview) =>
      api.captureCommit({
        kind: p.kind,
        title: p.title,
        details: p.details,
        dueAt: p.dueAt,
        allDay: p.allDay,
        remindAt: p.remindAt,
        priority: p.priority,
        tags: p.tags,
        projectId: p.projectId,
      }),
    onSuccess: async () => {
      setPreview(null);
      setText('');
      await qc.invalidateQueries();
    },
  });

  const update = (patch: Partial<CapturePreview>) => setPreview((p) => (p ? { ...p, ...patch } : p));

  return (
    <div className="relative w-full max-w-xl">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (text.trim()) analyze.mutate(text.trim());
        }}
      >
        <div className="flex items-center gap-2 rounded-lg border border-slate-300 bg-white px-3 py-1.5 focus-within:border-brand-500 dark:border-slate-700 dark:bg-slate-900">
          {analyze.isPending ? (
            <Loader2 size={16} className="animate-spin text-brand-600" />
          ) : (
            <Plus size={16} className="text-slate-400" />
          )}
          <input
            ref={inputRef}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder='Capture anything… "renew passport next month, high prio"'
            className="flex-1 bg-transparent text-sm outline-none"
            aria-label="Quick capture"
          />
          <kbd className="hidden rounded border border-slate-200 px-1.5 text-[10px] text-slate-400 sm:block dark:border-slate-700">
            ⌘K
          </kbd>
        </div>
      </form>
      {analyze.isError && <p className="mt-1 text-xs text-rose-600">{analyze.error.message}</p>}

      {preview && (
        <div
          className="card absolute z-20 mt-2 w-full space-y-3 p-4 text-sm"
          role="dialog"
          aria-label="Capture preview"
        >
          <div className="flex items-center justify-between">
            <div className="flex gap-1 rounded-lg bg-slate-100 p-0.5 dark:bg-slate-800">
              {(['task', 'note'] as const).map((k) => (
                <button
                  key={k}
                  type="button"
                  onClick={() => update({ kind: k })}
                  className={`rounded-md px-2.5 py-1 text-xs capitalize ${preview.kind === k ? 'bg-white shadow-sm dark:bg-slate-700' : 'text-slate-500'}`}
                >
                  {k}
                </button>
              ))}
            </div>
            <button className="btn-ghost px-1.5" onClick={() => setPreview(null)} aria-label="Discard">
              <X size={16} />
            </button>
          </div>
          <input
            className="input font-medium"
            value={preview.title}
            onChange={(e) => update({ title: e.target.value })}
            aria-label="Title"
          />
          {preview.kind === 'task' && (
            <div className="grid grid-cols-2 gap-2">
              <label className="space-y-1">
                <span className="text-xs text-slate-500">Due{preview.allDay ? ' (all day)' : ''}</span>
                <input
                  type="datetime-local"
                  className="input"
                  value={toLocalInput(preview.dueAt)}
                  onChange={(e) => update({ dueAt: fromLocalInput(e.target.value), allDay: false })}
                />
              </label>
              <label className="space-y-1">
                <span className="text-xs text-slate-500">Remind me</span>
                <input
                  type="datetime-local"
                  className="input"
                  value={toLocalInput(preview.remindAt)}
                  onChange={(e) => update({ remindAt: fromLocalInput(e.target.value) })}
                />
              </label>
              <label className="space-y-1">
                <span className="text-xs text-slate-500">Priority</span>
                <select
                  className="input"
                  value={preview.priority}
                  onChange={(e) => update({ priority: Number(e.target.value) })}
                >
                  <option value={0}>None</option>
                  <option value={1}>Low</option>
                  <option value={2}>Medium</option>
                  <option value={3}>High</option>
                </select>
              </label>
              <label className="space-y-1">
                <span className="text-xs text-slate-500">Tags</span>
                <input
                  className="input"
                  value={preview.tags.join(', ')}
                  onChange={(e) =>
                    update({
                      tags: e.target.value
                        .split(',')
                        .map((t) => t.trim())
                        .filter(Boolean),
                    })
                  }
                />
              </label>
            </div>
          )}
          <div className="flex items-center justify-between">
            <span className="text-xs text-slate-400">
              Parsed by {preview.provider} · {preview.model}
            </span>
            <button
              className="btn-primary"
              disabled={save.isPending || !preview.title.trim()}
              onClick={() => save.mutate(preview)}
            >
              {save.isPending ? <Loader2 size={14} className="animate-spin" /> : <CornerDownLeft size={14} />} Save{' '}
              {preview.kind}
            </button>
          </div>
          {save.isError && <p className="text-xs text-rose-600">{save.error.message}</p>}
        </div>
      )}
    </div>
  );
}
