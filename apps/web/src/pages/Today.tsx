import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Loader2, Plus, RefreshCw, Sun } from 'lucide-react';
import { useState } from 'react';
import { Markdown, TaskList } from '../components/Tasks';
import { api, type TaskView } from '../lib/api';
import { useMe } from '../lib/hooks';

export function TodayPage() {
  const me = useMe();
  const qc = useQueryClient();
  const today = useQuery({ queryKey: ['tasks', 'today'], queryFn: () => api.tasks('today') });
  const upcoming = useQuery({ queryKey: ['tasks', 'upcoming'], queryFn: () => api.tasks('upcoming') });
  const briefing = useQuery({ queryKey: ['briefing'], queryFn: api.briefing });
  const generate = useMutation({
    mutationFn: api.generateBriefing,
    onSuccess: (data) => qc.setQueryData(['briefing'], data),
  });

  const hour = new Date().getHours();
  const greeting = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">
        {greeting}
        {me.data ? `, ${me.data.displayName.split(' ')[0]}` : ''}
      </h1>

      <section className="card p-5">
        <div className="mb-2 flex items-center justify-between">
          <h2 className="flex items-center gap-2 font-medium">
            <Sun size={18} className="text-amber-500" /> Daily briefing
          </h2>
          <button className="btn-ghost text-xs" onClick={() => generate.mutate()} disabled={generate.isPending}>
            {generate.isPending ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
            {briefing.data?.briefing ? 'Refresh' : 'Generate'}
          </button>
        </div>
        {briefing.data?.briefing ? (
          <Markdown>{briefing.data.briefing.contentMd}</Markdown>
        ) : (
          <p className="text-sm text-slate-500">
            Your briefing arrives automatically at {me.data?.briefingTime ?? '07:30'} each morning, or generate it now.
          </p>
        )}
        {generate.isError && <p className="mt-2 text-sm text-rose-600">{generate.error.message}</p>}
      </section>

      <section className="space-y-2">
        <h2 className="text-sm font-medium text-slate-500">Due today & overdue</h2>
        <AddTask defaultDueToday />
        <TaskList tasks={today.data} empty="Nothing due today. Enjoy the breathing room." />
      </section>

      <section className="space-y-2">
        <h2 className="text-sm font-medium text-slate-500">Coming up</h2>
        <TaskList tasks={upcoming.data?.slice(0, 8)} empty="Nothing scheduled yet." />
      </section>
    </div>
  );
}

export function TasksPage({ view }: { view: Extract<TaskView, 'inbox' | 'all'> }) {
  const [tab, setTab] = useState<TaskView>(view);
  const [q, setQ] = useState('');
  const tasks = useQuery({ queryKey: ['tasks', tab, q], queryFn: () => api.tasks(tab, q || undefined) });
  const tabs: TaskView[] = view === 'inbox' ? ['inbox'] : ['all', 'today', 'upcoming', 'done'];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold">{view === 'inbox' ? 'Inbox' : 'Tasks'}</h1>
        <input className="input max-w-56" placeholder="Filter…" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      {tabs.length > 1 && (
        <div className="flex gap-1">
          {tabs.map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`btn ${tab === t ? 'bg-slate-900 text-white dark:bg-white dark:text-slate-900' : 'btn-ghost'} capitalize`}
            >
              {t}
            </button>
          ))}
        </div>
      )}
      <AddTask status={view === 'inbox' ? 'inbox' : 'todo'} />
      <TaskList tasks={tasks.data} empty={tab === 'inbox' ? 'Inbox zero!' : 'No tasks here.'} />
    </div>
  );
}

function AddTask({ defaultDueToday, status = 'todo' }: { defaultDueToday?: boolean; status?: 'todo' | 'inbox' }) {
  const qc = useQueryClient();
  const [title, setTitle] = useState('');
  const add = useMutation({
    mutationFn: () => {
      const end = new Date();
      end.setHours(17, 0, 0, 0);
      return api.createTask({ title, status, dueAt: defaultDueToday ? end.toISOString() : null });
    },
    onSuccess: async () => {
      setTitle('');
      await qc.invalidateQueries({ queryKey: ['tasks'] });
    },
  });
  return (
    <form
      className="flex gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (title.trim()) add.mutate();
      }}
    >
      <input
        className="input"
        placeholder="Add a task…"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        aria-label="New task"
      />
      <button className="btn-primary" disabled={!title.trim() || add.isPending} aria-label="Add task">
        <Plus size={16} />
      </button>
    </form>
  );
}
