/**
 * A client's pages (ADR-006), downloaded as their own part of the portal (P5C-ACCESS-06): a station's people never fetch
 * them, and a client never fetches the station's pages.
 */
export { ChangePasswordPage as ClientAccountPage } from '../account/change-password-page';
export { ClientAdPage, ClientNotFound } from './client-ad-page';
export { ClientHomePage } from './client-home-page';
export { ClientNotificationsPage } from './client-notifications-page';
export { ClientShell } from './client-shell';
