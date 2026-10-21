import { useMutation, useQueryClient } from '@tanstack/react-query';
import { clsx } from 'clsx';
import { Check, Flag, Trash2 } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import { api, type Task } from '../lib/api';
import { formatDue, isOverdue, useMe } from '../lib/hooks';

const PRIORITY_COLOR = ['', 'text-sky-500', 'text-amber-500', 'text-rose-500'];

export function TaskList({ tasks, empty }: { tasks: Task[] | undefined; empty: string }) {
  if (!tasks) return <div className="card h-24 animate-pulse" />;
  if (!tasks.length) return <p className="card px-4 py-6 text-center text-sm text-slate-500">{empty}</p>;
  return (
    <ul className="card divide-y divide-slate-100 dark:divide-slate-800">
      {tasks.map((t) => (
        <TaskItem key={t.id} task={t} />
      ))}
    </ul>
  );
}

function TaskItem({ task }: { task: Task }) {
  const qc = useQueryClient();
  const me = useMe();
  const done = task.status === 'done';
  const refresh = () => qc.invalidateQueries({ queryKey: ['tasks'] });
  const toggle = useMutation({
    mutationFn: () => (done ? api.updateTask(task.id, { status: 'todo' }) : api.completeTask(task.id)),
    onSettled: refresh,
  });
  const remove = useMutation({ mutationFn: () => api.deleteTask(task.id), onSettled: refresh });
  const overdue = !done && isOverdue(task.dueAt, task.allDay, me.data?.timezone);

  return (
    <li className="group flex items-start gap-3 px-4 py-3">
      <button
        aria-label={done ? 'Mark as not done' : 'Complete task'}
        onClick={() => toggle.mutate()}
        className={clsx(
          'mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full border transition',
          done
            ? 'border-brand-600 bg-brand-600 text-white'
            : 'border-slate-300 hover:border-brand-500 dark:border-slate-600',
        )}
      >
        {done && <Check size={12} />}
      </button>
      <div className="min-w-0 flex-1">
        <div className={clsx('text-sm', done && 'text-slate-400 line-through')}>{task.title}</div>
        <div className="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-slate-500">
          {task.dueAt && (
            <span className={clsx(overdue && 'font-medium text-rose-600')}>
              {overdue ? 'Overdue · ' : ''}
              {formatDue(task.dueAt, task.allDay, me.data?.timezone)}
            </span>
          )}
          {task.priority > 0 && (
            <Flag size={12} className={PRIORITY_COLOR[task.priority]} aria-label={`Priority ${task.priority}`} />
          )}
          {task.tags.map((t) => (
            <span key={t} className="rounded bg-slate-100 px-1.5 py-0.5 dark:bg-slate-800">
              #{t}
            </span>
          ))}
          {task.source !== 'manual' && <span className="text-slate-400">via {task.source}</span>}
        </div>
      </div>
      <button
        aria-label="Delete task"
        onClick={() => remove.mutate()}
        className="btn-ghost px-1.5 opacity-0 transition group-hover:opacity-100 focus:opacity-100"
      >
        <Trash2 size={14} />
      </button>
    </li>
  );
}

/** Markdown with no raw HTML and no remote images (blocks image-URL exfiltration). */
export function Markdown({ children }: { children: string }) {
  return (
    <div className="prose-sm text-sm leading-relaxed">
      <ReactMarkdown
        skipHtml
        components={{
          img: ({ alt }) => <span className="text-slate-400">[image: {alt}]</span>,
          a: ({ href, children: c }) => (
            <a href={href} target="_blank" rel="noreferrer noopener" className="text-brand-600 underline">
              {c}
            </a>
          ),
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
