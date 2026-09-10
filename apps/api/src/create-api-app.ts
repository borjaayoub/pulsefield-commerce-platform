import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import type { LocalProfile } from '@pulse-field/foundation';
import type { NextFunction, Request, Response } from 'express';
import helmet from 'helmet';
import pinoHttp from 'pino-http';
import { randomUUID } from 'node:crypto';
import { AppModule } from './app.module';
import { HttpProblemDetailsFilter } from './http/http-problem-details.filter';
import { createLogger } from './logger';

const securityPolicy = {
  useDefaults: true,
  directives: {
    defaultSrc: ["'self'"],
    baseUri: ["'self'"],
    frameAncestors: ["'none'"],
    objectSrc: ["'none'"],
    scriptSrc: ["'self'"],
    styleSrc: ["'self'", "'unsafe-inline'"],
    imgSrc: ["'self'", 'data:', 'blob:'],
    connectSrc: ["'self'", 'http://localhost:4000'],
    upgradeInsecureRequests: null,
  },
};

export async function createApiApp(profile: LocalProfile): Promise<NestExpressApplication> {
  const logger = createLogger(profile);
  const app = await NestFactory.create<NestExpressApplication>(AppModule.forRoot(profile), {
    bufferLogs: true,
  });
  app.useLogger({
    log: (message) => logger.info(message),
    error: (message, trace) => logger.error({ trace }, message),
    warn: (message) => logger.warn(message),
    debug: (message) => logger.debug(message),
    verbose: (message) => logger.trace(message),
    fatal: (message) => logger.fatal(message),
    setLogLevels: () => undefined,
  });
  app.getHttpAdapter().getInstance().disable('x-powered-by');
  app.use((request: Request, response: Response, next: NextFunction) => {
    const received = request.header('x-request-id');
    const requestId =
      received && /^[a-zA-Z0-9._-]{8,128}$/.test(received) ? received : randomUUID();
    response.setHeader('x-request-id', requestId);
    request.headers['x-request-id'] = requestId;
    next();
  });
  app.use(
    pinoHttp({
      logger,
      genReqId: (request) => request.headers['x-request-id']?.toString() ?? randomUUID(),
      customProps: (request) => ({ correlationId: request.headers['x-request-id'] }),
    }),
  );
  app.use(helmet({ contentSecurityPolicy: securityPolicy, crossOriginEmbedderPolicy: false }));
  app.enableCors({
    origin: profile.WEB_ORIGIN,
    credentials: true,
    methods: ['GET', 'HEAD', 'OPTIONS', 'POST', 'PUT', 'DELETE'],
    allowedHeaders: ['Content-Type', 'X-Request-ID', 'X-CSRF-Token'],
    maxAge: 600,
  });
  app.setGlobalPrefix('api/v1');
  app.useGlobalPipes(
    new ValidationPipe({
      transform: true,
      whitelist: true,
      forbidNonWhitelisted: true,
      validationError: { target: false, value: false },
    }),
  );
  app.useGlobalFilters(new HttpProblemDetailsFilter());

  const document = SwaggerModule.createDocument(
    app,
    new DocumentBuilder()
      .setTitle('PULSE//FIELD commerce API')
      .setDescription('Local-only commerce foundation and Phase 2 identity contract.')
      .setVersion('v1')
      .addCookieAuth(
        'pulse_field_session',
        {
          type: 'apiKey',
          in: 'cookie',
          name: 'pulse_field_session',
          description: 'Opaque server-side browser session identifier.',
        },
        'session-cookie',
      )
      .build(),
  );
  SwaggerModule.setup('api/docs', app, document, {
    jsonDocumentUrl: 'api/docs/openapi.json',
  });

  return app;
}
