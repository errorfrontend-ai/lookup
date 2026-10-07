import type { RouteObject } from 'react-router';
import { LoadingScreen, NotFoundPage } from '../components/plain-pages';
import { ChangePasswordPage } from '../features/account/change-password-page';
import { AdsListPage } from '../features/ads/ads-list-page';
import { ClientsPage } from '../features/clients/clients-page';
import { OverviewPage } from '../features/overview/overview-page';
import { SignInPage } from '../features/sign-in/sign-in-page';
import { StationProfilePage } from '../features/stations/station-profile-page';
import { PortalShell } from './portal-shell';
import { HomeRedirect, RequireSignedIn } from './require-signed-in';
import { RouteErrorPage } from './route-error-page';
import { ActiveStationOnly, ContentEditorsOnly, StationScope } from './station-scope';

// The new-ad wizard and an ad's own page are the largest parts of the portal and are downloaded only
// when first opened, so signing in and the lists load sooner on a slow connection.
const loadAdSetupPage = () => import('../features/new-ad/ad-setup-page').then((module) => ({ Component: module.AdSetupPage }));
const loadAdDetailPage = () => import('../features/ads/ad-detail-page').then((module) => ({ Component: module.AdDetailPage }));

/** Every page in the portal. Station pages live under /stations/:stationId so links can be shared. */
export const PORTAL_ROUTES: RouteObject[] = [
  {
    errorElement: <RouteErrorPage />,
    // Shown while a page that is opened directly is still downloading.
    hydrateFallbackElement: <LoadingScreen />,
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
                // Setting up an ad takes the whole screen, so it sits outside the shell.
                element: <ContentEditorsOnly />,
                children: [
                  { path: 'ads/new', lazy: loadAdSetupPage },
                  { path: 'ads/:adId/setup', lazy: loadAdSetupPage },
                ],
              },
              {
                element: <PortalShell />,
                children: [
                  {
                    element: <ActiveStationOnly />,
                    children: [
                      { path: 'overview', element: <OverviewPage /> },
                      { path: 'ads', element: <AdsListPage /> },
                      { path: 'ads/:adId', lazy: loadAdDetailPage },
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
