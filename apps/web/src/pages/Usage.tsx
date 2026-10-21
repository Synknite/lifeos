import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api, type User } from '../lib/api';
import { compact, useMe, usd } from '../lib/hooks';

export function UsagePage() {
  const [days, setDays] = useState(30);
  const usage = useQuery({ queryKey: ['usage', days], queryFn: () => api.usage(days) });
  const meta = useQuery({ queryKey: ['meta'], queryFn: api.meta });
  const u = usage.data;
  const maxDaily = Math.max(...(u?.daily.map((d) => d.costUsd) ?? [0]), 1e-9);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">AI usage</h1>
        <select
          className="input w-32"
          value={days}
          onChange={(e) => setDays(Number(e.target.value))}
          aria-label="Period"
        >
          <option value={7}>7 days</option>
          <option value={30}>30 days</option>
          <option value={90}>90 days</option>
        </select>
      </div>
      {meta.data && (
        <p className="text-sm text-slate-500">
          Chat: <b>{meta.data.llm.provider}</b> ({meta.data.llm.smartModel}) · Capture: {meta.data.llm.fastModel} ·
          Embeddings: {meta.data.llm.embeddingProvider} ({meta.data.llm.embeddingModel})
        </p>
      )}

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Estimated cost" value={u ? usd(u.totals.costUsd) : '—'} />
        <Stat label="Calls" value={u ? compact(u.totals.calls) : '—'} />
        <Stat
          label="Tokens in / out"
          value={u ? `${compact(u.totals.inputTokens)} / ${compact(u.totals.outputTokens)}` : '—'}
        />
        <Stat
          label="p95 latency"
          value={u ? `${(u.totals.p95LatencyMs / 1000).toFixed(1)}s` : '—'}
          sub={u ? `${(u.totals.errorRate * 100).toFixed(1)}% errors` : ''}
        />
      </div>

      <section className="card p-4">
        <h2 className="mb-3 text-sm font-medium">Daily spend</h2>
        {u?.daily.length ? (
          <div className="flex h-32 items-end gap-1" role="img" aria-label="Daily spend chart">
            {u.daily.map((d) => (
              <div key={d.date} className="group relative flex-1">
                <div
                  className="rounded-t bg-brand-500/80 group-hover:bg-brand-600"
                  style={{ height: `${Math.max(2, (d.costUsd / maxDaily) * 128)}px` }}
                />
                <div className="pointer-events-none absolute bottom-full left-1/2 mb-1 hidden -translate-x-1/2 whitespace-nowrap rounded bg-slate-900 px-2 py-1 text-[11px] text-white group-hover:block">
                  {d.date}: {usd(d.costUsd)} · {compact(d.tokens)} tok
                </div>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-sm text-slate-500">No usage yet.</p>
        )}
      </section>

      <section className="card overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-left text-xs text-slate-500">
            <tr>
              <th className="px-4 py-2 font-medium">Feature</th>
              <th className="px-4 py-2 font-medium">Model</th>
              <th className="px-4 py-2 text-right font-medium">Calls</th>
              <th className="px-4 py-2 text-right font-medium">Tokens</th>
              <th className="px-4 py-2 text-right font-medium">Avg latency</th>
              <th className="px-4 py-2 text-right font-medium">Cost</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
            {u?.byPurpose.map((r) => (
              <tr key={`${r.purpose}-${r.model}`}>
                <td className="px-4 py-2 capitalize">{r.purpose}</td>
                <td className="px-4 py-2 font-mono text-xs">{r.model}</td>
                <td className="px-4 py-2 text-right tabular-nums">{r.calls}</td>
                <td className="px-4 py-2 text-right tabular-nums">{compact(r.tokens)}</td>
                <td className="px-4 py-2 text-right tabular-nums">{(r.avgLatencyMs / 1000).toFixed(2)}s</td>
                <td className="px-4 py-2 text-right tabular-nums">{usd(r.costUsd)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="card p-4">
      <div className="text-xs text-slate-500">{label}</div>
      <div className="mt-1 text-xl font-semibold tabular-nums">{value}</div>
      {sub && <div className="text-xs text-slate-400">{sub}</div>}
    </div>
  );
}

export function SettingsPage() {
  const me = useMe();
  if (!me.data) return null;
  return <SettingsForm user={me.data} />;
}

function SettingsForm({ user }: { user: User }) {
  const qc = useQueryClient();
  const [form, setForm] = useState({
    displayName: user.displayName,
    timezone: user.timezone,
    briefingEnabled: user.briefingEnabled,
    briefingTime: user.briefingTime,
  });
  const save = useMutation({ mutationFn: () => api.updateMe(form), onSuccess: (u) => qc.setQueryData(['me'], u) });
  const zones = Intl.supportedValuesOf('timeZone');

  return (
    <form
      className="card max-w-lg space-y-4 p-6"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate();
      }}
    >
      <h1 className="text-xl font-semibold">Settings</h1>
      <label className="block space-y-1 text-sm">
        <span>Name</span>
        <input
          className="input"
          value={form.displayName}
          onChange={(e) => setForm({ ...form, displayName: e.target.value })}
        />
      </label>
      <label className="block space-y-1 text-sm">
        <span>Timezone</span>
        <select
          className="input"
          value={form.timezone}
          onChange={(e) => setForm({ ...form, timezone: e.target.value })}
        >
          {zones.map((z) => (
            <option key={z}>{z}</option>
          ))}
        </select>
      </label>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          className="accent-brand-600"
          checked={form.briefingEnabled}
          onChange={(e) => setForm({ ...form, briefingEnabled: e.target.checked })}
        />
        Send me a daily briefing at
        <input
          type="time"
          className="input w-28"
          value={form.briefingTime}
          onChange={(e) => setForm({ ...form, briefingTime: e.target.value })}
        />
      </label>
      <div className="flex items-center gap-3">
        <button className="btn-primary" disabled={save.isPending}>
          Save
        </button>
        {save.isSuccess && <span className="text-sm text-emerald-600">Saved</span>}
        {save.isError && <span className="text-sm text-rose-600">{save.error.message}</span>}
      </div>
    </form>
  );
}
