import { Injectable } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { Strategy } from 'passport-local';
import {
  type AuthenticatedPrincipal,
  CredentialAuthenticationService,
} from './credential-authentication.service';

@Injectable()
export class LocalStrategy extends PassportStrategy(Strategy, 'local') {
  constructor(private readonly credentials: CredentialAuthenticationService) {
    super({ usernameField: 'email', passwordField: 'password', session: false });
  }

  validate(email: string, password: string): Promise<AuthenticatedPrincipal> {
    return this.credentials.authenticate(email, password);
  }
}
