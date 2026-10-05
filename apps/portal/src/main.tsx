import '@fontsource-variable/bricolage-grotesque';
import '@fontsource-variable/public-sans';
import './styles.css';
import { QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { createBrowserRouter, RouterProvider } from 'react-router';
import { ErrorBoundary } from './app/error-boundary';
import { installGlobalErrorHandlers } from './app/error-reporting';
import { queryClient } from './app/portal-api';
import { PORTAL_ROUTES } from './app/portal-routes';

installGlobalErrorHandlers();

const router = createBrowserRouter(PORTAL_ROUTES);
const rootElement = document.getElementById('root');
if (!rootElement) throw new Error('The page has no #root element');

createRoot(rootElement).render(
  <StrictMode>
    <ErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </ErrorBoundary>
  </StrictMode>,
);
