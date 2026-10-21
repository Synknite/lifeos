import { useQuery } from '@tanstack/react-query';
import { api } from './api';

export const browserTimeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

export function useMe() {
  return useQuery({ queryKey: ['me'], queryFn: api.me, retry: false, staleTime: 60_000 });
}

export function formatDue(iso: string | null, allDay: boolean, timeZone?: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  const now = new Date();
  const dayDiff = Math.round((startOfDay(d, timeZone) - startOfDay(now, timeZone)) / 86_400_000);
  const time = allDay
    ? ''
    : ` ${new Intl.DateTimeFormat(undefined, { timeZone, hour: 'numeric', minute: '2-digit' }).format(d)}`;
  if (dayDiff === 0) return `Today${time}`;
  if (dayDiff === 1) return `Tomorrow${time}`;
  if (dayDiff === -1) return `Yesterday${time}`;
  if (dayDiff > 1 && dayDiff < 7) {
    return new Intl.DateTimeFormat(undefined, { timeZone, weekday: 'long' }).format(d) + time;
  }
  return (
    new Intl.DateTimeFormat(undefined, {
      timeZone,
      month: 'short',
      day: 'numeric',
      year: dayDiff < -300 || dayDiff > 300 ? 'numeric' : undefined,
    }).format(d) + time
  );
}

export function isOverdue(iso: string | null, allDay: boolean, timeZone?: string): boolean {
  if (!iso) return false;
  const d = new Date(iso);
  return allDay ? startOfDay(d, timeZone) < startOfDay(new Date(), timeZone) : d.getTime() < Date.now();
}

function startOfDay(d: Date, timeZone?: string): number {
  const [y, m, day] = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(d)
    .split('-')
    .map(Number);
  return Date.UTC(y!, m! - 1, day);
}

export const usd = (n: number) =>
  n < 0.01 && n > 0
    ? `$${n.toFixed(4)}`
    : new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD' }).format(n);

export const compact = (n: number) => new Intl.NumberFormat(undefined, { notation: 'compact' }).format(n);

/** Value for <input type="datetime-local"> in the browser's zone. */
export function toLocalInput(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export const fromLocalInput = (v: string): string | null => (v ? new Date(v).toISOString() : null);
