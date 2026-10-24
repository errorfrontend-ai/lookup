import { Navigate, type RouteObject } from 'react-router';
import { LoadingScreen, NotFoundPage } from '../components/plain-pages';
import { ChangePasswordPage } from '../features/account/change-password-page';
import { AdsListPage } from '../features/ads/ads-list-page';
import { ClientsPage } from '../features/clients/clients-page';
import { OverviewPage } from '../features/overview/overview-page';
import { SignInPage } from '../features/sign-in/sign-in-page';
import { StationProfilePage } from '../features/stations/station-profile-page';
import { TeamPage } from '../features/team/team-page';
import { PortalShell } from './portal-shell';
import { HomeRedirect, RequireSignedIn } from './require-signed-in';
import { RouteErrorPage } from './route-error-page';
import { ActiveStationOnly, ContentEditorsOnly, StationScope } from './station-scope';

// The new-ad wizard and an ad's own page are the largest parts of the portal and are downloaded only
// when first opened, so signing in and the lists load sooner on a slow connection.
const loadAdSetupPage = () => import('../features/new-ad/ad-setup-page').then((module) => ({ Component: module.AdSetupPage }));
const loadAdDetailPage = () => import('../features/ads/ad-detail-page').then((module) => ({ Component: module.AdDetailPage }));
// Sign-up is its own download: a station's people never fetch it once they are approved.
type SignUpPageName = keyof typeof import('../features/sign-up/sign-up-pages');
const loadSignUp = (pageName: SignUpPageName) => () => import('../features/sign-up/sign-up-pages').then((module) => ({ Component: module[pageName] }));
// A client's pages are their own download (ADR-006): station people never fetch them, and clients never fetch the station's.
type ClientPageName = keyof typeof import('../features/client-area/client-pages');
const loadClient = (pageName: ClientPageName) => () => import('../features/client-area/client-pages').then((module) => ({ Component: module[pageName] }));
// The super admin's console is its own download too: station people never fetch it.
type AdminPageName = keyof typeof import('../features/admin/admin-pages');
const loadAdmin = (pageName: AdminPageName) => () => import('../features/admin/admin-pages').then((module) => ({ Component: module[pageName] }));

/** Every page in the portal. Station pages live under /stations/:stationId so links can be shared. */
export const PORTAL_ROUTES: RouteObject[] = [
  {
    errorElement: <RouteErrorPage />,
    // Shown while a page that is opened directly is still downloading.
    hydrateFallbackElement: <LoadingScreen />,
    children: [
      { path: '/sign-in', element: <SignInPage /> },
      { path: '/signup', lazy: loadSignUp('SignUpPage') },
      { path: '/verify-email', lazy: loadSignUp('VerifyEmailPage') },
      { path: '/invitations/accept', lazy: loadSignUp('InvitationPage') },
      {
        element: <RequireSignedIn />,
        children: [
          { index: true, element: <HomeRedirect /> },
          { path: '/two-factor', lazy: loadAdmin('TwoFactorPage') },
          {
            path: '/admin',
            lazy: loadAdmin('RequireSuperAdmin'),
            children: [
              {
                lazy: loadAdmin('AdminShell'),
                children: [
                  { index: true, element: <Navigate to="/admin/applications" replace /> },
                  { path: 'applications', lazy: loadAdmin('ApplicationsPage') },
                  { path: 'applications/:stationId', lazy: loadAdmin('ApplicationsPage') },
                  { path: 'stations', lazy: loadAdmin('StationsPage') },
                  { path: 'audio-to-check', lazy: loadAdmin('AudioToCheckPage') },
                  { path: 'system-health', lazy: loadAdmin('SystemHealthPage') },
                  { path: 'reference-codes', lazy: loadAdmin('ReferenceCodesPage') },
                  { path: '*', element: <NotFoundPage /> },
                ],
              },
            ],
          },
          {
            // The business that pays for an advert follows it here (ADR-006): view only, every station that invited them.
            path: '/client',
            lazy: loadClient('ClientShell'),
            children: [
              { index: true, lazy: loadClient('ClientHomePage') },
              { path: 'stations/:stationId/ads/:adId', lazy: loadClient('ClientAdPage') },
              { path: 'account', lazy: loadClient('ClientAccountPage') },
              { path: '*', lazy: loadClient('ClientNotFound') },
            ],
          },
          {
            // A station still applying has no name yet, so its application lives outside the station's pages.
            path: '/stations/:stationId/application',
            children: [
              { index: true, lazy: loadSignUp('ApplicationStatusPage') },
              { path: 'account', lazy: loadSignUp('AccountStep') },
              { path: 'verify', lazy: loadSignUp('VerifyStep') },
              { path: 'details', lazy: loadSignUp('DetailsStep') },
              { path: 'licence', lazy: loadSignUp('LicenceStep') },
            ],
          },
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
                  { path: 'team', element: <TeamPage /> },
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
