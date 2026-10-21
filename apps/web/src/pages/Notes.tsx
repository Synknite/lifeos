import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { clsx } from 'clsx';
import { Loader2, Plus, Search, Sparkles, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { api, type Note } from '../lib/api';

export function NotesPage() {
  const qc = useQueryClient();
  const notes = useQuery({ queryKey: ['notes'], queryFn: api.notes, refetchInterval: 5_000 });
  const [selected, setSelected] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [query, setQuery] = useState('');
  const hits = useQuery({
    queryKey: ['search', query],
    queryFn: () => api.searchNotes(query),
    enabled: query.length > 0,
  });

  const create = useMutation({
    mutationFn: () => api.createNote({ title: 'Untitled', bodyMd: '' }),
    onSuccess: async (n) => {
      await qc.invalidateQueries({ queryKey: ['notes'] });
      setSelected(n.id);
    },
  });

  const current = notes.data?.find((n) => n.id === selected) ?? null;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Notes</h1>
        <button className="btn-primary" onClick={() => create.mutate()}>
          <Plus size={16} /> New note
        </button>
      </div>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          setQuery(q.trim());
        }}
        className="flex gap-2"
      >
        <input
          className="input"
          placeholder="Search by meaning or keyword… e.g. “what did I decide about insurance”"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <button className="btn-ghost border border-slate-200 dark:border-slate-700" aria-label="Search">
          <Search size={16} />
        </button>
      </form>

      {query && (
        <div className="card p-3">
          <div className="mb-2 text-xs text-slate-500">Results for “{query}”</div>
          {hits.isLoading && <Loader2 className="animate-spin" size={16} />}
          {hits.data?.length === 0 && <p className="text-sm text-slate-500">No matches.</p>}
          <ul className="space-y-1">
            {hits.data?.map((h) => (
              <li key={h.noteId}>
                <button
                  className="w-full rounded-lg px-2 py-1.5 text-left hover:bg-slate-100 dark:hover:bg-slate-800"
                  onClick={() => setSelected(h.noteId)}
                >
                  <div className="flex items-center gap-2 text-sm font-medium">
                    {h.title || 'Untitled'}
                    {h.matchedBy.includes('semantic') && (
                      <span className="flex items-center gap-0.5 text-[10px] text-brand-600">
                        <Sparkles size={10} /> semantic
                      </span>
                    )}
                  </div>
                  <div className="line-clamp-2 text-xs text-slate-500">{h.snippet.replaceAll('**', '')}</div>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="grid gap-4 md:grid-cols-[14rem_1fr]">
        <ul className="card max-h-[60vh] overflow-y-auto p-1">
          {notes.data?.map((n) => (
            <li key={n.id}>
              <button
                onClick={() => setSelected(n.id)}
                className={clsx(
                  'w-full rounded-lg px-2.5 py-2 text-left text-sm',
                  n.id === selected ? 'bg-brand-50 dark:bg-brand-600/15' : 'hover:bg-slate-100 dark:hover:bg-slate-800',
                )}
              >
                <div className="truncate font-medium">{n.title || 'Untitled'}</div>
                <div className="truncate text-xs text-slate-500">{n.bodyMd.slice(0, 60) || 'Empty'}</div>
              </button>
            </li>
          ))}
          {notes.data?.length === 0 && <li className="p-3 text-sm text-slate-500">No notes yet.</li>}
        </ul>
        {current ? (
          <NoteEditor key={current.id} note={current} onDeleted={() => setSelected(null)} />
        ) : (
          <div className="card grid place-items-center p-10 text-sm text-slate-500">Select or create a note.</div>
        )}
      </div>
    </div>
  );
}

function NoteEditor({ note, onDeleted }: { note: Note; onDeleted: () => void }) {
  const qc = useQueryClient();
  const [title, setTitle] = useState(note.title);
  const [body, setBody] = useState(note.bodyMd);
  const save = useMutation({
    mutationFn: () => api.updateNote(note.id, { title, bodyMd: body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['notes'] }),
  });
  const remove = useMutation({
    mutationFn: () => api.deleteNote(note.id),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['notes'] });
      onDeleted();
    },
  });

  // Autosave after a pause in typing; the worker debounces re-indexing too.
  useEffect(() => {
    if (title === note.title && body === note.bodyMd) return;
    const t = setTimeout(() => save.mutate(), 800);
    return () => clearTimeout(t);
  }, [title, body]);

  return (
    <div className="card flex flex-col p-4">
      <div className="flex items-center gap-2">
        <input
          className="flex-1 bg-transparent text-lg font-semibold outline-none"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          aria-label="Note title"
        />
        <span className="text-xs text-slate-400">
          {save.isPending ? 'Saving…' : note.indexed ? 'Indexed' : 'Indexing…'}
        </span>
        <button className="btn-ghost px-1.5" onClick={() => remove.mutate()} aria-label="Delete note">
          <Trash2 size={15} />
        </button>
      </div>
      <textarea
        className="mt-3 min-h-72 flex-1 resize-y bg-transparent text-sm leading-relaxed outline-none"
        placeholder="Write in markdown…"
        value={body}
        onChange={(e) => setBody(e.target.value)}
        aria-label="Note body"
      />
    </div>
  );
}
