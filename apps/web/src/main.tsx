import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Loader2 } from 'lucide-react';
import { StrictMode, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { Redirect, Route, Switch } from 'wouter';
import { Layout } from './components/Layout';
import './index.css';
import { ApiError } from './lib/api';
import { useMe } from './lib/hooks';
import { AssistantPage } from './pages/Assistant';
import { LoginPage } from './pages/Login';
import { NotesPage } from './pages/Notes';
import { TasksPage, TodayPage } from './pages/Today';
import { SettingsPage, UsagePage } from './pages/Usage';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: (count, err) => !(err instanceof ApiError && err.status < 500) && count < 2,
      refetchOnWindowFocus: true,
    },
  },
});

function Authed({ children }: { children: ReactNode }) {
  const me = useMe();
  if (me.isPending) {
    return (
      <div className="grid min-h-screen place-items-center">
        <Loader2 className="animate-spin text-brand-600" />
      </div>
    );
  }
  if (me.isError) return <Redirect to="/login" />;
  return <Layout>{children}</Layout>;
}

function App() {
  return (
    <Switch>
      <Route path="/login" component={LoginPage} />
      <Route path="/today">
        {() => (
          <Authed>
            <TodayPage />
          </Authed>
        )}
      </Route>
      <Route path="/inbox">
        {() => (
          <Authed>
            <TasksPage view="inbox" />
          </Authed>
        )}
      </Route>
      <Route path="/tasks">
        {() => (
          <Authed>
            <TasksPage view="all" />
          </Authed>
        )}
      </Route>
      <Route path="/notes">
        {() => (
          <Authed>
            <NotesPage />
          </Authed>
        )}
      </Route>
      <Route path="/assistant">
        {() => (
          <Authed>
            <AssistantPage />
          </Authed>
        )}
      </Route>
      <Route path="/usage">
        {() => (
          <Authed>
            <UsagePage />
          </Authed>
        )}
      </Route>
      <Route path="/settings">
        {() => (
          <Authed>
            <SettingsPage />
          </Authed>
        )}
      </Route>
      <Route>
        <Redirect to="/today" />
      </Route>
    </Switch>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </StrictMode>,
);
