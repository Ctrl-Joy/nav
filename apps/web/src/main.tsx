import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from 'react-router-dom';
import { isApiError, onUnauthorized } from '@/api/client';
import { qk } from '@/api/keys';
import { ConfirmProvider, ToastProvider } from '@/components/ui';
import { router } from './router';
import './index.css';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 15_000,
      refetchOnWindowFocus: true,
      retry: (count, e) => {
        if (isApiError(e) && e.status >= 400 && e.status < 500) return false;
        return count < 2;
      },
    },
  },
});

const PUBLIC = ['/', '/login', '/signup'];

onUnauthorized(() => {
  queryClient.setQueryData(qk.me, null);
  const { pathname, search } = window.location;
  if (!PUBLIC.includes(pathname)) {
    void router.navigate(`/login?next=${encodeURIComponent(pathname + search)}`, { replace: true });
  }
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <ConfirmProvider>
          <RouterProvider router={router} />
        </ConfirmProvider>
      </ToastProvider>
    </QueryClientProvider>
  </StrictMode>,
);
