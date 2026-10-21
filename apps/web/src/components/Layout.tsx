import { useQuery, useQueryClient } from '@tanstack/react-query';
import { clsx } from 'clsx';
import {
  Bell,
  BarChart3,
  CalendarCheck,
  Inbox,
  ListTodo,
  LogOut,
  MessageSquare,
  NotebookPen,
  Settings,
  Sparkles,
} from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Link, useLocation } from 'wouter';
import { api } from '../lib/api';
import { QuickCapture } from './QuickCapture';

const NAV = [
  { href: '/today', label: 'Today', icon: CalendarCheck },
  { href: '/inbox', label: 'Inbox', icon: Inbox },
  { href: '/tasks', label: 'All tasks', icon: ListTodo },
  { href: '/notes', label: 'Notes', icon: NotebookPen },
  { href: '/assistant', label: 'Assistant', icon: MessageSquare },
  { href: '/usage', label: 'AI usage', icon: BarChart3 },
  { href: '/settings', label: 'Settings', icon: Settings },
];

export function Layout({ children }: { children: ReactNode }) {
  const [location, navigate] = useLocation();
  const qc = useQueryClient();
  const meta = useQuery({ queryKey: ['meta'], queryFn: api.meta, staleTime: Infinity });
  const notifications = useQuery({ queryKey: ['notifications'], queryFn: api.notifications, refetchInterval: 30_000 });
  const unread = notifications.data?.filter((n) => !n.read) ?? [];
  const [showBell, setShowBell] = useState(false);

  const logout = async () => {
    await api.logout();
    qc.clear();
    navigate('/login');
  };

  return (
    <div className="flex min-h-screen">
      <aside className="hidden w-56 shrink-0 flex-col border-r border-slate-200 bg-white px-3 py-4 md:flex dark:border-slate-800 dark:bg-slate-900">
        <div className="mb-6 flex items-center gap-2 px-2 text-lg font-semibold">
          <span className="grid h-7 w-7 place-items-center rounded-lg bg-brand-600 text-white">
            <Sparkles size={16} />
          </span>
          LifeOS
        </div>
        <nav className="flex flex-1 flex-col gap-0.5">
          {NAV.map(({ href, label, icon: Icon }) => (
            <Link
              key={href}
              href={href}
              className={clsx(
                'flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm',
                location.startsWith(href)
                  ? 'bg-brand-50 font-medium text-brand-700 dark:bg-brand-600/15 dark:text-brand-100'
                  : 'text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800',
              )}
            >
              <Icon size={17} />
              {label}
            </Link>
          ))}
        </nav>
        <button className="btn-ghost justify-start" onClick={() => void logout()}>
          <LogOut size={16} /> Sign out
        </button>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-10 flex items-center gap-3 border-b border-slate-200 bg-white/80 px-4 py-2.5 backdrop-blur dark:border-slate-800 dark:bg-slate-950/80">
          <nav className="flex gap-1 overflow-x-auto md:hidden">
            {NAV.slice(0, 5).map(({ href, icon: Icon, label }) => (
              <Link key={href} href={href} aria-label={label} className="btn-ghost px-2">
                <Icon size={18} />
              </Link>
            ))}
          </nav>
          <QuickCapture />
          <div className="relative ml-auto">
            <button
              className="btn-ghost relative px-2"
              aria-label="Notifications"
              onClick={() => setShowBell((s) => !s)}
            >
              <Bell size={18} />
              {unread.length > 0 && (
                <span className="absolute -top-0.5 -right-0.5 grid h-4 min-w-4 place-items-center rounded-full bg-rose-500 px-1 text-[10px] text-white">
                  {unread.length}
                </span>
              )}
            </button>
            {showBell && (
              <div className="card absolute right-0 mt-2 w-80 p-2 text-sm">
                <div className="flex items-center justify-between px-2 py-1">
                  <span className="font-medium">Notifications</span>
                  {unread.length > 0 && (
                    <button
                      className="text-xs text-brand-600"
                      onClick={() => void api.markNotificationsRead('all').then(() => notifications.refetch())}
                    >
                      Mark all read
                    </button>
                  )}
                </div>
                {notifications.data?.length ? (
                  notifications.data.slice(0, 8).map((n) => (
                    <div
                      key={n.id}
                      className={clsx('rounded-lg px-2 py-1.5', !n.read && 'bg-brand-50 dark:bg-brand-600/10')}
                    >
                      <div className="font-medium">{n.title}</div>
                      <div className="text-xs text-slate-500">{new Date(n.createdAt).toLocaleString()}</div>
                    </div>
                  ))
                ) : (
                  <p className="px-2 py-3 text-slate-500">You're all caught up.</p>
                )}
              </div>
            )}
          </div>
        </header>

        {meta.data?.llm.demoMode && (
          <div className="border-b border-amber-200 bg-amber-50 px-4 py-1.5 text-xs text-amber-800 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200">
            Demo mode: no language model is configured, so the assistant uses simple pattern matching. Set{' '}
            <code>ANTHROPIC_API_KEY</code> for the full experience.
          </div>
        )}
        <main className="mx-auto w-full max-w-4xl flex-1 px-4 py-6">{children}</main>
      </div>
    </div>
  );
}
