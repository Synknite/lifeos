import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, signUp, WEB_ORIGIN, type TestContext } from '../test/helpers.js';

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestApp();
});
afterAll(() => ctx.close());
beforeEach(() => ctx.reset());

describe('health', () => {
  it('reports live and ready with dependency checks', async () => {
    expect((await ctx.app.inject('/livez')).statusCode).toBe(200);
    const ready = await ctx.app.inject('/readyz');
    expect(ready.statusCode).toBe(200);
    expect(ready.json()).toMatchObject({
      status: 'ok',
      checks: { postgres: { status: 'ok' }, redis: { status: 'ok' }, migrations: { status: 'ok' } },
    });
  });

  it('fails readiness while shutting down', async () => {
    ctx.deps.lifecycle.shuttingDown = true;
    try {
      expect((await ctx.app.inject('/readyz')).statusCode).toBe(503);
    } finally {
      ctx.deps.lifecycle.shuttingDown = false;
    }
  });
});

describe('auth', () => {
  it('signs up, reads /me, logs out', async () => {
    const { cookie, user } = await signUp(ctx.app);
    const me = await ctx.app.inject({ url: '/api/auth/me', headers: { cookie } });
    expect(me.statusCode).toBe(200);
    expect(me.json()).toMatchObject({ id: user.id, timezone: 'America/New_York' });

    const out = await ctx.app.inject({ method: 'POST', url: '/api/auth/logout', headers: { cookie } });
    expect(out.statusCode).toBe(204);
    expect((await ctx.app.inject({ url: '/api/auth/me', headers: { cookie } })).statusCode).toBe(401);
  });

  it('sets an httpOnly SameSite=Lax cookie', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/auth/signup',
      payload: { email: 'c@example.com', password: 'correct horse battery', displayName: 'C' },
    });
    const c = res.cookies.find((x) => x.name === 'lifeos_session')!;
    expect(c.httpOnly).toBe(true);
    expect(c.sameSite).toBe('Lax');
  });

  it('rejects duplicate emails case-insensitively', async () => {
    await signUp(ctx.app, { email: 'dup@example.com' });
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/auth/signup',
      payload: { email: 'DUP@example.com', password: 'correct horse battery', displayName: 'D' },
    });
    expect(res.statusCode).toBe(409);
  });

  it('rejects bad credentials with a generic message', async () => {
    await signUp(ctx.app, { email: 'login@example.com' });
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'login@example.com', password: 'wrong password!!' },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: { code: 'unauthorized', message: 'Invalid email or password' } });
  });

  it('validates input', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/auth/signup',
      payload: { email: 'nope', password: 'short', displayName: '' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('validation_error');
  });

  it('blocks cross-origin state-changing requests', async () => {
    const { cookie } = await signUp(ctx.app);
    const evil = await ctx.app.inject({
      method: 'POST',
      url: '/api/tasks',
      headers: { cookie, origin: 'https://evil.example' },
      payload: { title: 'pwned' },
    });
    expect(evil.statusCode).toBe(403);
    const ok = await ctx.app.inject({
      method: 'POST',
      url: '/api/tasks',
      headers: { cookie, origin: WEB_ORIGIN },
      payload: { title: 'fine' },
    });
    expect(ok.statusCode).toBe(201);
  });
});

describe('tasks', () => {
  it('requires authentication', async () => {
    expect((await ctx.app.inject('/api/tasks')).statusCode).toBe(401);
  });

  it('supports CRUD, views and completion', async () => {
    const { cookie } = await signUp(ctx.app);
    const create = (payload: object) =>
      ctx.app.inject({ method: 'POST', url: '/api/tasks', headers: { cookie }, payload });

    const overdue = (await create({ title: 'Overdue', dueAt: '2020-01-01T10:00:00Z' })).json();
    await create({ title: 'Someday', dueAt: '2099-01-01T10:00:00Z' });
    await create({ title: 'Inbox item', status: 'inbox' });

    const view = async (v: string) =>
      (await ctx.app.inject({ url: `/api/tasks?view=${v}`, headers: { cookie } }))
        .json<{ title: string }[]>()
        .map((t) => t.title);
    expect(await view('today')).toEqual(['Overdue']);
    expect(await view('upcoming')).toEqual(['Someday']);
    expect(await view('inbox')).toEqual(['Inbox item']);
    expect(await view('all')).toHaveLength(3);

    const done = await ctx.app.inject({
      method: 'POST',
      url: `/api/tasks/${overdue.id}/complete`,
      headers: { cookie },
    });
    expect(done.json()).toMatchObject({ status: 'done', completedAt: expect.any(String) });
    expect(await view('done')).toEqual(['Overdue']);

    const patched = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/tasks/${overdue.id}`,
      headers: { cookie },
      payload: { status: 'todo', tags: ['Errands'] },
    });
    expect(patched.json()).toMatchObject({ status: 'todo', completedAt: null, tags: ['errands'] });

    const del = await ctx.app.inject({ method: 'DELETE', url: `/api/tasks/${overdue.id}`, headers: { cookie } });
    expect(del.statusCode).toBe(204);
    expect((await ctx.app.inject({ url: `/api/tasks/${overdue.id}`, headers: { cookie } })).statusCode).toBe(404);
  });

  it("isolates users from each other's data", async () => {
    const alice = await signUp(ctx.app);
    const bob = await signUp(ctx.app);
    const task = (
      await ctx.app.inject({
        method: 'POST',
        url: '/api/tasks',
        headers: { cookie: alice.cookie },
        payload: { title: 'secret' },
      })
    ).json();
    const peek = await ctx.app.inject({ url: `/api/tasks/${task.id}`, headers: { cookie: bob.cookie } });
    expect(peek.statusCode).toBe(404);
    const list = await ctx.app.inject({ url: '/api/tasks', headers: { cookie: bob.cookie } });
    expect(list.json()).toEqual([]);
  });

  it('rejects assigning a task to another user’s project', async () => {
    const alice = await signUp(ctx.app);
    const bob = await signUp(ctx.app);
    const project = (
      await ctx.app.inject({
        method: 'POST',
        url: '/api/projects',
        headers: { cookie: alice.cookie },
        payload: { name: 'Home' },
      })
    ).json();
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/tasks',
      headers: { cookie: bob.cookie },
      payload: { title: 'x', projectId: project.id },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('projects', () => {
  it('counts open tasks per project', async () => {
    const { cookie } = await signUp(ctx.app);
    const project = (
      await ctx.app.inject({
        method: 'POST',
        url: '/api/projects',
        headers: { cookie },
        payload: { name: 'Move house' },
      })
    ).json();
    for (const title of ['Book movers', 'Change address']) {
      await ctx.app.inject({
        method: 'POST',
        url: '/api/tasks',
        headers: { cookie },
        payload: { title, projectId: project.id },
      });
    }
    const list = await ctx.app.inject({ url: '/api/projects', headers: { cookie } });
    expect(list.json()).toEqual([expect.objectContaining({ name: 'Move house', openTaskCount: 2 })]);
  });
});
