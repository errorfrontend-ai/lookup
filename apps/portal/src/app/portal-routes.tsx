import type { RouteObject } from 'react-router';
import { NotFoundPage } from '../components/plain-pages';
import { ChangePasswordPage } from '../features/account/change-password-page';
import { AdsListPage } from '../features/ads/ads-list-page';
import { ClientsPage } from '../features/clients/clients-page';
import { OverviewPage } from '../features/overview/overview-page';
import { SignInPage } from '../features/sign-in/sign-in-page';
import { StationProfilePage } from '../features/stations/station-profile-page';
import { PortalShell } from './portal-shell';
import { HomeRedirect, RequireSignedIn } from './require-signed-in';
import { RouteErrorPage } from './route-error-page';
import { ActiveStationOnly, StationScope } from './station-scope';

/** Every page in the portal. Station pages live under /stations/:stationId so links can be shared. */
export const PORTAL_ROUTES: RouteObject[] = [
  {
    errorElement: <RouteErrorPage />,
    children: [
      { path: '/sign-in', element: <SignInPage /> },
      {
        element: <RequireSignedIn />,
        children: [
          { index: true, element: <HomeRedirect /> },
          {
            path: '/stations/:stationId',
            element: <StationScope />,
            children: [
              {
                element: <PortalShell />,
                children: [
                  {
                    element: <ActiveStationOnly />,
                    children: [
                      { path: 'overview', element: <OverviewPage /> },
                      { path: 'ads', element: <AdsListPage /> },
                      { path: 'clients', element: <ClientsPage /> },
                    ],
                  },
                  { path: 'profile', element: <StationProfilePage /> },
                  { path: 'account', element: <ChangePasswordPage /> },
                  { path: '*', element: <NotFoundPage /> },
                ],
              },
            ],
          },
        ],
      },
      { path: '*', element: <NotFoundPage /> },
    ],
  },
];
