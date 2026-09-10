import { CanActivate, ExecutionContext, Inject, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { CrossSiteRequestError } from './authentication.errors';
import { IDENTITY_WEB_ORIGIN } from './identity.constants';

@Injectable()
export class BrowserRequestGuard implements CanActivate {
  constructor(@Inject(IDENTITY_WEB_ORIGIN) private readonly webOrigin: string) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    const origin = request.header('origin');
    const fetchSite = request.header('sec-fetch-site');

    if (fetchSite === 'cross-site' || (origin !== undefined && origin !== this.webOrigin)) {
      throw new CrossSiteRequestError();
    }

    return true;
  }
}
