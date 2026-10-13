import type { ListenerStationList } from '@lookup/contracts';
import { Controller, Get, Req, Res, UseGuards } from '@nestjs/common';
import type { Request, Response } from 'express';
import { InstallTokenGuard } from '../../common/listener-authentication/install-token.guard.js';
import { PublicRoute } from '../authentication/public-route.decorator.js';
import { isListedInIfNoneMatch, ListenerStationsService } from './listener-stations.service.js';

/**
 * GET /api/v1/stations (P4 design §5.6, contract §1.4): the "My station" list. An install token is needed and a
 * portal cookie opens nothing; the portal's own GET /stations/{stationId} is a different route. The app keeps the
 * list for 24 hours and asks again with If-None-Match, so an unchanged list costs a 304 with no body.
 *
 * The one listener answer that may be cached: `Cache-Control: private, max-age=86400` replaces the global
 * no-store here only, and is set only once the list is in hand, so an error on this route keeps no-store.
 */
@Controller('stations')
@PublicRoute()
@UseGuards(InstallTokenGuard)
export class ListenerStationsController {
  constructor(private readonly listenerStations: ListenerStationsService) {}

  @Get()
  async list(@Req() request: Request, @Res({ passthrough: true }) response: Response): Promise<ListenerStationList | undefined> {
    await this.listenerStations.countAgainstLimit(response);
    const { stationList, entityTag } = await this.listenerStations.readStationList();
    const ifNoneMatch = request.headers['if-none-match'];
    // Decided here, once and exactly: Express would otherwise compare the header again, weakly, as it sends the body.
    delete request.headers['if-none-match'];
    response.setHeader('Cache-Control', 'private, max-age=86400');
    response.setHeader('ETag', entityTag);
    if (isListedInIfNoneMatch(ifNoneMatch, entityTag)) {
      // Not modified: the app keeps its list and starts its 24 hours again. Nest sends the 304 with no body.
      response.statusCode = 304;
      return undefined;
    }
    return stationList;
  }
}
