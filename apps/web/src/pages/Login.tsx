import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Sparkles } from 'lucide-react';
import { useState } from 'react';
import { useLocation } from 'wouter';
import { api } from '../lib/api';
import { browserTimeZone } from '../lib/hooks';

export function LoginPage() {
  const [mode, setMode] = useState<'login' | 'signup'>('login');
  const [form, setForm] = useState({ email: '', password: '', displayName: '' });
  const [, navigate] = useLocation();
  const qc = useQueryClient();

  const submit = useMutation({
    mutationFn: () =>
      mode === 'login' ? api.login(form.email, form.password) : api.signup({ ...form, timezone: browserTimeZone() }),
    onSuccess: (user) => {
      qc.setQueryData(['me'], user);
      navigate('/today');
    },
  });

  return (
    <div className="grid min-h-screen place-items-center px-4">
      <form
        className="card w-full max-w-sm space-y-4 p-6"
        onSubmit={(e) => {
          e.preventDefault();
          submit.mutate();
        }}
      >
        <div className="flex items-center gap-2 text-xl font-semibold">
          <span className="grid h-8 w-8 place-items-center rounded-lg bg-brand-600 text-white">
            <Sparkles size={18} />
          </span>
          LifeOS
        </div>
        <p className="text-sm text-slate-500">Your tasks, notes and an assistant that keeps it all straight.</p>
        {mode === 'signup' && (
          <input
            className="input"
            placeholder="Your name"
            autoComplete="name"
            required
            value={form.displayName}
            onChange={(e) => setForm({ ...form, displayName: e.target.value })}
          />
        )}
        <input
          className="input"
          type="email"
          placeholder="Email"
          autoComplete="email"
          required
          value={form.email}
          onChange={(e) => setForm({ ...form, email: e.target.value })}
        />
        <input
          className="input"
          type="password"
          placeholder={mode === 'signup' ? 'Password (10+ characters)' : 'Password'}
          autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
          minLength={mode === 'signup' ? 10 : 1}
          required
          value={form.password}
          onChange={(e) => setForm({ ...form, password: e.target.value })}
        />
        {submit.isError && <p className="text-sm text-rose-600">{submit.error.message}</p>}
        <button className="btn-primary w-full py-2" disabled={submit.isPending}>
          {mode === 'login' ? 'Sign in' : 'Create account'}
        </button>
        <button
          type="button"
          className="w-full text-sm text-brand-600"
          onClick={() => setMode(mode === 'login' ? 'signup' : 'login')}
        >
          {mode === 'login' ? 'New here? Create an account' : 'Have an account? Sign in'}
        </button>
      </form>
    </div>
  );
}
