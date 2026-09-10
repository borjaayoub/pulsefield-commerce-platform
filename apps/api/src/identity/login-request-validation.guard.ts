import { CanActivate, ExecutionContext, Injectable, ValidationPipe } from '@nestjs/common';
import type { Request } from 'express';
import { CreateSessionDto } from './session.dto';

@Injectable()
export class LoginRequestValidationGuard implements CanActivate {
  private readonly validationPipe = new ValidationPipe({
    transform: true,
    whitelist: true,
    forbidNonWhitelisted: true,
    validationError: { target: false, value: false },
  });

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();
    request.body = await this.validationPipe.transform(request.body, {
      type: 'body',
      metatype: CreateSessionDto,
    });
    return true;
  }
}
