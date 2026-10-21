import type { CapturePreview, Note, Project, SearchHit, Task } from '@lifeos/domain';
import type {
  Briefing,
  CommitCaptureInput,
  Notification,
  PendingActionView,
  UsageSummary,
  User,
  ViewMessage,
} from '@lifeos/core';

export type {
  Briefing,
  CapturePreview,
  Note,
  Notification,
  PendingActionView,
  Project,
  SearchHit,
  Task,
  UsageSummary,
  User,
  ViewMessage,
};

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method,
    credentials: 'same-origin',
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 204) return undefined as T;
  const data = (await res.json().catch(() => ({}))) as { error?: { code: string; message: string } };
  if (!res.ok) throw new ApiError(res.status, data.error?.code ?? 'error', data.error?.message ?? res.statusText);
  return data as T;
}

const get = <T>(p: string) => request<T>('GET', p);
const post = <T>(p: string, b?: unknown) => request<T>('POST', p, b ?? {});
const patch = <T>(p: string, b: unknown) => request<T>('PATCH', p, b);
const del = (p: string) => request<void>('DELETE', p);

export interface Meta {
  version: string;
  llm: {
    provider: string;
    smartModel: string;
    fastModel: string;
    embeddingProvider: string;
    embeddingModel: string;
    demoMode: boolean;
  };
}

export type TaskView = 'today' | 'upcoming' | 'inbox' | 'all' | 'done';

export const api = {
  meta: () => get<Meta>('/meta'),
  me: () => get<User>('/auth/me'),
  login: (email: string, password: string) => post<User>('/auth/login', { email, password }),
  signup: (b: { email: string; password: string; displayName: string; timezone: string }) =>
    post<User>('/auth/signup', b),
  logout: () => post<void>('/auth/logout'),
  updateMe: (b: Partial<Pick<User, 'displayName' | 'timezone' | 'briefingEnabled' | 'briefingTime'>>) =>
    patch<User>('/auth/me', b),

  tasks: (view: TaskView, q?: string) => get<Task[]>(`/tasks?view=${view}${q ? `&q=${encodeURIComponent(q)}` : ''}`),
  createTask: (b: {
    title: string;
    dueAt?: string | null;
    priority?: number;
    status?: Task['status'];
    projectId?: string | null;
  }) => post<Task>('/tasks', b),
  updateTask: (
    id: string,
    b: Partial<Pick<Task, 'title' | 'status' | 'priority' | 'dueAt' | 'allDay' | 'projectId'>>,
  ) => patch<Task>(`/tasks/${id}`, b),
  completeTask: (id: string) => post<Task>(`/tasks/${id}/complete`),
  deleteTask: (id: string) => del(`/tasks/${id}`),

  projects: () => get<Project[]>('/projects'),
  createProject: (name: string) => post<Project>('/projects', { name }),

  notes: () => get<Note[]>('/notes'),
  note: (id: string) => get<Note>(`/notes/${id}`),
  createNote: (b: { title: string; bodyMd: string; kind?: 'note' | 'journal' }) => post<Note>('/notes', b),
  updateNote: (id: string, b: { title?: string; bodyMd?: string }) => patch<Note>(`/notes/${id}`, b),
  deleteNote: (id: string) => del(`/notes/${id}`),
  searchNotes: (q: string) => get<SearchHit[]>(`/notes/search?q=${encodeURIComponent(q)}`),

  capturePreview: (text: string) => post<CapturePreview>('/capture/preview', { text }),
  captureCommit: (b: CommitCaptureInput) => post<{ kind: 'task' | 'note' }>('/capture', b),

  conversations: () => get<{ id: string; title: string; updatedAt: string }[]>('/assistant/conversations'),
  conversation: (id: string) =>
    get<{ id: string; title: string; messages: ViewMessage[]; pending: (PendingActionView & { runId: string })[] }>(
      `/assistant/conversations/${id}`,
    ),
  deleteConversation: (id: string) => del(`/assistant/conversations/${id}`),

  briefing: () => get<{ briefing: Briefing | null }>('/briefings/today'),
  generateBriefing: () => post<{ briefing: Briefing }>('/briefings/today'),
  usage: (days = 30) => get<UsageSummary>(`/usage?days=${days}`),
  notifications: () => get<Notification[]>('/notifications'),
  markNotificationsRead: (ids: string[] | 'all') => post<{ updated: number }>('/notifications/read', { ids }),
};
