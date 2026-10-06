import { QueryClientProvider } from '@tanstack/react-query';
import { render } from '@testing-library/react';
import { createMemoryRouter, type RouteObject, RouterProvider } from 'react-router';
import { queryClient } from '../app/portal-api';
import { PORTAL_ROUTES } from '../app/portal-routes';

/** Renders the whole portal (real routes, real query cache) starting at one address. */
export function renderPortalAt(path: string, routes: RouteObject[] = PORTAL_ROUTES) {
  // A failing request should show its error at once in a test, not after the app's retry delays.
  queryClient.setDefaultOptions({ queries: { retry: false, refetchOnWindowFocus: false } });
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  const rendered = render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return { router, ...rendered };
}
