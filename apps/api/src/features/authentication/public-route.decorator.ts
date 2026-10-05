import { SetMetadata } from '@nestjs/common';

export const PUBLIC_ROUTE_METADATA = 'lookup:public-route';

/**
 * Every route requires a signed-in user unless it is marked public. Deny by default, so a new route
 * that forgets to think about authentication is closed rather than open.
 */
export const PublicRoute = () => SetMetadata(PUBLIC_ROUTE_METADATA, true);
